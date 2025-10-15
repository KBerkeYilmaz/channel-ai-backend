import { createLogger } from './logger';

const logger = createLogger('QueryPreprocessing');

export interface ProcessedQuery {
  original: string;
  cleaned: string;
  expanded: string;
  metadataExpanded: string;
  keywords: string[];
  contextualTerms: string[];
  metadata: {
    fillerWordsRemoved: number;
    abbreviationsExpanded: number;
    keywordsExtracted: number;
    contextualTermsAdded: number;
    processingTime: number;
  };
}

// Common filler words to remove
const FILLER_WORDS = new Set([
  'um', 'uh', 'like', 'you know', 'basically', 'actually', 'literally',
  'i mean', 'sort of', 'kind of', 'well', 'so', 'right', 'okay', 'ok',
  'yeah', 'yes', 'no', 'just', 'really', 'very', 'quite', 'pretty',
  'totally', 'completely', 'absolutely', 'definitely', 'probably',
  'maybe', 'perhaps', 'anyway', 'anyways', 'obviously', 'clearly'
]);

// Common abbreviations and acronyms to expand
const ABBREVIATIONS = new Map([
  // AI/Tech terms
  ['ai', 'artificial intelligence'],
  ['ml', 'machine learning'],
  ['dl', 'deep learning'],
  ['nlp', 'natural language processing'],
  ['api', 'application programming interface'],
  ['ui', 'user interface'],
  ['ux', 'user experience'],
  ['seo', 'search engine optimization'],
  ['css', 'cascading style sheets'],
  ['html', 'hypertext markup language'],
  ['js', 'javascript'],
  ['ts', 'typescript'],
  
  // YouTube/Content terms
  ['yt', 'youtube'],
  ['vid', 'video'],
  ['vids', 'videos'],
  ['sub', 'subscriber'],
  ['subs', 'subscribers'],
  ['ctr', 'click through rate'],
  ['cpm', 'cost per mille'],
  ['rpm', 'revenue per mille'],
  
  // Business terms
  ['roi', 'return on investment'],
  ['kpi', 'key performance indicator'],
  ['b2b', 'business to business'],
  ['b2c', 'business to consumer'],
  ['saas', 'software as a service'],
  
  // General abbreviations
  ['etc', 'etcetera'],
  ['vs', 'versus'],
  ['w/', 'with'],
  ['w/o', 'without'],
  ['&', 'and'],
  ['+', 'and'],
]);

// Contextual term expansion based on topic domains
const CONTEXTUAL_EXPANSIONS = new Map([
  // Gaming terms
  ['game', ['gameplay', 'gaming', 'video game', 'esports', 'competitive']],
  ['fps', ['first person shooter', 'frames per second', 'shooting game']],
  ['mmo', ['massively multiplayer online', 'online game', 'multiplayer']],
  ['pvp', ['player versus player', 'competitive', 'multiplayer combat']],
  ['pve', ['player versus environment', 'campaign', 'single player']],
  
  // YouTube/Content terms
  ['content', ['video content', 'creator content', 'entertainment', 'media']],
  ['creator', ['content creator', 'youtuber', 'influencer', 'streamer']],
  ['stream', ['streaming', 'live stream', 'broadcast', 'live content']],
  ['thumbnail', ['video thumbnail', 'preview image', 'cover image']],
  ['monetization', ['revenue', 'income', 'earnings', 'ad revenue']],
  
  // Tech/Science terms
  ['algorithm', ['machine learning', 'ai algorithm', 'computational method']],
  ['data', ['dataset', 'information', 'analytics', 'statistics']],
  ['analysis', ['research', 'study', 'examination', 'investigation']],
  ['optimization', ['improvement', 'enhancement', 'efficiency', 'performance']],
  
  // Business terms
  ['strategy', ['business strategy', 'approach', 'methodology', 'plan']],
  ['growth', ['expansion', 'scaling', 'development', 'increase']],
  ['marketing', ['promotion', 'advertising', 'branding', 'outreach']],
  ['audience', ['viewers', 'subscribers', 'community', 'followers']],
]);

// Stop words that don't add semantic value
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
  'to', 'was', 'will', 'with', 'this', 'these', 'they', 'them', 'their',
  // Question words that don't add meaning without context
  'what', 'how', 'why', 'when', 'where', 'who', 'which', 'whose',
  'did', 'do', 'does', 'can', 'could', 'would', 'should', 'you', 'your',
  'have', 'had', 'been', 'being', 'were'
]);

/**
 * Remove filler words from the query
 */
function removeFillerWords(text: string): { cleaned: string; removed: number } {
  const words = text.toLowerCase().split(/\s+/);
  let removed = 0;
  
  const cleanedWords = words.filter(word => {
    const cleanWord = word.replace(/[^\w\s]/g, ''); // Remove punctuation
    if (FILLER_WORDS.has(cleanWord)) {
      removed++;
      return false;
    }
    return true;
  });
  
  return {
    cleaned: cleanedWords.join(' '),
    removed
  };
}

/**
 * Expand abbreviations and acronyms
 */
function expandAbbreviations(text: string): { expanded: string; expansions: number } {
  let expanded = text.toLowerCase();
  let expansions = 0;
  
  // Sort by length (longest first) to avoid partial replacements
  const sortedAbbrevs = Array.from(ABBREVIATIONS.entries())
    .sort(([a], [b]) => b.length - a.length);
  
  for (const [abbrev, expansion] of sortedAbbrevs) {
    // Use word boundaries to avoid partial matches
    const regex = new RegExp(`\\b${abbrev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const matches = expanded.match(regex);
    if (matches) {
      expanded = expanded.replace(regex, expansion);
      expansions += matches.length;
    }
  }
  
  return { expanded, expansions };
}

/**
 * Extract important keywords from the query
 */
function extractKeywords(text: string): string[] {
  const words = text.toLowerCase()
    .split(/\s+/)
    .map(word => word.replace(/[^\w]/g, '')) // Remove punctuation
    .filter(word =>
      word.length > 2 && // Ignore very short words
      !STOP_WORDS.has(word) && // Remove stop words
      !FILLER_WORDS.has(word) // Remove filler words
    );

  // If no keywords remain after filtering, return original words (context will help)
  if (words.length === 0) {
    logger.debug('No keywords after filtering, returning original text words', {
      originalText: text.substring(0, 50)
    });
    return text.toLowerCase()
      .split(/\s+/)
      .map(word => word.replace(/[^\w]/g, ''))
      .filter(word => word.length > 0)
      .slice(0, 10);
  }

  // Count word frequency
  const wordCount = new Map<string, number>();
  words.forEach(word => {
    wordCount.set(word, (wordCount.get(word) ?? 0) + 1);
  });

  // Sort by frequency and return top keywords
  return Array.from(wordCount.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10) // Top 10 keywords
    .map(([word]) => word);
}

/**
 * Normalize whitespace and punctuation
 */
function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, ' ') // Multiple spaces to single space
    .replace(/[.,!?;]+/g, ' ') // Replace punctuation with spaces
    .replace(/\s+/g, ' ') // Clean up multiple spaces again
    .trim();
}

/**
 * Add contextual terms based on detected topics and domains
 */
function addContextualTerms(text: string, keywords: string[]): { 
  expanded: string; 
  contextualTerms: string[];
  termsAdded: number;
} {
  const contextualTerms: string[] = [];
  let expanded = text;
  
  // Find contextual expansions for keywords
  for (const keyword of keywords) {
    const expansions = CONTEXTUAL_EXPANSIONS.get(keyword.toLowerCase());
    if (expansions) {
      // Add relevant contextual terms (limit to avoid over-expansion)
      const relevantTerms = expansions.slice(0, 2); // Top 2 most relevant
      contextualTerms.push(...relevantTerms);
      
      // Add to expanded text
      expanded += ' ' + relevantTerms.join(' ');
    }
  }
  
  // Remove duplicates
  const uniqueContextualTerms = [...new Set(contextualTerms)];
  
  return {
    expanded,
    contextualTerms: uniqueContextualTerms,
    termsAdded: uniqueContextualTerms.length
  };
}

/**
 * Enhanced query preprocessing with metadata expansion
 */
export function preprocessQuery(query: string, creatorMetadata?: {
  name?: string;
  topics?: string[];
  categories?: string[];
  recentVideos?: string[];
}): ProcessedQuery {
  const startTime = Date.now();
  
  logger.debug('Starting enhanced query preprocessing', {
    originalQuery: query,
    originalLength: query.length,
    hasCreatorMetadata: !!creatorMetadata
  });
  
  // Step 1: Normalize the input
  const normalized = normalizeText(query);
  
  // Step 2: Remove filler words
  const { cleaned, removed: fillerWordsRemoved } = removeFillerWords(normalized);
  
  // Step 3: Expand abbreviations
  const { expanded, expansions: abbreviationsExpanded } = expandAbbreviations(cleaned);
  
  // Step 4: Extract keywords
  const keywords = extractKeywords(expanded);
  
  // Step 5: Add contextual terms based on content domain
  const { 
    expanded: contextuallyExpanded, 
    contextualTerms, 
    termsAdded: contextualTermsAdded 
  } = addContextualTerms(expanded, keywords);
  
  // Step 6: Add creator-specific metadata expansion
  let metadataExpanded = contextuallyExpanded;
  if (creatorMetadata) {
    const metadataTerms: string[] = [];
    
    // Add creator topics/categories as context
    if (creatorMetadata.topics?.length) {
      metadataTerms.push(...creatorMetadata.topics.slice(0, 3));
    }
    
    if (creatorMetadata.categories?.length) {
      metadataTerms.push(...creatorMetadata.categories.slice(0, 2));
    }
    
    // Add recent video context if relevant
    if (creatorMetadata.recentVideos?.length) {
      // Extract key terms from recent video titles
      const recentTerms = creatorMetadata.recentVideos
        .join(' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(term => term.length > 3 && !STOP_WORDS.has(term))
        .slice(0, 5);
      
      metadataTerms.push(...recentTerms);
    }
    
    if (metadataTerms.length > 0) {
      metadataExpanded += ' ' + metadataTerms.join(' ');
    }
  }
  
  const processingTime = Date.now() - startTime;
  
  const result: ProcessedQuery = {
    original: query,
    cleaned,
    expanded,
    metadataExpanded,
    keywords,
    contextualTerms,
    metadata: {
      fillerWordsRemoved,
      abbreviationsExpanded,
      keywordsExtracted: keywords.length,
      contextualTermsAdded,
      processingTime
    }
  };
  
  logger.info('Enhanced query preprocessing completed', {
    original: query.substring(0, 50) + (query.length > 50 ? '...' : ''),
    cleaned: cleaned.substring(0, 50) + (cleaned.length > 50 ? '...' : ''),
    expanded: expanded.substring(0, 50) + (expanded.length > 50 ? '...' : ''),
    metadataExpanded: metadataExpanded.substring(0, 80) + (metadataExpanded.length > 80 ? '...' : ''),
    keywordCount: keywords.length,
    contextualTermsCount: contextualTerms.length,
    topKeywords: keywords.slice(0, 3),
    topContextualTerms: contextualTerms.slice(0, 3),
    ...result.metadata
  });
  
  return result;
}

/**
 * Get the best query string for embedding generation
 * Uses the metadata-expanded version for maximum context
 */
export function getBestQueryForEmbedding(processed: ProcessedQuery): string {
  // Use metadata-expanded version for maximum context, fallback to expanded, then cleaned, then original
  return processed.metadataExpanded ?? processed.expanded ?? processed.cleaned ?? processed.original;
}

/**
 * Get the contextual query for semantic search (includes domain context)
 */
export function getContextualQueryForSearch(processed: ProcessedQuery): string {
  // Combine expanded query with contextual terms for richer semantic search
  const baseQuery = processed.expanded ?? processed.cleaned ?? processed.original;
  const contextualAddition = processed.contextualTerms.length > 0 
    ? ' ' + processed.contextualTerms.slice(0, 3).join(' ')
    : '';
  
  return baseQuery + contextualAddition;
}

/**
 * Get keywords for potential keyword search
 */
export function getKeywordsForSearch(processed: ProcessedQuery): string[] {
  return processed.keywords;
}

/**
 * Validate if query preprocessing improved the query
 */
export function validatePreprocessing(processed: ProcessedQuery): {
  improved: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  let improved = false;
  
  if (processed.metadata.fillerWordsRemoved > 0) {
    reasons.push(`Removed ${processed.metadata.fillerWordsRemoved} filler words`);
    improved = true;
  }
  
  if (processed.metadata.abbreviationsExpanded > 0) {
    reasons.push(`Expanded ${processed.metadata.abbreviationsExpanded} abbreviations`);
    improved = true;
  }
  
  if (processed.keywords.length > 0) {
    reasons.push(`Extracted ${processed.keywords.length} keywords`);
    improved = true;
  }
  
  if (processed.expanded.length > processed.original.length * 1.1) {
    reasons.push('Expanded query provides more context');
    improved = true;
  }
  
  return { improved, reasons };
}

// ProcessedQuery type is already exported above with the interface declaration
