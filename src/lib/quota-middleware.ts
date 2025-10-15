import { type NextRequest, NextResponse } from 'next/server';
import { resourceMonitor } from './monitoring';
import { createLogger } from './logger';

const logger = createLogger('QuotaMiddleware');

export interface QuotaMiddlewareOptions {
  service: string;
  operation: string;
  enabled?: boolean;
  skipPaths?: string[];
}

// Quota enforcement middleware
export function withQuotaCheck(options: QuotaMiddlewareOptions) {
  return async function quotaMiddleware<T>(
    request: NextRequest,
    handler: (request: NextRequest) => Promise<T>
  ): Promise<T | NextResponse> {

    // Skip if middleware disabled
    if (options.enabled === false) {
      return handler(request);
    }

    // Skip for certain paths
    if (options.skipPaths?.some(path => request.nextUrl.pathname.includes(path))) {
      return handler(request);
    }

    try {
      // Check if request should be blocked
      const { blocked, reason } = await resourceMonitor.shouldBlockRequest(options.service);

      if (blocked) {
        logger.warn('Request blocked by quota limit', {
          service: options.service,
          operation: options.operation,
          path: request.nextUrl.pathname,
          reason
        });

        return NextResponse.json(
          {
            error: 'Service quota exceeded',
            message: reason ?? 'Please try again later or contact support',
            service: options.service,
            retryAfter: '24h' // Suggest retry after daily reset
          },
          { status: 429 }
        );
      }

      // Proceed with request
      return handler(request);

    } catch (error: unknown) {
      logger.error('Quota middleware error', error, {
        service: options.service,
        operation: options.operation
      });

      // On error, allow request to proceed (fail open)
      return handler(request);
    }
  };
}

// Service-specific middleware creators
export const withOpenAIQuota = (operation: string, options?: Omit<QuotaMiddlewareOptions, 'service' | 'operation'>) =>
  withQuotaCheck({ service: 'openai', operation, ...options });

export const withGroqQuota = (operation: string, options?: Omit<QuotaMiddlewareOptions, 'service' | 'operation'>) =>
  withQuotaCheck({ service: 'groq', operation, ...options });

export const withPineconeQuota = (operation: string, options?: Omit<QuotaMiddlewareOptions, 'service' | 'operation'>) =>
  withQuotaCheck({ service: 'pinecone', operation, ...options });

// Rate limiting information for responses
export function addRateLimitHeaders(response: NextResponse, service: string): NextResponse {
  try {
    // Add standard rate limit headers
    response.headers.set('X-RateLimit-Service', service);
    response.headers.set('X-RateLimit-Reset', new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

    // Note: We could add more specific headers here if we track them
    // response.headers.set('X-RateLimit-Remaining', remaining.toString());
    // response.headers.set('X-RateLimit-Limit', limit.toString());

    return response;
  } catch (error: unknown) {
    logger.error('Failed to add rate limit headers', error);
    return response;
  }
}

// Usage tracking decorator for API routes
export function trackAPIUsage(service: string, operation: string) {
  return function decorator<T extends unknown[], R>(
    target: unknown,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<(...args: T) => Promise<R>>
  ) {
    const originalMethod = descriptor.value;

    if (originalMethod) {
      descriptor.value = async function (...args: T): Promise<R> {
        const startTime = Date.now();

        try {
          const result = await originalMethod.apply(this, args);

          // Track successful usage
          const duration = Date.now() - startTime;
          await resourceMonitor.trackUsage(service, operation, 0, {
            success: true,
            duration,
            timestamp: new Date()
          });

          return result;
        } catch (error: unknown) {
          // Track failed usage
          const duration = Date.now() - startTime;
          await resourceMonitor.trackUsage(service, operation, 0, {
            success: false,
            duration,
            error: error instanceof Error ? error.message : String(error as string),
            timestamp: new Date()
          });

          throw error;
        }
      };
    }

    return descriptor;
  };
}

// Express-style middleware for manual usage in API routes
export async function checkServiceQuota(
  service: string,
  operation: string
): Promise<{ allowed: boolean; response?: NextResponse }> {
  try {
    const { blocked, reason } = await resourceMonitor.shouldBlockRequest(service);

    if (blocked) {
      logger.warn('Service quota exceeded', { service, operation, reason });

      return {
        allowed: false,
        response: NextResponse.json(
          {
            error: 'Service quota exceeded',
            message: reason ?? 'Please try again later',
            service,
            operation,
            retryAfter: '24h'
          },
          { status: 429 }
        )
      };
    }

    return { allowed: true };
  } catch (error: unknown) {
    logger.error('Quota check failed', error, { service, operation });
    // Fail open - allow request on error
    return { allowed: true };
  }
}