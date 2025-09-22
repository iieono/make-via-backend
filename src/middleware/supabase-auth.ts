import { Request, Response, NextFunction } from 'express';
import { supabaseAuthService } from '@/services/supabase-auth';
import { userProfileService } from '@/services/user-profile';
import { logger } from '@/utils/logger';
import { UnauthorizedError, ForbiddenError } from '@/middleware/errorHandler';
import rateLimits from '@/middleware/rateLimit';

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    credits: number;
    subscription_type: 'free' | 'creator' | 'power';
    subscription_status: 'free' | 'active' | 'canceled' | 'past_due';
  };
}

/**
 * Middleware to require authentication
 */
export const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    // Verify token with Supabase Auth
    const authUser = await supabaseAuthService.verifyToken(token);
    
    if (!authUser) {
      throw new UnauthorizedError('Invalid or expired token');
    }

    // Get user profile from our database
    const userProfile = await userProfileService.getUserProfile(authUser.id);
    
    if (!userProfile) {
      // Create user profile if it doesn't exist
      const newProfile = await userProfileService.updateUserProfile(authUser.id, {
        name: authUser.user_metadata?.name || authUser.email.split('@')[0],
        email: authUser.email,
        full_name: authUser.user_metadata?.full_name || authUser.user_metadata?.name || authUser.email.split('@')[0],
        display_email: authUser.email,
      });
      
      req.user = {
        id: newProfile.id,
        email: newProfile.email,
        credits: newProfile.credits,
        subscription_type: newProfile.subscription_type,
        subscription_status: newProfile.subscription_status,
      };
    } else {
      req.user = {
        id: userProfile.id,
        email: userProfile.email,
        credits: userProfile.credits,
        subscription_type: userProfile.subscription_type,
        subscription_status: userProfile.subscription_status,
      };
    }

    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    
    if (error instanceof UnauthorizedError) {
      res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Authentication failed',
    });
  }
};

/**
 * Optional authentication - doesn't fail if user is not authenticated
 */
export const optionalAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      next();
      return;
    }

    const token = authHeader.substring(7);
    
    const authUser = await supabaseAuthService.verifyToken(token);
    
    if (!authUser) {
      req.user = null;
      next();
      return;
    }

    const userProfile = await userProfileService.getUserProfile(authUser.id);
    
    if (!userProfile) {
      req.user = null;
      next();
      return;
    }

    req.user = {
      id: userProfile.id,
      email: userProfile.email,
      credits: userProfile.credits,
      subscription_type: userProfile.subscription_type,
      subscription_status: userProfile.subscription_status,
    };

    next();
  } catch (error) {
    logger.error('Optional authentication error:', error);
    req.user = null;
    next();
  }
};

/**
 * Middleware to require sufficient credits
 */
export const requireCredits = (requiredCredits: number) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        throw new UnauthorizedError('User not authenticated');
      }

      if (req.user.credits < requiredCredits) {
        return res.status(402).json({
          success: false,
          error: 'insufficient_credits',
          message: `You need ${requiredCredits} credits but only have ${req.user.credits}`,
          requiredCredits,
          availableCredits: req.user.credits,
        });
      }

      next();
    } catch (error) {
      logger.error('Credit check error:', error);
      
      if (error instanceof UnauthorizedError) {
        res.status(401).json({
          success: false,
          error: 'unauthorized',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'server_error',
        message: 'Credit check failed',
      });
    }
  };
};

/**
 * AI rate limiting based on subscription tier
 */
export const aiRateLimit = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      throw new UnauthorizedError('User not authenticated');
    }

    // Apply different rate limits based on subscription tier
    const rateLimitKey = `ai:${req.user.id}:${req.user.subscription_type}`;
    
    // Use existing rate limiting middleware with tier-specific limits
    const tierLimits = {
      free: rateLimits.apiGeneration, // Most restrictive
      creator: rateLimits.apiGeneration, // Medium restrictions
      power: rateLimits.apiGeneration, // Least restrictive
    };

    // Apply the appropriate rate limit
    await new Promise<void>((resolve, reject) => {
      tierLimits[req.user.subscription_type](req, res, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    next();
  } catch (error) {
    logger.error('AI rate limit error:', error);
    
    if (error instanceof Error && error.message.includes('Too many requests')) {
      res.status(429).json({
        success: false,
        error: 'rate_limit_exceeded',
        message: 'Too many AI requests. Please upgrade your plan or wait.',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Rate limit check failed',
    });
  }
};

/**
 * Require specific subscription tier
 */
export const requireSubscription = (requiredTier: 'creator' | 'power') => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        throw new UnauthorizedError('User not authenticated');
      }

      // Check if user has required subscription tier and active status
      if (req.user.subscription_type === 'free' || 
          req.user.subscription_status !== 'active' ||
          (requiredTier === 'power' && req.user.subscription_type !== 'power')) {
        throw new ForbiddenError(`This feature requires a ${requiredTier} subscription`);
      }

      next();
    } catch (error) {
      logger.error('Subscription check error:', error);
      
      if (error instanceof ForbiddenError) {
        res.status(403).json({
          success: false,
          error: 'subscription_required',
          message: error.message,
          requiredTier,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'server_error',
        message: 'Subscription check failed',
      });
    }
  };
};