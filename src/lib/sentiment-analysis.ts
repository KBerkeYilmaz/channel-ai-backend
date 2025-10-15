import Sentiment from 'sentiment';
import nlp from 'compromise';
import { createLogger } from './logger';

const logger = createLogger('SentimentAnalysis');

// Initialize sentiment analyzer
const sentimentAnalyzer = new Sentiment();

export interface ChunkSentimentData {
  // Sentiment scores
  sentimentScore: number;           // Raw score (can be negative)
  sentimentComparative: number;     // Normalized score (-1 to 1)

  // Engagement markers
  exclamationCount: number;         // Number of exclamations ("wow!", "oh no!")
  questionCount: number;            // Number of questions
  hasExclamation: boolean;          // Quick filter flag
  hasQuestion: boolean;             // Quick filter flag

  // Emotional intensity (for "moment" detection)
  emotionalIntensity: number;       // 0-1, higher = more emotional/exciting
  isHighlightCandidate: boolean;    // Automatic flag for potential "moments"

  // Positive/negative words
  positiveWords: string[];
  negativeWords: string[];
}

/**
 * Analyze a text chunk for sentiment and engagement signals
 */
export function analyzeSentiment(text: string): ChunkSentimentData {
  // Sentiment analysis
  const sentimentResult = sentimentAnalyzer.analyze(text);

  // NLP analysis with compromise
  const doc = nlp(text);

  // Extract exclamations
  const exclamations = doc.match('#Exclamation');
  const exclamationCount = exclamations.length;

  // Extract questions
  const questions = doc.questions();
  const questionCount = questions.length;

  // Calculate emotional intensity
  // Higher absolute comparative score = more emotional (positive or negative)
  const emotionalIntensity = Math.min(Math.abs(sentimentResult.comparative) * 2, 1);

  // Determine if this is a highlight candidate
  // Criteria: high emotional intensity OR multiple exclamations
  const isHighlightCandidate =
    emotionalIntensity > 0.3 ||
    exclamationCount >= 2 ||
    (sentimentResult.score > 3 && exclamationCount >= 1);

  const result: ChunkSentimentData = {
    sentimentScore: sentimentResult.score,
    sentimentComparative: sentimentResult.comparative,
    exclamationCount,
    questionCount,
    hasExclamation: exclamationCount > 0,
    hasQuestion: questionCount > 0,
    emotionalIntensity,
    isHighlightCandidate,
    positiveWords: sentimentResult.positive || [],
    negativeWords: sentimentResult.negative || []
  };

  // Log only highlight candidates to avoid spam
  if (isHighlightCandidate) {
    logger.debug('Highlight candidate detected', {
      textPreview: text.substring(0, 80) + '...',
      sentimentScore: result.sentimentScore,
      emotionalIntensity: result.emotionalIntensity.toFixed(2),
      exclamations: exclamationCount,
      positiveWords: result.positiveWords.slice(0, 3),
      negativeWords: result.negativeWords.slice(0, 3)
    });
  }

  return result;
}

/**
 * Batch analyze multiple chunks
 */
export function analyzeSentimentBatch(chunks: string[]): ChunkSentimentData[] {
  logger.info('Starting batch sentiment analysis', {
    chunkCount: chunks.length
  });

  const startTime = Date.now();
  const results = chunks.map(chunk => analyzeSentiment(chunk));
  const processingTime = Date.now() - startTime;

  const highlightCandidates = results.filter(r => r.isHighlightCandidate);

  logger.info('Batch sentiment analysis completed', {
    totalChunks: chunks.length,
    highlightCandidates: highlightCandidates.length,
    highlightPercentage: `${Math.round((highlightCandidates.length / chunks.length) * 100)}%`,
    avgEmotionalIntensity: (results.reduce((sum, r) => sum + r.emotionalIntensity, 0) / results.length).toFixed(2),
    processingTime: `${processingTime}ms`,
    avgTimePerChunk: `${(processingTime / chunks.length).toFixed(1)}ms`
  });

  return results;
}

/**
 * Get top N most emotional/exciting chunks
 */
export function getTopEmotionalChunks(
  chunks: Array<{ text: string; sentiment: ChunkSentimentData }>,
  topN = 10
): Array<{ text: string; sentiment: ChunkSentimentData; rank: number }> {
  // Sort by emotional intensity (descending)
  const sorted = [...chunks]
    .sort((a, b) => b.sentiment.emotionalIntensity - a.sentiment.emotionalIntensity)
    .slice(0, topN)
    .map((chunk, index) => ({
      ...chunk,
      rank: index + 1
    }));

  logger.info('Top emotional chunks identified', {
    topN,
    topScores: sorted.slice(0, 3).map(c => ({
      rank: c.rank,
      intensity: c.sentiment.emotionalIntensity.toFixed(2),
      score: c.sentiment.sentimentScore,
      preview: c.text.substring(0, 50) + '...'
    }))
  });

  return sorted;
}
