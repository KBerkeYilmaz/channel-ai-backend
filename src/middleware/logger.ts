import { logger } from 'hono/logger';
import pino from 'pino';

// Create structured logger
export const structuredLogger = pino({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  } : undefined,
});

// Hono logger middleware
export const loggerMiddleware = logger((message, ...rest) => {
  structuredLogger.info({ message, extra: rest }, 'HTTP Request');
});
