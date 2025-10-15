import swaggerJSDoc from 'swagger-jsdoc';

const options: swaggerJSDoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'YouTube Channel AI Processor API',
      version: '1.0.0',
      description: 'A high-performance backend service for creator chat functionality using RAG and AI',
      contact: {
        name: 'API Support',
      },
    },
    servers: [
      {
        url: 'http://localhost:3001',
        description: 'Development server',
      },
      {
        url: 'https://your-app.railway.app',
        description: 'Production server',
      },
    ],
    components: {
      schemas: {
        Creator: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            slug: { type: 'string' },
            channelId: { type: 'string' },
            setupComplete: { type: 'boolean' },
            videosCount: { type: 'number' },
            createdAt: { type: 'string', format: 'date-time' },
            channelData: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                statistics: {
                  type: 'object',
                  properties: {
                    subscriberCount: { type: 'number' },
                    videoCount: { type: 'number' },
                    viewCount: { type: 'number' },
                  },
                },
              },
            },
          },
        },
        ApiResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object' },
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.ts'], // Path to the API files
};

export const swaggerSpec = swaggerJSDoc(options);
