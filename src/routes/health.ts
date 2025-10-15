import { Hono } from 'hono';
import type { HealthCheck } from '../types';
import { structuredLogger } from '../middleware/logger';
import { connectToDatabase } from '../lib/mongodb';

const health = new Hono();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Returns the health status of the API and its dependencies
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [healthy, degraded, unhealthy]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 responseTime:
 *                   type: number
 *                 version:
 *                   type: string
 *                 environment:
 *                   type: string
 *                 checks:
 *                   type: object
 *       503:
 *         description: Service is unhealthy
 */
health.get('/', async (c) => {
  const startTime = Date.now();
  
  try {
    const checks: HealthCheck['checks'] = {};
    
    // Check environment variables
    const requiredEnvVars = [
      'DATABASE_URL',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'PINECONE_API_KEY'
    ];
    
    const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
    checks.environment = {
      status: missingEnvVars.length === 0 ? 'healthy' : 'degraded',
      message: missingEnvVars.length > 0 ? `Missing: ${missingEnvVars.join(', ')}` : undefined
    };
    
    // Check database connection
    try {
      const dbStart = Date.now();
      await connectToDatabase();
      checks.database = {
        status: 'healthy',
        responseTime: Date.now() - dbStart
      };
    } catch (error) {
      checks.database = {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Database connection failed'
      };
    }
    
    // Determine overall health
    const hasUnhealthy = Object.values(checks).some(check => check.status === 'unhealthy');
    const hasDegraded = Object.values(checks).some(check => check.status === 'degraded');
    
    const overallStatus = hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy';
    const responseTime = Date.now() - startTime;
    
    const healthData: HealthCheck = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      responseTime,
      version: '1.0.0',
      environment: process.env.NODE_ENV ?? 'development',
      checks,
    };
    
    structuredLogger.info('Health check completed', {
      status: overallStatus,
      responseTime,
      checksCount: Object.keys(checks).length
    });
    
    const httpStatus = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 200 : 503;
    return c.json(healthData, httpStatus);
    
  } catch (error) {
    structuredLogger.error('Health check failed', error);
    
    const errorResponse: HealthCheck = {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      version: '1.0.0',
      environment: process.env.NODE_ENV ?? 'development',
      checks: {}
    };
    
    return c.json(errorResponse, 503);
  }
});

export default health;
