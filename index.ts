#!/usr/bin/env bun
/**
 * YouTube Channel AI Processor
 * 
 * A high-performance Hono/Bun backend service for creator chat functionality.
 * Built following modern best practices with TypeScript, OpenAPI docs, and structured logging.
 */

import { Hono } from 'hono';
import { prettyJSON } from 'hono/pretty-json';
import { swaggerUI } from '@hono/swagger-ui';

// Import configuration
import { env } from './src/config/env';
import { swaggerSpec } from './src/config/swagger';

// Import middleware
import { corsMiddleware } from './src/middleware/cors';
import { loggerMiddleware } from './src/middleware/logger';
import { structuredLogger } from './src/middleware/logger';

// Import routes
import health from './src/routes/health';
import creators from './src/routes/creators';
import chat from './src/routes/chat';
import rag from './src/routes/rag';
import process from './src/routes/process';

// Initialize Hono app
const app = new Hono();

// Global middleware
app.use('*', corsMiddleware);
app.use('*', loggerMiddleware);
app.use('*', prettyJSON());

// API Documentation
app.get('/docs', swaggerUI({ url: '/api-docs' }));
app.get('/api-docs', (c) => c.json(swaggerSpec));

// Health check (root level)
app.route('/health', health);

// API routes
app.route('/api/creators', creators);
app.route('/api/chat', chat);
app.route('/api/rag', rag);
app.route('/api/process', process);

// Root endpoint
app.get('/', (c) => {
  return c.json({
    name: 'YouTube Channel AI Processor',
    version: '1.0.0',
    description: 'High-performance backend service for creator chat functionality',
    endpoints: {
      health: '/health',
      docs: '/docs',
      apiDocs: '/api-docs',
      creators: '/api/creators',
      chat: '/api/chat',
      rag: '/api/rag',
      process: '/api/process'
    },
    powered_by: 'Hono + Bun 🚀'
  });
});

// 404 handler
app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Not Found',
    message: 'The requested endpoint does not exist'
  }, 404);
});

// Error handler
app.onError((err, c) => {
  structuredLogger.error('Unhandled error', err);
  
  return c.json({
    success: false,
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  }, 500);
});

// Start server
const port = parseInt(env.API_PORT);

console.log(`🚀 YouTube Channel AI Processor starting...`);
console.log(`📡 Server: http://localhost:${port}`);
console.log(`🔗 Health: http://localhost:${port}/health`);
console.log(`📚 Docs: http://localhost:${port}/docs`);
console.log(`🎯 Environment: ${env.NODE_ENV}`);

export default {
  port,
  fetch: app.fetch,
};

structuredLogger.info('Server started successfully', {
  port,
  environment: env.NODE_ENV,
  endpoints: ['health', 'api/creators', 'api/chat', 'api/rag', 'api/process', 'docs']
});