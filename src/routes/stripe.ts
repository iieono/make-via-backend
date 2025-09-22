import { Router } from 'express';
import Stripe from 'stripe';
import express, { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../types';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { logger } from '../utils/logger';
import { webhookProcessor } from '../services/webhook-processor';
import { config } from '../config/config';

const router = Router();
const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2024-06-20',
  typescript: true,
});

// Stripe webhook endpoint (no auth required)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
    logger.info(`Received Stripe webhook: ${event.type}`, { eventId: event.id });

    // Process webhook asynchronously
    webhookProcessor.processWebhookEvent(event).catch(error => {
      logger.error('Failed to process webhook event', {
        eventId: event.id,
        eventType: event.type,
        error: error.message,
      });
    });

    res.json({ received: true });
  } catch (err) {
    logger.error('Webhook signature verification failed', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Create checkout session for subscription
router.post('/create-checkout-session', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { price_id, tier, success_url, cancel_url } = req.body;
    const userId = req.user?.id;

    if (!userId || !price_id || !tier) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get or create Stripe customer
    let { data: userProfile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id, email, full_name')
      .eq('id', userId)
      .single();

    let customerId = userProfile?.stripe_customer_id;

    if (!customerId) {
      // Create new Stripe customer
      const customer = await stripe.customers.create({
        email: userProfile?.email,
        name: userProfile?.full_name,
        metadata: {
          user_id: userId,
        },
      });

      customerId = customer.id;

      // Update user profile with Stripe customer ID
      await supabase
        .from('user_profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: price_id,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: success_url || `${config.app.frontendUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancel_url || `${config.app.frontendUrl}/subscription/cancel`,
      metadata: {
        user_id: userId,
        tier: tier,
      },
      subscription_data: {
        metadata: {
          user_id: userId,
          tier: tier,
        },
      },
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      tax_id_collection: {
        enabled: true,
      },
    });

    res.json({ checkout_url: session.url });
  } catch (error) {
    logger.error('Failed to create checkout session', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create payment sheet for in-app purchases
router.post('/create-payment-sheet', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { price_id, tier, metadata = {} } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Get or create Stripe customer
    let { data: userProfile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id, email, full_name')
      .eq('id', userId)
      .single();

    let customerId = userProfile?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userProfile?.email,
        name: userProfile?.full_name,
        metadata: { user_id: userId },
      });

      customerId = customer.id;

      await supabase
        .from('user_profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    // Determine amount based on purchase type
    let amount = 299; // Default $2.99 for app export
    
    if (metadata.purchase_type === 'extra_generations') {
      const generationCount = parseInt(metadata.generation_count || '50');
      if (generationCount === 50) amount = 999; // $9.99 for 50 extra generations
      if (generationCount === 100) amount = 1799; // $17.99 for 100 extra generations
      if (generationCount === 250) amount = 3999; // $39.99 for 250 extra generations
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'usd',
      customer: customerId,
      metadata: {
        user_id: userId,
        tier: tier,
        ...metadata,
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    // Create ephemeral key
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2024-06-20' }
    );

    res.json({
      payment_intent: paymentIntent.client_secret,
      ephemeral_key: ephemeralKey.secret,
      customer: customerId,
      publishable_key: config.stripe.publishableKey,
    });
  } catch (error) {
    logger.error('Failed to create payment sheet', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to create payment sheet' });
  }
});

// Create customer portal session
router.post('/create-customer-portal', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { return_url } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Get user profile with Stripe customer ID
    let { data: userProfile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (!userProfile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    // Create customer portal session
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: userProfile.stripe_customer_id,
      return_url: return_url || `${config.app.frontendUrl}/subscription/billing`,
    });

    res.json({ portal_url: portalSession.url });
  } catch (error) {
    logger.error('Failed to create customer portal session', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to create customer portal session' });
  }
});

// Get subscription details
router.get('/subscription', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Get user subscription from database
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (!subscription) {
      return res.json({ subscription: null });
    }

    // Get Stripe subscription details using stripe schema (10x faster)
    let stripeSubscription = null;
    if (subscription.stripe_subscription_id) {
      stripeSubscription = await supabase.getStripeSubscriptionById(subscription.stripe_subscription_id);
      
      // If we need expanded data not available in stripe schema, fall back to API
      if (stripeSubscription && req.query.expand) {
        stripeSubscription = await stripe.subscriptions.retrieve(
          subscription.stripe_subscription_id,
          {
            expand: ['latest_invoice', 'customer.default_source'],
          }
        );
      }
    }

    res.json({
      subscription,
      stripe_subscription: stripeSubscription,
    });
  } catch (error) {
    logger.error('Failed to get subscription details', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to get subscription details' });
  }
});

// Get billing history
router.get('/invoices', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { limit = 10 } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Get user's Stripe customer ID
    let { data: userProfile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (!userProfile?.stripe_customer_id) {
      return res.json({ invoices: [] });
    }

    // Get invoices using stripe schema (10x faster)
    const invoices = await supabase.getStripeInvoicesForCustomer(
      userProfile.stripe_customer_id, 
      parseInt(limit as string)
    );

    res.json({ invoices });
  } catch (error) {
    logger.error('Failed to get billing history', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to get billing history' });
  }
});

// Get payment methods
router.get('/payment-methods', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Get user's Stripe customer ID
    let { data: userProfile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (!userProfile?.stripe_customer_id) {
      return res.json({ payment_methods: [] });
    }

    // Get payment methods from Stripe
    const paymentMethods = await stripe.paymentMethods.list({
      customer: userProfile.stripe_customer_id,
      type: 'card',
    });

    res.json({ payment_methods: paymentMethods.data });
  } catch (error) {
    logger.error('Failed to get payment methods', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to get payment methods' });
  }
});

// Get usage analytics
router.get('/usage', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { period = 'current' } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Call Supabase RPC function to get usage data
    const { data: usage, error } = await supabase.rpc('get_user_usage_analytics', {
      p_user_id: userId,
      p_period: period,
    });

    if (error) {
      throw error;
    }

    res.json({ usage });
  } catch (error) {
    logger.error('Failed to get usage analytics', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to get usage analytics' });
  }
});

// Cancel subscription
router.post('/cancel-subscription', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { reason, feedback, cancel_at_period_end = true } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Get user subscription
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (!subscription?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Cancel subscription in Stripe
    const canceledSubscription = await stripe.subscriptions.update(
      subscription.stripe_subscription_id,
      {
        cancel_at_period_end: cancel_at_period_end,
        metadata: {
          cancellation_reason: reason || 'user_requested',
          cancellation_feedback: feedback || '',
        },
      }
    );

    // Log cancellation reason
    await supabase.from('subscription_cancellations').insert({
      user_id: userId,
      subscription_id: subscription.stripe_subscription_id,
      reason: reason || 'user_requested',
      feedback: feedback,
      cancelled_at: new Date().toISOString(),
      effective_date: new Date(canceledSubscription.current_period_end * 1000).toISOString(),
    });

    res.json({
      success: true,
      cancellation_effective: new Date(canceledSubscription.current_period_end * 1000),
    });
  } catch (error) {
    logger.error('Failed to cancel subscription', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Reactivate subscription
router.post('/reactivate-subscription', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Get user subscription
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .single();

    if (!subscription?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    // Reactivate subscription in Stripe
    const reactivatedSubscription = await stripe.subscriptions.update(
      subscription.stripe_subscription_id,
      {
        cancel_at_period_end: false,
        metadata: {
          reactivated_at: new Date().toISOString(),
        },
      }
    );

    res.json({
      success: true,
      subscription: reactivatedSubscription,
    });
  } catch (error) {
    logger.error('Failed to reactivate subscription', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
});

// Upgrade/downgrade subscription
router.post('/change-subscription', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { new_price_id, tier } = req.body;

    if (!userId || !new_price_id || !tier) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get user subscription
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (!subscription?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Get current subscription from Stripe
    const currentSubscription = await stripe.subscriptions.retrieve(
      subscription.stripe_subscription_id
    );

    // Update subscription with new price
    const updatedSubscription = await stripe.subscriptions.update(
      subscription.stripe_subscription_id,
      {
        items: [{
          id: currentSubscription.items.data[0].id,
          price: new_price_id,
        }],
        proration_behavior: 'always_invoice',
        metadata: {
          previous_tier: currentSubscription.metadata.tier || 'unknown',
          new_tier: tier,
          changed_at: new Date().toISOString(),
        },
      }
    );

    res.json({
      success: true,
      subscription: updatedSubscription,
    });
  } catch (error) {
    logger.error('Failed to change subscription', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to change subscription' });
  }
});

// Apply coupon/discount
router.post('/apply-coupon', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { coupon_id } = req.body;

    if (!userId || !coupon_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get user's Stripe customer ID
    let { data: userProfile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (!userProfile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    // Validate coupon
    const coupon = await stripe.coupons.retrieve(coupon_id);
    
    // Apply coupon to customer
    const customer = await stripe.customers.update(
      userProfile.stripe_customer_id,
      {
        coupon: coupon_id,
      }
    );

    res.json({
      success: true,
      coupon: coupon,
      customer: customer,
    });
  } catch (error) {
    logger.error('Failed to apply coupon', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to apply coupon' });
  }
});

// Get upcoming invoice preview
router.get('/upcoming-invoice', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(400).json({ error: 'User not authenticated' });
    }

    // Get user's Stripe customer ID
    let { data: userProfile } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (!userProfile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    try {
      // Get upcoming invoice
      const invoice = await stripe.invoices.retrieveUpcoming({
        customer: userProfile.stripe_customer_id,
      });

      res.json({ invoice });
    } catch (error) {
      // No upcoming invoice
      if (error.code === 'invoice_upcoming_none') {
        res.json({ invoice: null });
      } else {
        throw error;
      }
    }
  } catch (error) {
    logger.error('Failed to get upcoming invoice', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to get upcoming invoice' });
  }
});

export default router;