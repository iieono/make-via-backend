import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { Redis } from 'ioredis';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import type { AuthenticatedRequest } from '@/types';

// Create Redis client for rate limiting (if Redis is configured)
let redisClient: Redis | undefined;

if (config.redis?.url) {
  try {
    redisClient = new Redis(config.redis.url);
    logger.info('Redis client initialized for rate limiting');
  } catch (error) {
    logger.warn('Failed to initialize Redis client, using memory store:', error);
  }
}

// Generic rate limiter
export const createRateLimit = (options: {
  windowMs: number;
  max: number | ((req: AuthenticatedRequest) => number);
  message?: string;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
}) => {
  const store = redisClient ? new RedisStore({
    sendCommand: (...args: string[]) => redisClient!.call(...args),
  }) : undefined;

  return rateLimit({
    windowMs: options.windowMs,
    max: typeof options.max === 'function' ? options.max : options.max,
    message: {
      success: false,
      error: options.message || 'Too many requests, please try again later',
      timestamp: new Date().toISOString(),
    },
    standardHeaders: options.standardHeaders ?? true,
    legacyHeaders: options.legacyHeaders ?? false,
    store,
    keyGenerator: (req: AuthenticatedRequest) => {
      // Use user ID if authenticated, otherwise use IP
      return req.user?.id || req.ip;
    },
    skip: (req) => {
      // Skip rate limiting for health checks
      return req.path === '/health';
    },
    handler: (req, res) => {
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        userId: (req as AuthenticatedRequest).user?.id,
        path: req.path,
        method: req.method,
      });
      
      res.status(429).json({
        success: false,
        error: options.message || 'Too many requests, please try again later',
        timestamp: new Date().toISOString(),
      });
    },
  });
};

// General API rate limiter
export const generalRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per 15 minutes
  message: 'Too many API requests, please try again later',
});

// Strict rate limiter for sensitive endpoints
export const strictRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per 15 minutes
  message: 'Too many requests to this endpoint, please try again later',
});

// Auth endpoints rate limiter
export const authRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 auth attempts per 15 minutes
  message: 'Too many authentication attempts, please try again later',
});

// AI generation rate limiter with tier-based limits
export const aiGenerationRateLimit = createRateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: AuthenticatedRequest) => {
    const subscription = req.subscription;
    if (!subscription) return 5; // Unauthenticated users get very limited access
    
    switch (subscription.tier) {
      case 'power':
        return 1000; // 1000 generations per hour
      case 'pro':
        return 100; // 100 generations per hour
      case 'free':
      default:
        return 10; // 10 generations per hour
    }
  },
  message: 'AI generation rate limit exceeded for your subscription tier',
});

// Stripe webhook rate limiter
export const webhookRateLimit = createRateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 webhooks per minute
  message: 'Webhook rate limit exceeded',
});

// File upload rate limiter
export const uploadRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req: AuthenticatedRequest) => {
    const subscription = req.subscription;
    if (!subscription) return 5;
    
    switch (subscription.tier) {
      case 'power':
        return 500; // 500 uploads per 15 minutes
      case 'pro':
        return 100; // 100 uploads per 15 minutes
      case 'free':
      default:
        return 20; // 20 uploads per 15 minutes
    }
  },
  message: 'File upload rate limit exceeded for your subscription tier',
});

// App creation rate limiter
export const appCreationRateLimit = createRateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: (req: AuthenticatedRequest) => {
    const subscription = req.subscription;
    if (!subscription) return 1;
    
    switch (subscription.tier) {
      case 'power':
        return 50; // 50 apps per day
      case 'pro':
        return 10; // 10 apps per day
      case 'free':
      default:
        return 3; // 3 apps per day
    }
  },
  message: 'App creation rate limit exceeded for your subscription tier',
});

// Screen creation rate limiter
export const screenCreationRateLimit = createRateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: AuthenticatedRequest) => {
    const subscription = req.subscription;
    if (!subscription) return 5;
    
    switch (subscription.tier) {
      case 'power':
        return 200; // 200 screens per hour
      case 'pro':
        return 50; // 50 screens per hour
      case 'free':
      default:
        return 10; // 10 screens per hour
    }
  },
  message: 'Screen creation rate limit exceeded for your subscription tier',
});

// Export rate limiter
export const exportRateLimit = createRateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req: AuthenticatedRequest) => {
    const subscription = req.subscription;
    if (!subscription) return 1;
    
    switch (subscription.tier) {
      case 'power':
        return 20; // 20 exports per hour
      case 'pro':
        return 5; // 5 exports per hour
      case 'free':
      default:
        return 2; // 2 exports per hour
    }
  },
  message: 'App export rate limit exceeded for your subscription tier',
});

// Preview rate limiter
export const previewRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req: AuthenticatedRequest) => {
    const subscription = req.subscription;
    if (!subscription) return 10;
    
    switch (subscription.tier) {
      case 'power':
        return 1000; // 1000 previews per 15 minutes
      case 'pro':
        return 200; // 200 previews per 15 minutes
      case 'free':
      default:
        return 50; // 50 previews per 15 minutes
    }
  },
  message: 'App preview rate limit exceeded for your subscription tier',
});

export default {
  general: generalRateLimit,
  strict: strictRateLimit,
  auth: authRateLimit,
  aiGeneration: aiGenerationRateLimit,
  webhook: webhookRateLimit,
  upload: uploadRateLimit,
  appCreation: appCreationRateLimit,
  screenCreation: screenCreationRateLimit,
  export: exportRateLimit,
  preview: previewRateLimit,
};