import { createLogger } from './logger';
import { connectToDatabase } from './mongodb';

const logger = createLogger('Monitoring');

// Service pricing (approximate costs per request/token)
export const SERVICE_COSTS = {
  openai: {
    embeddings: 0.0001, // per 1K tokens
    gpt4: 0.03,        // per 1K tokens (backup)
  },
  groq: {
    completion: 0.001,  // per 1K tokens (llama-3.3-70b)
  },
  pinecone: {
    query: 0.000001,    // per query (very approximate)
    upsert: 0.000002,   // per upsert operation
  },
  youtube: {
    transcript: 0,      // free (but rate limited)
  }
} as const;

// Quota configuration with enable/disable flags
export interface QuotaConfig {
  enabled: boolean;
  dailyLimit: number;
  monthlyLimit: number;
  warningThresholds: {
    daily: number;      // percentage (e.g., 80 for 80%)
    monthly: number;
  };
  enforceBlocking: boolean; // if false, just log warnings
}

// Default quota settings
export const DEFAULT_QUOTAS: Record<string, QuotaConfig> = {
  total: {
    enabled: false,
    dailyLimit: 5.0,     // $5 per day
    monthlyLimit: 20.0,  // $20 per month
    warningThresholds: { daily: 80, monthly: 80 },
    enforceBlocking: false
  },
  openai: {
    enabled: false,
    dailyLimit: 2.0,
    monthlyLimit: 10.0,
    warningThresholds: { daily: 75, monthly: 75 },
    enforceBlocking: false
  },
  groq: {
    enabled: false,
    dailyLimit: 1.0,
    monthlyLimit: 5.0,
    warningThresholds: { daily: 75, monthly: 75 },
    enforceBlocking: false
  },
  pinecone: {
    enabled: false,
    dailyLimit: 1.0,
    monthlyLimit: 3.0,
    warningThresholds: { daily: 75, monthly: 75 },
    enforceBlocking: false
  }
};

// Usage tracking types
export interface UsageRecord {
  _id?: string;
  service: string;
  operation: string;
  cost: number;
  tokens?: number;
  requestCount: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface UsageSummary {
  service: string;
  dailyCost: number;
  monthlyCost: number;
  dailyRequests: number;
  monthlyRequests: number;
  dailyTokens?: number;
  monthlyTokens?: number;
}

export interface QuotaStatus {
  service: string;
  config: QuotaConfig;
  usage: UsageSummary;
  status: 'ok' | 'warning' | 'limit_exceeded';
  remainingDaily: number;
  remainingMonthly: number;
  warningMessage?: string;
}

// Main monitoring class
export class ResourceMonitor {
  private quotas: Record<string, QuotaConfig>;
  private isEnabled: boolean;

  constructor(customQuotas?: Record<string, QuotaConfig>) {
    this.quotas = { ...DEFAULT_QUOTAS, ...customQuotas };
    this.isEnabled = process.env.RESOURCE_MONITORING_ENABLED === 'true';

    logger.info('Resource monitoring initialized', {
      enabled: this.isEnabled,
      quotasConfigured: Object.keys(this.quotas).length
    });
  }

  // Track usage for a service operation
  async trackUsage(
    service: string,
    operation: string,
    tokens = 0,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    if (!this.isEnabled) {
      logger.debug('Resource monitoring disabled, skipping tracking');
      return;
    }

    try {
      const cost = this.calculateCost(service, operation, tokens);

      const usageRecord: UsageRecord = {
        service,
        operation,
        cost,
        tokens: tokens ?? undefined,
        requestCount: 1,
        timestamp: new Date(),
        metadata
      };

      await this.storeUsageRecord(usageRecord);

      logger.debug('Usage tracked', {
        service,
        operation,
        cost: cost.toFixed(6),
        tokens
      });

      // Check quotas if enabled for this service
      if (this.quotas[service]?.enabled) {
        await this.checkQuotas(service);
      }

    } catch (error) {
      logger.error('Failed to track usage', error, { service, operation });
    }
  }

  // Calculate cost based on service and operation
  private calculateCost(service: string, operation: string, tokens: number): number {
    const serviceCosts = SERVICE_COSTS[service as keyof typeof SERVICE_COSTS];
    if (!serviceCosts) {
      logger.warn('Unknown service for cost calculation', { service });
      return 0;
    }

    const operationCost = serviceCosts[operation as keyof typeof serviceCosts];
    if (typeof operationCost !== 'number') {
      logger.warn('Unknown operation for cost calculation', { service, operation });
      return 0;
    }

    // Most costs are per 1K tokens
    const cost = service === 'pinecone'
      ? operationCost // Fixed cost per operation
      : (tokens / 1000) * operationCost; // Per 1K tokens

    return Math.max(0, cost);
  }

  // Store usage record in database
  private async storeUsageRecord(record: UsageRecord): Promise<void> {
    try {
      const { db } = await connectToDatabase();
      const collection = db.collection<UsageRecord>('usage_tracking');

      await collection.insertOne(record);
    } catch (error) {
      logger.error('Failed to store usage record', error);
    }
  }

  // Get usage summary for a service
  async getUsageSummary(service: string): Promise<UsageSummary> {
    try {
      const { db } = await connectToDatabase();
      const collection = db.collection<UsageRecord>('usage_tracking');

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      // Aggregate daily usage
      const dailyUsage = await collection.aggregate([
        {
          $match: {
            service,
            timestamp: { $gte: startOfDay }
          }
        },
        {
          $group: {
            _id: null,
            totalCost: { $sum: '$cost' },
            totalRequests: { $sum: '$requestCount' },
            totalTokens: { $sum: '$tokens' }
          }
        }
      ]).toArray();

      // Aggregate monthly usage
      const monthlyUsage = await collection.aggregate([
        {
          $match: {
            service,
            timestamp: { $gte: startOfMonth }
          }
        },
        {
          $group: {
            _id: null,
            totalCost: { $sum: '$cost' },
            totalRequests: { $sum: '$requestCount' },
            totalTokens: { $sum: '$tokens' }
          }
        }
      ]).toArray();

      const daily = dailyUsage[0] ?? { totalCost: 0, totalRequests: 0, totalTokens: 0 };
      const monthly = monthlyUsage[0] ?? { totalCost: 0, totalRequests: 0, totalTokens: 0 };

      return {
        service,
        dailyCost: (daily.totalCost as number) ?? 0,
        monthlyCost: (monthly.totalCost as number) ?? 0,
        dailyRequests: (daily.totalRequests as number) ?? 0,
        monthlyRequests: (monthly.totalRequests as number) ?? 0,
        dailyTokens: (daily.totalTokens as number | undefined) ?? undefined,
        monthlyTokens: (monthly.totalTokens as number | undefined) ?? undefined
      };

    } catch (error) {
      logger.error('Failed to get usage summary', error, { service });
      return {
        service,
        dailyCost: 0,
        monthlyCost: 0,
        dailyRequests: 0,
        monthlyRequests: 0
      };
    }
  }

  // Check quotas for a service
  async checkQuotas(service: string): Promise<QuotaStatus> {
    const config = this.quotas[service];
    if (!config?.enabled) {
      throw new Error(`Quota monitoring not enabled for service: ${service}`);
    }

    const usage = await this.getUsageSummary(service);

    const remainingDaily = Math.max(0, config.dailyLimit - usage.dailyCost);
    const remainingMonthly = Math.max(0, config.monthlyLimit - usage.monthlyCost);

    const dailyPercentage = (usage.dailyCost / config.dailyLimit) * 100;
    const monthlyPercentage = (usage.monthlyCost / config.monthlyLimit) * 100;

    let status: 'ok' | 'warning' | 'limit_exceeded' = 'ok';
    let warningMessage: string | undefined;

    // Check for limit exceeded
    if (usage.dailyCost >= config.dailyLimit || usage.monthlyCost >= config.monthlyLimit) {
      status = 'limit_exceeded';
      warningMessage = `${service} quota exceeded! Daily: $${usage.dailyCost.toFixed(2)}/$${config.dailyLimit}, Monthly: $${usage.monthlyCost.toFixed(2)}/$${config.monthlyLimit}`;
    }
    // Check for warnings
    else if (dailyPercentage >= config.warningThresholds.daily || monthlyPercentage >= config.warningThresholds.monthly) {
      status = 'warning';
      warningMessage = `${service} approaching quota limit. Daily: ${dailyPercentage.toFixed(1)}%, Monthly: ${monthlyPercentage.toFixed(1)}%`;
    }

    const quotaStatus: QuotaStatus = {
      service,
      config,
      usage,
      status,
      remainingDaily,
      remainingMonthly,
      warningMessage
    };

    // Log warnings or errors
    if (status === 'limit_exceeded') {
      logger.error('Service quota exceeded', quotaStatus as unknown as Record<string, unknown>);
    } else if (status === 'warning') {
      logger.warn('Service quota warning', quotaStatus as unknown as Record<string, unknown>);
    }

    return quotaStatus;
  }

  // Check if a service operation should be blocked
  async shouldBlockRequest(service: string): Promise<{ blocked: boolean; reason?: string }> {
    const config = this.quotas[service];

    // If monitoring disabled or quota not enabled, allow request
    if (!this.isEnabled || !config?.enabled) {
      return { blocked: false };
    }

    // If enforcement is disabled, allow request (just log warnings)
    if (!config.enforceBlocking) {
      const status = await this.checkQuotas(service);
      if (status.status === 'limit_exceeded') {
        logger.warn('Quota exceeded but enforcement disabled, allowing request', status as unknown as Record<string, unknown>);
      }
      return { blocked: false };
    }

    // Check if quotas are exceeded
    const status = await this.checkQuotas(service);
    if (status.status === 'limit_exceeded') {
      return {
        blocked: true,
        reason: status.warningMessage
      };
    }

    return { blocked: false };
  }

  // Get comprehensive status for all services
  async getAllQuotaStatus(): Promise<QuotaStatus[]> {
    const statuses: QuotaStatus[] = [];

    for (const [service, config] of Object.entries(this.quotas)) {
      if (config.enabled) {
        try {
          const status = await this.checkQuotas(service);
          statuses.push(status);
        } catch (error) {
          logger.error('Failed to get quota status', error, { service });
        }
      }
    }

    return statuses;
  }

  // Update quota configuration
  updateQuotas(newQuotas: Record<string, Partial<QuotaConfig>>): void {
    for (const [service, updates] of Object.entries(newQuotas)) {
      if (this.quotas[service]) {
        this.quotas[service] = { ...this.quotas[service], ...updates } as QuotaConfig;
        logger.info('Quota configuration updated', { service, updates });
      }
    }
  }

  // Enable/disable monitoring globally
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    logger.info('Resource monitoring toggled', { enabled });
  }
}

// Global monitor instance
export const resourceMonitor = new ResourceMonitor();

// Convenience functions for tracking specific services
export const trackOpenAIUsage = (operation: string, tokens: number, metadata?: Record<string, unknown>) =>
  resourceMonitor.trackUsage('openai', operation, tokens, metadata);

export const trackGroqUsage = (operation: string, tokens: number, metadata?: Record<string, unknown>) =>
  resourceMonitor.trackUsage('groq', operation, tokens, metadata);

export const trackPineconeUsage = (operation: string, metadata?: Record<string, unknown>) =>
  resourceMonitor.trackUsage('pinecone', operation, 0, metadata);

export const trackYouTubeUsage = (operation: string, metadata?: Record<string, unknown>) =>
  resourceMonitor.trackUsage('youtube', operation, 0, metadata);