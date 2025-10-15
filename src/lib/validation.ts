import { z } from 'zod';
import { createLogger } from './logger';

const logger = createLogger('Validation');

// YouTube URL validation regex
const YOUTUBE_URL_REGEX = /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})$/;

// Validation schemas
export const CreatorSetupSchema = z.object({
  creatorName: z.string()
    .min(1, 'Creator name is required')
    .max(100, 'Creator name must be less than 100 characters')
    .regex(/^[a-zA-Z0-9\s\-_.']+$/, 'Creator name contains invalid characters'),

  description: z.string()
    .max(500, 'Description must be less than 500 characters')
    .optional(),

  channelInput: z.string()
    .min(1, 'Channel input is required')
    .max(200, 'Channel input must be less than 200 characters'),

  videoCount: z.number()
    .min(1, 'At least 1 video is required')
    .max(50, 'Maximum 50 videos allowed')
    .optional()
    .default(20)
});

export const ChatMessageSchema = z.object({
  message: z.string()
    .min(1, 'Message cannot be empty')
    .max(1000, 'Message must be less than 1000 characters')
    .refine(
      (msg) => msg.trim().length > 0,
      'Message cannot be only whitespace'
    ),

  sessionId: z.string()
    .min(1, 'Session ID is required')
    .max(100, 'Session ID is too long')
    .regex(/^[a-zA-Z0-9\-_]+$/, 'Invalid session ID format')
});

export const CreatorSlugSchema = z.string()
  .min(1, 'Creator slug is required')
  .max(100, 'Creator slug is too long')
  .regex(/^[a-z0-9\-]+$/, 'Invalid creator slug format');

// Validation helper functions
export function validateAndSanitizeInput<T>(
  data: unknown,
  schema: z.ZodSchema<T>,
  context?: string
): { success: true; data: T } | { success: false; errors: string[] } {
  try {
    const validatedData = schema.parse(data);

    logger.debug('Input validation successful', {
      context: context ?? 'unknown',
      dataType: typeof data
    });

    return { success: true, data: validatedData };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map(err => `${err.path.join('.')}: ${err.message}`);

      logger.warn('Input validation failed', {
        context: context ?? 'unknown',
        errors,
        inputType: typeof data
      });

      return { success: false, errors };
    }

    logger.error('Unexpected validation error', error, { context });
    return { success: false, errors: ['Validation failed'] };
  }
}

// YouTube URL specific validation
export function validateYouTubeUrl(url: string): { valid: boolean; videoId?: string; error?: string } {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required and must be a string' };
  }

  const match = YOUTUBE_URL_REGEX.exec(url);
  if (!match?.[1]) {
    return { valid: false, error: 'Invalid YouTube URL format' };
  }

  const videoId = match[1];

  // Additional video ID validation
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return { valid: false, error: 'Invalid YouTube video ID' };
  }

  return { valid: true, videoId };
}

// Content sanitization
export function sanitizeText(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }

  return text
    .trim()
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '') // Remove control characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .substring(0, 10000); // Limit length for safety
}

// Rate limiting helpers
export function createRateLimitKey(identifier: string, endpoint: string): string {
  return `rate_limit:${endpoint}:${identifier}`;
}

// Security helpers
export function isValidSessionId(sessionId: string): boolean {
  return /^[a-zA-Z0-9\-_]{8,100}$/.test(sessionId);
}

export function generateSecureSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2);
  return `${timestamp}-${random}`;
}

// Content filtering (basic implementation)
export function containsInappropriateContent(text: string): boolean {
  const inappropriatePatterns = [
    /\b(spam|phishing|malware)\b/i,
    /\b(hack|crack|pirate)\b/i,
    // Add more patterns as needed
  ];

  return inappropriatePatterns.some(pattern => pattern.test(text));
}

// Export validation result type
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: string[] };