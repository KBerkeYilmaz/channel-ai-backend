import Redis from 'ioredis';
import { structuredLogger } from '../middleware/logger';

// Redis connection configuration
const redisConfig = {
  host: Bun.env.REDISHOST || 'localhost',
  port: Number(Bun.env.REDISPORT) || 6379,
  password: Bun.env.REDISPASSWORD,
  username: Bun.env.REDISUSER,
  maxRetriesPerRequest: null,
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
};

export const redisClient = new Redis(redisConfig);

// Redis connection event handlers
redisClient.on('connect', () => {
  structuredLogger.info({ host: redisConfig.host, port: redisConfig.port }, 'Redis client connecting...');
});

redisClient.on('ready', () => {
  structuredLogger.info({ host: redisConfig.host, port: redisConfig.port }, 'Redis client connected and ready');
});

redisClient.on('error', (err) => {
  structuredLogger.error({ error: err }, 'Redis client error');
});

redisClient.on('close', () => {
  structuredLogger.warn({ host: redisConfig.host }, 'Redis client connection closed');
});

// Key prefix for namespacing (prevents conflicts with other services)
export const REDIS_PREFIX = 'yt-processor:';

// TTL for job data (24 hours)
export const JOB_TTL_SECONDS = 86400;

