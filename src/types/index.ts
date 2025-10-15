// Core types for the YouTube Channel AI Processor

export interface Creator {
  _id?: string;
  name: string;
  slug: string;
  channelId?: string;
  channelData?: ChannelData;
  wikipediaData?: WikipediaData;
  videos?: Video[];
  setupComplete: boolean;
  ownedByTeamId?: string;
  ownedByChannelId?: string; // BetterThumbnailTester channel ID
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ChannelData {
  title: string;
  description?: string;
  thumbnails?: {
    default?: { url: string };
    medium?: { url: string };
    high?: { url: string };
  };
  statistics?: {
    viewCount?: number;
    subscriberCount?: number;
    videoCount?: number;
  };
}

export interface WikipediaData {
  title: string;
  summary: string;
  url?: string;
}

export interface Video {
  videoId: string;
  title: string;
  url: string;
  duration?: string;
  publishedAt?: Date;
  hasTranscript: boolean;
  thumbnails?: {
    default?: { url: string };
    medium?: { url: string };
    high?: { url: string };
  };
}

export interface TranscriptChunk {
  _id?: string;
  creatorId: string;
  videoId: string;
  chunkIndex: number;
  text: string;
  embedding?: number[];
  metadata?: {
    videoTitle?: string;
    videoUrl?: string;
    startTime?: number;
    endTime?: number;
    timestamp?: string;
    duration?: number;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
}

export interface UIMessage {
  role: 'user' | 'assistant' | 'system';
  parts?: Array<{
    type: 'text';
    text: string;
  }>;
}

export interface SearchResult {
  text: string;
  score: number;
  videoTitle?: string;
  videoUrl?: string;
  timestamp?: string;
  metadata?: Record<string, any>;
}

export interface VideoReference {
  text: string;
  score: number;
  videoTitle?: string;
  videoUrl?: string;
  timestamp?: string;
  videoId?: string;
  chunkIndex?: number;
  metadata?: Record<string, any>;
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface HealthCheck {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  responseTime: number;
  version: string;
  environment: string;
  checks: Record<string, {
    status: 'healthy' | 'unhealthy' | 'degraded';
    message?: string;
    responseTime?: number;
  }>;
}

// ChannelAIProcessing - Matches Prisma schema in BetterThumbnailTester
export interface ChannelAIProcessing {
  _id?: string; // MongoDB _id (Prisma uses @map("_id"))
  
  // Identification
  channelId: string;
  teamId: string;
  creatorId: string;
  
  // Processing info
  status: 'processing' | 'completed' | 'failed';
  jobId: string;
  chatUrl: string;
  channelUrl: string;
  
  // Timestamps
  processedAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
  
  // Stats
  videosProcessed: number;
  totalChunks: number;
  failedVideos: number;
  hasChannelContext: boolean;
  customDescriptionUsed?: boolean;
  
  // Error tracking
  lastError?: string;
  errorCount?: number;
  
  // Reprocessing control
  canReprocess?: boolean;
  lastReprocessAt?: Date;
  reprocessCount?: number;
}
