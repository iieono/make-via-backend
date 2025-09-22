import { logger } from '@/utils/logger';
import { webhookProcessor } from '@/services/webhook-processor';
import { supabase } from '@/services/supabase';

/**
 * Background job service for webhook processing
 * Handles retry processing, cleanup, and monitoring
 */
export class WebhookBackgroundJobs {
  private retryProcessorInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isProcessingRetries = false;

  /**
   * Start all background jobs
   */
  start(): void {
    logger.info('Starting webhook background jobs...');

    // Process pending retries every 30 seconds
    this.retryProcessorInterval = setInterval(async () => {
      if (!this.isProcessingRetries) {
        this.isProcessingRetries = true;
        try {
          await this.processWebhookRetries();
        } catch (error) {
          logger.error('Error in webhook retry processor:', error);
        } finally {
          this.isProcessingRetries = false;
        }
      }
    }, 30000);

    // Cleanup old webhook events every hour
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanupOldWebhookData();
      } catch (error) {
        logger.error('Error in webhook cleanup job:', error);
      }
    }, 60 * 60 * 1000);

    logger.info('Webhook background jobs started successfully');
  }

  /**
   * Stop all background jobs
   */
  stop(): void {
    logger.info('Stopping webhook background jobs...');

    if (this.retryProcessorInterval) {
      clearInterval(this.retryProcessorInterval);
      this.retryProcessorInterval = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    logger.info('Webhook background jobs stopped');
  }

  /**
   * Process pending webhook retries
   */
  private async processWebhookRetries(): Promise<void> {
    try {
      await webhookProcessor.processPendingRetries();
    } catch (error) {
      logger.error('Error processing webhook retries:', error);
    }
  }

  /**
   * Cleanup old webhook data to prevent database bloat
   */
  private async cleanupOldWebhookData(): Promise<void> {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      
      // Clean up old processed webhook events (keep for 30 days)
      const { error: cleanupError, count: deletedEvents } = await supabase.serviceClient
        .from('webhook_events')
        .delete()
        .eq('processed', true)
        .lt('created_at', thirtyDaysAgo);

      if (cleanupError) {
        logger.error('Error cleaning up old webhook events:', cleanupError);
      } else {
        logger.info(`Cleaned up ${deletedEvents || 0} old webhook events`);
      }

      // Clean up old retry queue entries (keep for 7 days)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      
      const { error: retryCleanupError, count: deletedRetries } = await supabase.serviceClient
        .from('webhook_retry_queue')
        .delete()
        .lt('created_at', sevenDaysAgo);

      if (retryCleanupError) {
        logger.error('Error cleaning up old retry queue entries:', retryCleanupError);
      } else {
        logger.info(`Cleaned up ${deletedRetries || 0} old retry queue entries`);
      }

      // Archive failed events that have exceeded max retries
      await this.archiveFailedEvents();

    } catch (error) {
      logger.error('Error in webhook data cleanup:', error);
    }
  }

  /**
   * Archive webhook events that have permanently failed
   */
  private async archiveFailedEvents(): Promise<void> {
    try {
      const maxRetries = 3;
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Find events that have failed permanently
      const { data: failedEvents, error } = await supabase.serviceClient
        .from('webhook_events')
        .select('stripe_event_id, event_type, error_message, processing_attempts')
        .eq('processed', false)
        .gte('processing_attempts', maxRetries)
        .lt('created_at', oneDayAgo);

      if (error) {
        logger.error('Error fetching permanently failed events:', error);
        return;
      }

      if (failedEvents && failedEvents.length > 0) {
        // Create archive records (you could create a separate table for this)
        const archiveRecords = failedEvents.map(event => ({
          ...event,
          archived_at: new Date().toISOString(),
          failure_reason: 'max_retries_exceeded',
        }));

        // Log the permanently failed events for monitoring
        logger.warn(`Archiving ${failedEvents.length} permanently failed webhook events:`, {
          events: failedEvents.map(e => ({ id: e.stripe_event_id, type: e.event_type, attempts: e.processing_attempts }))
        });

        // Mark as permanently failed (you might want to create a separate status for this)
        await supabase.serviceClient
          .from('webhook_events')
          .update({ 
            error_message: 'PERMANENTLY_FAILED: Max retries exceeded',
            processed_at: new Date().toISOString() 
          })
          .in('stripe_event_id', failedEvents.map(e => e.stripe_event_id));
      }
    } catch (error) {
      logger.error('Error archiving failed events:', error);
    }
  }

  /**
   * Get background job status
   */
  getStatus(): {
    retry_processor_active: boolean;
    cleanup_job_active: boolean;
    is_processing_retries: boolean;
  } {
    return {
      retry_processor_active: this.retryProcessorInterval !== null,
      cleanup_job_active: this.cleanupInterval !== null,
      is_processing_retries: this.isProcessingRetries,
    };
  }

  /**
   * Force run retry processing (for manual triggers)
   */
  async forceProcessRetries(): Promise<void> {
    if (this.isProcessingRetries) {
      throw new Error('Retry processing is already in progress');
    }

    this.isProcessingRetries = true;
    try {
      await this.processWebhookRetries();
    } finally {
      this.isProcessingRetries = false;
    }
  }

  /**
   * Force run cleanup (for manual triggers)
   */
  async forceCleanup(): Promise<void> {
    await this.cleanupOldWebhookData();
  }
}

export const webhookBackgroundJobs = new WebhookBackgroundJobs();