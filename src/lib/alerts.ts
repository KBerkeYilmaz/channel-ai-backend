import { createLogger } from './logger';
import { resourceMonitor, type QuotaStatus } from './monitoring';

const logger = createLogger('Alerts');

export interface AlertConfig {
  enabled: boolean;
  webhookUrl?: string;
  emailEndpoint?: string;
  slackChannel?: string;
  discordWebhook?: string;
}

export interface Alert {
  id: string;
  type: 'quota_warning' | 'quota_exceeded' | 'service_error' | 'cost_spike';
  severity: 'low' | 'medium' | 'high' | 'critical';
  service: string;
  message: string;
  data: Record<string, unknown>;
  timestamp: Date;
  acknowledged: boolean;
}

class AlertManager {
  private config: AlertConfig;
  private alerts: Alert[] = [];
  private alertHistory: Alert[] = [];

  constructor() {
    this.config = {
      enabled: process.env.ALERTS_ENABLED === 'true',
      webhookUrl: process.env.ALERTS_WEBHOOK_URL,
      emailEndpoint: process.env.ALERTS_EMAIL_ENDPOINT,
      slackChannel: process.env.ALERTS_SLACK_CHANNEL,
      discordWebhook: process.env.ALERTS_DISCORD_WEBHOOK
    };

    logger.info('Alert manager initialized', {
      enabled: this.config.enabled,
      hasWebhook: !!this.config.webhookUrl,
      hasEmail: !!this.config.emailEndpoint,
      hasSlack: !!this.config.slackChannel,
      hasDiscord: !!this.config.discordWebhook
    });
  }

  // Create and process an alert
  async createAlert(
    type: Alert['type'],
    severity: Alert['severity'],
    service: string,
    message: string,
    data: Record<string, unknown> = {}
  ): Promise<void> {
    const alert: Alert = {
      id: this.generateAlertId(),
      type,
      severity,
      service,
      message,
      data,
      timestamp: new Date(),
      acknowledged: false
    };

    this.alerts.push(alert);
    this.alertHistory.push(alert);

    // Keep only last 100 active alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }

    // Keep only last 1000 historical alerts
    if (this.alertHistory.length > 1000) {
      this.alertHistory = this.alertHistory.slice(-1000);
    }

    logger.info('Alert created', {
      alertId: alert.id,
      type,
      severity,
      service,
      message: message.substring(0, 100)
    });

    // Send notifications if enabled
    if (this.config.enabled) {
      await this.sendNotifications(alert);
    }
  }

  // Check quotas and create alerts as needed
  async checkQuotasAndAlert(): Promise<void> {
    try {
      const quotaStatuses = await resourceMonitor.getAllQuotaStatus();

      for (const status of quotaStatuses) {
        await this.processQuotaStatus(status);
      }
    } catch (error) {
      logger.error('Failed to check quotas for alerts', error);
      await this.createAlert(
        'service_error',
        'medium',
        'monitoring',
        'Failed to check quotas for alerting',
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  // Process individual quota status
  private async processQuotaStatus(status: QuotaStatus): Promise<void> {
    const { service, status: quotaStatus, usage, config } = status;

    // Check for quota exceeded
    if (quotaStatus === 'limit_exceeded') {
      const existingAlert = this.findRecentAlert('quota_exceeded', service, 60); // 60 minutes
      if (!existingAlert) {
        await this.createAlert(
          'quota_exceeded',
          'critical',
          service,
          `Quota exceeded for ${service}: Daily $${usage.dailyCost.toFixed(2)}/$${config.dailyLimit}, Monthly $${usage.monthlyCost.toFixed(2)}/$${config.monthlyLimit}`,
          {
            dailyCost: usage.dailyCost,
            dailyLimit: config.dailyLimit,
            monthlyCost: usage.monthlyCost,
            monthlyLimit: config.monthlyLimit,
            dailyRequests: usage.dailyRequests,
            monthlyRequests: usage.monthlyRequests
          }
        );
      }
    }
    // Check for quota warning
    else if (quotaStatus === 'warning') {
      const existingAlert = this.findRecentAlert('quota_warning', service, 120); // 2 hours
      if (!existingAlert) {
        const dailyPercentage = (usage.dailyCost / config.dailyLimit) * 100;
        const monthlyPercentage = (usage.monthlyCost / config.monthlyLimit) * 100;

        await this.createAlert(
          'quota_warning',
          'medium',
          service,
          `Approaching quota limit for ${service}: Daily ${dailyPercentage.toFixed(1)}%, Monthly ${monthlyPercentage.toFixed(1)}%`,
          {
            dailyPercentage,
            monthlyPercentage,
            dailyCost: usage.dailyCost,
            monthlyCost: usage.monthlyCost,
            dailyRequests: usage.dailyRequests,
            monthlyRequests: usage.monthlyRequests
          }
        );
      }
    }
  }

  // Find recent alert of specific type
  private findRecentAlert(type: Alert['type'], service: string, minutesBack: number): Alert | undefined {
    const cutoff = new Date(Date.now() - minutesBack * 60 * 1000);
    return this.alerts.find(alert =>
      alert.type === type &&
      alert.service === service &&
      alert.timestamp > cutoff &&
      !alert.acknowledged
    );
  }

  // Send notifications for an alert
  private async sendNotifications(alert: Alert): Promise<void> {
    const notifications: Promise<void>[] = [];

    // Webhook notification
    if (this.config.webhookUrl) {
      notifications.push(this.sendWebhook(alert));
    }

    // Discord notification
    if (this.config.discordWebhook) {
      notifications.push(this.sendDiscord(alert));
    }

    // Wait for all notifications to complete
    const results = await Promise.allSettled(notifications);

    // Log any notification failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error('Notification failed', result.reason, {
          alertId: alert.id,
          notificationIndex: index
        });
      }
    });
  }

  // Send webhook notification
  private async sendWebhook(alert: Alert): Promise<void> {
    try {
      const response = await fetch(this.config.webhookUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          alert,
          timestamp: alert.timestamp.toISOString(),
          source: 'creator-chat-bot'
        })
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
      }

      logger.debug('Webhook notification sent', { alertId: alert.id });
    } catch (error) {
      logger.error('Webhook notification failed', error, { alertId: alert.id });
      throw error;
    }
  }

  // Send Discord notification
  private async sendDiscord(alert: Alert): Promise<void> {
    try {
      const color = this.getDiscordColor(alert.severity);
      const embed = {
        title: `🚨 ${alert.type.replace('_', ' ').toUpperCase()}`,
        description: alert.message,
        color,
        fields: [
          { name: 'Service', value: alert.service, inline: true },
          { name: 'Severity', value: alert.severity.toUpperCase(), inline: true },
          { name: 'Time', value: alert.timestamp.toISOString(), inline: true }
        ],
        footer: { text: 'Creator Chat Bot Monitoring' }
      };

      const response = await fetch(this.config.discordWebhook!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ embeds: [embed] })
      });

      if (!response.ok) {
        throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}`);
      }

      logger.debug('Discord notification sent', { alertId: alert.id });
    } catch (error) {
      logger.error('Discord notification failed', error, { alertId: alert.id });
      throw error;
    }
  }

  // Get Discord embed color for severity
  private getDiscordColor(severity: Alert['severity']): number {
    switch (severity) {
      case 'critical': return 0xff0000; // Red
      case 'high': return 0xff8c00;     // Dark orange
      case 'medium': return 0xffa500;   // Orange
      case 'low': return 0xffff00;      // Yellow
      default: return 0x808080;         // Gray
    }
  }

  // Generate unique alert ID
  private generateAlertId(): string {
    return `alert_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  // Get active alerts
  getActiveAlerts(): Alert[] {
    return this.alerts.filter(alert => !alert.acknowledged);
  }

  // Get all alerts (with pagination)
  getAllAlerts(limit = 50, offset = 0): Alert[] {
    return this.alertHistory
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(offset, offset + limit);
  }

  // Acknowledge an alert
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      logger.info('Alert acknowledged', { alertId });
      return true;
    }
    return false;
  }

  // Update configuration
  updateConfig(newConfig: Partial<AlertConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('Alert configuration updated', newConfig);
  }
}

// Global alert manager instance
export const alertManager = new AlertManager();

// Convenience function to run periodic quota checks
export async function runQuotaMonitoring(): Promise<void> {
  try {
    await alertManager.checkQuotasAndAlert();
  } catch (error) {
    logger.error('Quota monitoring run failed', error);
  }
}

// Export alert manager for use in other modules
export { AlertManager };