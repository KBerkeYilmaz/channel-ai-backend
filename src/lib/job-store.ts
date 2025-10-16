import { redisClient, REDIS_PREFIX, JOB_TTL_SECONDS } from './redis';
import { structuredLogger } from '../middleware/logger';

// Job storage interface - matches ProcessingJob from process.ts
export interface ProcessingJob {
  jobId: string;
  creatorId: string;
  creatorSlug: string;
  channelUrl: string;
  chatUrl: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: {
    current: number;
    total: number;
  };
  result?: {
    processedVideos: number;
    totalChunks: number;
    failedVideos: number;
  };
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Redis-based job storage
 * Replaces in-memory Map with persistent Redis storage
 */
export class RedisJobStore {
  private prefix = REDIS_PREFIX;

  /**
   * Get job key with prefix
   */
  private getKey(jobId: string): string {
    return `${this.prefix}job:${jobId}`;
  }

  /**
   * Get channel processing key (for duplicate detection)
   */
  private getChannelKey(channelId: string, teamId: string): string {
    return `${this.prefix}processing:${channelId}:${teamId}`;
  }

  /**
   * Store job in Redis with TTL
   */
  async set(jobId: string, job: ProcessingJob): Promise<void> {
    try {
      const key = this.getKey(jobId);
      const value = JSON.stringify({
        ...job,
        // Convert dates to ISO strings for JSON storage
        createdAt: job.createdAt?.toISOString(),
        startedAt: job.startedAt?.toISOString(),
        completedAt: job.completedAt?.toISOString(),
      });

      await redisClient.setex(key, JOB_TTL_SECONDS, value);

      structuredLogger.debug({ jobId, ttl: JOB_TTL_SECONDS }, 'Job stored in Redis');
    } catch (error) {
      structuredLogger.error({ error, jobId }, 'Failed to store job in Redis');
      throw error;
    }
  }

  /**
   * Get job from Redis
   */
  async get(jobId: string): Promise<ProcessingJob | null> {
    try {
      const key = this.getKey(jobId);
      const value = await redisClient.get(key);

      if (!value) {
        return null;
      }

      const job = JSON.parse(value);
      
      // Convert ISO strings back to Date objects
      return {
        ...job,
        createdAt: job.createdAt ? new Date(job.createdAt) : undefined,
        startedAt: job.startedAt ? new Date(job.startedAt) : undefined,
        completedAt: job.completedAt ? new Date(job.completedAt) : undefined,
      };
    } catch (error) {
      structuredLogger.error({ error, jobId }, 'Failed to get job from Redis');
      return null;
    }
  }

  /**
   * Delete job from Redis
   */
  async delete(jobId: string): Promise<void> {
    try {
      const key = this.getKey(jobId);
      await redisClient.del(key);
      structuredLogger.debug({ jobId }, 'Job deleted from Redis');
    } catch (error) {
      structuredLogger.error({ error, jobId }, 'Failed to delete job from Redis');
    }
  }

  /**
   * Get all job values (for iteration)
   * Note: Inefficient for large numbers of jobs, but OK for now
   */
  async values(): Promise<ProcessingJob[]> {
    try {
      const pattern = `${this.prefix}job:*`;
      const keys = await redisClient.keys(pattern);

      if (keys.length === 0) {
        return [];
      }

      const values = await redisClient.mget(...keys);
      
      return values
        .filter((v): v is string => v !== null)
        .map(v => {
          const job = JSON.parse(v);
          return {
            ...job,
            createdAt: job.createdAt ? new Date(job.createdAt) : undefined,
            startedAt: job.startedAt ? new Date(job.startedAt) : undefined,
            completedAt: job.completedAt ? new Date(job.completedAt) : undefined,
          };
        });
    } catch (error) {
      structuredLogger.error({ error }, 'Failed to get all jobs from Redis');
      return [];
    }
  }

  /**
   * Mark channel as being processed (for duplicate prevention)
   */
  async markChannelProcessing(channelId: string, teamId: string, jobId: string): Promise<boolean> {
    try {
      const key = this.getChannelKey(channelId, teamId);
      const result = await redisClient.set(key, jobId, 'EX', JOB_TTL_SECONDS, 'NX'); // NX = only set if doesn't exist
      return result === 'OK';
    } catch (error) {
      structuredLogger.error({ error, channelId, teamId }, 'Failed to mark channel as processing');
      return false;
    }
  }

  /**
   * Unmark channel as processing
   */
  async unmarkChannelProcessing(channelId: string, teamId: string): Promise<void> {
    try {
      const key = this.getChannelKey(channelId, teamId);
      await redisClient.del(key);
    } catch (error) {
      structuredLogger.error({ error, channelId, teamId }, 'Failed to unmark channel');
    }
  }

  /**
   * Check if channel is being processed
   */
  async isChannelProcessing(channelId: string, teamId: string): Promise<boolean> {
    try {
      const key = this.getChannelKey(channelId, teamId);
      const exists = await redisClient.exists(key);
      return exists === 1;
    } catch (error) {
      structuredLogger.error({ error, channelId, teamId }, 'Failed to check channel processing status');
      return false;
    }
  }
}

// Export singleton instance
export const jobStore = new RedisJobStore();

