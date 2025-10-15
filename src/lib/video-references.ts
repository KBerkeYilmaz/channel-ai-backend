import { connectToDatabase } from './mongodb';
import { createLogger } from './logger';
import { ObjectId } from 'mongodb';
import type { VideoReference, Creator } from '../types';

const logger = createLogger('VideoReferences');

/**
 * Enhanced RAG search results with video reference data
 */
export interface EnhancedSearchResult {
  text: string;
  videoReference: VideoReference;
  similarity?: number;
}

/**
 * Tool definition for AI to cite video sources
 */
export const VIDEO_REFERENCE_TOOL = {
  name: "cite_video_source",
  description: "Reference a specific video and timestamp when answering user questions. Use this to provide video citations with clickable links.",
  parameters: {
    type: "object",
    properties: {
      videoId: {
        type: "string",
        description: "The YouTube video ID being referenced"
      },
      timestamp: {
        type: "number",
        description: "Timestamp in seconds where the relevant content appears"
      },
      relevantText: {
        type: "string",
        description: "The specific text or quote from the video being referenced"
      },
      context: {
        type: "string",
        description: "Brief explanation of how this video relates to the user's question"
      }
    },
    required: ["videoId", "relevantText"]
  }
};

/**
 * Enhanced search function that returns video references along with text chunks
 */
export async function searchSimilarChunksWithReferences(
  creatorId: string,
  query: string,
  limit = 5,
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<EnhancedSearchResult[]> {
  logger.info('Searching for chunks with video references', {
    creatorId,
    queryLength: query.length,
    queryPreview: query.substring(0, 100),
    limit,
    hasConversationHistory: !!conversationHistory,
    historyMessages: conversationHistory?.length || 0
  });

  try {
    const { db } = await connectToDatabase();

    // Get creator data for video metadata
    const creator = await db.collection<Creator>('creators').findOne({
      _id: new ObjectId(creatorId) as any
    });

    if (!creator) {
      logger.warn('Creator not found for reference search', { creatorId });
      return [];
    }

    logger.info('Creator found, searching chunks', {
      creatorName: creator.name,
      videosCount: creator.videos?.length || 0,
      videosWithTranscripts: creator.videos?.filter(v => v.hasTranscript).length || 0
    });

    // Build enhanced query with conversation context
    let enhancedQuery = query;
    if (conversationHistory && conversationHistory.length > 0) {
      // Get last 2-3 messages for context (exclude current query)
      const recentHistory = conversationHistory.slice(-4, -1).filter(msg => msg.content.length > 0);

      if (recentHistory.length > 0) {
        // Extract key context from previous messages
        const contextParts = recentHistory
          .map(msg => msg.content)
          .filter(content => content.length < 200) // Only short messages for context
          .join(' ');

        // Combine context with current query
        enhancedQuery = `${query} [Context from conversation: ${contextParts.substring(0, 300)}]`;

        logger.info('Enhanced query with conversation context', {
          originalQuery: query,
          contextAdded: contextParts.substring(0, 100) + '...',
          enhancedQueryLength: enhancedQuery.length,
          historyMessagesUsed: recentHistory.length
        });
      }
    }

    // Import and use existing RAG search with enhanced query
    const { searchSimilarChunks } = await import('./rag');
    const chunks = await searchSimilarChunks(creatorId, enhancedQuery, limit * 2); // Get more candidates

    logger.info('RAG search completed', {
      chunksFound: chunks.length,
      requestedCandidates: limit * 2
    });

    // Get transcript chunks from MongoDB with metadata
    const transcriptCollection = db.collection('transcript_chunks');
    const results: EnhancedSearchResult[] = [];

    // Extract potential video title keywords from query for better matching
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    // OPTIMIZATION: Batch fetch all transcript docs at once (fixes N+1 query problem)
    const transcriptDocs = await transcriptCollection.find({
      creatorId,
      text: { $in: chunks }
    }).toArray();

    // Create a map for O(1) lookup
    const transcriptMap = new Map(
      transcriptDocs.map(doc => [doc.text as string, doc])
    );

    logger.info('Batch MongoDB lookup completed', {
      chunksRequested: chunks.length,
      docsFound: transcriptDocs.length,
      matchRate: `${Math.round((transcriptDocs.length / chunks.length) * 100)}%`
    });

    let videoMetadataMatches = 0;

    for (const chunk of chunks) {
      try {
        // O(1) lookup from Map instead of individual DB query
        const transcriptDoc = transcriptMap.get(chunk);

        if (transcriptDoc) {

          // Find video metadata from creator.videos array
          const videoMetadata = creator.videos?.find(v => v.videoId === transcriptDoc.videoId);

          if (videoMetadata) {
            videoMetadataMatches++;
            const startTime = transcriptDoc.metadata?.startTime ?? 0;
            const endTime = transcriptDoc.metadata?.endTime ?? 0;
            const timestampUrl = `${videoMetadata.url}&t=${Math.floor(startTime)}s`;

            logger.info('📹 VIDEO REFERENCE CREATED', {
              videoTitle: videoMetadata.title,
              videoId: transcriptDoc.videoId,
              videoUrl: videoMetadata.url,
              startTime,
              endTime,
              timestampUrl,
              hasTimestamp: startTime > 0,
              metadataSource: transcriptDoc.metadata ? 'from-mongodb' : 'missing',
              fullMetadata: transcriptDoc.metadata
            });

            const videoReference: VideoReference = {
              videoId: transcriptDoc.videoId,
              title: videoMetadata.title,
              url: videoMetadata.url,
              thumbnailUrl: videoMetadata.thumbnails?.medium?.url,
              timestamp: startTime,
              timestampUrl,
              relevantText: chunk,
              viewCount: videoMetadata.viewCount,
              duration: videoMetadata.duration
            };

            // Calculate relevance boost based on title matching
            const titleLower = videoMetadata.title.toLowerCase();
            const titleMatchScore = queryWords.filter(word =>
              word.length > 2 && titleLower.includes(word)
            ).length;

            logger.debug('Video reference created', {
              videoTitle: videoMetadata.title,
              timestamp: startTime,
              endTime,
              hasTimestamp: startTime > 0,
              titleMatchScore,
              mongoMetadata: transcriptDoc.metadata,
              chunkPreview: chunk.substring(0, 50)
            });

            results.push({
              text: chunk,
              videoReference,
              similarity: titleMatchScore // Use title match as relevance score
            });
          } else {
            logger.warn('No video metadata found for chunk', {
              videoId: transcriptDoc.videoId,
              chunkPreview: chunk.substring(0, 50)
            });
          }
        } else {
          logger.warn('No MongoDB document found for chunk', {
            chunkPreview: chunk.substring(0, 50)
          });
        }
      } catch (chunkError) {
        logger.warn('Failed to process chunk for references', {
          error: chunkError instanceof Error ? chunkError.message : String(chunkError),
          chunkPreview: chunk.substring(0, 50)
        });
      }

      if (results.length >= limit) break;
    }

    logger.info('Video reference matching statistics', {
      totalChunks: chunks.length,
      mongoDocsFound: transcriptDocs.length,
      videoMetadataMatches,
      finalResults: results.length
    });

    // Sort by title match relevance score (higher is better)
    const sortedResults = results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));

    logger.info('Reference search completed', {
      creatorId,
      resultsWithReferences: sortedResults.length,
      totalChunksSearched: chunks.length,
      topResults: sortedResults.slice(0, 3).map(r => ({
        title: r.videoReference.title.substring(0, 40),
        relevanceScore: r.similarity,
        timestamp: r.videoReference.timestamp
      }))
    });

    return sortedResults;

  } catch (error) {
    logger.error('Reference search failed', error, { creatorId, queryLength: query.length });
    return [];
  }
}

/**
 * Generate YouTube URL with timestamp
 */
export function createTimestampUrl(videoUrl: string, timestampSeconds: number): string {
  const url = new URL(videoUrl);
  url.searchParams.set('t', `${Math.floor(timestampSeconds)}s`);
  return url.toString();
}

/**
 * Format timestamp for display (e.g., "2:34" or "1:23:45")
 */
export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
}

/**
 * Create system prompt instructions for video referencing
 */
export function getVideoReferencingInstructions(hasVideoContent: boolean, videoCount: number = 0): string {
  if (!hasVideoContent || videoCount === 0) {
    return "You don't currently have access to video transcripts for referencing.";
  }

  return `
🎥 VIDEO REFERENCING CAPABILITIES:
You have access to transcripts from ${videoCount} videos. When answering questions:

1. **Always reference specific videos** when you draw information from them
2. **Use this format for video citations**:
   📹 *From [Video Title](video-url-with-timestamp) at [timestamp]*

3. **Include relevant quotes** from the videos when appropriate
4. **Be specific about timestamps** - users love being able to jump to exact moments

Example response format:
"Based on what I discussed in my video about this topic:

📹 *From [How I Built My First App](https://youtube.com/watch?v=xyz&t=145s) at 2:25*

> 'The key insight I had was that users don't care about your tech stack, they care about solving their problems.'

This is why I always recommend starting with user research..."

Remember: Users find it impressive when you can point them to exact moments in videos!`;
}