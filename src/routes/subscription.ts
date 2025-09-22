import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '@/config/config';
import { supabase } from '@/services/supabase';
import { stripeService } from '@/services/stripe';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import { 
  validateSubscription, 
  requireSubscriptionFeature, 
  checkUsageLimit, 
  consumeUsage,
  subscriptionRateLimit,
  validatePaymentData 
} from '@/middleware/subscription-validation';
import type { AuthenticatedRequest } from '@/types';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from '@/middleware/errorHandler';

const router = Router();

// Apply general rate limiting to all routes
router.use(rateLimits.general);

// Get current user subscription
router.get('/', requireAuth, validateSubscription, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;

  if (!subscription) {
    // User has no active subscription, return free tier info
    res.json({
      success: true,
      data: {
        tier: 'free',
        status: 'active',
        claude_usage_count: 0,
        claude_usage_limit: 25, // Free tier limit
        screens_limit: 5,
        apps_limit: 3,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
        features: {
          ai_generations: 25,
          ai_models: ['Haiku'],
          max_apps: 3,
          max_screens_per_app: 5,
          support: 'community',
          custom_branding: false,
          export_apk: false,
          collaboration: false,
          extra_generations_price: 4,
          extra_generations_quantity: 100,
        },
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Get Stripe subscription details if available
  let stripeSubscription = null;
  if (subscription.stripe_subscription_id) {
    try {
      stripeSubscription = await stripeService.getSubscription(subscription.stripe_subscription_id);
    } catch (error) {
      logger.warn('Failed to fetch Stripe subscription:', error);
    }
  }

  // Define features based on tier
  const features = {
    free: {
      ai_generations: 25,
      ai_models: ['Haiku'], // Haiku only
      ai_speed: 'Standard',
      max_apps: 3,
      max_screens_per_app: 5,
      support: 'community',
      custom_branding: false,
      export_apk: false,
      collaboration: false,
      extra_generations_price: 4,
      extra_generations_quantity: 100,
    },
    pro: {
      ai_generations: 500,
      ai_models: ['Sonnet'], // Sonnet default
      ai_speed: 'Fast',
      max_apps: 999999,
      max_screens_per_app: 999999,
      support: 'email',
      custom_branding: true,
      export_apk: true,
      collaboration: false,
      component_marketplace: true,
      basic_logic: true,
      extra_generations_price: 4,
      extra_generations_quantity: 100,
    },
    power: {
      ai_generations: 2000,
      ai_models: ['Sonnet'], // Sonnet priority
      ai_speed: 'Priority',
      max_apps: 999999,
      max_screens_per_app: 999999,
      support: 'priority',
      custom_branding: true,
      export_apk: true,
      white_label: true,
      collaboration: true,
      team_collaborators: '3-5',
      advanced_logic: true,
      component_marketplace: true,
      extra_generations_price: 10,
      extra_generations_quantity: 500,
    },
  };

  res.json({
    success: true,
    data: {
      ...subscription,
      features: features[subscription.tier],
      stripe_details: stripeSubscription ? {
        cancel_at_period_end: stripeSubscription.cancel_at_period_end,
        canceled_at: stripeSubscription.canceled_at,
        trial_end: stripeSubscription.trial_end,
      } : null,
    },
    timestamp: new Date().toISOString(),
  });
}));

// Create checkout session for subscription upgrade
router.post('/checkout', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { priceId, successUrl, cancelUrl } = req.body;

  if (!priceId || typeof priceId !== 'string') {
    throw ValidationError('Price ID is required');
  }

  // Validate price ID format (should start with price_)
  if (!priceId.startsWith('price_')) {
    throw ValidationError('Invalid price ID format');
  }

  // Check if user already has an active subscription
  const currentSubscription = req.subscription;
  if (currentSubscription && currentSubscription.tier !== 'free') {
    throw ConflictError('User already has an active subscription. Use the customer portal to manage subscription.');
  }

  const checkoutSession = await stripeService.createCheckoutSession({
    priceId,
    userId: user.id,
    successUrl,
    cancelUrl,
  });

  logger.info(`Created checkout session for user ${user.id}: ${checkoutSession.sessionId}`);

  res.json({
    success: true,
    data: checkoutSession,
    message: 'Checkout session created successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Create customer portal session for subscription management
router.post('/portal', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  // Get Stripe customer
  const stripeCustomer = await supabase.getStripeCustomer(user.id);
  if (!stripeCustomer) {
    throw NotFoundError('Stripe customer not found. Please contact support.');
  }

  const portalSession = await stripeService.createCustomerPortalSession(
    stripeCustomer.stripe_customer_id
  );

  logger.info(`Created customer portal session for user ${user.id}`);

  res.json({
    success: true,
    data: portalSession,
    message: 'Customer portal session created successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Cancel subscription (set to cancel at period end)
router.post('/cancel', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;

  if (!subscription || !subscription.stripe_subscription_id) {
    throw NotFoundError('No active subscription found');
  }

  if (subscription.tier === 'free') {
    throw ValidationError('Cannot cancel free tier subscription');
  }

  const canceledSubscription = await stripeService.cancelSubscription(
    subscription.stripe_subscription_id
  );

  logger.info(`Canceled subscription for user ${user.id}: ${subscription.stripe_subscription_id}`);

  res.json({
    success: true,
    data: {
      subscription_id: canceledSubscription.id,
      cancel_at_period_end: canceledSubscription.cancel_at_period_end,
      current_period_end: new Date(canceledSubscription.current_period_end * 1000).toISOString(),
    },
    message: 'Subscription will be canceled at the end of the current billing period',
    timestamp: new Date().toISOString(),
  });
}));

// Reactivate canceled subscription
router.post('/reactivate', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;

  if (!subscription || !subscription.stripe_subscription_id) {
    throw NotFoundError('No active subscription found');
  }

  if (subscription.tier === 'free') {
    throw ValidationError('Cannot reactivate free tier subscription');
  }

  // Check if subscription is actually set to cancel
  const stripeSubscription = await stripeService.getSubscription(subscription.stripe_subscription_id);
  if (!stripeSubscription.cancel_at_period_end) {
    throw ConflictError('Subscription is not set to cancel');
  }

  const reactivatedSubscription = await stripeService.reactivateSubscription(
    subscription.stripe_subscription_id
  );

  logger.info(`Reactivated subscription for user ${user.id}: ${subscription.stripe_subscription_id}`);

  res.json({
    success: true,
    data: {
      subscription_id: reactivatedSubscription.id,
      cancel_at_period_end: reactivatedSubscription.cancel_at_period_end,
      status: reactivatedSubscription.status,
    },
    message: 'Subscription reactivated successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Get subscription usage statistics
router.get('/usage', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;

  if (!subscription) {
    // Return free tier usage
    res.json({
      success: true,
      data: {
        tier: 'free',
        claude_usage: {
          used: 0,
          limit: 25,
          remaining: 25,
          percentage: 0,
        },
        apps: {
          used: 0,
          limit: 3,
          remaining: 3,
          percentage: 0,
        },
        screens: {
          used: 0,
          limit: 5,
          remaining: 5,
          percentage: 0,
        },
        period: {
          start: new Date().toISOString(),
          end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Get user's apps count
  const apps = await supabase.getUserApps(user.id, 1000);
  const appsCount = apps.length;

  // Calculate total screens across all apps
  let totalScreens = 0;
  for (const app of apps) {
    const screens = await supabase.getAppScreens(app.id);
    totalScreens += screens.length;
  }

  const claudeUsage = {
    used: subscription.claude_usage_count,
    limit: subscription.claude_usage_limit,
    remaining: Math.max(0, subscription.claude_usage_limit - subscription.claude_usage_count),
    percentage: Math.round((subscription.claude_usage_count / subscription.claude_usage_limit) * 100),
  };

  const appsUsage = {
    used: appsCount,
    limit: subscription.apps_limit,
    remaining: Math.max(0, subscription.apps_limit - appsCount),
    percentage: subscription.apps_limit > 0 ? Math.round((appsCount / subscription.apps_limit) * 100) : 0,
  };

  const screensUsage = {
    used: totalScreens,
    limit: subscription.screens_limit,
    remaining: Math.max(0, subscription.screens_limit - totalScreens),
    percentage: subscription.screens_limit > 0 ? Math.round((totalScreens / subscription.screens_limit) * 100) : 0,
  };

  res.json({
    success: true,
    data: {
      tier: subscription.tier,
      claude_usage: claudeUsage,
      apps: appsUsage,
      screens: screensUsage,
      period: {
        start: subscription.current_period_start,
        end: subscription.current_period_end,
      },
    },
    timestamp: new Date().toISOString(),
  });
}));

// Get available pricing plans
router.get('/plans', asyncHandler(async (req, res) => {
  const { billing_cycle = 'monthly' } = req.query;
  
  const plans = [
    {
      id: 'free',
      name: 'Free',
      display_name: 'Free',
      description: 'Perfect for trying out MakeVia',
      price: 0,
      currency: 'USD',
      interval: billing_cycle,
      stripe_price_id: '',
      features: {
        ai_generations: 25,
        ai_models: ['Claude Haiku'],
        ai_speed: 'Standard',
        max_apps: 3,
        max_screens_per_app: 5,
        support: 'Community',
        custom_branding: false,
        export_apk: false,
        export_cost: 2.99,
        collaboration: false,
        white_label: false,
        priority_support: false,
        extra_generations_price: 9.99,
        extra_generations_quantity: 100,
      },
      limits: {
        ai_generations: 25,
        screens: 5,
        apps: 3,
        unlimitedScreens: false,
        unlimitedApps: false,
      },
      popular: false,
      badge: null,
    },
    {
      id: 'creator',
      name: 'Creator',
      display_name: 'Creator',
      description: 'For serious app creators',
      price: billing_cycle === 'yearly' ? 159.99 : 17.99,
      currency: 'USD',
      interval: billing_cycle,
      stripe_price_id: billing_cycle === 'yearly' 
        ? process.env.STRIPE_CREATOR_YEARLY_PRICE_ID
        : process.env.STRIPE_CREATOR_MONTHLY_PRICE_ID,
      features: {
        ai_generations: 600,
        ai_models: ['Claude Haiku', 'Claude Sonnet'],
        ai_speed: 'Fast',
        max_apps: 'Unlimited',
        max_screens_per_app: 'Unlimited',
        support: 'Email',
        custom_branding: true,
        export_apk: true,
        export_cost: 0,
        collaboration: false,
        white_label: false,
        priority_support: false,
        extra_generations_price: 9.99,
        extra_generations_quantity: 100,
      },
      limits: {
        ai_generations: 600,
        screens: 999999,
        apps: 999999,
        unlimitedScreens: true,
        unlimitedApps: true,
      },
      popular: true,
      badge: 'Most Popular',
      savings: billing_cycle === 'yearly' ? '~26% off' : null,
    },
    {
      id: 'power',
      name: 'Power',
      display_name: 'Power',
      description: 'For teams and agencies',
      price: billing_cycle === 'yearly' ? 669.99 : 69.99,
      currency: 'USD',
      interval: billing_cycle,
      stripe_price_id: billing_cycle === 'yearly'
        ? process.env.STRIPE_POWER_YEARLY_PRICE_ID
        : process.env.STRIPE_POWER_MONTHLY_PRICE_ID,
      features: {
        ai_generations: 2000,
        ai_models: ['Claude Haiku', 'Claude Sonnet', 'Claude Opus'],
        ai_speed: 'Priority',
        max_apps: 'Unlimited',
        max_screens_per_app: 'Unlimited',
        support: 'Priority',
        custom_branding: true,
        export_apk: true,
        export_cost: 0,
        collaboration: true,
        team_collaborators: '3-5',
        white_label: true,
        priority_support: true,
        advanced_logic: true,
        extra_generations_price: 19.99,
        extra_generations_quantity: 500,
      },
      limits: {
        ai_generations: 2000,
        screens: 999999,
        apps: 999999,
        unlimitedScreens: true,
        unlimitedApps: true,
      },
      popular: false,
      badge: 'Enterprise',
      savings: billing_cycle === 'yearly' ? '~20% off' : null,
    },
  ];

  res.json({
    success: true,
    data: plans,
    billing_cycle,
    timestamp: new Date().toISOString(),
  });
}));

// Purchase extra generations (now handled via website)
router.post('/extra-generations', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;
  const { successUrl, cancelUrl } = req.body;

  if (!subscription) {
    throw NotFoundError('No active subscription found');
  }

  // Create Stripe checkout session for extra generations using predefined products
  const checkoutSession = await stripeService.createExtraGenerationCheckout({
    userId: user.id,
    tier: subscription.tier,
    successUrl,
    cancelUrl,
  });

  logger.info(`Created extra generation checkout for user ${user.id}, tier: ${subscription.tier}`);

  res.json({
    success: true,
    data: checkoutSession,
    message: 'Extra generation checkout session created successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Get user's extra generation purchases
router.get('/extra-generations', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  // Get extra generation purchases from database
  const { data: purchases, error } = await supabase
    .from('extra_generation_purchases')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'completed')
    .order('purchased_at', { ascending: false });

  if (error) {
    logger.error('Failed to fetch extra generation purchases:', error);
    throw new Error('Failed to fetch purchases');
  }

  // Calculate totals
  const totalPurchased = purchases?.reduce((sum, p) => sum + p.quantity, 0) || 0;
  const totalRemaining = purchases?.reduce((sum, p) => sum + p.generations_remaining, 0) || 0;
  const totalUsed = purchases?.reduce((sum, p) => sum + p.generations_used, 0) || 0;

  res.json({
    success: true,
    data: {
      purchases: purchases || [],
      summary: {
        total_purchased: totalPurchased,
        total_remaining: totalRemaining,
        total_used: totalUsed,
      },
    },
    timestamp: new Date().toISOString(),
  });
}));

// Get available generations for user (subscription + extra)
router.get('/available-generations', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  // Call database function to get available generations
  const { data, error } = await supabase.rpc('get_available_generations', {
    user_uuid: user.id,
  });

  if (error) {
    logger.error('Failed to get available generations:', error);
    throw new Error('Failed to get available generations');
  }

  res.json({
    success: true,
    data: data[0] || {
      subscription_remaining: 0,
      extra_remaining: 0,
      total_available: 0,
    },
    timestamp: new Date().toISOString(),
  });
}));

// Create payment sheet for mobile Stripe integration
router.post('/create-payment-sheet', requireAuth, subscriptionRateLimit(5, 300000), validatePaymentData, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { planId, billingCycle } = req.body;

  if (!planId || typeof planId !== 'string') {
    throw ValidationError('Plan ID is required');
  }

  if (!billingCycle || !['monthly', 'yearly'].includes(billingCycle)) {
    throw ValidationError('Billing cycle must be monthly or yearly');
  }

  // Validate plan ID
  const validPlans = ['creator', 'power'];
  if (!validPlans.includes(planId)) {
    throw ValidationError('Invalid plan ID. Must be creator or power');
  }

  // Get or create Stripe customer
  let stripeCustomer = await supabase.getStripeCustomer(user.id);
  if (!stripeCustomer) {
    const customer = await stripeService.createCustomer({
      userId: user.id,
      email: user.email,
      name: user.user_metadata?.full_name,
    });
    
    await supabase.createStripeCustomer({
      user_id: user.id,
      stripe_customer_id: customer.id,
      email: user.email,
      name: user.user_metadata?.full_name,
    });
    
    stripeCustomer = {
      user_id: user.id,
      stripe_customer_id: customer.id,
      email: user.email,
      name: user.user_metadata?.full_name,
    };
  }

  // Get the correct product ID from environment configuration
  const productIdKey = `${planId}${billingCycle === 'yearly' ? 'Yearly' : 'Monthly'}` as keyof typeof config.stripe.productIds;
  const productId = config.stripe.productIds[productIdKey];
  
  if (!productId) {
    throw ValidationError(`Product ID not configured for plan: ${planId}, billing: ${billingCycle}`);
  }

  // Get the product data from Stripe schema (10x faster than API)
  const product = await supabase.getStripeProductById(productId);
  if (!product) {
    throw NotFoundError(`Stripe product not found: ${productId}`);
  }

  // Use the default price from the product
  const priceId = product.default_price;
  if (!priceId) {
    throw ValidationError(`No default price configured for product: ${productId}`);
  }

  // Create payment sheet
  const paymentSheet = await stripeService.createSubscriptionPaymentSheet({
    customerId: stripeCustomer.stripe_customer_id,
    priceId,
    metadata: {
      userId: user.id,
      planId,
      billingCycle,
    },
  });

  logger.info(`Created payment sheet for user ${user.id}: ${planId} ${billingCycle}`);

  res.json({
    success: true,
    data: paymentSheet,
    message: 'Payment sheet created successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Confirm payment and update subscription
router.post('/confirm-payment', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { paymentIntentId } = req.body;

  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    throw ValidationError('Payment intent ID is required');
  }

  // Get payment intent from Stripe to verify it's completed
  const paymentIntent = await stripeService.getPaymentIntent(paymentIntentId);
  
  if (paymentIntent.status !== 'succeeded') {
    throw ValidationError('Payment has not succeeded yet');
  }

  // Get subscription from payment intent metadata
  const metadata = paymentIntent.metadata;
  if (metadata.userId !== user.id) {
    throw ValidationError('Payment intent does not belong to current user');
  }

  const planId = metadata.planId;
  const billingCycle = metadata.billingCycle;

  if (!planId || !billingCycle) {
    throw ValidationError('Payment intent metadata is incomplete');
  }

  // Get the subscription from Stripe (should have been created automatically)
  const stripeSubscription = await stripeService.getSubscriptionByCustomer(
    paymentIntent.customer as string
  );

  if (!stripeSubscription) {
    throw new Error('Stripe subscription not found after payment');
  }

  // Update user subscription in database
  const currentTime = new Date().toISOString();
  const currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000).toISOString();

  // Define limits based on plan
  const planLimits = {
    creator: {
      aiGenerations: 500,
      screensLimit: 999999,
      appsLimit: 999999,
    },
    power: {
      aiGenerations: 2000,
      screensLimit: 999999,
      appsLimit: 999999,
    },
  };

  const limits = planLimits[planId];
  if (!limits) {
    throw ValidationError('Invalid plan ID in payment metadata');
  }

  await supabase.upsertUserSubscription({
    userId: user.id,
    tier: planId,
    status: 'active',
    currentPeriodStart: currentTime,
    currentPeriodEnd,
    claudeUsageCount: 0,
    claudeUsageLimit: limits.aiGenerations,
    screensLimit: limits.screensLimit,
    appsLimit: limits.appsLimit,
    stripeSubscriptionId: stripeSubscription.id,
    stripePriceId: stripeSubscription.items.data[0].price.id,
  });

  logger.info(`Updated subscription for user ${user.id}: ${planId} ${billingCycle}`);

  res.json({
    success: true,
    data: {
      subscriptionId: stripeSubscription.id,
      tier: planId,
      billingCycle,
      currentPeriodEnd,
    },
    message: 'Subscription activated successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Generate secure payment URL with JWT for app-to-website flow
router.post('/payments/generate-url', asyncHandler(async (req, res) => {
  const { userId, planId, limitType, source } = req.body;

  if (!userId || !planId) {
    throw ValidationError('userId and planId are required');
  }

  // Validate planId
  const validPlans = ['pro', 'power'];
  if (!validPlans.includes(planId)) {
    throw ValidationError('Invalid plan ID. Must be pro or power');
  }

  // Create payment session record in database
  const sessionId = crypto.randomUUID();
  
  try {
    const { error: sessionError } = await supabase
      .from('payment_sessions')
      .insert({
        id: sessionId,
        user_id: userId,
        plan_id: planId,
        limit_type: limitType,
        source: source || 'app',
        status: 'pending',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
      });

    if (sessionError) {
      logger.error('Failed to create payment session:', sessionError);
      throw new Error('Failed to create payment session');
    }

    // Generate JWT token with payment session info
    const token = jwt.sign(
      {
        userId,
        sessionId,
        planId,
        limitType,
        source,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (30 * 60), // 30 minutes
      },
      config.security.jwtSecret
    );

    // Generate payment URL
    const baseUrl = config.urls.frontend;
    const paymentUrl = `${baseUrl}/upgrade?token=${token}&plan=${planId}&return=app`;

    logger.info(`Generated secure payment URL for user ${userId}, plan: ${planId}`);

    res.json({
      success: true,
      data: {
        paymentUrl,
        sessionId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
      message: 'Payment URL generated successfully',
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    logger.error('Failed to generate payment URL:', error);
    throw new Error('Failed to generate payment URL');
  }
}));

// Verify payment completion and return app status
router.post('/payments/verify', asyncHandler(async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    throw ValidationError('sessionId is required');
  }

  try {
    // Get payment session
    const { data: session, error: sessionError } = await supabase
      .from('payment_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      throw NotFoundError('Payment session not found');
    }

    // Update session as verified
    const { error: updateError } = await supabase
      .from('payment_sessions')
      .update({
        status: 'verified',
        verified_at: new Date().toISOString(),
      })
      .eq('id', sessionId);

    if (updateError) {
      logger.error('Failed to update payment session:', updateError);
    }

    res.json({
      success: true,
      data: {
        sessionId,
        status: session.status,
        planId: session.plan_id,
        userId: session.user_id,
      },
      message: 'Payment verification successful',
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    logger.error('Failed to verify payment:', error);
    throw new Error('Failed to verify payment');
  }
}));

// Change subscription plan (upgrade/downgrade)
router.post('/change-plan', requireAuth, validateSubscription, subscriptionRateLimit(3, 600000), validatePaymentData, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { newPlanId, newBillingCycle } = req.body;

  if (!newPlanId || !newBillingCycle) {
    throw ValidationError('New plan ID and billing cycle are required');
  }

  const validPlans = ['free', 'creator', 'power'];
  const validCycles = ['monthly', 'yearly'];
  
  if (!validPlans.includes(newPlanId)) {
    throw ValidationError('Invalid plan ID');
  }
  
  if (!validCycles.includes(newBillingCycle)) {
    throw ValidationError('Invalid billing cycle');
  }

  const currentSubscription = req.subscription;
  
  // Handle downgrade to free
  if (newPlanId === 'free') {
    if (!currentSubscription || !currentSubscription.stripe_subscription_id) {
      throw ValidationError('No active subscription to cancel');
    }
    
    const canceledSubscription = await stripeService.cancelSubscription(
      currentSubscription.stripe_subscription_id
    );
    
    logger.info(`Canceled subscription for user ${user.id}: ${currentSubscription.stripe_subscription_id}`);
    
    res.json({
      success: true,
      data: {
        action: 'downgrade_to_free',
        effective_date: new Date(canceledSubscription.current_period_end * 1000).toISOString(),
        message: 'Subscription will be canceled at the end of the current billing period',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Get price ID for new plan
  const priceIdMap = {
    creator: {
      monthly: process.env.STRIPE_CREATOR_MONTHLY_PRICE_ID,
      yearly: process.env.STRIPE_CREATOR_YEARLY_PRICE_ID,
    },
    power: {
      monthly: process.env.STRIPE_POWER_MONTHLY_PRICE_ID,
      yearly: process.env.STRIPE_POWER_YEARLY_PRICE_ID,
    },
  };

  const newPriceId = priceIdMap[newPlanId]?.[newBillingCycle];
  if (!newPriceId) {
    throw ValidationError(`Price ID not configured for plan: ${newPlanId}, billing: ${newBillingCycle}`);
  }

  // If user has existing subscription, modify it
  if (currentSubscription && currentSubscription.stripe_subscription_id) {
    const stripeSubscription = await stripeService.getSubscription(currentSubscription.stripe_subscription_id);
    
    const updatedSubscription = await stripeService.updateSubscription(
      currentSubscription.stripe_subscription_id,
      {
        items: [{
          id: stripeSubscription.items.data[0].id,
          price: newPriceId,
        }],
        proration_behavior: 'always_invoice',
        metadata: {
          previous_tier: currentSubscription.tier,
          new_tier: newPlanId,
          changed_at: new Date().toISOString(),
        },
      }
    );

    logger.info(`Updated subscription for user ${user.id}: ${currentSubscription.tier} -> ${newPlanId}`);

    res.json({
      success: true,
      data: {
        action: 'plan_change',
        old_plan: currentSubscription.tier,
        new_plan: newPlanId,
        billing_cycle: newBillingCycle,
        effective_immediately: true,
      },
      message: 'Subscription plan updated successfully',
      timestamp: new Date().toISOString(),
    });
  } else {
    // Create new subscription for user upgrading from free
    res.json({
      success: false,
      message: 'Use create-payment-sheet endpoint to upgrade from free tier',
      timestamp: new Date().toISOString(),
    });
  }
}));

// Switch billing cycle (monthly <-> yearly)
router.post('/change-billing-cycle', requireAuth, validateSubscription, subscriptionRateLimit(3, 600000), asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { newBillingCycle } = req.body;

  if (!newBillingCycle || !['monthly', 'yearly'].includes(newBillingCycle)) {
    throw ValidationError('Valid billing cycle (monthly/yearly) is required');
  }

  const currentSubscription = req.subscription;
  if (!currentSubscription || !currentSubscription.stripe_subscription_id) {
    throw ValidationError('No active subscription found');
  }

  if (currentSubscription.tier === 'free') {
    throw ValidationError('Cannot change billing cycle for free tier');
  }

  // Get new price ID for same tier but different billing cycle
  const priceIdMap = {
    creator: {
      monthly: process.env.STRIPE_CREATOR_MONTHLY_PRICE_ID,
      yearly: process.env.STRIPE_CREATOR_YEARLY_PRICE_ID,
    },
    power: {
      monthly: process.env.STRIPE_POWER_MONTHLY_PRICE_ID,
      yearly: process.env.STRIPE_POWER_YEARLY_PRICE_ID,
    },
  };

  const newPriceId = priceIdMap[currentSubscription.tier]?.[newBillingCycle];
  if (!newPriceId) {
    throw ValidationError(`Price ID not configured for tier: ${currentSubscription.tier}, billing: ${newBillingCycle}`);
  }

  const stripeSubscription = await stripeService.getSubscription(currentSubscription.stripe_subscription_id);
  
  const updatedSubscription = await stripeService.updateSubscription(
    currentSubscription.stripe_subscription_id,
    {
      items: [{
        id: stripeSubscription.items.data[0].id,
        price: newPriceId,
      }],
      proration_behavior: 'always_invoice',
      metadata: {
        previous_billing_cycle: currentSubscription.billing_cycle || 'monthly',
        new_billing_cycle: newBillingCycle,
        changed_at: new Date().toISOString(),
      },
    }
  );

  logger.info(`Changed billing cycle for user ${user.id}: ${currentSubscription.billing_cycle} -> ${newBillingCycle}`);

  res.json({
    success: true,
    data: {
      action: 'billing_cycle_change',
      tier: currentSubscription.tier,
      old_billing_cycle: currentSubscription.billing_cycle || 'monthly',
      new_billing_cycle: newBillingCycle,
      effective_immediately: true,
    },
    message: 'Billing cycle updated successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Extra Generation Pack Endpoints

// Get available extra generation packs for user's tier
router.get('/extra-generations/available', requireAuth, validateSubscription, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;
  const tier = subscription?.tier || 'free';

  // Define available packs based on tier
  const availablePacks = [];

  if (tier === 'free') {
    availablePacks.push({
      id: 'extra_100_free',
      name: '100 Extra Generations',
      description: 'Perfect for extending your free tier usage',
      quantity: 100,
      price: 9.99,
      currency: 'USD',
      stripe_price_id: process.env.STRIPE_EXTRA_AI_100_FREE_PRICE_ID,
      tier: 'free',
      best_value: false,
    });
  } else if (tier === 'creator') {
    availablePacks.push({
      id: 'extra_100_creator',
      name: '100 Extra Generations',
      description: 'Boost your Creator plan with more AI generations',
      quantity: 100,
      price: 9.99,
      currency: 'USD',
      stripe_price_id: process.env.STRIPE_EXTRA_AI_100_CREATOR_PRICE_ID,
      tier: 'creator',
      best_value: true,
    });
  } else if (tier === 'power') {
    availablePacks.push({
      id: 'extra_500_power',
      name: '500 Extra Generations',
      description: 'Supercharge your Power plan with bulk generations',
      quantity: 500,
      price: 19.99,
      currency: 'USD',
      stripe_price_id: process.env.STRIPE_EXTRA_AI_500_POWER_PRICE_ID,
      tier: 'power',
      best_value: true,
    });
  }

  res.json({
    success: true,
    data: {
      current_tier: tier,
      available_packs: availablePacks,
      features: {
        no_expiration: true,
        used_after_subscription: true,
        no_refunds: true,
      },
    },
    timestamp: new Date().toISOString(),
  });
}));

// Purchase extra generation pack
router.post('/extra-generations/purchase', requireAuth, validateSubscription, subscriptionRateLimit(5, 300000), asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;
  const { packId } = req.body;

  if (!packId || typeof packId !== 'string') {
    throw ValidationError('Pack ID is required');
  }

  const tier = subscription?.tier || 'free';

  // Validate pack ID for user's tier
  const validPacks = {
    free: ['extra_100_free'],
    creator: ['extra_100_creator'],
    power: ['extra_500_power'],
  };

  if (!validPacks[tier]?.includes(packId)) {
    throw ValidationError(`Pack ${packId} not available for ${tier} tier`);
  }

  // Get pack details and Stripe price ID
  const packDetails = {
    extra_100_free: {
      quantity: 100,
      price: 9.99,
      stripe_price_id: process.env.STRIPE_EXTRA_AI_100_FREE_PRICE_ID,
    },
    extra_100_creator: {
      quantity: 100,
      price: 9.99,
      stripe_price_id: process.env.STRIPE_EXTRA_AI_100_CREATOR_PRICE_ID,
    },
    extra_500_power: {
      quantity: 500,
      price: 19.99,
      stripe_price_id: process.env.STRIPE_EXTRA_AI_500_POWER_PRICE_ID,
    },
  };

  const pack = packDetails[packId];
  if (!pack || !pack.stripe_price_id) {
    throw ValidationError('Invalid pack configuration');
  }

  // Get or create Stripe customer
  let stripeCustomer = await supabase.getStripeCustomer(user.id);
  if (!stripeCustomer) {
    const customer = await stripeService.createCustomer({
      userId: user.id,
      email: user.email,
      name: user.user_metadata?.full_name,
    });
    
    await supabase.createStripeCustomer({
      user_id: user.id,
      stripe_customer_id: customer.id,
      email: user.email,
      name: user.user_metadata?.full_name,
    });
    
    stripeCustomer = {
      user_id: user.id,
      stripe_customer_id: customer.id,
      email: user.email,
      name: user.user_metadata?.full_name,
    };
  }

  // Create one-time payment session for extra generations
  const session = await stripeService.createOneTimePaymentSession({
    customerId: stripeCustomer.stripe_customer_id,
    priceId: pack.stripe_price_id,
    quantity: 1,
    metadata: {
      userId: user.id,
      purchaseType: 'extra_generations',
      packId: packId,
      tier: tier,
      quantity: pack.quantity.toString(),
    },
    successUrl: `${process.env.FRONTEND_URL}/settings/usage?payment=success`,
    cancelUrl: `${process.env.FRONTEND_URL}/settings/usage?payment=cancelled`,
  });

  logger.info(`Created extra generation purchase session for user ${user.id}: ${packId}`);

  res.json({
    success: true,
    data: {
      session_id: session.id,
      checkout_url: session.url,
      pack_details: {
        id: packId,
        quantity: pack.quantity,
        price: pack.price,
        tier: tier,
      },
    },
    message: 'Extra generation purchase session created',
    timestamp: new Date().toISOString(),
  });
}));

// Get user's extra generation purchase history
router.get('/extra-generations/history', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  const { data: purchases, error } = await supabase
    .from('extra_generation_purchases')
    .select('*')
    .eq('user_id', user.id)
    .order('purchased_at', { ascending: false });

  if (error) {
    logger.error('Error fetching extra generation history:', error);
    throw new Error('Failed to fetch purchase history');
  }

  const totalPurchased = purchases.reduce((sum, p) => sum + p.quantity, 0);
  const totalRemaining = purchases.reduce((sum, p) => sum + p.generations_remaining, 0);
  const totalUsed = purchases.reduce((sum, p) => sum + p.generations_used, 0);

  res.json({
    success: true,
    data: {
      purchases: purchases.map(p => ({
        id: p.id,
        tier: p.tier,
        quantity: p.quantity,
        price_paid: p.price_paid,
        generations_used: p.generations_used,
        generations_remaining: p.generations_remaining,
        package_type: p.package_type,
        purchased_at: p.purchased_at,
        status: p.status,
      })),
      summary: {
        total_purchased: totalPurchased,
        total_used: totalUsed,
        total_remaining: totalRemaining,
        total_spent: purchases.reduce((sum, p) => sum + parseFloat(p.price_paid), 0),
      },
    },
    timestamp: new Date().toISOString(),
  });
}));

// === BUILD PACK ENDPOINTS ===

// Check if build pack is purchased for specific app
router.get('/build-pack/check/:appId', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { appId } = req.params;

  if (!appId) {
    throw ValidationError('App ID is required');
  }

  try {
    // Check if build pack is already purchased for this app
    const { data: purchase, error } = await supabase
      .from('app_build_purchases')
      .select('*')
      .eq('user_id', user.id)
      .eq('app_id', appId)
      .eq('status', 'active')
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      logger.error('Error checking build pack purchase:', error);
      throw new Error('Failed to check build pack status');
    }

    const isPurchased = !!purchase;
    const isUsed = purchase?.is_used || false;

    res.json({
      success: true,
      data: {
        app_id: appId,
        is_purchased: isPurchased,
        is_used: isUsed,
        can_build: isPurchased && !isUsed,
        purchase_date: purchase?.created_at || null,
        used_date: purchase?.used_at || null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Build pack check error:', error);
    throw new Error('Failed to check build pack status');
  }
}));

// Purchase build pack for APK generation
router.post('/build-pack/purchase', requireAuth, validateSubscription, subscriptionRateLimit(3, 300000), asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription!;
  const { app_id } = req.body;

  if (!app_id) {
    throw ValidationError('App ID is required');
  }

  // Only free tier users need to purchase build packs
  if (subscription.tier !== 'free') {
    throw ValidationError('Build pack purchase is only available for free tier users');
  }

  try {
    // Check if build pack is already purchased for this app
    const { data: existingPurchase, error: checkError } = await supabase
      .from('app_build_purchases')
      .select('id, status, is_used')
      .eq('user_id', user.id)
      .eq('app_id', app_id)
      .eq('status', 'active')
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      logger.error('Error checking existing build pack:', checkError);
      throw new Error('Failed to check existing build pack');
    }

    if (existingPurchase) {
      return res.json({
        success: true,
        data: {
          app_id,
          already_purchased: true,
          is_used: existingPurchase.is_used,
          can_build: !existingPurchase.is_used,
          message: existingPurchase.is_used 
            ? 'Build pack already used for this app'
            : 'Build pack already purchased and ready to use'
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Verify the app exists and belongs to the user
    const { data: app, error: appError } = await supabase
      .from('apps')
      .select('id, name, user_id')
      .eq('id', app_id)
      .eq('user_id', user.id)
      .single();

    if (appError || !app) {
      throw ValidationError('App not found or access denied');
    }

    // Get build pack price from environment
    const buildPackPriceId = process.env.STRIPE_BUILD_PACK_PRICE_ID;
    if (!buildPackPriceId) {
      logger.error('STRIPE_BUILD_PACK_PRICE_ID not configured');
      throw new Error('Build pack pricing not configured');
    }

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: buildPackPriceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      customer_email: user.email,
      metadata: {
        user_id: user.id,
        app_id: app_id,
        app_name: app.name,
        purchase_type: 'build_pack',
        tier: subscription.tier,
      },
      success_url: `${process.env.FRONTEND_URL}/apps/${app_id}/build?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/apps/${app_id}/build?canceled=true`,
    });

    logger.info(`Build pack checkout session created for user ${user.id}, app ${app_id}: ${session.id}`);

    res.json({
      success: true,
      data: {
        checkout_url: session.url,
        session_id: session.id,
        app_id: app_id,
        price: '$2.99',
        currency: 'USD',
      },
      message: 'Build pack checkout session created successfully',
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    logger.error('Build pack purchase error:', error);
    if (error.message.includes('already purchased')) {
      throw ValidationError(error.message);
    }
    throw new Error('Failed to initiate build pack purchase');
  }
}));

// Mark build pack as used (called when user actually builds APK)
router.post('/build-pack/use/:appId', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { appId } = req.params;

  if (!appId) {
    throw ValidationError('App ID is required');
  }

  try {
    // Use the database function to mark build pack as used
    const { data: result, error } = await supabase.rpc('use_build_pack', {
      user_uuid: user.id,
      app_uuid: appId,
    });

    if (error) {
      logger.error('Error using build pack:', error);
      if (error.message.includes('not found')) {
        throw ValidationError('Build pack not found for this app');
      }
      if (error.message.includes('already used')) {
        throw ValidationError('Build pack already used for this app');
      }
      throw new Error('Failed to use build pack');
    }

    if (!result) {
      throw ValidationError('No valid build pack found for this app');
    }

    logger.info(`Build pack used for user ${user.id}, app ${appId}`);

    res.json({
      success: true,
      data: {
        app_id: appId,
        used: true,
        used_at: new Date().toISOString(),
      },
      message: 'Build pack used successfully',
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    logger.error('Build pack usage error:', error);
    throw new Error('Failed to use build pack');
  }
}));

// Get build pack purchase history
router.get('/build-pack/history', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  try {
    // Get all build pack purchases for the user
    const { data: purchases, error } = await supabase
      .from('app_build_purchases')
      .select(`
        *,
        apps:app_id (
          id,
          name,
          status
        )
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching build pack history:', error);
      throw new Error('Failed to fetch build pack history');
    }

    const totalSpent = purchases
      .filter(p => p.status === 'active')
      .reduce((sum, p) => sum + parseFloat(p.price_paid), 0);

    const activeCount = purchases.filter(p => p.status === 'active' && !p.is_used).length;
    const usedCount = purchases.filter(p => p.status === 'active' && p.is_used).length;

    res.json({
      success: true,
      data: {
        purchases: purchases.map(p => ({
          id: p.id,
          app_id: p.app_id,
          app_name: p.apps?.name || 'Unknown App',
          app_status: p.apps?.status || 'unknown',
          price_paid: parseFloat(p.price_paid),
          currency: p.currency,
          status: p.status,
          is_used: p.is_used,
          created_at: p.created_at,
          used_at: p.used_at,
        })),
        summary: {
          total_purchases: purchases.length,
          active_unused: activeCount,
          active_used: usedCount,
          total_spent: totalSpent,
        },
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    logger.error('Build pack history error:', error);
    throw new Error('Failed to fetch build pack history');
  }
}));

export default router;