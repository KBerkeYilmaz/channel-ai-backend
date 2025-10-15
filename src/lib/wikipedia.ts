import { createLogger } from './logger';

const logger = createLogger('Wikipedia');

export interface WikipediaEnrichmentData {
  summary: string;
  url?: string;
  relatedTopics: string[];
}

export async function enrichChannelWithWikipedia(channelTitle: string): Promise<WikipediaEnrichmentData> {
  logger.info('Wikipedia enrichment placeholder', { channelTitle });
  
  return {
    summary: `Wikipedia information for "${channelTitle}"`,
    relatedTopics: []
  };
}
