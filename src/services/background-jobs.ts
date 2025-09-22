import { logger } from '@/utils/logger';
import { webhookBackgroundJobs } from '@/services/webhook-background-jobs';
// import { sessionService } from './session'; // TODO: Implement session service

export class BackgroundJobService {
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Start all background jobs
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Background jobs already running');
      return;
    }

    logger.info('Starting background jobs...');
    this.isRunning = true;

    // Start session cleanup job (runs every hour)
    this.startSessionCleanup();

    // Start webhook background jobs
    webhookBackgroundJobs.start();

    logger.info('Background jobs started successfully');
  }

  /**
   * Stop all background jobs
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn('Background jobs not running');
      return;
    }

    logger.info('Stopping background jobs...');
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Stop webhook background jobs
    webhookBackgroundJobs.stop();

    this.isRunning = false;
    logger.info('Background jobs stopped');
  }

  /**
   * Start the session cleanup job
   */
  private startSessionCleanup(): void {
    // Run immediately on start
    this.runSessionCleanup();

    // Then run every hour
    this.cleanupInterval = setInterval(() => {
      this.runSessionCleanup();
    }, 60 * 60 * 1000); // 1 hour

    logger.info('Session cleanup job scheduled to run every hour');
  }

  /**
   * Run session cleanup
   */
  private async runSessionCleanup(): Promise<void> {
    try {
      logger.debug('Running session cleanup...');
      // TODO: Implement session cleanup when session service is available
      // const deletedCount = await sessionService.cleanupExpiredSessions();
      
      logger.debug('Session cleanup skipped: session service not implemented');
    } catch (error) {
      logger.error('Session cleanup failed:', error);
    }
  }

  /**
   * Get the status of background jobs
   */
  getStatus(): { running: boolean; jobs: string[] } {
    return {
      running: this.isRunning,
      jobs: this.isRunning ? ['session-cleanup'] : [],
    };
  }
}

export const backgroundJobService = new BackgroundJobService();