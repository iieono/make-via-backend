import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { stripeService } from '@/services/stripe';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
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
router.get('/', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
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
        claude_usage_limit: 10, // Free tier limit
        screens_limit: 5,
        apps_limit: 1,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
        features: {
          ai_generations: 10,
          max_apps: 1,
          max_screens_per_app: 5,
          support: 'community',
          custom_branding: false,
          export_apk: false,
          collaboration: false,
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
      ai_generations: 10,
      max_apps: 1,
      max_screens_per_app: 5,
      support: 'community',
      custom_branding: false,
      export_apk: false,
      collaboration: false,
    },
    pro: {
      ai_generations: 500,
      max_apps: 10,
      max_screens_per_app: 50,
      support: 'email',
      custom_branding: true,
      export_apk: true,
      collaboration: false,
    },
    power: {
      ai_generations: 2000,
      max_apps: 100,
      max_screens_per_app: 200,
      support: 'priority',
      custom_branding: true,
      export_apk: true,
      collaboration: true,
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
          limit: 10,
          remaining: 10,
          percentage: 0,
        },
        apps: {
          used: 0,
          limit: 1,
          remaining: 1,
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
  const plans = [
    {
      id: 'free',
      name: 'Free',
      price: 0,
      currency: 'USD',
      interval: 'month',
      features: {
        ai_generations: 10,
        max_apps: 1,
        max_screens_per_app: 5,
        support: 'Community',
        custom_branding: false,
        export_apk: false,
        collaboration: false,
      },
      popular: false,
    },
    {
      id: 'pro',
      name: 'Pro',
      price: 29,
      currency: 'USD',
      interval: 'month',
      stripe_price_id: process.env.STRIPE_PRO_PRICE_ID,
      features: {
        ai_generations: 500,
        max_apps: 10,
        max_screens_per_app: 50,
        support: 'Email',
        custom_branding: true,
        export_apk: true,
        collaboration: false,
      },
      popular: true,
    },
    {
      id: 'power',
      name: 'Power',
      price: 99,
      currency: 'USD',
      interval: 'month',
      stripe_price_id: process.env.STRIPE_POWER_PRICE_ID,
      features: {
        ai_generations: 2000,
        max_apps: 100,
        max_screens_per_app: 200,
        support: 'Priority',
        custom_branding: true,
        export_apk: true,
        collaboration: true,
      },
      popular: false,
    },
  ];

  res.json({
    success: true,
    data: plans,
    timestamp: new Date().toISOString(),
  });
}));

export default router;