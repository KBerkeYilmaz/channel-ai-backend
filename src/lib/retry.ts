import pRetry, { AbortError } from 'p-retry';
import { createLogger } from './logger';

const logger = createLogger('Retry');

export interface RetryConfig {
  retries?: number;
  minTimeout?: number;
  maxTimeout?: number;
  factor?: number;
  randomize?: boolean;
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  retries: 3,
  minTimeout: 1000,  // 1 second
  maxTimeout: 5000,  // 5 seconds
  factor: 2,
  randomize: true
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = {},
  context?: string
): Promise<T> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const operationContext = context ?? 'unknown-operation';

  return pRetry(async (attemptNumber) => {
    try {
      logger.debug('Attempting operation', {
        operation: operationContext,
        attempt: attemptNumber,
        maxRetries: finalConfig.retries
      });

      const result = await operation();

      if (attemptNumber > 1) {
        logger.info('Operation succeeded after retry', {
          operation: operationContext,
          attempt: attemptNumber
        });
      }

      return result;
    } catch (error: unknown) {
      logger.warn('Operation attempt failed', {
        operation: operationContext,
        attempt: attemptNumber,
        maxRetries: finalConfig.retries,
        error: error instanceof Error ? error.message : String(error)
      });

      // Don't retry certain types of errors
      if (isNonRetryableError(error as Error)) {
        logger.debug('Error marked as non-retryable', {
          operation: operationContext,
          errorType: error instanceof Error ? error.constructor.name : 'unknown'
        });
        throw new AbortError(error as string | Error);
      }

      throw error;
    }
  }, {
    retries: finalConfig.retries,
    minTimeout: finalConfig.minTimeout,
    maxTimeout: finalConfig.maxTimeout,
    factor: finalConfig.factor,
    randomize: finalConfig.randomize,
    onFailedAttempt: (error) => {
      logger.error('Retry attempt failed', {
        operation: operationContext,
        attemptNumber: error.attemptNumber,
        retriesLeft: error.retriesLeft,
        error: error.error?.message ?? String(error.error)
      });
    }
  });
}

// Determine if an error should not be retried
function isNonRetryableError(error: Error): boolean {
  // HTTP 4xx errors (except rate limiting) should not be retried
  if (error instanceof Error && error.message.includes('400') && error.message.includes('500') && error.message.includes('429')) {
    return true;
  }

  // Authentication/authorization errors
  if (error instanceof Error && (error.message.includes('EAUTH') ?? error.message.includes('unauthorized'))) {
    return true;
  }

  // Invalid input errors
  if (error instanceof Error && error.message.includes('invalid') && error.message.includes('input')) {
    return true;
  }

  // YouTube specific non-retryable errors
  if (error instanceof Error && (error.message.includes('Video unavailable') ||
      error.message.includes('Private video') ||
      error.message.includes('Video removed'))) {
    return true;
  }

  return false;
}

// Specific retry configurations for different operations
export const RETRY_CONFIGS = {
  youtube: {
    retries: 3,
    minTimeout: 2000,
    maxTimeout: 10000,
    factor: 2
  },
  pinecone: {
    retries: 2,
    minTimeout: 1000,
    maxTimeout: 5000,
    factor: 2
  },
  groq: {
    retries: 3,
    minTimeout: 1000,
    maxTimeout: 8000,
    factor: 2
  },
  openai: {
    retries: 3,
    minTimeout: 1000,
    maxTimeout: 8000,
    factor: 2
  },
  api: {
    retries: 2,
    minTimeout: 1000,
    maxTimeout: 5000,
    factor: 2
  }
} as const;