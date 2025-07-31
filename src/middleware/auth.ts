import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import type { AuthenticatedRequest, User, UserSubscription } from '@/types';

const supabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey
);

export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Authorization header required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const token = authHeader.substring(7);

    // Verify JWT token with Supabase
    const { data: { user }, error } = await supabaseClient.auth.getUser(token);

    if (error || !user) {
      logger.warn('Invalid or expired token', { error: error?.message });
      res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get user profile and subscription
    const [userProfile, userSubscription] = await Promise.all([
      supabase.getUserById(user.id),
      supabase.getUserSubscription(user.id),
    ]);

    if (!userProfile) {
      logger.warn('User profile not found', { userId: user.id });
      res.status(404).json({
        success: false,
        error: 'User profile not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Attach user and subscription to request
    req.user = userProfile;
    req.subscription = userSubscription || undefined;

    logger.info(`Authenticated user: ${user.id}`);
    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed',
      timestamp: new Date().toISOString(),
    });
  }
};

export const requireSubscription = (tiers: ('free' | 'pro' | 'power')[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.subscription) {
      res.status(403).json({
        success: false,
        error: 'Subscription required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!tiers.includes(req.subscription.tier)) {
      res.status(403).json({
        success: false,
        error: `This feature requires ${tiers.join(' or ')} subscription`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
};

export const checkUsageLimit = (
  limitType: 'claude_usage' | 'apps' | 'screens'
) => {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.subscription) {
        res.status(403).json({
          success: false,
          error: 'Subscription required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const subscription = req.subscription;
      let hasExceededLimit = false;

      switch (limitType) {
        case 'claude_usage':
          hasExceededLimit = subscription.claude_usage_count >= subscription.claude_usage_limit;
          break;
        case 'apps':
          // Would need to implement app count tracking
          hasExceededLimit = false;
          break;
        case 'screens':
          // Would need to implement screen count tracking
          hasExceededLimit = false;
          break;
      }

      if (hasExceededLimit) {
        res.status(429).json({
          success: false,
          error: `${limitType.replace('_', ' ')} limit exceeded for current billing period`,
          data: {
            current: limitType === 'claude_usage' ? subscription.claude_usage_count : 0,
            limit: limitType === 'claude_usage' ? subscription.claude_usage_limit : 0,
            tier: subscription.tier,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    } catch (error) {
      logger.error('Usage limit check error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to check usage limits',
        timestamp: new Date().toISOString(),
      });
    }
  };
};

export const requireOwnership = (resourceType: 'app' | 'screen') => {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const resourceId = req.params.id || req.params.appId || req.params.screenId;
      if (!resourceId) {
        res.status(400).json({
          success: false,
          error: 'Resource ID required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      let resource: any = null;

      switch (resourceType) {
        case 'app':
          resource = await supabase.getAppById(resourceId, req.user.id);
          break;
        case 'screen':
          const screen = await supabase.getScreenById(resourceId);
          if (screen) {
            const app = await supabase.getAppById(screen.app_id, req.user.id);
            resource = app ? screen : null;
          }
          break;
      }

      if (!resource) {
        res.status(404).json({
          success: false,
          error: `${resourceType} not found or access denied`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    } catch (error) {
      logger.error('Ownership check error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to verify ownership',
        timestamp: new Date().toISOString(),
      });
    }
  };
};

export const optionalAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No auth provided, continue without user
      next();
      return;
    }

    const token = authHeader.substring(7);

    // Verify JWT token with Supabase
    const { data: { user }, error } = await supabaseClient.auth.getUser(token);

    if (error || !user) {
      // Invalid token, but we don't fail - just continue without user
      logger.info('Optional auth failed, continuing without user');
      next();
      return;
    }

    // Get user profile and subscription
    const [userProfile, userSubscription] = await Promise.all([
      supabase.getUserById(user.id),
      supabase.getUserSubscription(user.id),
    ]);

    if (userProfile) {
      req.user = userProfile;
      req.subscription = userSubscription || undefined;
    }

    next();
  } catch (error) {
    logger.error('Optional auth middleware error:', error);
    // Don't fail on optional auth errors
    next();
  }
};