import { emailService } from '@/services/email-service';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import Stripe from 'stripe';
import { config } from '@/config/config';

/**
 * Email processing worker that runs periodically to send queued emails
 */
export class EmailWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private intervalMs: number;

  constructor(intervalMs: number = 60000) { // Default: process every minute
    this.intervalMs = intervalMs;
  }

  /**
   * Start the email worker
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Email worker is already running');
      return;
    }

    logger.info('Starting email worker', { intervalMs: this.intervalMs });

    // Process emails immediately on start
    this.processEmails();

    // Set up interval for periodic processing
    this.intervalId = setInterval(() => {
      this.processEmails();
    }, this.intervalMs);
  }

  /**
   * Stop the email worker
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Email worker stopped');
    }
  }

  /**
   * Process pending emails and handle subscription cancellations
   */
  private async processEmails(): Promise<void> {
    if (this.isProcessing) {
      return; // Skip if already processing
    }

    this.isProcessing = true;

    try {
      await emailService.processPendingEmails();
      await this.processSubscriptionCancellations();
    } catch (error) {
      logger.error('Email worker processing failed', { error });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process subscription cancellations for failed payments
   * Cancels subscriptions after 3-day email sequence is complete
   */
  private async processSubscriptionCancellations(): Promise<void> {
    try {
      // Find subscriptions that should be cancelled (3+ days after first failed payment)
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      const { data: emailsToCancel, error } = await supabase
        .from('email_queue')
        .select('user_id, metadata, created_at')
        .eq('type', 'subscription_failure_day_3')
        .eq('status', 'sent')
        .is('cancelled_at', null)
        .lt('created_at', threeDaysAgo.toISOString());

      if (error) {
        logger.error('Failed to fetch subscriptions for cancellation', { error });
        return;
      }

      if (!emailsToCancel?.length) {
        return; // No subscriptions to cancel
      }

      const stripe = new Stripe(config.stripe.secretKey, {
        apiVersion: '2023-10-16',
      });

      for (const email of emailsToCancel) {
        try {
          const metadata = email.metadata as { stripe_customer_id?: string; subscription_id?: string };
          const customerId = metadata?.stripe_customer_id;
          const subscriptionId = metadata?.subscription_id;

          if (!customerId) {
            logger.warn('No customer ID found for subscription cancellation', { 
              userId: email.user_id 
            });
            continue;
          }

          // Cancel the subscription in Stripe
          if (subscriptionId) {
            await stripe.subscriptions.cancel(subscriptionId);
            logger.info('Cancelled subscription after payment failure', { 
              userId: email.user_id,
              subscriptionId,
              customerId 
            });
          } else {
            // If no specific subscription ID, cancel all active subscriptions for customer
            const subscriptions = await stripe.subscriptions.list({
              customer: customerId,
              status: 'active',
            });

            for (const subscription of subscriptions.data) {
              await stripe.subscriptions.cancel(subscription.id);
              logger.info('Cancelled subscription after payment failure', { 
                userId: email.user_id,
                subscriptionId: subscription.id,
                customerId 
              });
            }
          }

          // Update user subscription status in database
          const { error: updateError } = await supabase
            .from('user_subscriptions')
            .update({
              status: 'cancelled',
              cancel_at_period_end: true,
              cancelled_at: new Date().toISOString(),
            })
            .eq('user_id', email.user_id)
            .eq('status', 'active');

          if (updateError) {
            logger.error('Failed to update user subscription status after cancellation', { 
              userId: email.user_id,
              error: updateError 
            });
          }

          // Mark email sequence as completed to prevent future processing
          await supabase
            .from('email_queue')
            .update({ cancelled_at: new Date().toISOString() })
            .eq('user_id', email.user_id)
            .eq('type', 'subscription_failure_day_3')
            .eq('status', 'sent');

        } catch (cancelError) {
          logger.error('Failed to cancel subscription after payment failure', { 
            userId: email.user_id,
            error: cancelError 
          });
        }
      }

      if (emailsToCancel.length > 0) {
        logger.info('Processed subscription cancellations', { 
          count: emailsToCancel.length 
        });
      }

    } catch (error) {
      logger.error('Failed to process subscription cancellations', { error });
    }
  }

  /**
   * Get worker status
   */
  getStatus(): { isRunning: boolean; isProcessing: boolean; intervalMs: number } {
    return {
      isRunning: this.intervalId !== null,
      isProcessing: this.isProcessing,
      intervalMs: this.intervalMs,
    };
  }
}

// Export singleton instance
export const emailWorker = new EmailWorker();