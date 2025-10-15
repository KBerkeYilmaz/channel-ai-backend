import Groq from 'groq-sdk';
import { createLogger } from './logger';
import { withRetry, RETRY_CONFIGS } from './retry';
import { withTimeout, TIMEOUT_CONFIGS } from './timeout';
import { trackGroqUsage } from './monitoring';

const logger = createLogger('Groq');

if (!process.env.GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY environment variable is not defined');
}

export const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function generateChatResponse(
  creatorName: string,
  context: string,
  userMessage: string
): Promise<string> {
  logger.info('Generating chat response', {
    creatorName,
    contextLength: context.length,
    messageLength: userMessage.length
  });
  const systemPrompt = `You are ${creatorName}, a YouTube content creator.

Based on these excerpts from your videos:
${context}

Respond to the user's message in your authentic style and voice. Keep it conversational, engaging, and true to your personality as shown in the context above. Be natural and don't mention that you're an AI or reference the video excerpts directly.`;

  try {
    const completion = await withRetry(
      () => withTimeout(
        groq.chat.completions.create({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
          ],
          model: "llama-3.1-8b-instant", // Updated to current model
          temperature: 0.8,
          max_tokens: 2000,
        }),
        TIMEOUT_CONFIGS.groq,
        `groq-completion-${creatorName}`
      ),
      RETRY_CONFIGS.groq,
      `groq-completion-${creatorName}`
    );

    const response = completion.choices[0]?.message?.content ?? "Sorry, I couldn't generate a response.";
    const tokensUsed = completion.usage?.total_tokens ?? 0;

    logger.info('Chat response generated successfully', {
      creatorName,
      responseLength: response.length,
      tokensUsed
    });

    // Track successful usage
    await trackGroqUsage('completion', tokensUsed, {
      creatorName,
      responseLength: response.length,
      model: 'llama-3.1-8b-instant',
      success: true
    });

    return response;
  } catch (error) {
    logger.error('Groq API error', error, { creatorName });

    // Track failed usage
    await trackGroqUsage('completion', 0, {
      creatorName,
      model: 'llama-3.1-8b-instant',
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });

    return "Sorry, I'm having trouble responding right now. Please try again.";
  }
}