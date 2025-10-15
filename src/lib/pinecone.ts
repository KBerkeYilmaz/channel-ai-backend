import { Pinecone, type RecordMetadata, type PineconeRecord, type RecordValues } from '@pinecone-database/pinecone';
import { createLogger } from './logger';
import { withRetry, RETRY_CONFIGS } from './retry';
import { trackPineconeUsage } from './monitoring';

const logger = createLogger('Pinecone');

if (!process.env.PINECONE_API_KEY) {
  throw new Error('PINECONE_API_KEY environment variable is required');
}

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

const INDEX_NAME = 'creator-transcripts-v2';

// IMPROVED: Better index existence checking
export async function getOrCreateIndex() {
  try {
    // First check if index exists
    const indexList = await pinecone.listIndexes();
    const indexExists = indexList.indexes?.some(index => index.name === INDEX_NAME);

    if (indexExists) {
      logger.info('Using existing Pinecone index', { indexName: INDEX_NAME });
      return pinecone.index(INDEX_NAME);
    }

    // Create index if it doesn't exist
    logger.info('Creating new Pinecone index', { indexName: INDEX_NAME });
    
    await pinecone.createIndex({
      name: INDEX_NAME,
      dimension: 3072,  // Full text-embedding-3-large dimensions
      metric: 'cosine',
      spec: {
        serverless: {
          cloud: 'aws',
          region: 'us-east-1'  // Free tier only supports us-east-1
        }
      }
    });

    // Wait for index to be ready with better polling
    logger.info('Waiting for index to be ready');
    let isReady = false;
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes max

    while (!isReady && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds

      try {
        const indexStatus = await pinecone.describeIndex(INDEX_NAME);
        isReady = indexStatus.status?.ready === true;

        if (!isReady) {
          logger.debug('Index still initializing', { attempt: attempts + 1, maxAttempts });
        }
      } catch {
        logger.debug('Waiting for index to be created', { attempt: attempts + 1, maxAttempts });
      }

      attempts++;
    }

    if (!isReady) {
      const error = new Error('Index creation timed out after 5 minutes');
      logger.error('Index creation timeout', error);
      throw error;
    }

    logger.info('Index ready', { indexName: INDEX_NAME });
    return pinecone.index(INDEX_NAME);

  } catch (error: unknown) {
    logger.error('Pinecone index error', error);
    throw error;
  }
}

// IMPROVED: Better error handling and batch processing
export async function storeTranscriptChunks(
  creatorId: string,
  videoId: string,
  chunks: Array<{
    text: string;
    embedding: number[];
    chunkIndex: number;
    videoTitle?: string;
    startTime?: number;
    endTime?: number;
  }>
): Promise<void> {
  if (chunks.length === 0) {
    logger.warn('No chunks to store', { creatorId, videoId });
    return;
  }

  const index = await getOrCreateIndex();

  const chunksWithTimestamps = chunks.filter(c => c.startTime !== undefined).length;

  logger.info('Preparing vectors for Pinecone', {
    totalChunks: chunks.length,
    chunksWithTimestamps,
    timestampCoverage: `${Math.round((chunksWithTimestamps / chunks.length) * 100)}%`
  });

  const vectors = chunks.map(chunk => ({
    id: `${creatorId}_${videoId}_${chunk.chunkIndex}`,
    values: chunk.embedding,
    metadata: {
      creatorId,
      videoId,
      chunkIndex: chunk.chunkIndex,
      // OPTIMIZATION: Store full text but limit to 5000 chars (down from 40000)
      // Full text in MongoDB for reference. This reduces Pinecone costs by ~70%
      text: chunk.text.substring(0, 5000),
      videoTitle: chunk.videoTitle ?? '',
      startTime: chunk.startTime ?? 0,
      endTime: chunk.endTime ?? 0,
      createdAt: new Date().toISOString()
    }
  }));

  try {
    // Process in batches if there are many vectors
    const batchSize = 100;
    const batches: Array<Array<{
      id: string;
      values: number[];
      metadata: Record<string, unknown>;
    }>> = [];
    
    for (let i = 0; i < vectors.length; i += batchSize) {
      batches.push(vectors.slice(i, i + batchSize));
    }

    logger.info('Storing vectors in batches', {
      totalVectors: vectors.length,
      batchCount: batches.length,
      creatorId,
      videoId
    });

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (batch) {
        logger.debug('Uploading batch', {
          batchNumber: i + 1,
          totalBatches: batches.length,
          vectorsInBatch: batch.length
        });

        await withRetry(
          () => index.upsert(batch as PineconeRecord<RecordMetadata>[]),
          RETRY_CONFIGS.pinecone,
          `pinecone-upsert-batch-${i + 1}`
        );

        // Track usage for each batch
        await trackPineconeUsage('upsert', {
          batchNumber: i + 1,
          vectorCount: batch.length,
          creatorId,
          videoId
        });
      }

      // Small delay between batches to avoid rate limits
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info('Successfully stored vectors', {
      vectorCount: vectors.length,
      creatorId,
      videoId
    });

    // Track overall operation
    await trackPineconeUsage('store_chunks', {
      totalVectors: vectors.length,
      batches: batches.length,
      creatorId,
      videoId,
      success: true
    });
  } catch (error: unknown) {
    logger.error('Error storing chunks', error, { videoId, creatorId });

    // Track failed operation
    await trackPineconeUsage('store_chunks', {
      creatorId,
      videoId,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }
}

// IMPROVED: Better error handling and debugging
export async function searchSimilarChunks(
  creatorId: string,
  queryEmbedding: number[],
  topK = 5
): Promise<string[]> {
  try {
    const index = await getOrCreateIndex();

    logger.info('Searching Pinecone', { creatorId, topK });

    const results = await withRetry(
      () => index.query({
        vector: queryEmbedding,
        topK,
        filter: { creatorId },
        includeMetadata: true
      }),
      RETRY_CONFIGS.pinecone,
      `pinecone-query-${creatorId}`
    );

    if (!results.matches || results.matches.length === 0) {
      logger.info('No matches found', { creatorId });
      return [];
    }

    const matchData = results.matches.map((match, index) => ({
      rank: index + 1,
      score: match.score?.toFixed(3),
      preview: String(match.metadata?.text ?? '').substring(0, 50) + '...',
      hasTimestamp: (match.metadata?.startTime as number ?? 0) > 0
    }));

    logger.info('Search results found', {
      totalMatches: results.matches.length,
      creatorId,
      topScores: matchData.slice(0, 3),
      chunksWithTimestamps: matchData.filter(m => m.hasTimestamp).length
    });

    // More aggressive filtering with better logging
    const allResults = results.matches.map(match => ({
      score: match.score ?? 0,
      text: match.metadata?.text as string,
      videoId: match.metadata?.videoId as string,
      videoTitle: match.metadata?.videoTitle as string,
      startTime: match.metadata?.startTime as number,
      endTime: match.metadata?.endTime as number
    }));

    // Filter by similarity threshold - only keep relevant results
    // Cosine similarity: 0.7+ = very similar, 0.5-0.7 = similar, 0.25-0.5 = somewhat related
    const SIMILARITY_THRESHOLD = 0.25;
    const filteredResults = results.matches
      .filter(match => (match.score ?? 0) >= SIMILARITY_THRESHOLD)
      .map(match => match.metadata?.text as string)
      .filter(Boolean);

    logger.info('Detailed search results', {
      allScores: allResults.map(r => ({ score: r.score.toFixed(3), videoTitle: r.videoTitle?.substring(0, 30) })),
      resultsBeforeFilter: results.matches.length,
      resultsAfterFilter: filteredResults.length,
      threshold: SIMILARITY_THRESHOLD,
      lowestScore: Math.min(...allResults.map(r => r.score)).toFixed(3),
      highestScore: Math.max(...allResults.map(r => r.score)).toFixed(3),
      filteredOut: results.matches.length - filteredResults.length
    });

    // Track successful query
    await trackPineconeUsage('query', {
      creatorId,
      topK,
      resultsFound: results.matches?.length ?? 0,
      resultsReturned: filteredResults.length,
      success: true
    });

    return filteredResults;

  } catch (error) {
    logger.error('Pinecone search error', error, { creatorId });

    // Track failed query
    await trackPineconeUsage('query', {
      creatorId,
      topK,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });

    return []; // Return empty array instead of throwing
  }
}

// NEW: Utility functions for debugging and management

export async function getIndexStats(): Promise<{
  totalVectors: number;
  dimension: number;
  indexFullness: number;
}> {
  try {
    const index = await getOrCreateIndex();
    const stats = await index.describeIndexStats();
    
    return {
      totalVectors: stats.totalRecordCount ?? 0,
      dimension: stats.dimension ?? 3072,
      indexFullness: stats.indexFullness ?? 0
    };
  } catch (error) {
    logger.error('Error getting index stats', error);
    return { totalVectors: 0, dimension: 3072, indexFullness: 0 };
  }
}

export async function getCreatorStats(creatorId: string): Promise<{
  totalChunks: number;
  videos: string[];
}> {
  try {
    const index = await getOrCreateIndex();
    
    // Query with dummy vector to get all results for this creator
    const results = await index.query({
      vector: new Array(3072).fill(0) as RecordValues,
      topK: 10000,
      filter: { creatorId },
      includeMetadata: true
    });

    const videoIds = new Set<string>();
    results.matches?.forEach(match => {
      if (match.metadata?.videoId) {
        videoIds.add(match.metadata.videoId as string);
      }
    });

    return {
      totalChunks: results.matches?.length ?? 0,
      videos: Array.from(videoIds)
    };
  } catch (error) {
    logger.error('Error getting creator stats', error, { creatorId });
    return { totalChunks: 0, videos: [] };
  }
}

// NEW: Clean up function for development
export async function deleteCreatorData(creatorId: string): Promise<void> {
  try {
    const index = await getOrCreateIndex();

    // Get all vector IDs for this creator
    const results = await index.query({
      vector: new Array(3072).fill(0) as RecordValues,
      topK: 10000,
      filter: { creatorId },
      includeMetadata: false
    });

    if (!results.matches || results.matches.length === 0) {
      logger.info('No data found for deletion', { creatorId });
      return;
    }

    const idsToDelete = results.matches.map(match => match.id).filter(Boolean);

    logger.info('Starting data deletion', {
      vectorsToDelete: idsToDelete.length,
      creatorId
    });

    // Delete in batches
    const batchSize = 1000;
    for (let i = 0; i < idsToDelete.length; i += batchSize) {
      const batch = idsToDelete.slice(i, i + batchSize);
      await index.deleteMany(batch);
    }

    logger.info('Successfully deleted creator data', { creatorId });
  } catch (error) {
    logger.error('Error deleting creator data', error, { creatorId });
    throw error;
  }
}

// Delete channel context for a creator (used when updating context)
export async function deleteChannelContext(creatorId: string): Promise<void> {
  try {
    const index = await getOrCreateIndex();

    // Get all vector IDs for channel context
    const results = await index.query({
      vector: new Array(3072).fill(0) as RecordValues,
      topK: 100,
      filter: {
        creatorId,
        videoId: 'CHANNEL_CONTEXT'
      },
      includeMetadata: false
    });

    if (!results.matches || results.matches.length === 0) {
      logger.info('No channel context found for deletion', { creatorId });
      return;
    }

    const idsToDelete = results.matches.map(match => match.id).filter(Boolean);

    logger.info('Deleting channel context', {
      vectorsToDelete: idsToDelete.length,
      creatorId
    });

    await index.deleteMany(idsToDelete);

    logger.info('Successfully deleted channel context', {
      creatorId,
      deletedCount: idsToDelete.length
    });
  } catch (error) {
    logger.error('Error deleting channel context', error, { creatorId });
    throw error;
  }
}