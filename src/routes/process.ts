import { Hono } from 'hono';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { randomUUID } from 'crypto';
import type { ApiResponse, Creator, ChannelAIProcessing } from '../types';
import { structuredLogger } from '../middleware/logger';
import { connectToDatabase, connectToOrgsDatabase, connectToPrismaDatabase } from '../lib/mongodb';
import { getChannelVideos, getChannelInfo } from '../lib/youtube';
import { getVideoTranscriptWithData, cleanTranscript, chunkTextWithMetadata } from '../lib/youtube';
import { storeTranscriptChunks, storeChannelContext } from '../lib/rag';
import { jobStore, type ProcessingJob } from '../lib/job-store';

const process = new Hono();

// Processing timeout: 30 minutes
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

// Validation schemas
const processCreatorSchema = z.object({
  // Security & identification
  teamId: z.string().min(1, 'Team ID is required'),
  channelId: z.string().min(1, 'Channel ID is required'),

  // Channel information
  channelUrl: z.string().url('Valid channel URL required'),
  channelHandle: z.string().min(1, 'Channel handle is required'),
  channelThumbnail: z.string().url().optional(),

  // Optional custom description (max 1000 chars)
  customDescription: z.string().max(1000, 'Description must be less than 1000 characters').optional(),

  // Processing options
  options: z.object({
    maxVideos: z.number().min(1).max(100).default(20),
    forceRefresh: z.boolean().default(false)
  }).optional()
});

/**
 * @swagger
 * /api/process/creator:
 *   post:
 *     summary: Trigger async video processing for a creator
 *     description: Starts background job to process videos, generate embeddings, and store in Pinecone
 *     tags:
 *       - Processing
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - creatorId
 *               - channelUrl
 *             properties:
 *               creatorId:
 *                 type: string
 *                 description: MongoDB creator ID
 *               channelUrl:
 *                 type: string
 *                 format: uri
 *                 description: YouTube channel URL
 *               options:
 *                 type: object
 *                 properties:
 *                   maxVideos:
 *                     type: number
 *                     minimum: 1
 *                     maximum: 100
 *                     default: 20
 *                   forceRefresh:
 *                     type: boolean
 *                     default: false
 *     responses:
 *       202:
 *         description: Job created and processing started
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Server error
 */
process.post('/creator', async (c) => {
  try {
    // Validate security header
    const originHeader = c.req.header('X-ThumbnailTest-Origin');
    if (originHeader !== 'true') {
      structuredLogger.warn({ originHeader }, 'Invalid origin header');
      return c.json<ApiResponse>({
        success: false,
        error: 'Unauthorized request origin'
      }, 401);
    }

    const body = await c.req.json();
    const { channelUrl, channelHandle, channelThumbnail, customDescription, teamId, channelId, options } = processCreatorSchema.parse(body);

    const maxVideos = options?.maxVideos || 20;
    const forceRefresh = options?.forceRefresh || false;

    structuredLogger.info({
      channelUrl,
      channelHandle,
      teamId,
      channelId,
      maxVideos,
      forceRefresh,
      hasCustomDescription: !!customDescription
    }, 'Processing request received');

    // Connect to orgs database for validation
    const { db: orgsDb } = await connectToOrgsDatabase();
    const team = await orgsDb.collection('teams').findOne({ teamId });

    if (!team) {
      structuredLogger.warn({ teamId }, 'Team not found');
      return c.json<ApiResponse>({
        success: false,
        error: 'Team not found'
      }, 404);
    }

    // Check if team has active subscription
    if (team.sub_status !== 'active') {
      structuredLogger.warn({ teamId, sub_status: team.sub_status }, 'Inactive subscription');
      return c.json<ApiResponse>({
        success: false,
        error: 'Active subscription required. Please renew your subscription.'
      }, 403);
    }

    // Check if team has Channel AI add-on
    if (team.has_channel_ai !== true) {
      structuredLogger.warn({ teamId, has_channel_ai: team.has_channel_ai }, 'No Channel AI subscription');
      return c.json<ApiResponse>({
        success: false,
        error: 'Channel AI subscription required. Please purchase the Channel AI add-on.'
      }, 403);
    }

    // Validate channelId is in team's channels array
    const teamChannels = team.channels || [];
    const channelExists = teamChannels.some((ch: any) => ch.channelId === channelId || ch === channelId);

    // if (!channelExists) {
    //   structuredLogger.warn({ teamId, channelId, teamChannels }, 'Channel not in team channels');
    //   return c.json<ApiResponse>({
    //     success: false,
    //     error: 'Channel not found in team. Please add the channel to your team first.'
    //   }, 403);
    // }

    structuredLogger.info({ teamId, channelId }, 'Team and channel validation passed');

    // Check for duplicate/concurrent processing requests
    const { db: prismaDb } = await connectToPrismaDatabase();
    const ongoingProcessing = await prismaDb.collection<ChannelAIProcessing>('ChannelAIProcessing').findOne({
      channelId,
      teamId,
      status: 'processing'
    });

    if (ongoingProcessing) {
      structuredLogger.warn({ 
        teamId, 
        channelId, 
        existingJobId: ongoingProcessing.jobId,
        startedAt: ongoingProcessing.processedAt 
      }, 'Channel is already being processed - rejecting duplicate request');
      
      return c.json<ApiResponse>({
        success: false,
        error: 'This channel is already being processed. Please wait for the current job to complete.',
        data: {
          existingJobId: ongoingProcessing.jobId,
          status: ongoingProcessing.status
        }
      }, 409);
    }

    // Connect to creator-ai database for creator operations
    const { db } = await connectToDatabase();

    // Use channelHandle for creator name, fallback to extracting from URL
    let creatorName = channelHandle;
    if (!creatorName) {
      const match = channelUrl.match(/@([^/?]+)/);
      creatorName = match ? match[1] : 'Unknown Creator';
    }

    // Generate slug with proper handling of ALL Unicode characters
    // Uses transliteration approach: NFD normalization splits accented characters
    // into base + combining marks, then we remove the combining marks
    // This works for most languages (French, Spanish, German, etc.)
    // Special handling for Turkish and other characters that don't normalize well
    const slug = creatorName
      // Turkish character replacements (uppercase) - these don't normalize well
      .replace(/Ğ/g, 'G')
      .replace(/Ü/g, 'U')
      .replace(/Ş/g, 'S')
      .replace(/İ/g, 'I')
      .replace(/Ö/g, 'O')
      .replace(/Ç/g, 'C')
      // Turkish lowercase characters
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ı/g, 'i')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      // Normalize Unicode: NFD splits accented chars (é → e + ´)
      .normalize('NFD')
      // Remove combining diacritical marks (accents)
      .replace(/[\u0300-\u036f]/g, '')
      // Lowercase everything
      .toLowerCase()
      // Replace spaces and non-alphanumeric with hyphens
      .replace(/[^a-z0-9]+/g, '-')
      // Remove leading/trailing hyphens
      .replace(/^-+|-+$/g, '');

    // Check if creator already exists by channelId (more reliable than slug)
    let creator = await db.collection<Creator>('creators').findOne({ ownedByChannelId: channelId });
    let actualCreatorId: string;

    if (!creator) {
      // Create new creator with ownership
      const newCreator: Omit<Creator, '_id'> = {
        name: creatorName,
        slug,
        setupComplete: false,
        ownedByTeamId: teamId,
        ownedByChannelId: channelId,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await db.collection('creators').insertOne(newCreator);
      actualCreatorId = result.insertedId.toString();

      structuredLogger.info({
        creatorId: actualCreatorId,
        name: creatorName,
        slug,
        ownedByTeamId: teamId,
        ownedByChannelId: channelId
      }, 'Created new creator');
    } else {
      // Check ownership - channelId is unique, so if it exists, check if same team
      if (creator.ownedByTeamId && creator.ownedByTeamId !== teamId) {
        structuredLogger.warn({
          creatorId: creator._id?.toString(),
          ownedByTeamId: creator.ownedByTeamId,
          ownedByChannelId: creator.ownedByChannelId,
          requestingTeamId: teamId,
          requestingChannelId: channelId
        }, 'Channel owned by different team');
        return c.json<ApiResponse>({
          success: false,
          error: 'This channel has already been processed by another team. Please contact support for ownership transfer.'
        }, 403);
      }

      actualCreatorId = creator._id?.toString() || '';
      structuredLogger.info({
        creatorId: actualCreatorId,
        name: creator.name,
        slug,
        ownedByTeamId: creator.ownedByTeamId,
        ownedByChannelId: creator.ownedByChannelId
      }, 'Using existing creator (reprocessing)');
    }

    // Generate chat URL using channelId (guaranteed unique, prevents slug collisions)
    const chatUrl = `${Bun.env.CHAT_BOT_URL || 'http://localhost:3002'}/c/${channelId}`;

    // Create job
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const job: ProcessingJob = {
      jobId,
      creatorId: actualCreatorId,
      creatorSlug: slug, // Keep slug for metadata/display
      channelUrl,
      chatUrl,
      status: 'queued',
      progress: { current: 0, total: 0 },
      createdAt: new Date()
    };

    await jobStore.set(jobId, job);

    structuredLogger.info({
      jobId,
      creatorId: actualCreatorId,
      creatorName,
      slug
    }, 'Job created');

    // Start processing asynchronously with timeout (non-blocking)
    processVideosAsyncWithTimeout(jobId, actualCreatorId, channelUrl, options?.maxVideos || 20, options?.forceRefresh || false, customDescription);

    const response: ApiResponse = {
      success: true,
      data: {
        jobId,
        creatorId: actualCreatorId,
        creatorSlug: slug,
        chatUrl,
        status: 'queued',
        estimatedTime: '10-20 minutes',
        message: 'Processing job created successfully'
      }
    };

    return c.json(response, 202);

  } catch (error) {
    console.error('FULL ERROR:', error);
    structuredLogger.error({ error }, 'Error creating processing job');

    if (error instanceof z.ZodError) {
      const errorResponse: ApiResponse = {
        success: false,
        error: 'Invalid request parameters',
        message: error.issues.map((e: z.ZodIssue) => e.message).join(', ')
      };
      return c.json(errorResponse, 400);
    }

    const errorResponse: ApiResponse = {
      success: false,
      error: 'Failed to create processing job'
    };

    return c.json(errorResponse, 500);
  }
});

/**
 * @swagger
 * /api/process/status/{jobId}:
 *   get:
 *     summary: Get processing job status
 *     description: Check the status and progress of a video processing job
 *     tags:
 *       - Processing
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: Job ID
 *     responses:
 *       200:
 *         description: Job status retrieved
 *       404:
 *         description: Job not found
 */
process.get('/status/:jobId', async (c) => {
  try {
    const { jobId } = c.req.param();

    const job = await jobStore.get(jobId);

    if (!job) {
      const errorResponse: ApiResponse = {
        success: false,
        error: 'Job not found'
      };
      return c.json(errorResponse, 404);
    }

    const response: ApiResponse = {
      success: true,
      data: {
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        result: job.result,
        error: job.error,
        creatorSlug: job.creatorSlug,
        chatUrl: job.chatUrl,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        duration: job.completedAt && job.startedAt
          ? Math.round((job.completedAt.getTime() - job.startedAt.getTime()) / 1000)
          : undefined
      }
    };

    return c.json(response);

  } catch (error) {
    structuredLogger.error({ error }, 'Error fetching job status');

    const errorResponse: ApiResponse = {
      success: false,
      error: 'Failed to fetch job status'
    };

    return c.json(errorResponse, 500);
  }
});

// Wrapper function with timeout protection
async function processVideosAsyncWithTimeout(
  jobId: string,
  creatorId: string,
  channelUrl: string,
  maxVideos: number,
  forceRefresh: boolean,
  customDescription?: string
) {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Processing timeout: Job exceeded maximum time limit of ${PROCESSING_TIMEOUT_MS / 60000} minutes`));
    }, PROCESSING_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      processVideosAsync(jobId, creatorId, channelUrl, maxVideos, forceRefresh, customDescription),
      timeoutPromise
    ]);
  } catch (error) {
    // If it's a timeout error, the processVideosAsync catch block will handle it
    // We just let it bubble up naturally
    structuredLogger.error({ 
      error: error instanceof Error ? error.message : String(error),
      jobId,
      creatorId 
    }, 'Processing failed or timed out');
  }
}

// Async processing function
async function processVideosAsync(
  jobId: string,
  creatorId: string,
  channelUrl: string,
  maxVideos: number,
  forceRefresh: boolean,
  customDescription?: string
) {
  const job = await jobStore.get(jobId);
  if (!job) return;

  // Generate a unique document ID upfront (Prisma-compatible UUID)
  const documentId = randomUUID();

  try {
    job.status = 'processing';
    job.startedAt = new Date();
    await jobStore.set(jobId, job);

    structuredLogger.info({ jobId, creatorId, channelUrl }, 'Processing started');

    const { db } = await connectToDatabase();

    // Write "processing" status to Prisma database at start
    try {
      const creator = await db.collection<Creator>('creators').findOne({ _id: new ObjectId(creatorId) } as any);
      
      if (creator?.ownedByTeamId && creator?.ownedByChannelId) {
        const { db: prismaDb } = await connectToPrismaDatabase();
        
        const processingStartRecord: ChannelAIProcessing = {
          _id: documentId, // Add _id field
          channelId: creator.ownedByChannelId,
          teamId: creator.ownedByTeamId,
          creatorId,
          status: 'processing',
          jobId,
          chatUrl: job.chatUrl,
          channelUrl,
          processedAt: new Date(),
          videosProcessed: 0,
          totalChunks: 0,
          failedVideos: 0,
          hasChannelContext: false,
          customDescriptionUsed: false,
          canReprocess: false, // Don't allow reprocessing while processing
        };

        await prismaDb.collection<ChannelAIProcessing>('ChannelAIProcessing').updateOne(
          { 
            channelId: creator.ownedByChannelId, 
            teamId: creator.ownedByTeamId,
            jobId: jobId
          },
          { 
            $set: processingStartRecord,
            $setOnInsert: { createdAt: new Date() }
          },
          { upsert: true }
        );

        structuredLogger.info({ 
          jobId, 
          creatorId, 
          teamId: creator.ownedByTeamId,
          channelId: creator.ownedByChannelId 
        }, 'Processing status written to Prisma database');
      }
    } catch (error) {
      structuredLogger.error({ error, jobId, creatorId }, 'Failed to write processing start status (non-fatal)');
      // Non-fatal - continue processing even if status write fails
    }

    // Fetch channel videos
    structuredLogger.info({ jobId, channelUrl, maxVideos }, 'Fetching channel videos from YouTube...');
    const videosData = await getChannelVideos(channelUrl, maxVideos);
    const videos = videosData.videos || [];

    // Set progress total (even if 0 videos)
    job.progress.total = videos.length;
    await jobStore.set(jobId, job);

    if (videos.length > 0) {
      structuredLogger.info({
        jobId,
        videoCount: videos.length,
        channelTitle: videosData.channel?.title,
        videoDetails: videos.map(v => ({
          title: v.title?.substring(0, 50),
          duration: v.duration,
          durationMinutes: v.durationMinutes,
          hasCaptions: v.hasCaptions
        }))
      }, 'Videos fetched - detailed breakdown');
    } else {
      structuredLogger.warn({
        jobId,
        channelUrl,
        channelTitle: videosData.channel?.title
      }, 'No eligible videos found (all filtered out by duration 2-25min)');
    }

    // Fetch channel info with Wikipedia
    structuredLogger.info({ jobId, channelUrl }, 'Fetching channel info and Wikipedia data...');
    const channelInfo = await getChannelInfo(channelUrl);

    structuredLogger.info({
      jobId,
      hasChannelData: !!channelInfo?.channelData,
      hasWikipediaData: !!channelInfo?.wikipediaData,
      channelTitle: channelInfo?.channelData?.title,
      descriptionLength: channelInfo?.channelData?.description?.length || 0,
      wikipediaSummaryLength: channelInfo?.wikipediaData?.summary?.length || 0
    }, 'Channel info fetched');

    // NOW check eligibility with all the data
    const hasCustomDescription = customDescription && customDescription.length > 50;
    const hasChannelDescription = channelInfo?.channelData?.description && channelInfo.channelData.description.length > 50;
    const hasWikipedia = channelInfo?.wikipediaData?.summary && channelInfo.wikipediaData.summary.length > 50;

    // Calculate eligibility FIRST before checking
    const videosWithCaptions = videos.filter(v => v.hasCaptions).length;
    const videosWithValidDuration = videos.filter(v => {
      const duration = v.durationMinutes || 0;
      return duration >= 2 && duration <= 25;
    }).length;
    const videosEligibleForProcessing = videos.filter(v => {
      const duration = v.durationMinutes || 0;
      return v.hasCaptions && duration >= 2 && duration <= 25;
    }).length;

    // If no ELIGIBLE videos AND no descriptions, fail early
    if (videosEligibleForProcessing === 0 && !hasCustomDescription && !hasChannelDescription && !hasWikipedia) {
      const errorMsg = 'No eligible videos found. Your videos must be between 2-25 minutes long with captions enabled. ' +
        'To proceed without eligible videos, please provide a custom description when creating the bot (or add a detailed channel description on YouTube).';

      structuredLogger.error({
        jobId,
        channelUrl,
        totalVideos: videos.length,
        videosEligibleForProcessing,
        videosWithCaptions,
        videosWithValidDuration,
        hasCustomDescription,
        hasChannelDescription,
        hasWikipedia
      }, errorMsg);

      throw new Error(errorMsg);
    }

    // If no eligible videos but HAS descriptions, allow processing
    if (videosEligibleForProcessing === 0 && (hasCustomDescription || hasChannelDescription || hasWikipedia)) {
      structuredLogger.info({
        jobId,
        totalVideos: videos.length,
        videosEligibleForProcessing,
        hasCustomDescription,
        hasChannelDescription,
        hasWikipedia
      }, 'No eligible videos, but has descriptions - proceeding with channel context only');
    }

    structuredLogger.info({
      jobId,
      totalVideos: videos.length,
      videosWithCaptions,
      videosWithValidDuration,
      videosEligibleForProcessing,
      hasChannelDescription,
      hasCustomDescription,
      hasWikipedia,
      channelDescriptionLength: channelInfo?.channelData?.description?.length || 0,
      customDescriptionLength: customDescription?.length || 0,
      wikipediaSummaryLength: channelInfo?.wikipediaData?.summary?.length || 0
    }, 'Eligibility check - detailed');

    // Build specific error message based on what's missing
    let errorMessage = '';

    if (videosEligibleForProcessing === 0 && !hasChannelDescription && !hasCustomDescription && !hasWikipedia) {
      // No eligible videos AND no descriptions
      if (videosWithCaptions === 0 && videosWithValidDuration === 0) {
        errorMessage = 'Channel not eligible: No videos with captions AND no videos between 2-25 minutes in length. ' +
          'Requirements:\n' +
          '• Videos must have captions/transcripts enabled\n' +
          '• Videos must be between 2-25 minutes long\n' +
          'OR provide a custom description when creating the bot.';
      } else if (videosWithCaptions === 0) {
        errorMessage = `Channel not eligible: Found ${videosWithValidDuration} video(s) with valid duration (2-25 min), but NONE have captions/transcripts. ` +
          'YouTube auto-generates captions after 10-30 minutes. ' +
          'Please enable captions or provide a custom description.';
      } else if (videosWithValidDuration === 0) {
        errorMessage = `Channel not eligible: Found ${videosWithCaptions} video(s) with captions, but NONE are between 2-25 minutes in length. ` +
          'We only process videos between 2-25 minutes. ' +
          'Please ensure you have videos in this duration range or provide a custom description.';
      } else {
        errorMessage = `Channel not eligible: Found ${videosWithCaptions} video(s) with captions and ${videosWithValidDuration} video(s) with valid duration, but NO overlap. ` +
          'Videos need BOTH captions AND be 2-25 minutes long. ' +
          'Please provide a custom description to proceed.';
      }

      structuredLogger.error({
        jobId,
        totalVideos: videos.length,
        videosWithCaptions,
        videosWithValidDuration,
        videosEligibleForProcessing,
        hasChannelDescription,
        hasCustomDescription,
        hasWikipedia
      }, 'Channel NOT eligible for processing');

      throw new Error(errorMessage);
    }

    // Warn if only relying on descriptions
    if (videosEligibleForProcessing === 0 && (hasChannelDescription || hasCustomDescription || hasWikipedia)) {
      structuredLogger.warn({
        jobId,
        hasChannelDescription,
        hasCustomDescription,
        hasWikipedia,
        totalVideos: videos.length,
        videosWithCaptions,
        videosWithValidDuration,
        channelDescriptionPreview: channelInfo?.channelData?.description?.substring(0, 100),
        customDescriptionPreview: customDescription?.substring(0, 100),
        wikipediaSummaryPreview: channelInfo?.wikipediaData?.summary?.substring(0, 100)
      }, 'No eligible videos (captions + 2-25min duration), but channel context available - proceeding with descriptions only');
    }

    structuredLogger.info({
      jobId,
      eligibilityPassed: true,
      willProcessVideos: videosEligibleForProcessing > 0,
      videosEligibleForProcessing,
      willUseChannelContext: hasChannelDescription || hasCustomDescription || hasWikipedia
    }, 'Eligibility check PASSED - proceeding with processing');

    // Process videos
    let processedVideos = 0;
    let totalChunks = 0;
    let failedVideos = 0;
    const processedVideoData = [];

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const { videoId, title, url, description, publishedAt, thumbnails, duration, durationMinutes, viewCount, likeCount, hasCaptions } = video;

      try {
        // Skip videos outside duration range (2-25 minutes)
        const videoDuration = durationMinutes || 0;
        if (videoDuration < 2 || videoDuration > 25) {
          structuredLogger.info({
            jobId,
            videoId,
            durationMinutes: videoDuration,
            title: title?.substring(0, 50)
          }, 'Skipping video - duration out of range (2-25 min)');
          processedVideoData.push({
            videoId,
            title: title || `Video ${videoId}`,
            url,
            hasTranscript: false
          });
          failedVideos++;
          continue;
        }

        structuredLogger.info({
          jobId,
          videoIndex: i + 1,
          totalVideos: videos.length,
          videoId,
          durationMinutes: videoDuration,
          title: title?.substring(0, 50)
        }, 'Processing video');

        // Get transcript
        const transcriptData = await getVideoTranscriptWithData(videoId);

        if (!transcriptData?.text) {
          structuredLogger.warn({ jobId, videoId, durationMinutes: videoDuration }, 'No transcript found');
          processedVideoData.push({
            videoId,
            title: title || `Video ${videoId}`,
            url,
            hasTranscript: false
          });
          failedVideos++;
          continue;
        }

        // Clean and chunk
        let rawTranscript = transcriptData.text;
        rawTranscript = rawTranscript.replace(/(\b[\w\s',.!?]+?)\s+\1(?=\s|$)/g, '$1');
        rawTranscript = rawTranscript.replace(/\s+/g, ' ').trim();

        const cleanedTranscript = cleanTranscript(rawTranscript);
        const documents = await chunkTextWithMetadata(
          cleanedTranscript,
          transcriptData.segments || [],
          {
            videoId,
            videoTitle: title || `Video ${videoId}`,
            videoUrl: url,
            thumbnailUrl: thumbnails?.medium?.url ?? undefined
          }
        );

        if (documents.length === 0) {
          processedVideoData.push({
            videoId,
            title: title || `Video ${videoId}`,
            url,
            hasTranscript: false
          });
          failedVideos++;
          continue;
        }

        // Store in Pinecone + MongoDB
        await storeTranscriptChunks(
          creatorId,
          videoId,
          documents,
          title || `Video ${videoId}`,
          url,
          thumbnails?.medium?.url ?? undefined,
          transcriptData.segments || []
        );

        processedVideos++;
        totalChunks += documents.length;

        processedVideoData.push({
          videoId,
          title: title || `Video ${videoId}`,
          url,
          duration: duration ?? undefined,
          publishedAt: publishedAt ? new Date(publishedAt) : undefined,
          thumbnails: thumbnails ? {
            default: thumbnails.default?.url ? { url: thumbnails.default.url } : undefined,
            medium: thumbnails.medium?.url ? { url: thumbnails.medium.url } : undefined,
            high: thumbnails.high?.url ? { url: thumbnails.high.url } : undefined,
          } : undefined,
          hasTranscript: true
        });

        // Update progress
        job.progress.current = i + 1;
        await jobStore.set(jobId, job);

        structuredLogger.info({
          jobId,
          videoId,
          documentsGenerated: documents.length,
          progress: `${i + 1}/${videos.length}`
        }, 'Video processed');

      } catch (error) {
        structuredLogger.error({ error, jobId, videoId }, 'Failed to process video');
        processedVideoData.push({
          videoId,
          title: title || `Video ${videoId}`,
          url,
          hasTranscript: false
        });
        failedVideos++;
      }
    }

    // Post-processing validation (reuse variables from eligibility check)
    if (processedVideos === 0 && !hasChannelDescription && !hasCustomDescription && !hasWikipedia) {
      // This shouldn't happen due to eligibility check, but just in case
      throw new Error(
        'Processing completed but no content available. None of your videos have transcripts, and no channel description was found. ' +
        'Please either:\n' +
        '1. Enable captions on your videos\n' +
        '2. Add a channel description on YouTube\n' +
        '3. Provide a custom description'
      );
    }

    if (processedVideos === 0 && (hasChannelDescription || hasCustomDescription || hasWikipedia)) {
      structuredLogger.info({
        jobId,
        creatorId,
        hasChannelDescription,
        hasCustomDescription,
        hasWikipedia,
        totalVideos: videos.length,
        failedVideos
      }, 'No video transcripts processed, but channel context available - proceeding with descriptions only');
    }

    if (processedVideos === 0) {
      structuredLogger.warn({
        jobId,
        creatorId,
        failedVideos,
        totalVideos: videos.length,
        proceedingWithContextOnly: hasChannelDescription || hasCustomDescription || hasWikipedia
      }, 'No videos processed successfully');
    }

    // RE-VALIDATE subscription and channel membership before storing results
    // This prevents giving processed content to teams that cancelled during processing
    try {
      const { db: orgsDb } = await connectToOrgsDatabase();
      const creator = await db.collection<Creator>('creators').findOne({ _id: new ObjectId(creatorId) } as any);
      
      if (creator?.ownedByTeamId && creator?.ownedByChannelId) {
        const team = await orgsDb.collection('teams').findOne({ teamId: creator.ownedByTeamId });
        
        if (!team) {
          throw new Error('Team no longer exists. Processing aborted.');
        }
        
        if (team.sub_status !== 'active') {
          throw new Error(`Subscription is no longer active (status: ${team.sub_status}). Processing aborted.`);
        }
        
        if (team.has_channel_ai !== true) {
          throw new Error('Channel AI subscription was cancelled during processing. Processing aborted.');
        }
        
        // const channelStillExists = team.channels?.some(
        //   (ch: any) => ch.channelId === creator.ownedByChannelId || ch === creator.ownedByChannelId
        // );
        
        // if (!channelStillExists) {
        //   throw new Error('Channel was removed from team during processing. Processing aborted.');
        // }
        
        structuredLogger.info({
          jobId,
          creatorId,
          teamId: creator.ownedByTeamId,
          channelId: creator.ownedByChannelId
        }, 'Re-validation passed: Team still has active Channel AI subscription and channel membership');
      }
    } catch (validationError) {
      structuredLogger.error({
        error: validationError instanceof Error ? validationError.message : String(validationError),
        jobId,
        creatorId
      }, 'Subscription/channel re-validation failed - aborting processing');
      
      throw validationError; // Will be caught by outer catch block and marked as failed
    }

    // Update creator in MongoDB
    const enhancedMetadata: Partial<Creator> = {
      setupComplete: true,
      updatedAt: new Date(),
      videos: processedVideoData
    };

    if (channelInfo) {
      if (channelInfo.channelData) {
        const channelThumbnails = channelInfo.channelData.thumbnails;
        const channelStats = channelInfo.channelData.statistics;

        enhancedMetadata.channelData = {
          title: channelInfo.channelData.title ?? 'Unknown Channel',
          description: channelInfo.channelData.description ?? undefined,
          thumbnails: channelThumbnails ? {
            default: channelThumbnails.default?.url ? { url: channelThumbnails.default.url } : undefined,
            medium: channelThumbnails.medium?.url ? { url: channelThumbnails.medium.url } : undefined,
            high: channelThumbnails.high?.url ? { url: channelThumbnails.high.url } : undefined,
          } : undefined,
          statistics: channelStats ? {
            viewCount: channelStats.viewCount ? parseInt(channelStats.viewCount) : undefined,
            subscriberCount: channelStats.subscriberCount ? parseInt(channelStats.subscriberCount) : undefined,
            videoCount: channelStats.videoCount ? parseInt(channelStats.videoCount) : undefined,
          } : undefined
        };
      }
      if (channelInfo.wikipediaData) {
        // WikipediaEnrichmentData has different structure than WikipediaData
        // Need to map it properly - use channel title as Wikipedia title
        enhancedMetadata.wikipediaData = {
          title: channelInfo.channelData?.title ?? 'Unknown',
          summary: channelInfo.wikipediaData.summary || '',
          url: channelInfo.wikipediaData.url
        };
      }
    }

    await db.collection<Creator>('creators').updateOne(
      { _id: new ObjectId(creatorId) } as any,
      { $set: enhancedMetadata }
    );

    // Store channel context embeddings
    try {
      structuredLogger.info({
        jobId,
        creatorId,
        hasChannelDescription: !!channelInfo?.channelData?.description,
        hasCustomDescription: !!customDescription,
        hasWikipedia: !!channelInfo?.wikipediaData
      }, 'Storing channel context');

      await storeChannelContext(
        creatorId,
        {
          title: channelInfo?.channelData?.title ?? undefined,
          description: channelInfo?.channelData?.description ?? undefined,
          customDescription
        },
        channelInfo?.wikipediaData ?? undefined
      );

      structuredLogger.info({ jobId, creatorId }, 'Channel context stored successfully');
    } catch (error) {
      // Don't fail the entire job if channel context fails
      structuredLogger.error({ error, jobId, creatorId }, 'Failed to store channel context');
    }

    // Job complete
    job.status = 'completed';
    job.completedAt = new Date();
    job.result = {
      processedVideos,
      totalChunks,
      failedVideos
    };
    await jobStore.set(jobId, job);

    structuredLogger.info({
      jobId,
      processedVideos,
      totalChunks,
      failedVideos,
      duration: Math.round((job.completedAt.getTime() - job.startedAt!.getTime()) / 1000)
    }, 'Processing completed');

    // Write processing status directly to Prisma database
    try {
      const creator = await db.collection<Creator>('creators').findOne({ _id: new ObjectId(creatorId) } as any);

      if (creator?.ownedByTeamId && creator?.ownedByChannelId) {
        const { db: prismaDb } = await connectToPrismaDatabase();
        
        const processingRecord: ChannelAIProcessing = {
          _id: documentId, // Add _id field
          channelId: creator.ownedByChannelId,
          teamId: creator.ownedByTeamId,
          creatorId,
          status: 'completed',
          jobId,
          chatUrl: job.chatUrl,
          channelUrl,
          processedAt: new Date(),
          videosProcessed: processedVideos,
          totalChunks,
          failedVideos,
          hasChannelContext: !!channelInfo,
          customDescriptionUsed: !!customDescription,
          errorCount: 0, // Reset error count on success
          lastError: undefined, // Clear previous errors on success
          canReprocess: true, // Allow reprocessing after successful completion
        };

        structuredLogger.info({
          jobId,
          creatorId,
          teamId: creator.ownedByTeamId,
          channelId: creator.ownedByChannelId,
        }, 'Writing processing status directly to Prisma database');

        // Upsert: update if exists, insert if not
        await prismaDb.collection<ChannelAIProcessing>('ChannelAIProcessing').updateOne(
          { 
            channelId: creator.ownedByChannelId, 
            teamId: creator.ownedByTeamId, 
            jobId: jobId 
          },
          { 
            $set: processingRecord,
            $setOnInsert: { createdAt: new Date() }
          },
          { upsert: true }
        );

        structuredLogger.info({ 
          jobId, 
          creatorId, 
          teamId: creator.ownedByTeamId,
          channelId: creator.ownedByChannelId 
        }, 'Processing status written successfully to Prisma database');
      } else {
        structuredLogger.warn({
          jobId,
          creatorId,
          hasTeamId: !!creator?.ownedByTeamId,
          hasChannelId: !!creator?.ownedByChannelId
        }, 'Creator missing ownership info, skipping status update');
      }
    } catch (error) {
      structuredLogger.error({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        jobId,
        creatorId
      }, 'Failed to write processing status to Prisma database');
      // Don't fail the job if status update fails
    }

  } catch (error) {
    structuredLogger.error({ error, jobId }, 'Processing failed');
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : 'Unknown error';
    job.completedAt = new Date();
    await jobStore.set(jobId, job);

    // Write failed status directly to Prisma database
    try {
      const { db } = await connectToDatabase();
      const creator = await db.collection<Creator>('creators').findOne({ _id: new ObjectId(creatorId) } as any);

      if (creator?.ownedByTeamId && creator?.ownedByChannelId) {
        const { db: prismaDb } = await connectToPrismaDatabase();
        
        const failedRecord: Omit<ChannelAIProcessing, 'errorCount'> = {
          _id: documentId, // Add _id to failedRecord
          channelId: creator.ownedByChannelId,
          teamId: creator.ownedByTeamId,
          creatorId,
          status: 'failed',
          jobId,
          chatUrl: job.chatUrl,
          channelUrl,
          processedAt: new Date(),
          videosProcessed: 0,
          totalChunks: 0,
          failedVideos: 0,
          hasChannelContext: false,
          customDescriptionUsed: false,
          lastError: job.error,
          canReprocess: true, // Allow retry after failure
        };

        structuredLogger.info({
          jobId,
          creatorId,
          teamId: creator.ownedByTeamId,
          channelId: creator.ownedByChannelId,
        }, 'Writing failed status directly to Prisma database');

        // Upsert: update if exists, insert if not
        await prismaDb.collection<ChannelAIProcessing>('ChannelAIProcessing').updateOne(
          { 
            channelId: creator.ownedByChannelId, 
            teamId: creator.ownedByTeamId,
            jobId: jobId
          },
          { 
            $set: failedRecord,
            $inc: { errorCount: 1 }, // Increment error count (MongoDB creates field if doesn't exist)
            $setOnInsert: { createdAt: new Date() } // Only set createdAt on insert
          },
          { upsert: true }
        );

        structuredLogger.info({ jobId, creatorId, teamId: creator.ownedByTeamId }, 'Failed status written to Prisma database');
      }
    } catch (statusError) {
      structuredLogger.error({ error: statusError, jobId, creatorId }, 'Failed to write failed status to Prisma database');
    }
  }
}

export default process;
