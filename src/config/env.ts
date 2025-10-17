import { z } from 'zod';

const envSchema = z.object({
  // Server
  API_PORT: z.string().default('3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Database (optional for development)
  DATABASE_URL: z.string().optional(),
  
  // Redis (required for job storage)
  REDISHOST: z.string().optional(),
  REDISPORT: z.string().optional(),
  REDISPASSWORD: z.string().optional(),
  REDISUSER: z.string().optional(),
  
  // AI Services (optional for development)
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  
  // Vector Database (optional for development)
  PINECONE_API_KEY: z.string().optional(),
  PINECONE_INDEX_NAME: z.string().default('creator-transcripts-v2'),
  
  // YouTube API (optional for development)
  YOUTUBE_API_KEY: z.string().optional(),
  
  // Security
  BETTER_AUTH_SECRET: z.string().optional(),
  TRUSTED_ORIGINS: z.string().default('http://localhost:3000'),
});

export const env = envSchema.parse(process.env);

export type Env = z.infer<typeof envSchema>;
