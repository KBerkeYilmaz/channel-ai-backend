import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import type { UIMessage, ApiResponse, Creator } from '../types';
import { structuredLogger } from '../middleware/logger';
import { connectToDatabase } from '../lib/mongodb';
import { searchSimilarChunksWithReferences } from '../lib/video-references';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';

const chat = new Hono();

// Initialize Google AI
const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_API_KEY!,
});

// Validation schemas
const chatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    parts: z.array(z.object({
      type: z.literal('text'),
      text: z.string()
    })).optional()
  }))
});

/**
 * @swagger
 * /api/chat:
 *   post:
 *     summary: Chat with AI
 *     description: Send messages to AI and receive streaming responses
 *     tags:
 *       - Chat
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant, system]
 *                     parts:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           type:
 *                             type: string
 *                             enum: [text]
 *                           text:
 *                             type: string
 *     responses:
 *       200:
 *         description: Streaming chat response
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid request format
 */
chat.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { messages } = chatRequestSchema.parse(body);
    
    structuredLogger.info('Chat request received', {
      messageCount: messages.length,
      lastMessageRole: messages[messages.length - 1]?.role
    });
    
    // Extract creator slug and user query from the latest message
    const lastUserMessage = messages.filter((m) => m.role === "user").pop();
    const fullMessageText = lastUserMessage?.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ") ?? "";
    
    // Extract creator slug and clean user query
    const creatorMatch = /^\[CREATOR:([^\]]+)\]\s*/.exec(fullMessageText);
    const creatorSlug = creatorMatch?.[1];
    const userQuery = creatorMatch
      ? fullMessageText.replace(/^\[CREATOR:[^\]]+\]\s*/, "")
      : fullMessageText;
    
    structuredLogger.info('Message parsing results', {
      creatorSlug,
      userQuery: userQuery.substring(0, 100),
      hasCreatorSlug: !!creatorSlug
    });
    
    let actualCreatorName = "Creator";
    let staticContext = "";  // Static context for caching (channel, Wikipedia, video list)
    let dynamicContext = "";  // Dynamic RAG chunks (changes per query)
    let creator: Creator | null = null;

    // If we have a creator slug, do RAG retrieval
    if (creatorSlug) {
      try {
        const { db } = await connectToDatabase();

        structuredLogger.info("Looking up creator in database", { creatorSlug });
        creator = await db
          .collection<Creator>("creators")
          .findOne({ slug: creatorSlug });

        structuredLogger.info("Creator lookup result", {
          found: !!creator,
          creatorName: creator?.name,
          setupComplete: creator?.setupComplete,
          creatorId: creator?._id?.toString(),
        });

        if (creator && creator.setupComplete && creator._id) {
          actualCreatorName = creator.name;
          const creatorId = creator._id.toString();

          // Prepare enhanced creator metadata for RAG
          const creatorMetadata = {
            name: creator.name,
            topics: [], // Don't pollute queries
            categories: [], // Don't pollute queries with Wikipedia topics
            recentVideos: [] // Don't pollute queries with video titles
          };

          structuredLogger.info("Searching for relevant content with enhanced metadata", {
            query: userQuery.substring(0, 100) + (userQuery.length > 100 ? "..." : ""),
            creatorId,
            hasChannelData: !!creator.channelData,
            hasWikipediaData: !!creator.wikipediaData,
            videosWithTranscripts: creator.videos?.filter(v => v.hasTranscript).length || 0
          });

          // Extract conversation history for context-aware search
          const conversationHistory = messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({
              role: m.role as 'user' | 'assistant',
              content: m.parts
                ?.filter(p => p.type === 'text')
                .map(p => p.text)
                .join(' ') || ''
            }))
            .filter(m => m.content.length > 0);

          structuredLogger.info("Conversation history extracted", {
            historyLength: conversationHistory.length,
            lastUserMessage: conversationHistory.filter(m => m.role === 'user').pop()?.content?.substring(0, 50)
          });

          // Use enhanced RAG search with video references
          const relevantResults = await searchSimilarChunksWithReferences(
            creatorId,
            userQuery,
            5,
            creatorMetadata,
            conversationHistory
          );

          structuredLogger.info("RAG search completed", {
            resultsCount: relevantResults.length,
            topScore: relevantResults[0]?.score,
            hasVideoReferences: relevantResults.some(r => r.videoTitle)
          });

          // Build static context (always identical for caching)
          if (creator.channelData) {
            staticContext += `\n=== CHANNEL INFORMATION ===\n`;
            staticContext += `Channel: ${creator.channelData.title}\n`;
            if (creator.channelData.statistics) {
              staticContext += `Subscribers: ${creator.channelData.statistics.subscriberCount?.toLocaleString() || 'N/A'}\n`;
              staticContext += `Total Views: ${creator.channelData.statistics.viewCount?.toLocaleString() || 'N/A'}\n`;
              staticContext += `Videos: ${creator.channelData.statistics.videoCount?.toLocaleString() || 'N/A'}\n`;
            }
            if (creator.channelData.description) {
              staticContext += `Description: ${creator.channelData.description.substring(0, 300)}...\n`;
            }
          }

          if (creator.wikipediaData) {
            staticContext += `\n=== BACKGROUND INFORMATION ===\n`;
            staticContext += `${creator.wikipediaData.summary}\n`;
          }

          // Add video list to static context (always identical)
          if (creator.videos && creator.videos.length > 0) {
            staticContext += `\n=== AVAILABLE VIDEO CONTENT ===\n`;
            staticContext += `You have access to transcripts from ${creator.videos.length} videos:\n`;
            creator.videos.forEach((video, index) => {
              if (video.hasTranscript) {
                staticContext += `${index + 1}. "${video.title}" (${video.url})\n`;
              }
            });
          }

          // Build dynamic context (RAG chunks - changes per query)
          if (relevantResults.length > 0) {
            dynamicContext += `=== RELEVANT CONTENT FROM VIDEOS ===\n`;
            dynamicContext += `Based on the user's question, here are the most relevant excerpts from your videos:\n\n`;

            relevantResults.forEach((result, index) => {
              dynamicContext += `**Excerpt ${index + 1}** (Similarity: ${(result.score * 100).toFixed(1)}%)\n`;
              if (result.videoTitle) {
                dynamicContext += `From: "${result.videoTitle}"\n`;
              }
              if (result.videoUrl) {
                dynamicContext += `Video: ${result.videoUrl}\n`;
              }
              if (result.timestamp && result.timestamp !== "0:00") {
                dynamicContext += `Timestamp: ${result.timestamp}\n`;
              }
              dynamicContext += `Content: ${result.text}\n\n`;
            });

            dynamicContext += `Use this content to answer the user's question. Reference specific videos and timestamps when relevant.\n`;
          }
        }
      } catch (error) {
        structuredLogger.error("Error during RAG retrieval", error);
        // Continue without RAG context
      }
    }

    // Build system prompt with ONLY static context (for caching)
    const systemPrompt = `You are ${actualCreatorName}, a content creator engaging with your audience through an AI chat interface.

**PERSONALITY & TONE:**
- Be conversational, authentic, and engaging
- Match the creator's natural speaking style and personality
- Use "I" when referring to yourself and your experiences
- Be helpful and informative while staying true to your character

**ALWAYS use the information from the "RELEVANT CONTENT FROM VIDEOS" section when it's provided to you.**

When answering:
1. Answer the question directly using your video transcripts
2. Be specific and detailed - share actual tips, advice, or stories
3. Reference your videos naturally (e.g., "In my video about X, I mentioned...")
4. Be conversational but informative
5. Include timestamps when provided
6. If you mention a video, format it like: 📹 From [Video Title] ([Video URL]) at [timestamp]

**CRITICAL RULES:**
- NEVER make up video titles, URLs, or timestamps that weren't provided to you
- ONLY reference videos and content that appear in the context sections below
- If you don't have relevant video content for a question, be honest about it
- Always be helpful and try to provide value even without specific video references

${staticContext ? `=== YOUR BACKGROUND & CONTENT ===\n${staticContext}` : ""}

Remember: You're having a real conversation with someone who follows your content. Be genuine, helpful, and true to your creator persona.`;

    // Convert UI messages to model format
    const modelMessages = messages.map((message) => ({
      role: message.role,
      content: message.parts
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("") || "",
    }));

    // Inject dynamic context as message before user query (if we have RAG results)
    if (dynamicContext) {
      const lastUserMessageIndex = modelMessages.map(m => m.role).lastIndexOf('user');
      if (lastUserMessageIndex !== -1) {
        const contextMessage = {
          role: 'user' as const,
          content: `[Context for this query - relevant excerpts from your videos]\n\n${dynamicContext}`
        };
        modelMessages.splice(lastUserMessageIndex, 0, contextMessage);
      }
    }

    structuredLogger.info("Generating AI response", {
      systemPromptLength: systemPrompt.length,
      modelMessagesCount: modelMessages.length,
      hasDynamicContext: !!dynamicContext,
      staticContextLength: staticContext.length,
      dynamicContextLength: dynamicContext.length,
    });

    // Generate streaming response
    const result = streamText({
      model: google("gemini-2.5-flash"),
      system: systemPrompt,
      messages: modelMessages,
      temperature: 0.8,
    });

    // Return streaming response
    return stream(c, async (stream) => {
      for await (const chunk of result.textStream) {
        await stream.write(chunk);
      }
    });
    
  } catch (error) {
    structuredLogger.error('Error in chat endpoint', error);
    
    if (error instanceof z.ZodError) {
      const errorResponse: ApiResponse = {
        success: false,
        error: 'Invalid request format',
        message: error.errors.map(e => e.message).join(', ')
      };
      return c.json(errorResponse, 400);
    }
    
    const errorResponse: ApiResponse = {
      success: false,
      error: 'Internal server error'
    };
    
    return c.json(errorResponse, 500);
  }
});

export default chat;
