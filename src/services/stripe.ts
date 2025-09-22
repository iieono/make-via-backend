import Stripe from 'stripe';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import { emailService } from '@/services/email-service';
import type { CreateCheckoutSessionRequest, CreateCheckoutSessionResponse } from '@/types';

class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(config.stripe.secretKey, {
      apiVersion: '2024-06-20',
      typescript: true,
    });
  }

  async createExtraAiCheckout(request: {
    userId: string;
    aiPackage: string;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<CreateCheckoutSessionResponse> {
    try {
      const { userId, aiPackage, successUrl, cancelUrl } = request;

      // Get user data
      const user = await supabase.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Get the appropriate price ID for AI package
      const priceId = config.claude.extraAiPriceIds[aiPackage as keyof typeof config.claude.extraAiPriceIds];
      if (!priceId) {
        throw new Error(`No extra AI generations price configured for package: ${aiPackage}`);
      }

      // Get or create Stripe customer using optimized stripe schema lookup
      let stripeCustomer = await supabase.getStripeCustomer(userId);
      let customerId: string;
      
      if (!stripeCustomer) {
        // Try to find existing customer by email in stripe schema (10x faster)
        const existingCustomer = await supabase.getStripeCustomerByEmail(user.email);
        
        if (existingCustomer) {
          // Customer exists in Stripe but not linked in our DB
          customerId = existingCustomer.id;
          
          // Link to our user
          await supabase.createStripeCustomer({
            user_id: userId,
            stripe_customer_id: customerId,
            email: user.email,
            name: user.full_name || undefined,
          });
        } else {
          // Create new customer
          const customer = await this.stripe.customers.create({
            email: user.email,
            name: user.full_name || undefined,
            metadata: { user_id: userId },
          });

          customerId = customer.id;
          
          await supabase.createStripeCustomer({
            user_id: userId,
            stripe_customer_id: customerId,
            email: user.email,
            name: user.full_name || undefined,
          });
        }
      } else {
        customerId = stripeCustomer.stripe_customer_id;
      }

      // Create checkout session for one-time payment using predefined price
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl || `${config.urls.frontend}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl || `${config.urls.frontend}/subscription/canceled`,
        metadata: {
          user_id: userId,
          ai_package: aiPackage,
          purchase_type: 'extra_ai_generations',
        },
      });

      logger.info(`Created extra AI generations checkout for user ${userId}, package: ${aiPackage}, price: ${priceId}`);

      return {
        url: session.url!,
        sessionId: session.id,
      };
    } catch (error) {
      logger.error('Error creating extra generation checkout:', error);
      throw error;
    }
  }

  async createAppBuildCheckout(request: {
    userId: string;
    buildType: 'free_build';
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<CreateCheckoutSessionResponse> {
    try {
      const { userId, buildType, successUrl, cancelUrl } = request;

      // Get user data
      const user = await supabase.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Get the appropriate price ID for app build
      const priceId = config.claude.appBuildPriceIds.freeAppBuild;
      if (!priceId) {
        throw new Error('No app build price configured');
      }

      // Get or create Stripe customer
      let stripeCustomer = await supabase.getStripeCustomer(userId);
      
      if (!stripeCustomer) {
        const customer = await this.stripe.customers.create({
          email: user.email,
          name: user.full_name || undefined,
          metadata: { user_id: userId },
        });

        await supabase.createStripeCustomer({
          user_id: userId,
          stripe_customer_id: customer.id,
          email: user.email,
          name: user.full_name || undefined,
        });

        stripeCustomer = { stripe_customer_id: customer.id };
      }

      // Create checkout session for one-time payment
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        customer: stripeCustomer.stripe_customer_id,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl || `${config.urls.frontend}/build/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl || `${config.urls.frontend}/build/canceled`,
        metadata: {
          user_id: userId,
          build_type: buildType,
          purchase_type: 'app_build',
        },
      });

      logger.info(`Created app build checkout for user ${userId}, type: ${buildType}, price: ${priceId}`);

      return {
        url: session.url!,
        sessionId: session.id,
      };
    } catch (error) {
      logger.error('Error creating app build checkout:', error);
      throw error;
    }
  }

  async createCheckoutSession(
    request: CreateCheckoutSessionRequest
  ): Promise<CreateCheckoutSessionResponse> {
    try {
      const { priceId, userId, successUrl, cancelUrl } = request;

      // Get user data
      const user = await supabase.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Get or create Stripe customer
      let stripeCustomer = await supabase.getStripeCustomer(userId);
      
      if (!stripeCustomer) {
        const customer = await this.stripe.customers.create({
          email: user.email,
          name: user.full_name || undefined,
          metadata: { user_id: userId },
        });

        await supabase.createStripeCustomer({
          user_id: userId,
          stripe_customer_id: customer.id,
          email: user.email,
          name: user.full_name || undefined,
        });

        stripeCustomer = { stripe_customer_id: customer.id };
      }

      // Create checkout session
      const session = await this.stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomer.stripe_customer_id,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl || config.urls.success,
        cancel_url: cancelUrl || config.urls.cancel,
        metadata: {
          user_id: userId,
        },
        subscription_data: {
          metadata: {
            user_id: userId,
          },
        },
        allow_promotion_codes: true,
        billing_address_collection: 'required',
        payment_method_collection: 'if_required',
      });

      logger.info(`Created checkout session for user ${userId}: ${session.id}`);

      return {
        url: session.url!,
        sessionId: session.id,
      };
    } catch (error) {
      logger.error('Error creating checkout session:', error);
      throw error;
    }
  }

  async createCustomerPortalSession(customerId: string): Promise<{ url: string }> {
    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: config.urls.frontend,
      });

      return { url: session.url };
    } catch (error) {
      logger.error('Error creating customer portal session:', error);
      throw error;
    }
  }

  async cancelSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    try {
      const subscription = await this.stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });

      logger.info(`Canceled subscription ${subscriptionId}`);
      return subscription;
    } catch (error) {
      logger.error('Error canceling subscription:', error);
      throw error;
    }
  }

  async reactivateSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    try {
      const subscription = await this.stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
      });

      logger.info(`Reactivated subscription ${subscriptionId}`);
      return subscription;
    } catch (error) {
      logger.error('Error reactivating subscription:', error);
      throw error;
    }
  }

  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    try {
      // Use stripe schema for 10x faster reads
      const subscription = await supabase.getStripeSubscriptionById(subscriptionId);
      if (!subscription) {
        throw new Error(`Subscription ${subscriptionId} not found`);
      }
      return subscription;
    } catch (error) {
      logger.error('Error fetching subscription:', error);
      throw error;
    }
  }

  async handleWebhookEvent(
    payload: string | Buffer,
    signature: string
  ): Promise<Stripe.Event> {
    try {
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        config.stripe.webhookSecret
      );

      logger.info(`Received Stripe webhook: ${event.type}`);
      
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await this.handleSubscriptionChange(event.data.object as Stripe.Subscription);
          break;
          
        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
          break;
          
        case 'invoice.payment_succeeded':
          await this.handlePaymentSucceeded(event.data.object as Stripe.Invoice);
          break;
          
        case 'invoice.payment_failed':
          await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
          break;
          
        case 'checkout.session.completed':
          await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
          break;
          
        default:
          logger.info(`Unhandled webhook event type: ${event.type}`);
      }

      return event;
    } catch (error) {
      logger.error('Error handling webhook:', error);
      throw error;
    }
  }

  private async handleSubscriptionChange(subscription: Stripe.Subscription): Promise<void> {
    try {
      const userId = subscription.metadata.user_id;
      if (!userId) {
        logger.warn('No user_id in subscription metadata');
        return;
      }

      // Determine tier from price ID
      const tier = this.getTierFromPriceId(subscription.items.data[0]?.price.id);

      await supabase.handleStripeSubscriptionChange(
        subscription.id,
        subscription.status,
        new Date(subscription.current_period_start * 1000).toISOString(),
        new Date(subscription.current_period_end * 1000).toISOString(),
        tier,
        subscription.cancel_at_period_end
      );

      logger.info(`Updated subscription for user ${userId}: ${subscription.status}`);
    } catch (error) {
      logger.error('Error handling subscription change:', error);
      throw error;
    }
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    try {
      const userId = subscription.metadata.user_id;
      if (!userId) {
        logger.warn('No user_id in subscription metadata');
        return;
      }

      await supabase.handleStripeSubscriptionChange(
        subscription.id,
        'canceled',
        new Date(subscription.current_period_start * 1000).toISOString(),
        new Date(subscription.current_period_end * 1000).toISOString(),
        'free', // Downgrade to free
        true
      );

      logger.info(`Deleted subscription for user ${userId}`);
    } catch (error) {
      logger.error('Error handling subscription deletion:', error);
      throw error;
    }
  }

  private async handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    try {
      logger.info(`Payment succeeded for invoice ${invoice.id}`);
      
      // Get subscription details
      const subscriptionId = invoice.subscription as string;
      if (!subscriptionId) {
        return;
      }

      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
      const userId = subscription.metadata.user_id;
      
      if (!userId) {
        return;
      }

      // Update subscription status to active (payment recovered)
      await supabase.serviceClient
        .from('user_subscriptions')
        .update({
          status: 'active',
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('stripe_subscription_id', subscriptionId);

      // Cancel any scheduled payment failure emails
      await emailService.cancelScheduledEmails(userId, 'subscription_payment_failed');

      logger.info(`Payment recovered for user ${userId}, cancelled failure emails`);

    } catch (error) {
      logger.error('Error handling payment success:', error);
      throw error;
    }
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    try {
      logger.warn(`Payment failed for invoice ${invoice.id}`);
      
      // Get subscription and customer details
      const subscriptionId = invoice.subscription as string;
      if (!subscriptionId) {
        logger.warn('No subscription ID in failed invoice');
        return;
      }

      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
      const userId = subscription.metadata.user_id;
      
      if (!userId) {
        logger.warn('No user_id in subscription metadata for failed payment');
        return;
      }

      // Get user details for email
      const user = await supabase.getUserById(userId);
      if (!user) {
        logger.warn(`User ${userId} not found for failed payment notification`);
        return;
      }

      // Get customer details
      const customer = await this.stripe.customers.retrieve(invoice.customer as string) as Stripe.Customer;
      
      // Determine plan name from price ID
      const priceId = subscription.items.data[0]?.price.id;
      const planName = this.getPlanNameFromPriceId(priceId);

      // Update subscription status to past_due
      await supabase.serviceClient
        .from('user_subscriptions')
        .update({
          status: 'past_due',
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('stripe_subscription_id', subscriptionId);

      // Schedule email sequence for subscription failure
      await emailService.scheduleSubscriptionFailureEmails(
        userId,
        user.email,
        user.full_name || user.email.split('@')[0],
        planName,
        customer.id
      );

      logger.info(`Scheduled payment failure email sequence for user ${userId}`);

    } catch (error) {
      logger.error('Error handling payment failure:', error);
      throw error;
    }
  }

  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    try {
      const { metadata, mode } = session;
      
      // Handle subscription upgrades (from payment sessions)
      if (mode === 'subscription' && metadata?.userId) {
        await this.handleSubscriptionUpgrade(session);
        return;
      }
      
      if (metadata?.purchase_type === 'extra_ai_generations') {
        const userId = metadata.user_id;
        const aiPackage = metadata.ai_package;

        if (!userId || !aiPackage) {
          logger.warn('Invalid metadata for extra AI generations purchase', metadata);
          return;
        }

        // Get the price details from Stripe to determine quantity and price
        const lineItems = await this.stripe.checkout.sessions.listLineItems(session.id);
        const lineItem = lineItems.data[0];
        
        if (!lineItem?.price) {
          logger.error('No price found in checkout session line items');
          return;
        }

        // Get price details including metadata
        const priceDetails = await this.stripe.prices.retrieve(lineItem.price.id);
        const productDetails = await this.stripe.products.retrieve(priceDetails.product as string);

        // Extract AI generation count from package name
        const aiGenerationCount = this.getAiGenerationCountFromPackage(aiPackage);
        const price = (priceDetails.unit_amount || 0) / 100; // Convert from cents

        // Create extra AI generations purchase record
        const { data, error } = await supabase.rpc('create_extra_generation_purchase', {
          user_uuid: userId,
          user_tier: 'pro', // Default tier for extra purchases
          purchase_quantity: aiGenerationCount,
          purchase_price: price,
          stripe_intent_id: session.payment_intent as string,
        });

        if (error) {
          logger.error('Failed to create extra AI generations purchase:', error);
          throw error;
        }

        logger.info(`Created extra AI generations purchase for user ${userId}: ${aiGenerationCount} generations for $${price}`);
      } else if (metadata?.purchase_type === 'app_build') {
        const userId = metadata.user_id;
        const buildType = metadata.build_type;

        if (!userId || !buildType) {
          logger.warn('Invalid metadata for app build purchase', metadata);
          return;
        }

        // Get the price details
        const lineItems = await this.stripe.checkout.sessions.listLineItems(session.id);
        const lineItem = lineItems.data[0];
        
        if (!lineItem?.price) {
          logger.error('No price found in checkout session line items');
          return;
        }

        const priceDetails = await this.stripe.prices.retrieve(lineItem.price.id);
        const price = (priceDetails.unit_amount || 0) / 100; // Convert from cents

        // Create app build purchase record
        const { data, error } = await supabase.rpc('create_app_build_purchase', {
          user_uuid: userId,
          build_type: buildType,
          purchase_price: price,
          stripe_intent_id: session.payment_intent as string,
        });

        if (error) {
          logger.error('Failed to create app build purchase:', error);
          throw error;
        }

        logger.info(`Created app build purchase for user ${userId}: ${buildType} build for $${price}`);
      }
    } catch (error) {
      logger.error('Error handling checkout completion:', error);
      throw error;
    }
  }

  private async handleSubscriptionUpgrade(session: Stripe.Checkout.Session): Promise<void> {
    try {
      const userId = session.metadata?.userId;
      const planType = session.metadata?.productType;
      const sessionId = session.metadata?.sessionId;

      if (!userId || !planType) {
        logger.warn('Missing metadata for subscription upgrade', session.metadata);
        return;
      }

      // Update payment session status
      if (sessionId) {
        await supabase
          .from('payment_sessions')
          .update({
            status: 'completed',
            stripe_session_id: session.id,
            completed_at: new Date().toISOString(),
            metadata: { stripe_subscription_id: session.subscription }
          })
          .eq('id', sessionId);

        // Log subscription event
        await supabase
          .from('subscription_events')
          .insert({
            user_id: userId,
            event_type: 'payment_succeeded',
            new_tier: planType as 'pro' | 'power',
            payment_session_id: sessionId,
            stripe_event_id: session.id,
            metadata: {
              stripe_session_id: session.id,
              stripe_subscription_id: session.subscription,
              amount: session.amount_total
            }
          });
      }

      logger.info(`Successfully processed subscription upgrade for user ${userId} to ${planType}`);

      // Note: The actual subscription update will be handled by the subscription webhook events
      // that Stripe will send separately (customer.subscription.created/updated)
    } catch (error) {
      logger.error('Error handling subscription upgrade:', error);
      throw error;
    }
  }

  private getAiGenerationCountFromPackage(aiPackage: string): number {
    switch (aiPackage) {
      case 'ai100Free':
        return 100;
      case 'ai100Pro':
        return 100;
      case 'ai400Power':
        return 400;
      default:
        return 100;
    }
  }

  private getTierFromPriceId(priceId?: string): 'free' | 'creator' | 'power' {
    if (!priceId) return 'free';
    
    // Check against product IDs since we have multiple price IDs per product
    if (priceId.includes(config.stripe.productIds.creatorMonthly) || 
        priceId.includes(config.stripe.productIds.creatorYearly)) {
      return 'creator';
    } else if (priceId.includes(config.stripe.productIds.powerMonthly) || 
               priceId.includes(config.stripe.productIds.powerYearly)) {
      return 'power';
    }
    
    return 'free';
  }

  private getPlanNameFromPriceId(priceId?: string): string {
    if (!priceId) return 'Free';
    
    // Check against product IDs
    if (priceId.includes(config.stripe.productIds.creatorMonthly) || 
        priceId.includes(config.stripe.productIds.creatorYearly)) {
      return 'Creator';
    } else if (priceId.includes(config.stripe.productIds.powerMonthly) || 
               priceId.includes(config.stripe.productIds.powerYearly)) {
      return 'Power';
    }
    
    return 'Free';
  }

  // Utility methods
  async getPriceDetails(priceId: string): Promise<Stripe.Price> {
    try {
      // Use stripe schema for 10x faster reads
      const { data, error } = await supabase.serviceClient
        .schema('stripe')
        .from('prices')
        .select('*')
        .eq('id', priceId)
        .single();

      if (error) {
        logger.error('Error fetching price details from stripe schema:', error);
        throw error;
      }

      if (!data) {
        throw new Error(`Price ${priceId} not found`);
      }

      return data;
    } catch (error) {
      logger.error('Error fetching price details:', error);
      throw error;
    }
  }

  async getCustomer(customerId: string): Promise<Stripe.Customer> {
    try {
      // Use stripe schema for 10x faster reads
      const customer = await supabase.getStripeCustomerById(customerId);
      if (!customer) {
        throw new Error(`Customer ${customerId} not found`);
      }
      if (customer.deleted) {
        throw new Error('Customer has been deleted');
      }
      return customer as Stripe.Customer;
    } catch (error) {
      logger.error('Error fetching customer:', error);
      throw error;
    }
  }

  async getCustomerSubscriptions(customerId: string): Promise<Stripe.Subscription[]> {
    try {
      // Use stripe schema for 10x faster reads
      const { data, error } = await supabase.serviceClient
        .schema('stripe')
        .from('subscriptions')
        .select('*')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) {
        logger.error('Error fetching customer subscriptions from stripe schema:', error);
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('Error fetching customer subscriptions:', error);
      throw error;
    }
  }

  async createCustomer(params: {
    userId: string;
    email: string;
    name?: string;
  }): Promise<Stripe.Customer> {
    try {
      const customer = await this.stripe.customers.create({
        email: params.email,
        name: params.name || undefined,
        metadata: { user_id: params.userId },
      });

      logger.info(`Created Stripe customer for user ${params.userId}: ${customer.id}`);
      return customer;
    } catch (error) {
      logger.error('Error creating Stripe customer:', error);
      throw error;
    }
  }

  async createSubscriptionPaymentSheet(params: {
    customerId: string;
    priceId: string;
    metadata: {
      userId: string;
      planId: string;
      billingCycle: string;
    };
  }): Promise<{
    paymentIntent: string;
    ephemeralKey: string;
    customer: string;
    publishableKey: string;
  }> {
    try {
      // Create ephemeral key for customer
      const ephemeralKey = await this.stripe.ephemeralKeys.create(
        { customer: params.customerId },
        { apiVersion: '2024-06-20' }
      );

      // Create subscription with incomplete status
      const subscription = await this.stripe.subscriptions.create({
        customer: params.customerId,
        items: [{ price: params.priceId }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
        metadata: params.metadata,
      });

      const invoice = subscription.latest_invoice as Stripe.Invoice;
      const paymentIntent = invoice.payment_intent as Stripe.PaymentIntent;

      logger.info(`Created subscription payment sheet for user ${params.metadata.userId}: ${subscription.id}`);

      return {
        paymentIntent: paymentIntent.client_secret!,
        ephemeralKey: ephemeralKey.secret,
        customer: params.customerId,
        publishableKey: config.stripe.publishableKey,
      };
    } catch (error) {
      logger.error('Error creating subscription payment sheet:', error);
      throw error;
    }
  }

  async getPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      return await this.stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (error) {
      logger.error('Error fetching payment intent:', error);
      throw error;
    }
  }

  async getSubscriptionByCustomer(customerId: string): Promise<Stripe.Subscription | null> {
    try {
      // Use stripe schema for 10x faster reads
      const activeSubscription = await supabase.getActiveStripeSubscription(customerId);
      return activeSubscription;
    } catch (error) {
      logger.error('Error fetching subscription by customer:', error);
      throw error;
    }
  }

  async updateSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams
  ): Promise<Stripe.Subscription> {
    try {
      const subscription = await this.stripe.subscriptions.update(subscriptionId, params);
      logger.info(`Updated subscription ${subscriptionId}`);
      return subscription;
    } catch (error) {
      logger.error('Error updating subscription:', error);
      throw error;
    }
  }

  async createExtraGenerationCheckout(request: {
    userId: string;
    tier: string;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<CreateCheckoutSessionResponse> {
    try {
      const { userId, tier, successUrl, cancelUrl } = request;

      // Get user data
      const user = await supabase.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Get the appropriate price ID based on tier
      let priceId: string;
      switch (tier) {
        case 'free':
          priceId = config.claude.extraAiPriceIds.ai100Free;
          break;
        case 'creator':
          priceId = config.claude.extraAiPriceIds.ai100Pro;
          break;
        case 'power':
          priceId = config.claude.extraAiPriceIds.ai400Power;
          break;
        default:
          throw new Error(`Invalid tier for extra generations: ${tier}`);
      }

      if (!priceId) {
        throw new Error(`No extra generations price configured for tier: ${tier}`);
      }

      // Get or create Stripe customer
      let stripeCustomer = await supabase.getStripeCustomer(userId);
      
      if (!stripeCustomer) {
        const customer = await this.createCustomer({
          userId,
          email: user.email,
          name: user.full_name || undefined,
        });

        await supabase.createStripeCustomer({
          user_id: userId,
          stripe_customer_id: customer.id,
          email: user.email,
          name: user.full_name || undefined,
        });

        stripeCustomer = { stripe_customer_id: customer.id };
      }

      // Create checkout session for one-time payment
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        customer: stripeCustomer.stripe_customer_id,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl || `${config.urls.frontend}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl || `${config.urls.frontend}/subscription/canceled`,
        metadata: {
          user_id: userId,
          tier,
          purchase_type: 'extra_generations',
        },
      });

      logger.info(`Created extra generation checkout for user ${userId}, tier: ${tier}, price: ${priceId}`);

      return {
        url: session.url!,
        sessionId: session.id,
      };
    } catch (error) {
      logger.error('Error creating extra generation checkout:', error);
      throw error;
    }
  }
}

export const stripeService = new StripeService();