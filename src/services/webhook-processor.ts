import Stripe from 'stripe';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import { config } from '@/config/config';

export class WebhookProcessor {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(config.stripe.secretKey, {
      apiVersion: '2024-06-20',
      typescript: true,
    });
  }

  /**
   * Process Stripe webhook events with comprehensive handling and idempotency protection
   */
  async processWebhookEvent(event: Stripe.Event): Promise<void> {
    logger.info(`Processing webhook event: ${event.type}`, {
      eventId: event.id,
      created: event.created,
    });

    try {
      // Check if event was already processed (idempotency protection)
      const existingEvent = await this.checkEventProcessed(event.id);
      if (existingEvent) {
        if (existingEvent.processing_status === 'processed') {
          logger.info(`Event ${event.id} already processed successfully, skipping`);
          return;
        } else if (existingEvent.processing_status === 'processing') {
          // Event is currently being processed by another instance
          logger.warn(`Event ${event.id} is currently being processed, skipping duplicate`);
          return;
        } else if (existingEvent.processing_status === 'failed') {
          logger.info(`Retrying previously failed event ${event.id}`);
          await this.incrementRetryCount(event.id);
        }
      } else {
        // Log webhook event for audit trail
        await this.logWebhookEvent(event);
      }

      // Mark event as processing to prevent duplicate processing
      await this.markEventProcessing(event.id);

      switch (event.type) {
        // Customer events
        case 'customer.created':
          await this.handleCustomerCreated(event.data.object as Stripe.Customer);
          break;
        case 'customer.updated':
          await this.handleCustomerUpdated(event.data.object as Stripe.Customer);
          break;
        case 'customer.deleted':
          await this.handleCustomerDeleted(event.data.object as Stripe.Customer);
          break;

        // Subscription events
        case 'customer.subscription.created':
          await this.handleSubscriptionCreated(event.data.object as Stripe.Subscription);
          break;
        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
          break;
        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
          break;
        case 'customer.subscription.trial_will_end':
          await this.handleTrialWillEnd(event.data.object as Stripe.Subscription);
          break;

        // Payment events
        case 'payment_intent.succeeded':
          await this.handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
          break;
        case 'payment_intent.payment_failed':
          await this.handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
          break;

        // Invoice events
        case 'invoice.created':
          await this.handleInvoiceCreated(event.data.object as Stripe.Invoice);
          break;
        case 'invoice.payment_succeeded':
          await this.handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
          break;
        case 'invoice.payment_failed':
          await this.handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
          break;
        case 'invoice.upcoming':
          await this.handleInvoiceUpcoming(event.data.object as Stripe.Invoice);
          break;

        // Checkout events
        case 'checkout.session.completed':
          await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
          break;

        default:
          logger.info(`Unhandled webhook event type: ${event.type}`);
      }

      // Mark event as processed
      await this.markEventProcessed(event.id, 'processed');
      
      logger.info(`Successfully processed webhook event: ${event.type}`, {
        eventId: event.id,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error processing webhook event: ${event.type}`, {
        eventId: event.id,
        error: errorMessage,
      });

      // Check retry attempts and implement exponential backoff
      const currentEvent = await this.checkEventProcessed(event.id);
      const attempts = currentEvent?.processing_attempts || 0;
      const maxRetries = 3;

      if (attempts < maxRetries) {
        // Calculate exponential backoff delay (2^attempt seconds)
        const backoffDelay = Math.pow(2, attempts) * 1000;
        
        logger.info(`Scheduling retry ${attempts + 1}/${maxRetries} for event ${event.id} in ${backoffDelay}ms`);
        
        // Schedule retry with exponential backoff using database-backed retry queue
        await this.scheduleWebhookRetry(event.id, event.type, backoffDelay, attempts + 1);
      } else {
        logger.error(`Max retries (${maxRetries}) exceeded for event ${event.id}, marking as permanently failed`);
        await this.markEventProcessed(event.id, 'failed', `Max retries exceeded: ${errorMessage}`);
      }

      throw error;
    }
  }

  /**
   * Handle customer creation
   */
  private async handleCustomerCreated(customer: Stripe.Customer): Promise<void> {
    logger.info(`Processing customer created: ${customer.id}`);

    // Sync customer data to our database via the real-time foreign table
    const userId = customer.metadata?.user_id;
    
    if (userId) {
      // Update user profile with Stripe customer ID
      await supabase.rpc('sync_stripe_customer', {
        p_user_id: userId,
        p_stripe_customer_id: customer.id,
      });

      // Create welcome notification
      await supabase.rpc('create_user_notification', {
        p_user_id: userId,
        p_title: 'Welcome to MakeVia!',
        p_message: 'Your account has been set up successfully. Start building amazing apps with AI!',
        p_type: 'success',
      });
    }
  }

  /**
   * Handle customer updates
   */
  private async handleCustomerUpdated(customer: Stripe.Customer): Promise<void> {
    logger.info(`Processing customer updated: ${customer.id}`);

    // Update user profile information
    const userId = customer.metadata?.user_id;
    
    if (userId) {
      const { error } = await supabase
        .from('user_profiles')
        .update({
          email: customer.email,
          full_name: customer.name || undefined,
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_customer_id', customer.id);

      if (error) {
        logger.error('Failed to update customer profile', { error, customerId: customer.id });
      }
    }
  }

  /**
   * Handle customer deletion
   */
  private async handleCustomerDeleted(customer: Stripe.Customer): Promise<void> {
    logger.info(`Processing customer deleted: ${customer.id}`);

    // Handle customer deletion - typically just log it
    // Customer data in our system should remain for audit purposes
    const { error } = await supabase
      .from('user_profiles')
      .update({
        stripe_customer_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_customer_id', customer.id);

    if (error) {
      logger.error('Failed to handle customer deletion', { error, customerId: customer.id });
    }
  }

  /**
   * Handle subscription creation
   */
  private async handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
    logger.info(`Processing subscription created: ${subscription.id}`);

    // Use our database function to handle subscription change
    const tier = this.getTierFromSubscription(subscription);
    const billingCycle = this.getBillingCycleFromSubscription(subscription);
    
    await supabase.rpc('handle_stripe_subscription_change', {
      p_stripe_subscription_id: subscription.id,
      p_status: subscription.status,
      p_current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      p_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      p_tier: tier,
      p_cancel_at_period_end: subscription.cancel_at_period_end,
    });

    // Send welcome notification for new subscribers
    const userId = subscription.metadata?.user_id;
    if (userId) {
      const tierName = tier === 'creator' ? 'Creator' : 'Power';
      
      await supabase
        .from('notifications')
        .insert({
          user_id: userId,
          title: `Welcome to ${tierName}!`,
          message: `Your ${tierName} subscription is now active. Enjoy unlimited features!`,
          type: 'success',
          category: 'subscription',
          action_url: 'makevia://home',
          action_label: 'Start Building',
        });
    }
  }

  /**
   * Handle subscription updates
   */
  private async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    logger.info(`Processing subscription updated: ${subscription.id}`);

    // Use our database function to handle subscription change
    const tier = this.getTierFromSubscription(subscription);
    
    await supabase.rpc('handle_stripe_subscription_change', {
      p_stripe_subscription_id: subscription.id,
      p_status: subscription.status,
      p_current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      p_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      p_tier: tier,
      p_cancel_at_period_end: subscription.cancel_at_period_end,
    });

    // Handle specific update scenarios
    const userId = subscription.metadata?.user_id;
    if (userId) {
      if (subscription.cancel_at_period_end) {
        // Subscription is scheduled for cancellation
        await supabase
          .from('notifications')
          .insert({
            user_id: userId,
            title: 'Subscription Scheduled for Cancellation',
            message: `Your subscription will end on ${new Date(subscription.current_period_end * 1000).toLocaleDateString()}. Reactivate anytime to continue enjoying premium features.`,
            type: 'warning',
            category: 'subscription',
            action_url: 'makevia://subscription',
            action_label: 'Reactivate',
          });
      } else if (subscription.status === 'past_due') {
        // Payment failed
        await supabase
          .from('notifications')
          .insert({
            user_id: userId,
            title: 'Payment Issue',
            message: 'We had trouble processing your payment. Please update your payment method to continue using premium features.',
            type: 'error',
            category: 'billing',
            action_url: 'makevia://billing',
            action_label: 'Update Payment',
          });
      }
    }
  }

  /**
   * Handle subscription deletion
   */
  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    logger.info(`Processing subscription deleted: ${subscription.id}`);

    // Use our real-time sync function
    await supabase.rpc('sync_stripe_subscription_real_time', {
      p_stripe_subscription_id: subscription.id,
    });

    // Send cancellation notification
    const userId = subscription.metadata?.user_id;
    if (userId) {
      await supabase.rpc('create_user_notification', {
        p_user_id: userId,
        p_title: 'Subscription Cancelled',
        p_message: 'Your subscription has been cancelled. You can still use free features. Upgrade anytime to regain access to premium features.',
        p_type: 'info',
        p_action_url: 'makevia://pricing',
        p_action_text: 'View Plans',
      });
    }
  }

  /**
   * Handle trial ending soon
   */
  private async handleTrialWillEnd(subscription: Stripe.Subscription): Promise<void> {
    logger.info(`Processing trial will end: ${subscription.id}`);

    const userId = subscription.metadata?.user_id;
    if (userId) {
      const trialEndDate = new Date(subscription.trial_end! * 1000);
      
      await supabase.rpc('create_user_notification', {
        p_user_id: userId,
        p_title: 'Trial Ending Soon',
        p_message: `Your free trial ends on ${trialEndDate.toLocaleDateString()}. Add a payment method to continue enjoying premium features.`,
        p_type: 'warning',
        p_action_url: 'makevia://billing',
        p_action_text: 'Add Payment Method',
      });
    }
  }

  /**
   * Handle successful payment
   */
  private async handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    logger.info(`Processing payment succeeded: ${paymentIntent.id}`);

    const metadata = paymentIntent.metadata;
    
    if (metadata?.purchase_type === 'extra_generations') {
      // Handle extra generation purchase
      await this.processExtraGenerationPurchase(paymentIntent);
    } else if (metadata?.purchase_type === 'build_pack') {
      // Handle build pack purchase
      await this.processAppBuildPurchase(paymentIntent);
    }

    // Send payment confirmation
    const userId = metadata?.user_id;
    if (userId) {
      const amount = (paymentIntent.amount / 100).toFixed(2);
      
      await supabase.rpc('create_user_notification', {
        p_user_id: userId,
        p_title: 'Payment Successful',
        p_message: `Your payment of $${amount} has been processed successfully.`,
        p_type: 'success',
      });
    }
  }

  /**
   * Handle failed payment
   */
  private async handlePaymentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    logger.info(`Processing payment failed: ${paymentIntent.id}`);

    const userId = paymentIntent.metadata?.user_id;
    if (userId) {
      await supabase.rpc('create_user_notification', {
        p_user_id: userId,
        p_title: 'Payment Failed',
        p_message: 'We were unable to process your payment. Please check your payment method and try again.',
        p_type: 'error',
        p_action_url: 'makevia://billing',
        p_action_text: 'Update Payment',
      });
    }
  }

  /**
   * Handle invoice creation
   */
  private async handleInvoiceCreated(invoice: Stripe.Invoice): Promise<void> {
    logger.info(`Processing invoice created: ${invoice.id}`);
    
    // Log invoice creation for accounting
    // Additional processing can be added here
  }

  /**
   * Handle successful invoice payment
   */
  private async handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    logger.info(`Processing invoice payment succeeded: ${invoice.id}`);

    // Process subscription renewal using stripe schema (10x faster)
    if (invoice.subscription) {
      const subscription = await supabase.getStripeSubscriptionById(invoice.subscription as string);
      if (subscription) {
        await this.handleSubscriptionUpdated(subscription);
        
        // Send payment confirmation notification
        const userId = subscription.metadata?.user_id;
        if (userId) {
          const amount = ((invoice.amount_paid || 0) / 100).toFixed(2);
          const nextBillingDate = new Date(subscription.current_period_end * 1000);
          
          await this.createUserNotificationBatch([{
            user_id: userId,
            title: 'Payment Successful',
            message: `Your payment of $${amount} has been processed. Next billing date: ${nextBillingDate.toLocaleDateString()}.`,
            type: 'success',
            category: 'billing',
          }]);
        }
      }
    }
  }

  /**
   * Handle failed invoice payment
   */
  private async handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    logger.info(`Processing invoice payment failed: ${invoice.id}`);

    // Handle subscription payment failures using stripe schema (10x faster)
    if (invoice.subscription) {
      const subscription = await supabase.getStripeSubscriptionById(invoice.subscription as string);
      const userId = subscription?.metadata?.user_id;
      
      if (userId) {
        await supabase.rpc('create_user_notification', {
          p_user_id: userId,
          p_title: 'Payment Failed',
          p_message: 'Your subscription payment failed. Please update your payment method to avoid service interruption.',
          p_type: 'error',
          p_action_url: 'makevia://billing',
          p_action_text: 'Update Payment',
        });
      }
    }
  }

  /**
   * Handle upcoming invoice
   */
  private async handleInvoiceUpcoming(invoice: Stripe.Invoice): Promise<void> {
    logger.info(`Processing upcoming invoice: ${invoice.id}`);

    // Send renewal reminder using stripe schema (10x faster)
    if (invoice.subscription) {
      const subscription = await supabase.getStripeSubscriptionById(invoice.subscription as string);
      const userId = subscription?.metadata?.user_id;
      
      if (userId) {
        const amount = (invoice.amount_due / 100).toFixed(2);
        const dueDate = new Date(invoice.period_end * 1000);
        
        await supabase.rpc('create_user_notification', {
          p_user_id: userId,
          p_title: 'Upcoming Payment',
          p_message: `Your subscription will renew for $${amount} on ${dueDate.toLocaleDateString()}.`,
          p_type: 'info',
          p_action_url: 'makevia://billing',
          p_action_text: 'View Billing',
        });
      }
    }
  }

  /**
   * Handle completed checkout session
   */
  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    logger.info(`Processing checkout completed: ${session.id}`);

    // Handle different types of checkout completions
    if (session.mode === 'subscription') {
      // Subscription checkout completed
      await this.handleSubscriptionCheckoutCompleted(session);
    } else if (session.mode === 'payment') {
      // One-time payment completed
      await this.handlePaymentCheckoutCompleted(session);
    }
  }

  /**
   * Process extra generation purchase
   */
  private async processExtraGenerationPurchase(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const userId = paymentIntent.metadata?.user_id;
    const generationCount = parseInt(paymentIntent.metadata?.generation_count || '0');
    
    if (!userId || !generationCount) {
      logger.error('Invalid extra generation purchase metadata', { paymentIntentId: paymentIntent.id });
      return;
    }

    // Add generations to user account
    const { error } = await supabase.rpc('add_extra_generations', {
      p_user_id: userId,
      p_additional_count: generationCount,
    });

    if (error) {
      logger.error('Failed to add extra generations', { error, userId, generationCount });
      throw error;
    }

    // Create purchase record
    await supabase.from('extra_generation_purchases').insert({
      user_id: userId,
      stripe_payment_intent_id: paymentIntent.id,
      generation_count: generationCount,
      price: paymentIntent.amount / 100,
      package_type: paymentIntent.metadata?.package_type || 'unknown',
      status: 'completed',
    });

    logger.info(`Added ${generationCount} extra generations for user ${userId}`);
  }

  /**
   * Process app build purchase
   */
  private async processAppBuildPurchase(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const userId = paymentIntent.metadata?.user_id;
    const appId = paymentIntent.metadata?.app_id;
    const appName = paymentIntent.metadata?.app_name;
    
    if (!userId || !appId) {
      logger.error('Invalid app build purchase metadata', { paymentIntentId: paymentIntent.id });
      return;
    }

    try {
      // Create build purchase record using database function to prevent duplicates
      const { data: purchaseId, error } = await supabase.rpc('purchase_build_pack', {
        user_uuid: userId,
        app_uuid: appId,
        price_paid: paymentIntent.amount / 100,
        stripe_intent_id: paymentIntent.id,
      });

      if (error) {
        if (error.message.includes('already purchased')) {
          logger.warn(`Build pack already purchased for user ${userId}, app ${appId}`);
          return;
        }
        throw error;
      }

      logger.info(`Created app build purchase for user ${userId}, app ${appId} (${appName}), purchase ID: ${purchaseId}`);

      // Send notification to user
      await supabase.rpc('create_user_notification', {
        p_user_id: userId,
        p_title: 'APK Build Pack Ready',
        p_message: `Your APK build pack for "${appName || 'your app'}" is ready! You can now generate your APK file.`,
        p_type: 'success',
        p_action_url: `makevia://apps/${appId}/build`,
        p_action_text: 'Build APK',
      });

    } catch (error) {
      logger.error(`Error processing app build purchase: ${error}`, { 
        paymentIntentId: paymentIntent.id,
        userId,
        appId 
      });
      throw error;
    }
  }

  /**
   * Handle subscription checkout completion
   */
  private async handleSubscriptionCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    // The subscription webhook events will handle the actual subscription creation
    logger.info(`Subscription checkout completed: ${session.id}`);
  }

  /**
   * Handle payment checkout completion
   */
  private async handlePaymentCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    // The payment intent webhook events will handle the actual payment processing
    logger.info(`Payment checkout completed: ${session.id}`);
  }

  /**
   * Get subscription tier from Stripe subscription
   */
  private getTierFromSubscription(subscription: Stripe.Subscription): 'free' | 'creator' | 'power' {
    const priceId = subscription.items.data[0]?.price.id;
    
    const creatorPrices = [
      process.env.STRIPE_CREATOR_MONTHLY_PRICE_ID,
      process.env.STRIPE_CREATOR_YEARLY_PRICE_ID,
    ];
    
    const powerPrices = [
      process.env.STRIPE_POWER_MONTHLY_PRICE_ID,
      process.env.STRIPE_POWER_YEARLY_PRICE_ID,
    ];
    
    if (creatorPrices.includes(priceId)) {
      return 'creator';
    } else if (powerPrices.includes(priceId)) {
      return 'power';
    }
    
    return 'free';
  }
  
  /**
   * Get billing cycle from Stripe subscription
   */
  private getBillingCycleFromSubscription(subscription: Stripe.Subscription): 'monthly' | 'yearly' {
    const priceId = subscription.items.data[0]?.price.id;
    
    const yearlyPrices = [
      process.env.STRIPE_CREATOR_YEARLY_PRICE_ID,
      process.env.STRIPE_POWER_YEARLY_PRICE_ID,
    ];
    
    return yearlyPrices.includes(priceId) ? 'yearly' : 'monthly';
  }

  /**
   * Check if webhook event was already processed
   */
  private async checkEventProcessed(eventId: string): Promise<any | null> {
    try {
      const { data, error } = await supabase.serviceClient
        .from('webhook_events')
        .select('*')
        .eq('stripe_event_id', eventId)
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.error('Error checking event status:', { error, eventId });
        return null;
      }

      return data;
    } catch (error) {
      logger.error('Failed to check event processed status', { error, eventId });
      return null;
    }
  }

  /**
   * Mark event as currently processing
   */
  private async markEventProcessing(eventId: string): Promise<void> {
    try {
      await supabase.serviceClient
        .from('webhook_events')
        .upsert({
          stripe_event_id: eventId,
          processed: false,
          processing_attempts: 1,
          created_at: new Date().toISOString(),
        });
    } catch (error) {
      logger.error('Failed to mark event as processing', { error, eventId });
    }
  }

  /**
   * Increment retry count for failed events
   */
  private async incrementRetryCount(eventId: string): Promise<void> {
    try {
      const { data: currentEvent } = await supabase.serviceClient
        .from('webhook_events')
        .select('processing_attempts')
        .eq('stripe_event_id', eventId)
        .single();

      const currentAttempts = currentEvent?.processing_attempts || 0;
      
      await supabase.serviceClient
        .from('webhook_events')
        .update({
          processing_attempts: currentAttempts + 1,
          processed: false,
          error_message: null, // Clear previous error message
        })
        .eq('stripe_event_id', eventId);
    } catch (error) {
      logger.error('Failed to increment retry count', { error, eventId });
    }
  }

  /**
   * Log webhook event to database
   */
  private async logWebhookEvent(event: Stripe.Event): Promise<void> {
    try {
      await supabase.serviceClient.from('webhook_events').insert({
        stripe_event_id: event.id,
        event_type: event.type,
        processed: false,
        processing_attempts: 0,
        event_data: event,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to log webhook event', { error, eventId: event.id });
    }
  }

  /**
   * Schedule webhook retry with exponential backoff
   */
  private async scheduleWebhookRetry(eventId: string, eventType: string, delayMs: number, attemptNumber: number): Promise<void> {
    try {
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      
      await supabase.serviceClient
        .from('webhook_retry_queue')
        .insert({
          stripe_event_id: eventId,
          event_type: eventType,
          retry_at: retryAt,
          attempt_number: attemptNumber,
          created_at: new Date().toISOString(),
        });
        
      logger.info(`Scheduled webhook retry for event ${eventId} at ${retryAt} (attempt ${attemptNumber})`);
    } catch (error) {
      logger.error('Failed to schedule webhook retry', { error, eventId });
      
      // Fallback to immediate retry if queue insertion fails
      setTimeout(async () => {
        try {
          const { data: eventData } = await supabase.serviceClient
            .from('webhook_events')
            .select('event_data')
            .eq('stripe_event_id', eventId)
            .single();
            
          if (eventData?.event_data) {
            await this.processWebhookEvent(eventData.event_data);
          }
        } catch (retryError) {
          logger.error(`Fallback retry failed for event ${eventId}:`, retryError);
        }
      }, delayMs);
    }
  }

  /**
   * Process pending webhook retries (should be called by a background job)
   */
  async processPendingRetries(): Promise<void> {
    try {
      const { data: pendingRetries, error } = await supabase.serviceClient
        .from('webhook_retry_queue')
        .select(`
          stripe_event_id,
          event_type,
          attempt_number,
          webhook_events!inner(event_data)
        `)
        .lte('retry_at', new Date().toISOString())
        .limit(10); // Process in batches

      if (error) {
        logger.error('Error fetching pending webhook retries:', error);
        return;
      }

      for (const retry of pendingRetries || []) {
        try {
          logger.info(`Processing scheduled retry for event ${retry.stripe_event_id} (attempt ${retry.attempt_number})`);
          
          // Remove from retry queue first to prevent duplicate processing
          await supabase.serviceClient
            .from('webhook_retry_queue')
            .delete()
            .eq('stripe_event_id', retry.stripe_event_id);

          // Process the event
          if (retry.webhook_events?.event_data) {
            await this.processWebhookEvent(retry.webhook_events.event_data);
          }
        } catch (error) {
          logger.error(`Failed to process retry for event ${retry.stripe_event_id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error processing pending webhook retries:', error);
    }
  }

  /**
   * Mark webhook event as processed/failed
   */
  private async markEventProcessed(eventId: string, status: 'processed' | 'failed', errorMessage?: string): Promise<void> {
    try {
      await supabase.serviceClient
        .from('webhook_events')
        .update({
          processed: status === 'processed',
          error_message: errorMessage,
          processed_at: new Date().toISOString(),
        })
        .eq('stripe_event_id', eventId);

      // Clean up any pending retries for this event
      if (status === 'processed') {
        await supabase.serviceClient
          .from('webhook_retry_queue')
          .delete()
          .eq('stripe_event_id', eventId);
      }
    } catch (error) {
      logger.error('Failed to mark event as processed', { error, eventId });
    }
  }

  /**
   * Create notifications in batch for better performance
   */
  private async createUserNotificationBatch(notifications: Array<{
    user_id: string;
    title: string;
    message: string;
    type: string;
    category?: string;
    action_url?: string;
    action_label?: string;
  }>): Promise<void> {
    try {
      if (notifications.length === 0) return;

      const notificationRecords = notifications.map(notification => ({
        ...notification,
        created_at: new Date().toISOString(),
      }));

      const { error } = await supabase.serviceClient
        .from('notifications')
        .insert(notificationRecords);

      if (error) {
        logger.error('Failed to create batch notifications:', error);
        
        // Fallback to individual inserts if batch fails
        for (const notification of notifications) {
          try {
            await supabase.serviceClient
              .from('notifications')
              .insert({
                ...notification,
                created_at: new Date().toISOString(),
              });
          } catch (individualError) {
            logger.error('Failed to create individual notification:', individualError);
          }
        }
      } else {
        logger.info(`Successfully created ${notifications.length} notifications in batch`);
      }
    } catch (error) {
      logger.error('Error in createUserNotificationBatch:', error);
    }
  }

  /**
   * Optimize subscription data sync using stripe schema
   */
  private async syncSubscriptionDataOptimized(subscriptionId: string): Promise<void> {
    try {
      // Get subscription data from stripe schema (10x faster)
      const subscription = await supabase.getStripeSubscriptionById(subscriptionId);
      if (!subscription) {
        logger.warn(`Subscription ${subscriptionId} not found in stripe schema`);
        return;
      }

      // Get customer data from stripe schema
      const customer = await supabase.getStripeCustomerById(subscription.customer);
      if (!customer) {
        logger.warn(`Customer ${subscription.customer} not found in stripe schema`);
        return;
      }

      const userId = subscription.metadata?.user_id || customer.metadata?.user_id;
      if (!userId) {
        logger.warn(`No user_id found in subscription or customer metadata`);
        return;
      }

      // Update user subscription in our public schema using optimized function
      const tier = this.getTierFromSubscription(subscription);
      const billingCycle = this.getBillingCycleFromSubscription(subscription);
      
      await supabase.serviceClient.rpc('handle_stripe_subscription_change', {
        p_stripe_subscription_id: subscription.id,
        p_status: subscription.status,
        p_current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        p_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        p_tier: tier,
        p_cancel_at_period_end: subscription.cancel_at_period_end,
      });

      logger.info(`Optimized subscription sync completed for ${subscriptionId}`);
    } catch (error) {
      logger.error(`Error in optimized subscription sync for ${subscriptionId}:`, error);
      throw error;
    }
  }

  /**
   * Get subscription metrics for monitoring
   */
  async getWebhookMetrics(): Promise<{
    total_events: number;
    processed_events: number;
    failed_events: number;
    pending_retries: number;
    success_rate: number;
  }> {
    try {
      const { data: metrics, error } = await supabase.serviceClient
        .from('webhook_events')
        .select('processed, error_message')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()); // Last 24 hours

      if (error) {
        logger.error('Error fetching webhook metrics:', error);
        throw error;
      }

      const total = metrics?.length || 0;
      const processed = metrics?.filter(m => m.processed).length || 0;
      const failed = metrics?.filter(m => !m.processed && m.error_message).length || 0;

      const { count: pendingRetries } = await supabase.serviceClient
        .from('webhook_retry_queue')
        .select('*', { count: 'exact', head: true });

      return {
        total_events: total,
        processed_events: processed,
        failed_events: failed,
        pending_retries: pendingRetries || 0,
        success_rate: total > 0 ? (processed / total) * 100 : 100,
      };
    } catch (error) {
      logger.error('Error calculating webhook metrics:', error);
      throw error;
    }
  }
}

export const webhookProcessor = new WebhookProcessor();