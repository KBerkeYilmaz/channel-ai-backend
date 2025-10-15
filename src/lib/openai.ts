import OpenAI from 'openai';
import { trackOpenAIUsage } from './monitoring';
import { createLogger } from './logger';

const logger = createLogger('OpenAI');

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is not defined');
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function createEmbedding(text: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-large",
      input: text,
      // Using full 3072 dimensions for maximum quality
    });

    const embedding = response.data[0]?.embedding ?? [];
    const tokensUsed = response.usage?.total_tokens ?? 0;

    // Track successful usage
    await trackOpenAIUsage('embeddings', tokensUsed, {
      model: 'text-embedding-3-large',
      inputLength: text.length,
      embeddingDimensions: embedding.length,
      success: true
    });

    logger.debug('Embedding created successfully', {
      inputLength: text.length,
      tokensUsed,
      dimensions: embedding.length,
      model: 'text-embedding-3-large'
    });

    return embedding;
  } catch (error) {
    logger.error('OpenAI embedding creation failed', error);

    // Track failed usage
    await trackOpenAIUsage('embeddings', 0, {
      model: 'text-embedding-3-large',
      inputLength: text.length,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }
}

// Note: Chat response generation moved to groq.ts
// This file now only handles embeddings
