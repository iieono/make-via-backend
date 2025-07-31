import Stripe from 'stripe';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import type { CreateCheckoutSessionRequest, CreateCheckoutSessionResponse } from '@/types';

class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(config.stripe.secretKey, {
      apiVersion: '2024-06-20',
      typescript: true,
    });
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
      return await this.stripe.subscriptions.retrieve(subscriptionId);
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
      // Additional logic for successful payments can be added here
    } catch (error) {
      logger.error('Error handling payment success:', error);
      throw error;
    }
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    try {
      logger.warn(`Payment failed for invoice ${invoice.id}`);
      // Additional logic for failed payments can be added here
      // Could send notification to user, update subscription status, etc.
    } catch (error) {
      logger.error('Error handling payment failure:', error);
      throw error;
    }
  }

  private getTierFromPriceId(priceId?: string): 'free' | 'pro' | 'power' {
    if (!priceId) return 'free';
    
    if (priceId === config.stripe.priceIds.pro) {
      return 'pro';
    } else if (priceId === config.stripe.priceIds.power) {
      return 'power';
    }
    
    return 'free';
  }

  // Utility methods
  async getPriceDetails(priceId: string): Promise<Stripe.Price> {
    try {
      return await this.stripe.prices.retrieve(priceId);
    } catch (error) {
      logger.error('Error fetching price details:', error);
      throw error;
    }
  }

  async getCustomer(customerId: string): Promise<Stripe.Customer> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId);
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
      const subscriptions = await this.stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      });
      return subscriptions.data;
    } catch (error) {
      logger.error('Error fetching customer subscriptions:', error);
      throw error;
    }
  }
}

export const stripeService = new StripeService();