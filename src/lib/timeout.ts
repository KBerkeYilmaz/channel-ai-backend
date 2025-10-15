import { createLogger } from './logger';

const logger = createLogger('Timeout');

export interface TimeoutConfig {
  timeout: number;
  signal?: AbortSignal;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  context?: string
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    logger.warn('Operation timed out', {
      context: context ?? 'unknown-operation',
      timeout: timeoutMs
    });
    controller.abort();
  }, timeoutMs);

  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms: ${context ?? 'unknown-operation'}`));
    });
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise
  ]);
}

// Default timeout configurations for different services
export const TIMEOUT_CONFIGS = {
  youtube: 30000,    // 30 seconds for video processing
  pinecone: 15000,   // 15 seconds for vector operations
  groq: 20000,       // 20 seconds for LLM completion
  openai: 20000,     // 20 seconds for embeddings
  mongodb: 10000,    // 10 seconds for database operations
  api: 15000,        // 15 seconds for external API calls
  default: 10000     // 10 seconds default
} as const;

export function createTimeoutPromise<T>(
  operation: () => Promise<T>,
  service: keyof typeof TIMEOUT_CONFIGS,
  context?: string
): Promise<T> {
  const timeout = TIMEOUT_CONFIGS[service];
  const operationContext = context ?? `${service}-operation`;

  return withTimeout(operation(), timeout, operationContext);
}