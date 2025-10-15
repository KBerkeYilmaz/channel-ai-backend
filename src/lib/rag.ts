import { connectToDatabase } from './mongodb';
import { createEmbedding } from './openai';
import { storeTranscriptChunks as storeToPinecone, searchSimilarChunks as searchPinecone, deleteChannelContext as deletePineconeChannelContext } from './pinecone';
import { createLogger } from './logger';
import { preprocessQuery, getBestQueryForEmbedding, type ProcessedQuery } from './query-preprocessing';
import { matchChunkToTimestamp, type TimestampSegment } from './timestamp-matching';
import type { TranscriptChunk } from '../types';
import { Document } from "@langchain/core/documents";

const logger = createLogger('RAG');

/**
 * Store channel context (description, Wikipedia, custom description) as embeddings
 * This allows the AI to answer questions about the channel itself
 */
export async function storeChannelContext(
  creatorId: string,
  channelData: {
    title?: string;
    description?: string;
    customDescription?: string;
  },
  wikipediaData?: {
    summary?: string;
    relatedTopics?: string[];
  }
): Promise<void> {
  logger.info('Storing channel context embeddings', {
    creatorId,
    channelTitle: channelData.title,
    hasDescription: !!channelData.description,
    hasCustomDescription: !!channelData.customDescription,
    hasWikipedia: !!wikipediaData?.summary
  });

  const contextChunks: Array<{
    text: string;
    contentType: 'channel_description' | 'custom_description' | 'wikipedia_summary' | 'wikipedia_topics';
  }> = [];

  // 1. Channel description (official YouTube description)
  if (channelData.description && channelData.description.length > 50) {
    contextChunks.push({
      text: `Channel Description: ${channelData.description}`,
      contentType: 'channel_description'
    });
    logger.debug('Added channel description chunk', { length: channelData.description.length });
  }

  // 2. Custom description (from user input - optional, max 1000 chars)
  if (channelData.customDescription && channelData.customDescription.length > 50) {
    contextChunks.push({
      text: `About this channel: ${channelData.customDescription}`,
      contentType: 'custom_description'
    });
    logger.debug('Added custom description chunk', { length: channelData.customDescription.length });
  }

  // 3. Wikipedia summary (background information)
  if (wikipediaData?.summary && wikipediaData.summary.length > 50) {
    contextChunks.push({
      text: `Background information: ${wikipediaData.summary}`,
      contentType: 'wikipedia_summary'
    });
    logger.debug('Added Wikipedia summary chunk', { length: wikipediaData.summary.length });
  }

  // 4. Wikipedia related topics (for broader context)
  if (wikipediaData?.relatedTopics && wikipediaData.relatedTopics.length > 0) {
    contextChunks.push({
      text: `Related topics: ${wikipediaData.relatedTopics.join(', ')}`,
      contentType: 'wikipedia_topics'
    });
    logger.debug('Added Wikipedia topics chunk', { topicsCount: wikipediaData.relatedTopics.length });
  }

  if (contextChunks.length === 0) {
    logger.warn('No channel context to store', { creatorId });
    return;
  }

  // Create embeddings for each context chunk
  const chunksWithEmbeddings: Array<{
    text: string;
    embedding: number[];
    chunkIndex: number;
    contentType: string;
  }> = [];

  for (let i = 0; i < contextChunks.length; i++) {
    const chunk = contextChunks[i]!;

    try {
      logger.debug('Creating embedding for channel context', {
        type: chunk.contentType,
        textLength: chunk.text.length
      });

      const embedding = await createEmbedding(chunk.text);

      if (!embedding || embedding.length === 0) {
        throw new Error(`Failed to create embedding for ${chunk.contentType}`);
      }

      chunksWithEmbeddings.push({
        text: chunk.text,
        embedding,
        chunkIndex: i,
        contentType: chunk.contentType
      });

      logger.debug('Channel context embedding created', {
        type: chunk.contentType,
        embeddingDimension: embedding.length
      });
    } catch (error) {
      logger.error(`Failed to create embedding for ${chunk.contentType}`, error);
      // Continue with other chunks even if one fails
    }
  }

  if (chunksWithEmbeddings.length === 0) {
    throw new Error('Failed to create any channel context embeddings');
  }

  logger.info('Channel context embeddings created', {
    totalChunks: chunksWithEmbeddings.length,
    types: chunksWithEmbeddings.map(c => c.contentType)
  });

  // Store in Pinecone with special videoId to identify as channel context
  const pineconeChunks = chunksWithEmbeddings.map(chunk => ({
    text: chunk.text,
    embedding: chunk.embedding,
    chunkIndex: chunk.chunkIndex,
    videoTitle: `${channelData.title} - Channel Context`,
    startTime: undefined,
    endTime: undefined
  }));

  await storeToPinecone(creatorId, 'CHANNEL_CONTEXT', pineconeChunks);

  // Store metadata in MongoDB with contentType for filtering
  const { db } = await connectToDatabase();
  const collection = db.collection('transcript_chunks');

  const documents = chunksWithEmbeddings.map(chunk => ({
    creatorId,
    videoId: 'CHANNEL_CONTEXT',
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    metadata: {
      contentType: chunk.contentType,
      videoTitle: `${channelData.title} - Channel Context`,
      isChannelContext: true
    },
    createdAt: new Date(),
  }));

  await collection.insertMany(documents);

  logger.info('Channel context stored successfully', {
    creatorId,
    contextChunksStored: chunksWithEmbeddings.length,
    types: chunksWithEmbeddings.map(c => c.contentType),
    storedInPinecone: true,
    storedInMongoDB: true
  });
}

/**
 * Update channel context - useful when customDescription changes
 * Deletes old context and creates new embeddings
 */
export async function updateChannelContext(
  creatorId: string,
  channelData: {
    title?: string;
    description?: string;
    customDescription?: string;
  },
  wikipediaData?: {
    summary?: string;
    relatedTopics?: string[];
  }
): Promise<void> {
  logger.info('Updating channel context', { creatorId });

  try {
    // Delete old channel context from Pinecone
    await deletePineconeChannelContext(creatorId);

    // Delete old channel context from MongoDB
    const { db } = await connectToDatabase();
    const collection = db.collection('transcript_chunks');
    const deleteResult = await collection.deleteMany({
      creatorId,
      videoId: 'CHANNEL_CONTEXT'
    });

    logger.info('Old channel context deleted', {
      creatorId,
      deletedFromMongoDB: deleteResult.deletedCount
    });

    // Store new channel context
    await storeChannelContext(creatorId, channelData, wikipediaData);

    logger.info('Channel context updated successfully', { creatorId });
  } catch (error) {
    logger.error('Failed to update channel context', error, { creatorId });
    throw error;
  }
}

export async function storeTranscriptChunks(
  creatorId: string,
  videoId: string,
  chunks: string[] | Document[],
  videoTitle?: string,
  videoUrl?: string,
  thumbnailUrl?: string,
  timestampSegments?: Array<{
    text: string;
    timestampDisplay: string;
    timestampSeconds: number;
    endSeconds: number;
  }>
): Promise<void> {
  // Check if we received LangChain Documents
  const isLangChainDocs = chunks.length > 0 && chunks[0] instanceof Document;

  logger.info('Processing chunks for RAG storage', {
    creatorId,
    videoId,
    chunkCount: chunks.length,
    chunkType: isLangChainDocs ? 'LangChain Documents' : 'string[]',
    videoTitle,
    videoUrl,
    thumbnailUrl,
    hasTimestamps: !!timestampSegments,
    timestampSegmentCount: timestampSegments?.length || 0,
    chunkSizes: isLangChainDocs
      ? (chunks as Document[]).map(d => d.pageContent.length)
      : (chunks as string[]).map(c => c.length)
  });

  if (chunks.length === 0) {
    throw new Error('No chunks provided for storage');
  }

  const chunksWithEmbeddings: Array<{
    text: string;
    embedding: number[];
    chunkIndex: number;
    videoTitle?: string;
    startTime?: number;
    endTime?: number;
  }> = [];

  try {
    // Process embeddings with better error handling
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;

      // Extract text and metadata based on chunk type
      let chunkText: string;
      let startTime: number | undefined;
      let endTime: number | undefined;

      if (isLangChainDocs) {
        const doc = chunk as Document;
        chunkText = doc.pageContent;
        // Use metadata from LangChain Document (already has timestamps!)
        startTime = doc.metadata.startTime;
        endTime = doc.metadata.endTime;
      } else {
        chunkText = chunk as string;

        // Old timestamp matching logic for string[] chunks
        if (timestampSegments && timestampSegments.length > 0) {
          const matchingSegment = timestampSegments.find(seg =>
            chunkText.includes(seg.text.replace(seg.timestampDisplay, '').trim().substring(0, 50))
          );

          if (matchingSegment) {
            startTime = matchingSegment.timestampSeconds;
            endTime = matchingSegment.endSeconds;
          } else {
            const chunkPosition = i / chunks.length;
            const totalDuration = timestampSegments[timestampSegments.length - 1]?.endSeconds || 0;
            startTime = Math.floor(chunkPosition * totalDuration);
            endTime = Math.floor((chunkPosition + (1 / chunks.length)) * totalDuration);
          }
        }
      }

      if (!chunkText || chunkText.length === 0) {
        logger.warn('Skipping empty chunk', { chunkIndex: i });
        continue;
      }

      logger.debug('Creating embedding for chunk', {
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        chunkLength: chunkText.length,
        startTime,
        endTime,
        hasTimestamp: (startTime || 0) > 0,
        chunkType: isLangChainDocs ? 'Document' : 'string',
        chunkPreview: chunkText.substring(0, 100) + '...'
      });

      try {
        const embedding = await createEmbedding(chunkText);

        if (!embedding || embedding.length === 0) {
          throw new Error(`Failed to create embedding for chunk ${i}`);
        }

        chunksWithEmbeddings.push({
          text: chunkText,
          embedding,
          chunkIndex: i,
          videoTitle,
          startTime,
          endTime
        });
      } catch (embeddingError) {
        logger.error('Failed to create embedding for chunk', embeddingError, {
          chunkIndex: i,
          chunkLength: chunkText.length,
          creatorId,
          videoId
        });
        throw new Error(`Embedding creation failed for chunk ${i}: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`);
      }
    }

    if (chunksWithEmbeddings.length === 0) {
      throw new Error('No valid embeddings created from chunks');
    }

    logger.info('Embeddings created successfully', {
      creatorId,
      videoId,
      validChunks: chunksWithEmbeddings.length,
      totalChunks: chunks.length
    });

    // Store in Pinecone with error handling
    try {
      await storeToPinecone(creatorId, videoId, chunksWithEmbeddings);
      logger.info('Pinecone storage completed', { creatorId, videoId });
    } catch (pineconeError) {
      logger.error('Pinecone storage failed', pineconeError, { creatorId, videoId });
      throw new Error(`Pinecone storage failed: ${pineconeError instanceof Error ? pineconeError.message : String(pineconeError)}`);
    }

    // Store metadata in MongoDB with error handling
    try {
      const { db } = await connectToDatabase();
      const collection = db.collection<Omit<TranscriptChunk, 'embedding'>>('transcript_chunks');

      // Map chunks to timestamps if available
      const documents = chunksWithEmbeddings.map(chunk => {
        // OPTIMIZATION: Use shared timestamp matching function
        const timestampMatch = matchChunkToTimestamp(
          chunk.text,
          timestampSegments || [],
          chunk.chunkIndex,
          chunksWithEmbeddings.length
        );

        const startTime = timestampMatch.startTime;
        const endTime = timestampMatch.endTime;

        return {
          creatorId,
          videoId,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          metadata: {
            contentType: 'video_transcript',
            videoTitle,
            videoUrl,
            thumbnailUrl,
            startTime,
            endTime,
            duration: startTime && endTime ? endTime - startTime : undefined
          },
          createdAt: new Date(),
        };
      });

      if (documents.length > 0) {
        await collection.insertMany(documents);

        const documentsWithTimestamps = documents.filter(d => d.metadata.startTime !== undefined).length;

        logger.info('MongoDB storage completed', {
          creatorId,
          videoId,
          documentsStored: documents.length,
          documentsWithTimestamps,
          timestampCoverage: `${Math.round((documentsWithTimestamps / documents.length) * 100)}%`
        });
      }
    } catch (mongoError) {
      logger.error('MongoDB storage failed', mongoError, { creatorId, videoId });
      throw new Error(`MongoDB storage failed: ${mongoError instanceof Error ? mongoError.message : String(mongoError)}`);
    }

    logger.info('RAG storage completed successfully', {
      creatorId,
      videoId,
      chunksStored: chunksWithEmbeddings.length,
      totalDocuments: chunksWithEmbeddings.length
    });

  } catch (error) {
    logger.error('RAG storage failed completely', error, {
      creatorId,
      videoId,
      chunkCount: chunks.length,
      processedChunks: chunksWithEmbeddings.length
    });
    throw error; // Re-throw for API error handling
  }
}

export async function searchSimilarChunks(
  creatorId: string,
  query: string,
  limit = 5,
  creatorMetadata?: {
    name?: string;
    topics?: string[];
    categories?: string[];
    recentVideos?: string[];
  }
): Promise<string[]> {
  logger.info('Searching for similar chunks', {
    creatorId,
    queryLength: query.length,
    limit,
    queryPreview: query.substring(0, 50) + (query.length > 50 ? '...' : ''),
    hasCreatorMetadata: !!creatorMetadata
  });

  // OPTIMIZATION: Skip query preprocessing - Gemini 2.5 Flash + context-aware search handles this
  // Raw query works better with semantic search
  const searchQuery = query;

  logger.info('Using raw query for semantic search (preprocessing disabled)', {
    query: searchQuery.substring(0, 100) + (searchQuery.length > 100 ? '...' : '')
  });

  // Use a higher search limit to get more candidates for filtering
  const searchLimit = Math.max(limit * 2, 10);

  const queryEmbedding = await createEmbedding(searchQuery);
  const results = await searchPinecone(creatorId, queryEmbedding, searchLimit);

  logger.info('Similar chunks search completed', {
    creatorId,
    resultsFound: results.length,
    requestedLimit: limit,
    searchLimit,
    preprocessingSkipped: true,
    resultsPreview: results.slice(0, 2).map(r => r.substring(0, 100) + '...')
  });

  // Return only the requested limit
  return results.slice(0, limit);
}

// Enhanced search function with detailed debugging
export async function searchSimilarChunksWithDetails(
  creatorId: string,
  query: string,
  limit = 5
): Promise<{
  chunks: string[];
  metadata: {
    queryLength: number;
    searchTime: number;
    totalCandidates: number;
    finalResults: number;
    avgSimilarity?: number;
    queryProcessing: ProcessedQuery['metadata'];
  };
}> {
  const startTime = Date.now();
  
  logger.info('Enhanced search starting', {
    creatorId,
    query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
    limit
  });

  try {
    // Preprocess the query for better search quality
    const processed = preprocessQuery(query);
    const searchQuery = getBestQueryForEmbedding(processed);
    
    logger.debug('Query preprocessing for detailed search', {
      originalQuery: query.substring(0, 50) + (query.length > 50 ? '...' : ''),
      processedQuery: searchQuery.substring(0, 50) + (searchQuery.length > 50 ? '...' : ''),
      improvements: processed.metadata
    });
    
    const searchLimit = Math.max(limit * 3, 15); // Even more candidates
    const queryEmbedding = await createEmbedding(searchQuery);
    const results = await searchPinecone(creatorId, queryEmbedding, searchLimit);
    
    const searchTime = Date.now() - startTime;
    const finalResults = results.slice(0, limit);
    
    const metadata = {
      queryLength: query.length,
      searchTime,
      totalCandidates: results.length,
      finalResults: finalResults.length,
      avgSimilarity: undefined as number | undefined,
      queryProcessing: processed.metadata
    };

    logger.info('Enhanced search completed', {
      ...metadata,
      queryWords: query.split(/\s+/).length,
      resultsPreview: finalResults.slice(0, 1).map(r => ({
        length: r.length,
        preview: r.substring(0, 80) + '...'
      }))
    });

    return {
      chunks: finalResults,
      metadata
    };
  } catch (error) {
    logger.error('Enhanced search failed', error, { creatorId, queryLength: query.length });
    return {
      chunks: [],
      metadata: {
        queryLength: query.length,
        searchTime: Date.now() - startTime,
        totalCandidates: 0,
        finalResults: 0,
        queryProcessing: {
          fillerWordsRemoved: 0,
          abbreviationsExpanded: 0,
          keywordsExtracted: 0,
          contextualTermsAdded: 0,
          processingTime: 0
        }
      }
    };
  }
}

// Diagnostic function to check RAG health
export async function diagnoseRAGHealth(creatorId: string): Promise<{
  totalChunks: number;
  sampleChunks: string[];
  indexHealth: {
    totalVectors: number;
    dimension: number;
    indexFullness: number;
  };
  testQuery: {
    query: string;
    results: number;
    searchTime: number;
  };
}> {
  logger.info('Starting RAG health diagnosis', { creatorId });

  try {
    // Get MongoDB stats
    const { db } = await connectToDatabase();
    const collection = db.collection('transcript_chunks');
    const totalChunks = await collection.countDocuments({ creatorId });
    
    // Get sample chunks
    const sampleDocs = await collection
      .find({ creatorId })
      .limit(3)
      .toArray();
    
    const sampleChunks = sampleDocs.map(doc => {
      const text = doc.text as string | undefined;
      return text 
        ? `${text.substring(0, 100)}... (${text.length} chars)`
        : 'No text content';
    });

    // Get Pinecone stats
    const { getIndexStats } = await import('./pinecone');
    const indexHealth = await getIndexStats();

    // Test search with a generic query
    const testQuery = 'what do you think about';
    const startTime = Date.now();
    const testResults = await searchSimilarChunks(creatorId, testQuery, 3);
    const searchTime = Date.now() - startTime;

    const diagnosis = {
      totalChunks,
      sampleChunks,
      indexHealth,
      testQuery: {
        query: testQuery,
        results: testResults.length,
        searchTime
      }
    };

    logger.info('RAG health diagnosis completed', {
      creatorId,
      diagnosis: {
        ...diagnosis,
        sampleChunks: sampleChunks.length
      }
    });

    return diagnosis;
  } catch (error) {
    logger.error('RAG health diagnosis failed', error, { creatorId });
    throw error;
  }
}