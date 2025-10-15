import { Hono } from 'hono';
import { z } from 'zod';
import type { Creator, ApiResponse } from '../types';
import { structuredLogger } from '../middleware/logger';
import { connectToDatabase } from '../lib/mongodb';

const creators = new Hono();

// Validation schemas
const creatorParamsSchema = z.object({
  id: z.string().min(1, 'Creator ID is required'),
});

/**
 * @swagger
 * /api/creators:
 *   get:
 *     summary: Get all creators
 *     description: Retrieve a list of all setup-complete creators
 *     tags:
 *       - Creators
 *     responses:
 *       200:
 *         description: List of creators
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     creators:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Creator'
 *                     total:
 *                       type: number
 */
creators.get('/', async (c) => {
  try {
    structuredLogger.info('Fetching all creators');
    
    const { db } = await connectToDatabase();
    
    // Only return setup-complete creators
    const creatorsData = await db
      .collection<Creator>('creators')
      .find({ setupComplete: true })
      .sort({ createdAt: -1 }) // Newest first
      .toArray();
    
    // Return lightweight creator data for browsing
    const creatorsList = creatorsData.map(creator => ({
      _id: creator._id?.toString(),
      name: creator.name,
      slug: creator.slug,
      channelData: {
        title: creator.channelData?.title,
        thumbnails: creator.channelData?.thumbnails,
        statistics: creator.channelData?.statistics,
        description: creator.channelData?.description?.substring(0, 150) // Preview only
      },
      videosCount: creator.videos?.length || 0,
      setupComplete: creator.setupComplete,
      createdAt: creator.createdAt,
    }));
    
    const response: ApiResponse = {
      success: true,
      data: {
        creators: creatorsList,
        total: creatorsList.length
      }
    };
    
    structuredLogger.info('Creators fetched successfully', {
      total: creatorsList.length
    });
    
    return c.json(response);
    
  } catch (error) {
    structuredLogger.error('Error fetching creators', error);
    
    const errorResponse: ApiResponse = {
      success: false,
      error: 'Failed to fetch creators'
    };
    
    return c.json(errorResponse, 500);
  }
});

/**
 * @swagger
 * /api/creators/{id}/info:
 *   get:
 *     summary: Get creator details
 *     description: Retrieve detailed information about a specific creator
 *     tags:
 *       - Creators
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Creator slug or ID
 *     responses:
 *       200:
 *         description: Creator details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Creator'
 *       404:
 *         description: Creator not found
 */
creators.get('/:id/info', async (c) => {
  try {
    const { id } = creatorParamsSchema.parse(c.req.param());
    
    structuredLogger.info('Fetching creator details', { creatorId: id });
    
    const { db } = await connectToDatabase();
    const creator = await db.collection<Creator>('creators').findOne({ slug: id });
    
    if (!creator) {
      structuredLogger.warn('Creator not found', { slug: id });
      const errorResponse: ApiResponse = {
        success: false,
        error: 'Creator not found'
      };
      return c.json(errorResponse, 404);
    }
    
    structuredLogger.info('Creator found', {
      slug: id,
      name: creator.name,
      setupComplete: creator.setupComplete,
      videosCount: creator.videos?.length || 0
    });
    
    // Return creator data (excluding sensitive fields if any)
    const response: ApiResponse = {
      success: true,
      data: {
        _id: creator._id?.toString(),
        name: creator.name,
        slug: creator.slug,
        channelData: creator.channelData,
        wikipediaData: creator.wikipediaData,
        videos: creator.videos,
        setupComplete: creator.setupComplete,
        createdAt: creator.createdAt,
        updatedAt: creator.updatedAt,
      }
    };
    
    structuredLogger.info('Creator details fetched successfully', {
      creatorId: id,
      creatorName: creator.name
    });
    
    return c.json(response);
    
  } catch (error) {
    structuredLogger.error('Error fetching creator details', error);
    
    const errorResponse: ApiResponse = {
      success: false,
      error: 'Failed to fetch creator details'
    };
    
    return c.json(errorResponse, 500);
  }
});

export default creators;
