import { createLogger } from './logger';

const logger = createLogger('TimestampMatching');

export interface TimestampSegment {
  text: string;
  timestampDisplay: string;
  timestampSeconds: number;
  endSeconds: number;
}

export interface TimestampMatch {
  startTime: number;
  endTime: number;
  matched: boolean;
  timestampDisplay?: string;
}

/**
 * OPTIMIZATION: Pre-process timestamp segments for faster matching
 * Creates fingerprints once instead of on every comparison
 */
export function preprocessTimestampSegments(segments: TimestampSegment[]) {
  return segments.map(seg => ({
    ...seg,
    // Pre-compute the fingerprint for O(1) comparisons
    fingerprint: seg.text
      .replace(/\d+:\d+/g, '') // Remove timestamps from text
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 20)
      .join(' ')
  }));
}

/**
 * SHARED FUNCTION: Match a text chunk to the best timestamp segment
 * Used across multiple parts of the system for consistent timestamp assignment
 */
export function matchChunkToTimestamp(
  chunkText: string,
  segments: TimestampSegment[],
  chunkIndex: number,
  totalChunks: number
): TimestampMatch {
  logger.info('🔍 TIMESTAMP MATCHING STARTED', {
    chunkIndex,
    totalChunks,
    totalSegments: segments?.length || 0,
    chunkLength: chunkText.length,
    chunkPreview: chunkText.substring(0, 100) + '...',
    hasSegments: !!segments && segments.length > 0
  });

  if (!segments || segments.length === 0) {
    logger.warn('⚠️ NO SEGMENTS AVAILABLE - Using zero timestamps', {
      chunkIndex,
      chunkPreview: chunkText.substring(0, 50)
    });
    return {
      startTime: 0,
      endTime: 0,
      matched: false
    };
  }

  // Pre-process segments if not already done
  const preprocessedSegments = preprocessTimestampSegments(segments);

  // Create chunk fingerprint
  const chunkFingerprint = chunkText
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 20)
    .join(' ');

  logger.info('🔎 Chunk fingerprint created', {
    chunkIndex,
    fingerprintLength: chunkFingerprint.length,
    fingerprintWords: chunkFingerprint.split(' ').length,
    fingerprint: chunkFingerprint.substring(0, 80)
  });

  // Find best matching segment using pre-computed fingerprints
  let matchFound = false;
  let matchingSegment = null;

  for (const seg of preprocessedSegments) {
    const segmentFp = seg.fingerprint;
    const chunkIncludesSegment = chunkFingerprint.includes(segmentFp.substring(0, 50));
    const segmentIncludesChunk = segmentFp.includes(chunkFingerprint.substring(0, 50));

    if (chunkIncludesSegment || segmentIncludesChunk) {
      matchingSegment = seg;
      matchFound = true;
      logger.info('✅ EXACT MATCH FOUND', {
        chunkIndex,
        matchType: chunkIncludesSegment ? 'chunk-includes-segment' : 'segment-includes-chunk',
        segmentTimestamp: seg.timestampDisplay,
        segmentStart: seg.timestampSeconds,
        segmentEnd: seg.endSeconds,
        segmentPreview: seg.text.substring(0, 80),
        segmentFingerprint: segmentFp.substring(0, 80)
      });
      break;
    }
  }

  if (matchingSegment) {
    const result = {
      startTime: matchingSegment.timestampSeconds,
      endTime: matchingSegment.endSeconds,
      timestampDisplay: matchingSegment.timestampDisplay,
      matched: true
    };

    logger.info('🎯 TIMESTAMP ASSIGNED (Matched)', {
      chunkIndex,
      startTime: result.startTime,
      endTime: result.endTime,
      duration: result.endTime - result.startTime,
      timestampDisplay: result.timestampDisplay,
      matchQuality: 'exact'
    });

    return result;
  }

  // Fallback: Use proportional positioning
  const chunkPosition = chunkIndex / totalChunks;
  const totalDuration = segments[segments.length - 1]?.endSeconds || 0;
  const startTime = Math.floor(chunkPosition * totalDuration);
  const endTime = Math.floor((chunkPosition + (1 / totalChunks)) * totalDuration);

  logger.warn('⚠️ NO MATCH - Using proportional positioning', {
    chunkIndex,
    totalChunks,
    chunkPosition: `${(chunkPosition * 100).toFixed(1)}%`,
    totalDuration,
    calculatedStartTime: startTime,
    calculatedEndTime: endTime,
    chunkPreview: chunkText.substring(0, 80),
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

  return {
    startTime,
    endTime,
    matched: false
  };
}
