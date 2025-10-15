import { Innertube } from 'youtubei.js';
import { google } from 'googleapis';
import { createLogger } from './logger';
import { matchChunkToTimestamp, type TimestampSegment } from './timestamp-matching';
import { withRetry, RETRY_CONFIGS } from './retry';
import { withTimeout, TIMEOUT_CONFIGS } from './timeout';
import { trackYouTubeUsage } from './monitoring';
import { env } from '../config/env';
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { Document } from "@langchain/core/documents";
import { analyzeSentiment, type ChunkSentimentData } from './sentiment-analysis';

const logger = createLogger('YouTube');

// Initialize YouTube Data API v3 client
const youtube = google.youtube({
  version: 'v3',
  auth: env.YOUTUBE_API_KEY as string,
});

// Type definitions for YouTube transcript data structures
interface TranscriptSegment {
  text?: string;
  snippet?: {
    text?: string;
  };
}

// Enhanced transcript with timestamp data
export interface TranscriptWithTimestamps {
  text: string; // Full transcript text with embedded timestamps
  segments: Array<{
    text: string; // Text with timestamp prefix (e.g., "2:34 Some text")
    timestampDisplay: string; // Display format (e.g., "2:34")
    timestampSeconds: number; // Seconds from start (e.g., 154)
    endSeconds: number; // End time in seconds
  }>;
}

interface TranscriptRun {
  text?: string;
}

interface TranscriptSegmentRenderer {
  snippet?: {
    runs?: TranscriptRun[];
  };
}

interface TranscriptItem {
  text?: string;
  snippet?: {
    text?: string;
  };
  transcript_segment_renderer?: TranscriptSegmentRenderer;
}

interface TranscriptContent {
  body?: {
    contents?: TranscriptItem[];
  };
}

interface TranscriptData {
  segments?: TranscriptSegment[];
  content?: TranscriptContent;
}

export function extractVideoId(url: string): string | null {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/;
  const match = regex.exec(url);
  return match ? match[1] ?? null : null;
}

// NEW: Get transcript with timestamps using YouTube Data API v3 (official API)
export async function getVideoTranscriptWithTimestamps(videoId: string): Promise<TranscriptWithTimestamps | null> {
  const videoLogger = logger.child({ videoId });

  return withRetry(async () => {
    return withTimeout((async () => {
      videoLogger.info('Starting official YouTube API transcript extraction', {
        url: `https://www.youtube.com/watch?v=${videoId}`
      });

      try {
        // Step 1: Get caption list for the video
        videoLogger.debug('Fetching available captions');
        const captionsResponse = await youtube.captions.list({
          part: ['snippet'],
          videoId: videoId,
        });

        if (!captionsResponse.data.items || captionsResponse.data.items.length === 0) {
          videoLogger.warn('No captions available for this video');
          return null;
        }

        // Step 2: Find the best caption track (prefer auto-generated English)
        const captions = captionsResponse.data.items;
        let selectedCaption = captions.find(cap =>
          cap.snippet?.language === 'en' && cap.snippet.trackKind === 'standard'
        ) || captions.find(cap =>
          cap.snippet?.language === 'en' && cap.snippet.trackKind === 'ASR'
        ) || captions[0]; // Fallback to first available

        if (!selectedCaption?.id) {
          videoLogger.warn('No suitable caption track found');
          return null;
        }

        videoLogger.debug('Selected caption track', {
          captionId: selectedCaption.id,
          language: selectedCaption.snippet?.language,
          trackKind: selectedCaption.snippet?.trackKind,
          name: selectedCaption.snippet?.name
        });

        // Step 3: Download the actual transcript
        videoLogger.debug('Downloading transcript content');
        const transcriptResponse = await youtube.captions.download({
          id: selectedCaption.id,
          tfmt: 'srt', // Get SRT format with timestamps
        });

        const transcriptData = transcriptResponse.data as string;

        if (!transcriptData || transcriptData.length === 0) {
          videoLogger.warn('Empty transcript received from API');
          return null;
        }

        // Step 4: Parse SRT format to extract text with timestamps
        const srtLines = transcriptData.split('\n');
        const transcriptSegments: Array<{ text: string; timestampDisplay: string; timestampSeconds: number; endSeconds: number }> = [];
        let currentText = '';
        let currentTimestampDisplay = '';
        let currentTimestampSeconds = 0;
        let currentEndSeconds = 0;

        for (let i = 0; i < srtLines.length; i++) {
          const line = srtLines[i]?.trim() || '';

          // Skip sequence numbers
          if (/^\d+$/.test(line)) {
            continue;
          }

          // Capture timestamp lines (format: 00:00:01,000 --> 00:00:03,000)
          if (line.includes('-->')) {
            const [startTime, endTime] = line.split(' --> ');

            if (!startTime || !endTime) continue;

            // Parse start time
            const startParts = startTime.split(':');
            const startHours = parseInt(startParts[0] || '0');
            const startMinutes = parseInt(startParts[1] || '0');
            const startSeconds = Math.floor(parseFloat(startParts[2]?.replace(',', '.') || '0'));

            // Parse end time
            const endParts = endTime.split(':');
            const endHours = parseInt(endParts[0] || '0');
            const endMinutes = parseInt(endParts[1] || '0');
            const endSeconds = Math.floor(parseFloat(endParts[2]?.replace(',', '.') || '0'));

            // Calculate total seconds for both
            currentTimestampSeconds = startHours * 3600 + startMinutes * 60 + startSeconds;
            currentEndSeconds = endHours * 3600 + endMinutes * 60 + endSeconds;

            // Format as MM:SS for display in transcript text
            currentTimestampDisplay = `${startMinutes}:${startSeconds.toString().padStart(2, '0')}`;
            continue;
          }

          // Capture text content
          if (line.length > 0 && !line.includes('-->')) {
            // Clean HTML tags and format
            const cleanText = line
              .replace(/<[^>]*>/g, '') // Remove HTML tags
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .trim();

            if (cleanText.length > 0) {
              currentText += cleanText + ' ';
            }
          }

          // Empty line indicates end of subtitle block
          if (line === '' && currentText.trim().length > 0) {
            transcriptSegments.push({
              text: `${currentTimestampDisplay} ${currentText.trim()}`,
              timestampDisplay: currentTimestampDisplay,
              timestampSeconds: currentTimestampSeconds,
              endSeconds: currentEndSeconds
            });
            currentText = '';
            currentTimestampDisplay = '';
            currentTimestampSeconds = 0;
            currentEndSeconds = 0;
          }
        }

        // Don't forget the last segment
        if (currentText.trim().length > 0 && currentTimestampDisplay) {
          transcriptSegments.push({
            text: `${currentTimestampDisplay} ${currentText.trim()}`,
            timestampDisplay: currentTimestampDisplay,
            timestampSeconds: currentTimestampSeconds,
            endSeconds: currentEndSeconds
          });
        }

        const finalTranscript = transcriptSegments.map(seg => seg.text).join(' ');

        if (finalTranscript.length === 0) {
          videoLogger.warn('No text extracted from SRT transcript');
          return null;
        }

        videoLogger.info('YouTube API transcript extraction successful', {
          captionTrackUsed: selectedCaption.snippet?.trackKind,
          language: selectedCaption.snippet?.language,
          extractedLength: finalTranscript.length,
          segmentCount: transcriptSegments.length,
          timestampRange: transcriptSegments.length > 0 ? {
            start: transcriptSegments[0]?.timestampSeconds,
            end: transcriptSegments[transcriptSegments.length - 1]?.endSeconds
          } : null,
          preview: finalTranscript.substring(0, 100) + '...'
        });

        // Track successful usage
        await trackYouTubeUsage('transcript-api', {
          videoId,
          success: true,
          source: 'youtube-data-api',
          captionTrack: selectedCaption.snippet?.trackKind,
          extractedLength: finalTranscript.length
        });

        return {
          text: finalTranscript,
          segments: transcriptSegments
        };

      } catch (apiError: any) {
        // Check if it's a quota/permission issue
        if (apiError?.code === 403) {
          videoLogger.warn('YouTube API access restricted - may need additional permissions for captions');
        } else if (apiError?.code === 404) {
          videoLogger.warn('Video not found or captions not accessible via API');
        } else {
          videoLogger.error('YouTube API transcript extraction failed', {
            error: apiError?.message || String(apiError),
            code: apiError?.code
          });
        }

        // Track failed usage
        await trackYouTubeUsage('transcript-api', {
          videoId,
          success: false,
          source: 'youtube-data-api',
          error: apiError?.message || String(apiError),
          errorCode: apiError?.code
        });

        return null;
      }
    })(), TIMEOUT_CONFIGS.youtube, `youtube-api-transcript-${videoId}`)
  }, RETRY_CONFIGS.youtube, `youtube-api-transcript-${videoId}`);
}

export interface YouTubeTranscriptData {
  text: string;
  segments?: Array<{
    text: string;
    timestampDisplay: string;
    timestampSeconds: number;
    endSeconds: number;
  }>;
}

export async function getVideoTranscript(videoId: string): Promise<string | null> {
  const data = await getVideoTranscriptWithData(videoId);
  return data?.text ?? null;
}

export async function getVideoTranscriptWithData(videoId: string): Promise<YouTubeTranscriptData | null> {
  const videoLogger = logger.child({ videoId });

  // OPTIMIZATION: Use only youtubei.js (Innertube) - more reliable and we extract timestamps from text
  videoLogger.info('Using youtubei.js for transcript extraction');

  return withRetry(async () => {
    return withTimeout((async () => {
      videoLogger.info('Starting transcript extraction', {
        url: `https://www.youtube.com/watch?v=${videoId}`
      });

      // Initialize YouTube client
      const yt = await Innertube.create();

      // Focus on transcript extraction with minimal video info dependency
      let videoTitle = `Video ${videoId}`;
      let transcriptData;
      
      try {
        // Try to get full video info first
        const info = await yt.getInfo(videoId);
        videoTitle = info.basic_info.title ?? `Video ${videoId}`;
        transcriptData = await info.getTranscript();
        
        videoLogger.info('Full video info and transcript retrieved successfully', {
          title: videoTitle,
          duration: String(info.basic_info.duration) || 'Unknown'
        });
        
      } catch (fullInfoError) {
        videoLogger.warn('Full video info failed, attempting alternative transcript extraction', {
          error: fullInfoError instanceof Error ? fullInfoError.message : String(fullInfoError),
          videoId
        });
        
        // Alternative approach: Try simpler approach without client specification
        try {
          // Create a fresh YouTube client and try again
          const freshYt = await Innertube.create();
          const simpleResponse = await freshYt.getInfo(videoId);
          transcriptData = await simpleResponse.getTranscript();
          
          videoLogger.info('Fresh client transcript extraction successful', {
            videoId,
            fallbackTitle: videoTitle
          });
          
        } catch (freshClientError) {
          videoLogger.error('All transcript extraction methods failed', {
            originalError: fullInfoError instanceof Error ? fullInfoError.message : String(fullInfoError),
            freshClientError: freshClientError instanceof Error ? freshClientError.message : String(freshClientError)
          });
          
          throw new Error(`Cannot access video transcript using any method. This might be due to: 1) Video has no captions, 2) Video is private/restricted, 3) YouTube API changes affecting the youtubei.js library. Please try a different video or check if captions are enabled. Original error: ${fullInfoError instanceof Error ? fullInfoError.message : String(fullInfoError)}`);
        }
      }

    if (!transcriptData) {
      videoLogger.warn('No transcript content found');
      return null;
    }

    videoLogger.debug('Transcript data structure', {
      type: typeof transcriptData,
      constructor: transcriptData.constructor?.name,
      keys: Object.keys(transcriptData),
      // Check specific properties
      hasActions: 'actions' in transcriptData,
      hasTranscriptSearchPanel: 'transcript_search_panel' in transcriptData
    });

    // Try different extraction approaches with deduplication
    let text = '';
    const extractedTexts: string[] = [];

    // Approach 1: Check if it has a segments property directly
    const typedData = transcriptData as TranscriptData | TranscriptSegment[];
    if ('segments' in typedData && typedData.segments) {
      const segments = typedData.segments;
      videoLogger.debug('Using segments extraction approach', { segmentCount: segments.length });

      const segmentTexts = segments
        .map((segment: TranscriptSegment) => segment.text ?? segment.snippet?.text ?? '')
        .filter((t: string) => t.length > 0);

      extractedTexts.push(...segmentTexts);
      text = segmentTexts.join(' ');
    }

    // Approach 2: Check nested content structure
    else if ('content' in typedData && typedData.content?.body?.contents) {
      const contents = typedData.content.body.contents;
      videoLogger.debug('Using nested content extraction approach', { contentCount: contents.length });

      const contentTexts = contents
        .map((item: TranscriptItem) => {
          if (item.transcript_segment_renderer?.snippet?.runs) {
            return item.transcript_segment_renderer.snippet.runs
              .map((run: TranscriptRun) => run.text ?? '')
              .join('');
          }
          return '';
        })
        .filter((t: string) => t.length > 0);

      extractedTexts.push(...contentTexts);
      text = contentTexts.join(' ');
    }

    // Approach 3: Check if transcriptData itself is an array
    else if (Array.isArray(transcriptData)) {
      videoLogger.debug('Using array extraction approach', { arrayLength: transcriptData.length });

      const arrayTexts = (transcriptData as TranscriptSegment[])
        .map((item: TranscriptSegment) => item.text ?? item.snippet?.text ?? '')
        .filter((t: string) => t.length > 0);

      extractedTexts.push(...arrayTexts);
      text = arrayTexts.join(' ');
    }

    // Approach 4: Try to find any text-like properties
    else {
      videoLogger.debug('Using recursive text extraction approach');
      const findTextProperties = (obj: unknown, path = ''): string[] => {
        const texts: string[] = [];

        if (typeof obj === 'string' && obj.length > 5) {
          texts.push(obj);
        } else if (typeof obj === 'object' && obj !== null) {
          for (const [key, value] of Object.entries(obj)) {
            if (key.toLowerCase().includes('text') && typeof value === 'string') {
              texts.push(value);
            } else if (typeof value === 'object') {
              texts.push(...findTextProperties(value, `${path}.${key}`));
            }
          }
        }

        return texts;
      };

      const foundTexts = findTextProperties(transcriptData);
      extractedTexts.push(...foundTexts);
      text = foundTexts.join(' ');
      videoLogger.debug('Recursive extraction completed', { textPropertiesFound: foundTexts.length });
    }

    // CRITICAL: Remove immediate duplications that occur during extraction
    // Pattern: "text text timestamp" where the same text appears twice before timestamp
    if (text.length > 0) {
      const originalText = text;

      // Remove phrase-level duplicates before timestamps
      // Pattern: "phrase phrase timestamp" -> "phrase timestamp"
      // Use a more aggressive approach: match any repeated sequence of 2+ words before timestamps
      text = text.replace(/(\b[\w\s']+)\s+\1\s+(?=\d+:\d+)/g, '$1 ');

      // Clean up extra spaces
      text = text.replace(/\s+/g, ' ').trim();

      videoLogger.debug('Extraction deduplication completed', {
        originalLength: originalText.length,
        deduplicatedLength: text.length,
        timestampsPreserved: (text.match(/\d+:\d+/g) || []).length,
        compressionRatio: ((originalText.length - text.length) / originalText.length * 100).toFixed(1) + '%'
      });
    }

    if (text.length > 0) {
      videoLogger.info('Transcript extraction successful (no timestamps from fallback)', {
        extractedLength: text.length,
        preview: text.substring(0, 100) + '...'
      });
        // Track successful usage
        await trackYouTubeUsage('transcript', {
          videoId,
          success: true,
          extractedLength: text.length
        });

        // Note: youtubei.js fallback doesn't provide structured timestamps
        return { text, segments: undefined };
      } else {
        videoLogger.warn('No text extracted from transcript data');

        // Track failed usage
        await trackYouTubeUsage('transcript', {
          videoId,
          success: false,
          reason: 'no_text_extracted'
        });

        return null;
      }
    })(), TIMEOUT_CONFIGS.youtube, `youtube-transcript-${videoId}`)
  }, RETRY_CONFIGS.youtube, `youtube-transcript-${videoId}`).catch(async (error: unknown) => {
    videoLogger.error('Transcript extraction failed after all retries', error);

    // Track failed usage
    await trackYouTubeUsage('transcript', {
      videoId,
      success: false,
      reason: 'extraction_failed',
      error: error instanceof Error ? error.message : String(error)
    });

    return null;
  });
}

/**
 * Extract timestamp segments from raw transcript text
 * Handles format like: "text 0:00 more text 0:02 more 0:05"
 */
export function extractTimestampSegments(text: string): Array<{
  text: string;
  timestampDisplay: string;
  timestampSeconds: number;
  endSeconds: number;
}> {
  const segments: Array<{
    text: string;
    timestampDisplay: string;
    timestampSeconds: number;
    endSeconds: number;
  }> = [];

  // Match pattern: text followed by timestamp (M:SS or H:MM:SS)
  const timestampRegex = /([^0-9]+?)(\d+:\d{2}(?::\d{2})?)/g;
  let match;

  while ((match = timestampRegex.exec(text)) !== null) {
    const textContent = match[1]?.trim() || '';
    const timestampDisplay = match[2] || '';

    if (textContent.length > 5 && timestampDisplay) {
      // Parse timestamp to seconds
      const parts = timestampDisplay.split(':').map(Number);
      let seconds = 0;
      if (parts.length === 3) {
        // H:MM:SS
        seconds = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
      } else if (parts.length === 2) {
        // M:SS
        seconds = parts[0]! * 60 + parts[1]!;
      }

      segments.push({
        text: textContent,
        timestampDisplay,
        timestampSeconds: seconds,
        endSeconds: seconds + 2 // Default 2 second duration, will be updated
      });
    }
  }

  // Update endSeconds based on next segment's start time
  for (let i = 0; i < segments.length - 1; i++) {
    segments[i]!.endSeconds = segments[i + 1]!.timestampSeconds;
  }

  // Last segment gets +10 seconds
  if (segments.length > 0) {
    const lastSegment = segments[segments.length - 1]!;
    lastSegment.endSeconds = lastSegment.timestampSeconds + 10;
  }

  logger.info('Extracted timestamp segments from text', {
    totalSegments: segments.length,
    firstSegment: segments[0] ? {
      time: segments[0].timestampDisplay,
      text: segments[0].text.substring(0, 50)
    } : null,
    lastSegment: segments[segments.length - 1] ? {
      time: segments[segments.length - 1].timestampDisplay,
      text: segments[segments.length - 1].text.substring(0, 50)
    } : null
  });

  return segments;
}

export function cleanTranscript(text: string): string {
  const originalLength = text.length;

  // Remove timestamps, music notation, etc.
  const cleaned = text
    .replace(/\d+:\d{2}(?::\d{2})?/g, '') // Remove timestamps (M:SS or H:MM:SS)
    .replace(/\[.*?\]/g, '') // Remove [Music], [Applause] etc
    .replace(/\[adultswim\]/g, '') // Remove watermarks like [adultswim]
    .replace(/\s+/g, ' ') // Multiple spaces to single
    .trim();

  // Check for potential duplication patterns
  const duplicatePatterns = text.match(/(.{10,})\s+\1/g);
  if (duplicatePatterns) {
    logger.warn('Potential transcript duplicates detected', {
      duplicateCount: duplicatePatterns.length,
      examples: duplicatePatterns.slice(0, 3).map(p => p.substring(0, 50) + '...')
    });
  }

  logger.info('Transcript cleaned', {
    originalLength,
    cleanedLength: cleaned.length,
    compressionRatio: ((originalLength - cleaned.length) / originalLength * 100).toFixed(1) + '%',
    potentialDuplicates: duplicatePatterns?.length || 0
  });

  return cleaned;
}

// Better token estimation function
function estimateTokens(text: string): number {
  // More accurate token estimation: ~4 characters per token for English
  // Account for spaces, punctuation, and common patterns
  return Math.ceil(text.length / 4);
}

export function chunkText(text: string, maxTokens = 400): string[] {
  if (!text || text.length < 50) { // Increased minimum length
    logger.warn('Text too short to chunk', { textLength: text.length });
    return [];
  }

  // Better sentence splitting with more punctuation patterns
  let sentences = text.split(/[.!?;]\s+|[\n\r]+/).filter(s => s.trim().length > 10);

  // If no good sentences found, try paragraph splitting
  if (sentences.length <= 2) {
    sentences = text.split(/\n\s*\n/).filter(s => s.trim().length > 10);
  }

  // Final fallback: word-based chunking with overlap
  if (sentences.length <= 1) {
    logger.debug('Using word-based chunking with overlap');
    const words = text.split(/\s+/);
    const wordsPerChunk = Math.floor(maxTokens * 0.7); // Conservative estimate
    const overlapWords = Math.floor(wordsPerChunk * 0.1); // 10% overlap
    sentences = [];

    for (let i = 0; i < words.length; i += wordsPerChunk - overlapWords) {
      const chunk = words.slice(i, i + wordsPerChunk).join(' ');
      if (chunk.length > 50) {
        sentences.push(chunk);
      }
    }
  }

  const chunks: string[] = [];
  let currentChunk = '';
  const targetChunkTokens = maxTokens * 0.8; // Leave some buffer

  for (const sentence of sentences) {
    const testChunk = currentChunk ? `${currentChunk} ${sentence.trim()}` : sentence.trim();
    const estimatedTokens = estimateTokens(testChunk);

    if (estimatedTokens < targetChunkTokens && testChunk.length < 2500) {
      currentChunk = testChunk;
    } else {
      // Save current chunk if it's substantial
      if (currentChunk.length > 100) { // Higher quality threshold
        chunks.push(currentChunk);
      }
      currentChunk = sentence.trim();
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 100) {
    chunks.push(currentChunk);
  }

  logger.info('Text chunking completed', {
    originalLength: text.length,
    totalChunks: chunks.length,
    averageChunkSize: chunks.length > 0 ? Math.round(chunks.reduce((sum, chunk) => sum + chunk.length, 0) / chunks.length) : 0,
    averageTokens: chunks.length > 0 ? Math.round(chunks.reduce((sum, chunk) => sum + estimateTokens(chunk), 0) / chunks.length) : 0,
    chunkSizeRange: chunks.length > 0 ? `${Math.min(...chunks.map(c => c.length))}-${Math.max(...chunks.map(c => c.length))}` : 'N/A'
  });

  return chunks;
}

// NEW: LangChain-powered chunking with metadata preservation
export async function chunkTextWithMetadata(
  text: string,
  timestampSegments?: Array<{
    text: string;
    timestampDisplay: string;
    timestampSeconds: number;
    endSeconds: number;
  }>,
  videoMetadata?: {
    videoId: string;
    videoTitle?: string;
    videoUrl?: string;
    thumbnailUrl?: string;
  }
): Promise<Document[]> {
  if (!text || text.length < 50) {
    logger.warn('Text too short to chunk', { textLength: text.length });
    return [];
  }

  // LangChain's smart text splitter with overlap
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1600, // ~400 tokens (4 chars per token)
    chunkOverlap: 200, // Prevent context loss at boundaries
    separators: ["\n\n", "\n", ". ", "! ", "? ", "; ", " "],
    lengthFunction: (text) => text.length,
  });

  // Split text into chunks
  const textChunks = await splitter.splitText(text);

  // Create documents with metadata
  const documents = textChunks.map((chunk, index) => {
    const metadata: Record<string, any> = {
      chunkIndex: index,
      ...videoMetadata,
    };

    // OPTIMIZATION: Use shared timestamp matching function
    if (timestampSegments && timestampSegments.length > 0) {
      const timestampMatch = matchChunkToTimestamp(
        chunk,
        timestampSegments,
        index,
        textChunks.length
      );

      metadata.startTime = timestampMatch.startTime;
      metadata.endTime = timestampMatch.endTime;
      metadata.timestampDisplay = timestampMatch.timestampDisplay;
      metadata.matched = timestampMatch.matched;
    }

    // NEW: Sentiment analysis for moment detection
    const sentiment = analyzeSentiment(chunk);
    metadata.sentiment = sentiment;
    metadata.emotionalIntensity = sentiment.emotionalIntensity;
    metadata.isHighlightCandidate = sentiment.isHighlightCandidate;
    metadata.exclamationCount = sentiment.exclamationCount;

    return new Document({
      pageContent: chunk,
      metadata,
    });
  });

  const highlightCandidates = documents.filter(d => d.metadata.isHighlightCandidate);
  const avgEmotionalIntensity = documents.reduce((sum, d) => sum + (d.metadata.emotionalIntensity || 0), 0) / documents.length;

  logger.info('LangChain text chunking completed', {
    inputLength: text.length,
    chunksCreated: documents.length,
    avgChunkSize: Math.round(documents.reduce((sum, d) => sum + d.pageContent.length, 0) / documents.length),
    chunksWithTimestamps: documents.filter(d => (d.metadata.startTime || 0) > 0).length,
    chunksMatched: documents.filter(d => d.metadata.matched).length,
    timestampCoverage: timestampSegments && timestampSegments.length > 0
      ? `${Math.round((documents.filter(d => (d.metadata.startTime || 0) > 0).length / documents.length) * 100)}%`
      : '0%',
    // NEW: Sentiment stats
    highlightCandidates: highlightCandidates.length,
    highlightPercentage: `${Math.round((highlightCandidates.length / documents.length) * 100)}%`,
    avgEmotionalIntensity: avgEmotionalIntensity.toFixed(2)
  });

  return documents;
}

// Helper function to extract channel info from various URL formats
function extractChannelInfo(input: string): { type: 'id' | 'handle' | 'name', value: string } {
  const trimmedInput = input.trim();

  // Handle direct channel IDs (UCxxxxxxxxx format)
  if (/^UC[a-zA-Z0-9_-]{22}$/.test(trimmedInput)) {
    return { type: 'id', value: trimmedInput };
  }

  // Handle various YouTube URL formats
  const urlPatterns = [
    // https://www.youtube.com/@handle
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([^\/\?&\s]+)/,
    // https://www.youtube.com/channel/UCxxxxxxx
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/channel\/([^\/\?&\s]+)/,
    // https://www.youtube.com/c/channelname
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/c\/([^\/\?&\s]+)/,
    // https://www.youtube.com/user/username
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/user\/([^\/\?&\s]+)/,
  ];

  for (const pattern of urlPatterns) {
    const match = trimmedInput.match(pattern);
    if (match?.[1]) {
      const extractedValue = decodeURIComponent(match[1]);

      // If it starts with @, it's a handle
      if (pattern.source.includes('@')) {
        return { type: 'handle', value: extractedValue };
      }

      // If it matches the channel ID format, it's an ID
      if (/^UC[a-zA-Z0-9_-]{22}$/.test(extractedValue)) {
        return { type: 'id', value: extractedValue };
      }

      // Otherwise treat as name
      return { type: 'name', value: extractedValue };
    }
  }

  // If it starts with @, treat as handle
  if (trimmedInput.startsWith('@')) {
    return { type: 'handle', value: trimmedInput.substring(1) };
  }

  // Default to treating as channel name
  return { type: 'name', value: trimmedInput };
}

// Helper function to parse ISO 8601 duration and convert to minutes
function parseDurationToMinutes(duration: string): number {
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const match = regex.exec(duration);
  if (!match) return 0;

  const hours = parseInt(match[1] ?? '0');
  const minutes = parseInt(match[2] ?? '0');
  const seconds = parseInt(match[3] ?? '0');

  return hours * 60 + minutes + (seconds > 0 ? 1 : 0);
}

/**
 * Get channel videos using YouTube Data API
 */
export async function getChannelVideos(channelInput: string, maxVideos: number = 20) {
  try {
    logger.info('Fetching channel videos', { channelInput, maxVideos });

    const { type, value } = extractChannelInfo(channelInput);
    logger.info('Channel info extracted', { type, value });

    let channelData;

    // Fetch channel information
    if (type === 'id') {
      const response = await youtube.channels.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        id: [value],
      });
      channelData = response.data;
    } else if (type === 'handle') {
      const response = await youtube.channels.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        forHandle: value,
      });
      channelData = response.data;
    } else {
      // Search for channel by name
      const searchResponse = await youtube.search.list({
        part: ['snippet'],
        q: value,
        type: ['channel'],
        maxResults: 1,
      });

      if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
        throw new Error('Channel not found');
      }

      const foundChannelId = searchResponse.data.items[0]?.snippet?.channelId;
      if (!foundChannelId) {
        throw new Error('Channel ID not found');
      }

      const response = await youtube.channels.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        id: [foundChannelId],
      });
      channelData = response.data;
    }

    if (!channelData?.items || channelData.items.length === 0) {
      throw new Error('Channel not found');
    }

    const channel = channelData.items[0];
    const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads;

    if (!uploadsPlaylistId) {
      throw new Error('Channel uploads playlist not found');
    }

    // Fetch videos - get extra to compensate for filtering
    const fetchCount = Math.max(maxVideos * 2.5, 50);

    const videosResponse = await youtube.playlistItems.list({
      part: ['snippet', 'contentDetails'],
      playlistId: uploadsPlaylistId,
      maxResults: fetchCount,
    });

    if (!videosResponse.data.items) {
      throw new Error('No videos found in channel');
    }

    // Get video IDs
    const videoIds = videosResponse.data.items
      .filter(item => item.snippet?.resourceId?.videoId)
      .map(item => item.snippet!.resourceId!.videoId!)
      .filter(Boolean);

    if (videoIds.length === 0) {
      throw new Error('No valid video IDs found');
    }

    // Fetch detailed video information
    const videosDetailResponse = await youtube.videos.list({
      part: ['snippet', 'contentDetails', 'statistics'],
      id: videoIds,
    });

    if (!videosDetailResponse.data.items) {
      throw new Error('Failed to fetch video details');
    }

    // Transform and filter videos (2-25 minutes)
    const MIN_DURATION_MINUTES = 2;
    const MAX_DURATION_MINUTES = 25;

    const allVideos = videosDetailResponse.data.items.map(item => {
      const durationMinutes = parseDurationToMinutes(item.contentDetails?.duration ?? 'PT0S');
      const hasCaptions = item.contentDetails?.caption === 'true';

      return {
        videoId: item.id!,
        title: item.snippet!.title,
        description: item.snippet!.description,
        publishedAt: item.snippet!.publishedAt,
        thumbnails: item.snippet!.thumbnails,
        url: `https://www.youtube.com/watch?v=${item.id}`,
        duration: item.contentDetails?.duration,
        durationMinutes,
        hasCaptions,
        viewCount: item.statistics?.viewCount,
        likeCount: item.statistics?.likeCount,
        commentCount: item.statistics?.commentCount
      };
    });

    // Filter by duration
    const filteredByDuration = allVideos.filter(video =>
      video.durationMinutes >= MIN_DURATION_MINUTES &&
      video.durationMinutes <= MAX_DURATION_MINUTES
    );

    // Prioritize videos with captions
    const videosWithCaptions = filteredByDuration.filter(v => v.hasCaptions);
    const videosWithoutCaptions = filteredByDuration.filter(v => !v.hasCaptions);

    const videos = [
      ...videosWithCaptions.slice(0, maxVideos),
      ...videosWithoutCaptions.slice(0, Math.max(0, maxVideos - videosWithCaptions.length))
    ].slice(0, maxVideos);

    logger.info('Channel videos fetched', {
      channelTitle: channel.snippet?.title,
      totalFetched: allVideos.length,
      afterFiltering: videos.length,
      withCaptions: videos.filter(v => v.hasCaptions).length
    });

    return {
      channel: {
        id: channel.id,
        title: channel.snippet?.title,
        description: channel.snippet?.description,
        thumbnails: channel.snippet?.thumbnails
      },
      videos
    };

  } catch (error) {
    logger.error('Failed to fetch channel videos', error);
    throw error;
  }
}

/**
 * Get channel info with Wikipedia enrichment
 */
export async function getChannelInfo(channelInput: string) {
  try {
    logger.info('Fetching channel info', { channelInput });

    const { type, value } = extractChannelInfo(channelInput);

    let channelData;

    if (type === 'id') {
      const response = await youtube.channels.list({
        part: ['snippet', 'statistics', 'contentDetails', 'brandingSettings', 'status', 'topicDetails'],
        id: [value],
      });
      channelData = response.data;
    } else if (type === 'handle') {
      const response = await youtube.channels.list({
        part: ['snippet', 'statistics', 'contentDetails', 'brandingSettings', 'status', 'topicDetails'],
        forHandle: value,
      });
      channelData = response.data;
    } else {
      const searchResponse = await youtube.search.list({
        part: ['snippet'],
        q: value,
        type: ['channel'],
        maxResults: 1,
      });

      if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
        throw new Error('Channel not found');
      }

      const foundChannelId = searchResponse.data.items[0]?.snippet?.channelId;
      if (!foundChannelId) {
        throw new Error('Channel ID not found');
      }

      const response = await youtube.channels.list({
        part: ['snippet', 'statistics', 'contentDetails', 'brandingSettings', 'status', 'topicDetails'],
        id: [foundChannelId],
      });
      channelData = response.data;
    }

    if (!channelData?.items || channelData.items.length === 0) {
      throw new Error('Channel not found');
    }

    const channel = channelData.items[0];

    // Enrich with Wikipedia data
    let wikipediaData = null;
    if (channel?.snippet?.title) {
      try {
        const { enrichChannelWithWikipedia } = await import('./wikipedia');
        wikipediaData = await enrichChannelWithWikipedia(channel.snippet.title);
      } catch (error) {
        logger.warn('Wikipedia enrichment failed', error);
      }
    }

    return {
      channelData: {
        channelId: channel.id,
        title: channel.snippet?.title,
        description: channel.snippet?.description,
        thumbnails: channel.snippet?.thumbnails,
        statistics: channel.statistics,
        customUrl: channel.snippet?.customUrl,
        publishedAt: channel.snippet?.publishedAt
      },
      wikipediaData
    };

  } catch (error) {
    logger.error('Failed to fetch channel info', error);
    throw error;
  }
}

