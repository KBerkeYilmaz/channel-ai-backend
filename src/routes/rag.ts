import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiResponse, Creator } from '../types';
import { structuredLogger } from '../middleware/logger';
import { connectToDatabase } from '../lib/mongodb';
import { searchSimilarChunksWithReferences } from '../lib/video-references';

const rag = new Hono();

// Validation schemas
const ragSearchSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  creatorSlug: z.string().min(1, 'Creator slug is required'),
  limit: z.number().min(1).max(20).default(5),
  conversationHistory: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string()
  })).optional().default([])
});

/**
 * @swagger
 * /api/rag/search:
 *   post:
 *     summary: Search for relevant video content using RAG
 *     description: Performs semantic search across creator's video transcripts and returns relevant context
 *     tags:
 *       - RAG
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *               - creatorSlug
 *             properties:
 *               query:
 *                 type: string
 *                 description: User's search query
 *               creatorSlug:
 *                 type: string
 *                 description: Creator's slug identifier
 *               limit:
 *                 type: number
 *                 minimum: 1
 *                 maximum: 20
 *                 default: 5
 *                 description: Number of results to return
 *               conversationHistory:
 *                 type: array
 *                 description: Previous conversation messages for context-aware search
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *     responses:
 *       200:
 *         description: Relevant context chunks found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     formattedContext:
 *                       type: string
 *                       description: Ready-to-inject context string
 *                     chunks:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           text:
 *                             type: string
 *                           videoTitle:
 *                             type: string
 *                           videoUrl:
 *                             type: string
 *                           timestamp:
 *                             type: string
 *                           score:
 *                             type: number
 *                     staticContext:
 *                       type: string
 *                       description: Channel info and creator background
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Creator not found
 *       500:
 *         description: Internal server error
 */
rag.post('/search', async (c) => {
  try {
    const body = await c.req.json();
    const { query, creatorSlug, limit, conversationHistory } = ragSearchSchema.parse(body);

    structuredLogger.info('RAG search request received', {
      creatorSlug,
      query: query.substring(0, 100),
      limit,
      hasConversationHistory: conversationHistory.length > 0
    });

    // Get creator from database
    const { db } = await connectToDatabase();
    const creator = await db.collection<Creator>('creators').findOne({ slug: creatorSlug });

    if (!creator) {
      structuredLogger.warn('Creator not found for RAG search', { slug: creatorSlug });
      const errorResponse: ApiResponse = {
        success: false,
        error: 'Creator not found'
      };
      return c.json(errorResponse, 404);
    }

    if (!creator.setupComplete || !creator._id) {
      structuredLogger.warn('Creator setup incomplete', {
        slug: creatorSlug,
        setupComplete: creator.setupComplete
      });
      const errorResponse: ApiResponse = {
        success: false,
        error: 'Creator setup is not complete'
      };
      return c.json(errorResponse, 400);
    }

    const creatorId = creator._id.toString();

    // Prepare creator metadata for RAG
    const creatorMetadata = {
      name: creator.name,
      topics: [],
      categories: [],
      recentVideos: []
    };

    structuredLogger.info('Performing semantic search', {
      creatorId,
      query: query.substring(0, 50),
      limit,
      videosWithTranscripts: creator.videos?.filter(v => v.hasTranscript).length || 0
    });

    // Perform RAG search
    const searchResults = await searchSimilarChunksWithReferences(
      creatorId,
      query,
      limit,
      creatorMetadata,
      conversationHistory
    );

    structuredLogger.info('RAG search completed', {
      resultsCount: searchResults.length,
      topScore: searchResults[0]?.score,
      hasVideoReferences: searchResults.some(r => r.videoTitle)
    });

    // Build static context (channel info, Wikipedia, video list)
    let staticContext = '';

    if (creator.channelData) {
      staticContext += `=== CHANNEL INFORMATION ===\n`;
      staticContext += `Channel: ${creator.channelData.title}\n`;
      if (creator.channelData.statistics) {
        staticContext += `Subscribers: ${creator.channelData.statistics.subscriberCount?.toLocaleString() || 'N/A'}\n`;
        staticContext += `Total Views: ${creator.channelData.statistics.viewCount?.toLocaleString() || 'N/A'}\n`;
        staticContext += `Videos: ${creator.channelData.statistics.videoCount?.toLocaleString() || 'N/A'}\n`;
      }
      if (creator.channelData.description) {
        staticContext += `Description: ${creator.channelData.description.substring(0, 300)}...\n`;
      }
    }

    if (creator.wikipediaData) {
      staticContext += `\n=== BACKGROUND INFORMATION ===\n`;
      staticContext += `${creator.wikipediaData.summary}\n`;
    }

    // Add video list
    if (creator.videos && creator.videos.length > 0) {
      staticContext += `\n=== AVAILABLE VIDEO CONTENT ===\n`;
      staticContext += `You have access to transcripts from ${creator.videos.length} videos:\n`;
      creator.videos.forEach((video, index) => {
        if (video.hasTranscript) {
          staticContext += `${index + 1}. "${video.title}" (${video.url})\n`;
        }
      });
    }

    // Build formatted context string (dynamic RAG chunks)
    let formattedContext = '';

    if (searchResults.length > 0) {
      formattedContext += `=== RELEVANT CONTENT FROM VIDEOS ===\n`;
      formattedContext += `Based on the user's question, here are the most relevant excerpts from your videos:\n\n`;

      searchResults.forEach((result, index) => {
        formattedContext += `**Excerpt ${index + 1}** (Similarity: ${(result.score * 100).toFixed(1)}%)\n`;
        if (result.videoTitle) {
          formattedContext += `From: "${result.videoTitle}"\n`;
        }
        if (result.videoUrl) {
          formattedContext += `Video: ${result.videoUrl}\n`;
        }
        if (result.timestamp && result.timestamp !== "0:00") {
          formattedContext += `Timestamp: ${result.timestamp}\n`;
        }
        formattedContext += `Content: ${result.text}\n\n`;
      });

      formattedContext += `Use this content to answer the user's question. Reference specific videos and timestamps when relevant.\n`;
    }

    // Prepare chunks for structured response
    const chunks = searchResults.map(result => ({
      text: result.text,
      videoTitle: result.videoTitle,
      videoUrl: result.videoUrl,
      videoId: result.videoId,
      timestamp: result.timestamp,
      score: result.score,
      chunkIndex: result.chunkIndex,
      metadata: result.metadata
    }));

    const response: ApiResponse = {
      success: true,
      data: {
        formattedContext,
        staticContext,
        chunks,
        creator: {
          name: creator.name,
          slug: creator.slug,
          channelTitle: creator.channelData?.title
        }
      }
    };

    structuredLogger.info('RAG search response prepared', {
      creatorSlug,
      chunksCount: chunks.length,
      formattedContextLength: formattedContext.length,
      staticContextLength: staticContext.length
    });

    return c.json(response);

  } catch (error) {
    structuredLogger.error('Error in RAG search endpoint', error);

    if (error instanceof z.ZodError) {
      const errorResponse: ApiResponse = {
        success: false,
        error: 'Invalid request parameters',
        message: error.errors.map(e => e.message).join(', ')
      };
      return c.json(errorResponse, 400);
    }

    const errorResponse: ApiResponse = {
      success: false,
      error: 'Failed to perform RAG search'
    };

    return c.json(errorResponse, 500);
  }
});

export default rag;
