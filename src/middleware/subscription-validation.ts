import { Request, Response, NextFunction } from 'express';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import { ValidationError, AuthenticationError, ForbiddenError } from '@/utils/errors';

interface AuthenticatedRequest extends Request {
  user?: any;
  subscription?: any;
}

export interface SubscriptionLimits {
  ai_generations: number;
  screens: number;
  apps: number;
  unlimitedScreens: boolean;
  unlimitedApps: boolean;
}

export interface SubscriptionFeatures {
  ai_models: string[];
  export_apk: boolean;
  collaboration: boolean;
  white_label: boolean;
  priority_support: boolean;
}

/**
 * Middleware to validate subscription status and attach to request
 */
export const validateSubscription = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user?.id) {
      throw AuthenticationError('User not authenticated');
    }

    // Get user's current subscription
    const { data: subscriptionData, error } = await supabase.rpc('get_user_subscription', {
      user_uuid: req.user.id,
    });

    if (error) {
      logger.error('Error fetching user subscription:', error);
      throw new Error('Failed to fetch subscription data');
    }

    // If no subscription found, create default free subscription
    if (!subscriptionData || subscriptionData.length === 0) {
      await createFreeSubscription(req.user.id);
      
      // Retry fetching subscription
      const { data: retryData, error: retryError } = await supabase.rpc('get_user_subscription', {
        user_uuid: req.user.id,
      });

      if (retryError || !retryData || retryData.length === 0) {
        logger.error('Failed to create or fetch default subscription:', retryError);
        throw new Error('Failed to initialize subscription');
      }

      req.subscription = retryData[0];
    } else {
      req.subscription = subscriptionData[0];
    }

    // Validate subscription status
    const subscription = req.subscription;
    
    // Check if subscription is expired
    if (subscription.current_period_end && new Date(subscription.current_period_end) < new Date()) {
      if (subscription.tier !== 'free') {
        // Downgrade to free tier
        await downgradeToFree(req.user.id);
        
        // Update request subscription data
        const { data: freeData } = await supabase.rpc('get_user_subscription', {
          user_uuid: req.user.id,
        });
        req.subscription = freeData[0];
      }
    }

    next();
  } catch (error) {
    logger.error('Subscription validation error:', error);
    next(error);
  }
};

/**
 * Middleware to check if user can perform specific action
 */
export const requireSubscriptionFeature = (feature: keyof SubscriptionFeatures) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.subscription) {
        throw ForbiddenError('Subscription data not available');
      }

      const subscription = req.subscription;
      const features: SubscriptionFeatures = subscription.plan_features || {};

      switch (feature) {
        case 'export_apk':
          if (subscription.tier === 'free' || !features.export_apk) {
            throw ForbiddenError('APK export requires a paid subscription');
          }
          break;

        case 'collaboration':
          if (!features.collaboration) {
            throw ForbiddenError('Team collaboration requires Power tier');
          }
          break;

        case 'white_label':
          if (!features.white_label) {
            throw ForbiddenError('White-label branding requires Power tier');
          }
          break;

        case 'priority_support':
          if (!features.priority_support) {
            throw ForbiddenError('Priority support requires Power tier');
          }
          break;

        default:
          break;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Middleware to check usage limits
 */
export const checkUsageLimit = (limitType: 'ai_generations' | 'screens' | 'apps') => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.subscription) {
        throw ForbiddenError('Subscription data not available');
      }

      const subscription = req.subscription;
      const limits: SubscriptionLimits = subscription.plan_limits || {};

      switch (limitType) {
        case 'ai_generations':
          // Check AI generation limits
          const { data: usageData } = await supabase.rpc('get_available_generations', {
            user_uuid: req.user.id,
          });
          
          const availableGenerations = usageData?.[0]?.total_available || 0;
          if (availableGenerations <= 0) {
            throw ForbiddenError('AI generation limit exceeded. Upgrade your plan or purchase additional generations.');
          }
          break;

        case 'screens':
          if (!limits.unlimitedScreens) {
            // Count user's screens
            const { count: screenCount } = await supabase
              .from('app_screens')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', req.user.id);

            if (screenCount >= limits.screens) {
              throw ForbiddenError(`Screen limit exceeded. Current plan allows ${limits.screens} screens.`);
            }
          }
          break;

        case 'apps':
          if (!limits.unlimitedApps) {
            // Count user's apps
            const { count: appCount } = await supabase
              .from('apps')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', req.user.id);

            if (appCount >= limits.apps) {
              throw ForbiddenError(`App limit exceeded. Current plan allows ${limits.apps} apps.`);
            }
          }
          break;

        default:
          break;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Middleware to consume usage (for tracking)
 */
export const consumeUsage = (usageType: 'ai_generation' | 'screen_created' | 'app_created') => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user?.id) {
        throw AuthenticationError('User not authenticated');
      }

      switch (usageType) {
        case 'ai_generation':
          // Consume one AI generation
          const { data: consumeResult, error: consumeError } = await supabase.rpc('consume_generation', {
            user_uuid: req.user.id,
          });

          if (consumeError || !consumeResult) {
            logger.error('Failed to consume AI generation:', consumeError);
            throw ForbiddenError('Unable to consume AI generation. Check your remaining quota.');
          }
          break;

        default:
          // For other usage types, just log the usage
          logger.info(`Usage consumed: ${usageType} for user ${req.user.id}`);
          break;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Rate limiting for subscription endpoints
 */
export const subscriptionRateLimit = (maxRequests: number = 10, windowMs: number = 60000) => {
  const requestCounts = new Map<string, { count: number; resetTime: number }>();

  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const userId = req.user?.id;
    if (!userId) {
      throw AuthenticationError('User not authenticated');
    }

    const now = Date.now();
    const userKey = `subscription:${userId}`;
    const current = requestCounts.get(userKey);

    if (!current || now > current.resetTime) {
      // Reset or create new counter
      requestCounts.set(userKey, {
        count: 1,
        resetTime: now + windowMs,
      });
      next();
      return;
    }

    if (current.count >= maxRequests) {
      res.status(429).json({
        success: false,
        message: 'Rate limit exceeded for subscription operations',
        retryAfter: Math.ceil((current.resetTime - now) / 1000),
      });
      return;
    }

    current.count++;
    next();
  };
};

/**
 * Security validation for payment data
 */
export const validatePaymentData = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const { planId, billingCycle } = req.body;

    // Validate plan ID
    const validPlans = ['creator', 'power'];
    if (!planId || !validPlans.includes(planId)) {
      throw ValidationError('Invalid plan ID');
    }

    // Validate billing cycle
    const validCycles = ['monthly', 'yearly'];
    if (!billingCycle || !validCycles.includes(billingCycle)) {
      throw ValidationError('Invalid billing cycle');
    }

    // Sanitize input
    req.body.planId = planId.toLowerCase().trim();
    req.body.billingCycle = billingCycle.toLowerCase().trim();

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Helper function to create default free subscription
 */
async function createFreeSubscription(userId: string): Promise<void> {
  try {
    await supabase.rpc('upsert_user_subscription', {
      p_user_id: userId,
      p_tier: 'free',
      p_status: 'active',
      p_current_period_start: new Date().toISOString(),
      p_current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year
      p_claude_usage_count: 0,
      p_claude_usage_limit: 25,
      p_screens_limit: 5,
      p_apps_limit: 3,
      p_billing_cycle: 'monthly',
    });

    logger.info(`Created default free subscription for user: ${userId}`);
  } catch (error) {
    logger.error('Error creating free subscription:', error);
    throw error;
  }
}

/**
 * Helper function to downgrade user to free tier
 */
async function downgradeToFree(userId: string): Promise<void> {
  try {
    await supabase.rpc('upsert_user_subscription', {
      p_user_id: userId,
      p_tier: 'free',
      p_status: 'active',
      p_current_period_start: new Date().toISOString(),
      p_current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      p_claude_usage_count: 0,
      p_claude_usage_limit: 25,
      p_screens_limit: 5,
      p_apps_limit: 3,
      p_stripe_subscription_id: null,
      p_billing_cycle: 'monthly',
    });

    // Update user profile
    await supabase
      .from('user_profiles')
      .update({ subscription_tier: 'free' })
      .eq('id', userId);

    logger.info(`Downgraded user to free tier: ${userId}`);
  } catch (error) {
    logger.error('Error downgrading to free tier:', error);
    throw error;
  }
}