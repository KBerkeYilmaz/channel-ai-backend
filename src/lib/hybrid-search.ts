import { createLogger } from './logger';
import { connectToDatabase } from './mongodb';
import { createEmbedding } from './openai';
import { searchSimilarChunks as searchPinecone } from './pinecone';
import { preprocessQuery, getBestQueryForEmbedding, getKeywordsForSearch } from './query-preprocessing';

const logger = createLogger('HybridSearch');

export interface SearchResult {
  text: string;
  score: number;
  source: 'semantic' | 'keyword' | 'hybrid';
  metadata: {
    videoId: string;
    videoTitle?: string;
    chunkIndex: number;
    timestamp?: string;
    thumbnailUrl?: string;
    videoUrl?: string;
  };
}

export interface HybridSearchResults {
  results: SearchResult[];
  metadata: {
    totalResults: number;
    semanticResults: number;
    keywordResults: number;
    fusedResults: number;
    searchTime: number;
    queryProcessing: {
      original: string;
      processed: string;
      keywords: string[];
    };
  };
}

/**
 * Perform keyword search using MongoDB text search
 */
async function performKeywordSearch(
  creatorId: string,
  keywords: string[],
  limit = 10
): Promise<SearchResult[]> {
  const startTime = Date.now();
  
  try {
    const { db } = await connectToDatabase();
    const collection = db.collection('transcript_chunks');
    
    // Create text search query from keywords
    const searchQuery = keywords.join(' ');
    
    logger.debug('Performing MongoDB text search', {
      creatorId,
      searchQuery,
      keywords,
      limit
    });
    
    // MongoDB text search with scoring
    const results = await collection.find({
      creatorId,
      $text: { $search: searchQuery }
    })
    .project({ score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .toArray();
    
    const searchResults: SearchResult[] = results.map(doc => {
      const metadata = doc.metadata as Record<string, unknown> | undefined;
      return {
        text: doc.text as string,
        score: (doc.score as number) ?? 0,
        source: 'keyword' as const,
        metadata: {
          videoId: doc.videoId as string,
          videoTitle: metadata?.videoTitle as string | undefined,
          chunkIndex: doc.chunkIndex as number,
          timestamp: metadata?.timestamp as string | undefined,
          thumbnailUrl: metadata?.thumbnailUrl as string | undefined,
          videoUrl: metadata?.videoUrl as string | undefined
        }
      };
    });
    
    const searchTime = Date.now() - startTime;
    
    logger.info('Keyword search completed', {
      creatorId,
      searchQuery,
      resultsFound: searchResults.length,
      searchTime,
      topScores: searchResults.slice(0, 3).map(r => r.score.toFixed(3))
    });
    
    return searchResults;
    
  } catch (error) {
    logger.error('Keyword search failed', error, { creatorId, keywords });
    return [];
  }
}

/**
 * Perform semantic search using Pinecone
 */
async function performSemanticSearch(
  creatorId: string,
  query: string,
  limit = 10
): Promise<SearchResult[]> {
  const startTime = Date.now();
  
  try {
    logger.debug('Performing semantic search', {
      creatorId,
      query: query.substring(0, 50) + (query.length > 50 ? '...' : ''),
      limit
    });
    
    // Create embedding for semantic search
    const queryEmbedding = await createEmbedding(query);
    
    // Get raw results from Pinecone (we'll enhance this to get metadata)
    const chunks = await searchPinecone(creatorId, queryEmbedding, limit);
    
    // For now, convert to SearchResult format
    // TODO: Enhance searchPinecone to return metadata including scores
    const searchResults: SearchResult[] = chunks.map((text, index) => ({
      text,
      score: 0.8 - (index * 0.05), // Approximate scoring based on order
      source: 'semantic' as const,
      metadata: {
        videoId: 'unknown', // TODO: Extract from Pinecone metadata
        chunkIndex: index,
      }
    }));
    
    const searchTime = Date.now() - startTime;
    
    logger.info('Semantic search completed', {
      creatorId,
      resultsFound: searchResults.length,
      searchTime,
      topScores: searchResults.slice(0, 3).map(r => r.score.toFixed(3))
    });
    
    return searchResults;
    
  } catch (error) {
    logger.error('Semantic search failed', error, { creatorId, query });
    return [];
  }
}

/**
 * Fuse and rank results from semantic and keyword search
 */
function fuseAndRankResults(
  semanticResults: SearchResult[],
  keywordResults: SearchResult[],
  query: string,
  limit = 5
): SearchResult[] {
  logger.debug('Fusing search results', {
    semanticCount: semanticResults.length,
    keywordCount: keywordResults.length,
    targetLimit: limit
  });
  
  // Combine all results
  const allResults = [...semanticResults, ...keywordResults];
  
  // Remove duplicates based on text similarity (simple approach)
  const uniqueResults = allResults.filter((result, index, array) => {
    return !array.slice(0, index).some(prev => 
      prev.text.substring(0, 100) === result.text.substring(0, 100)
    );
  });
  
  // Calculate hybrid scores
  const scoredResults = uniqueResults.map(result => {
    let hybridScore = result.score;
    
    // Boost score based on source type
    if (result.source === 'semantic') {
      hybridScore *= 0.7; // 70% weight for semantic
    } else if (result.source === 'keyword') {
      hybridScore *= 0.3; // 30% weight for keyword
    }
    
    // Boost if query keywords appear in text
    const queryWords = query.toLowerCase().split(/\s+/);
    const textWords = result.text.toLowerCase();
    const keywordMatches = queryWords.filter(word => 
      word.length > 2 && textWords.includes(word)
    ).length;
    
    if (keywordMatches > 0) {
      hybridScore *= (1 + keywordMatches * 0.1); // 10% boost per keyword match
    }
    
    return {
      ...result,
      score: hybridScore,
      source: 'hybrid' as const
    };
  });
  
  // Sort by hybrid score and return top results
  const rankedResults = scoredResults
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  logger.info('Result fusion completed', {
    totalCombined: allResults.length,
    afterDeduplication: uniqueResults.length,
    finalResults: rankedResults.length,
    topScores: rankedResults.slice(0, 3).map(r => r.score.toFixed(3))
  });
  
  return rankedResults;
}

/**
 * Main hybrid search function
 */
export async function hybridSearch(
  creatorId: string,
  query: string,
  limit = 5
): Promise<HybridSearchResults> {
  const startTime = Date.now();
  
  logger.info('Starting hybrid search', {
    creatorId,
    query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
    limit
  });
  
  try {
    // Preprocess the query
    const processed = preprocessQuery(query);
    const semanticQuery = getBestQueryForEmbedding(processed);
    const keywords = getKeywordsForSearch(processed);
    
    logger.debug('Query preprocessing for hybrid search', {
      original: query.substring(0, 50) + (query.length > 50 ? '...' : ''),
      processed: semanticQuery.substring(0, 50) + (semanticQuery.length > 50 ? '...' : ''),
      keywords: keywords.slice(0, 5),
      improvements: processed.metadata
    });
    
    // Perform both searches in parallel
    const searchLimit = Math.max(limit * 2, 10);
    
    const [semanticResults, keywordResults] = await Promise.all([
      performSemanticSearch(creatorId, semanticQuery, searchLimit),
      keywords.length > 0 ? performKeywordSearch(creatorId, keywords, searchLimit) : Promise.resolve([])
    ]);
    
    // Fuse and rank results
    const fusedResults = fuseAndRankResults(
      semanticResults,
      keywordResults,
      semanticQuery,
      limit
    );
    
    const totalTime = Date.now() - startTime;
    
    const metadata = {
      totalResults: fusedResults.length,
      semanticResults: semanticResults.length,
      keywordResults: keywordResults.length,
      fusedResults: fusedResults.length,
      searchTime: totalTime,
      queryProcessing: {
        original: query,
        processed: semanticQuery,
        keywords: keywords.slice(0, 10)
      }
    };
    
    logger.info('Hybrid search completed', {
      ...metadata,
      topResults: fusedResults.slice(0, 2).map(r => ({
        score: r.score.toFixed(3),
        source: r.source,
        preview: r.text.substring(0, 80) + '...'
      }))
    });
    
    return {
      results: fusedResults,
      metadata
    };
    
  } catch (error) {
    logger.error('Hybrid search failed', error, { creatorId, query });
    
    return {
      results: [],
      metadata: {
        totalResults: 0,
        semanticResults: 0,
        keywordResults: 0,
        fusedResults: 0,
        searchTime: Date.now() - startTime,
        queryProcessing: {
          original: query,
          processed: query,
          keywords: []
        }
      }
    };
  }
}

/**
 * Enhanced search that returns just the text chunks (for backward compatibility)
 */
export async function hybridSearchChunks(
  creatorId: string,
  query: string,
  limit = 5
): Promise<string[]> {
  const results = await hybridSearch(creatorId, query, limit);
  return results.results.map(r => r.text);
}

// Types are already exported above with the interface declarations
