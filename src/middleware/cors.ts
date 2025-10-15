import { cors } from 'hono/cors';
import { env } from '../config/env';

export const corsMiddleware = cors({
  origin: env.TRUSTED_ORIGINS.split(',').map(origin => origin.trim()),
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-ThumbnailTest-Origin'],
  credentials: true,
});
