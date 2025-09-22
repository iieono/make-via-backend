import { Request, Response, NextFunction } from 'express';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import { ValidationError, ForbiddenError } from '@/utils/errors';

interface AuthenticatedRequest extends Request {
  user?: any;
  subscription?: any;
}

export interface AIModelRestrictions {
  allowedModels: string[];
  defaultModel: string;
  tier: string;
}

/**
 * Middleware to enforce AI model restrictions based on subscription tier
 */
export const enforceAIModelRestrictions = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user?.id) {
      throw new Error('User not authenticated');
    }

    // Get user's available AI models
    const { data: availableModels, error } = await supabase.rpc('get_available_ai_models', {
      user_uuid: req.user.id,
    });

    if (error) {
      logger.error('Error fetching available AI models:', error);
      throw new Error('Failed to get AI model restrictions');
    }

    // Get model from request (could be in body, query, or headers)
    const requestedModel = req.body?.model || req.query?.model || req.headers['x-ai-model'];

    // If no model specified, use the default for their tier
    if (!requestedModel) {
      req.body = req.body || {};
      req.body.model = getDefaultModelForTier(availableModels);
      next();
      return;
    }

    // Validate the requested model is allowed for this tier
    if (!availableModels.includes(requestedModel)) {
      const tier = await getUserTier(req.user.id);
      const allowedModelsStr = availableModels.join(', ');
      
      throw ForbiddenError(
        `Model '${requestedModel}' not available for ${tier} tier. Available models: ${allowedModelsStr}`
      );
    }

    // Ensure the model is set in the request body for downstream processing
    req.body = req.body || {};
    req.body.model = requestedModel;

    next();
  } catch (error) {
    logger.error('AI model enforcement error:', error);
    next(error);
  }
};

/**
 * Middleware to consume AI generation and track model usage
 */
export const consumeAIGeneration = (modelOverride?: string) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user?.id) {
        throw new Error('User not authenticated');
      }

      const model = modelOverride || req.body?.model || 'claude-3-haiku';

      // Consume one generation
      const { data: consumed, error } = await supabase.rpc('consume_generation', {
        user_uuid: req.user.id,
        model_name: model,
      });

      if (error) {
        logger.error('Error consuming generation:', error);
        throw new Error('Failed to consume AI generation');
      }

      if (!consumed) {
        throw ForbiddenError(
          'No AI generations available. Upgrade your plan or purchase additional generations to continue.'
        );
      }

      // Log successful consumption
      logger.info(`AI generation consumed for user ${req.user.id} using model ${model}`);

      next();
    } catch (error) {
      logger.error('Error in consumeAIGeneration middleware:', error);
      next(error);
    }
  };
};

/**
 * Middleware to check if user has available generations before processing
 */
export const checkAIGenerationAvailability = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user?.id) {
      throw new Error('User not authenticated');
    }

    // Get available generations
    const { data: usage, error } = await supabase.rpc('get_user_usage_stats', {
      user_uuid: req.user.id,
    });

    if (error) {
      logger.error('Error checking generation availability:', error);
      throw new Error('Failed to check generation availability');
    }

    const userUsage = usage[0];
    const totalAvailable = userUsage?.total_available_generations || 0;

    if (totalAvailable <= 0) {
      throw ForbiddenError(
        'No AI generations available. Your subscription limit has been reached and you have no extra generation packs. ' +
        'Upgrade your plan or purchase additional generations to continue.'
      );
    }

    // Add usage info to request for downstream use
    req.userUsage = userUsage;

    next();
  } catch (error) {
    logger.error('Error checking AI generation availability:', error);
    next(error);
  }
};

/**
 * Middleware to validate AI model request parameters
 */
export const validateAIModelRequest = (req: Request, res: Response, next: NextFunction): void => {
  try {
    // Validate model parameter if present
    if (req.body?.model) {
      const validModels = ['claude-3-haiku', 'claude-3-sonnet', 'claude-3-opus'];
      if (!validModels.includes(req.body.model)) {
        throw ValidationError(`Invalid AI model: ${req.body.model}. Valid models: ${validModels.join(', ')}`);
      }
    }

    // Validate other AI-related parameters
    if (req.body?.max_tokens && (req.body.max_tokens < 1 || req.body.max_tokens > 4096)) {
      throw ValidationError('max_tokens must be between 1 and 4096');
    }

    if (req.body?.temperature && (req.body.temperature < 0 || req.body.temperature > 1)) {
      throw ValidationError('temperature must be between 0 and 1');
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware to rate limit AI generation requests
 */
export const rateLimitAIGeneration = (maxRequests: number = 30, windowMs: number = 60000) => {
  const requestCounts = new Map<string, { count: number; resetTime: number }>();

  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User not authenticated');
    }

    const now = Date.now();
    const userKey = `ai_gen:${userId}`;
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
        message: 'Rate limit exceeded for AI generation requests',
        retryAfter: Math.ceil((current.resetTime - now) / 1000),
      });
      return;
    }

    current.count++;
    next();
  };
};

/**
 * Helper function to get default model for available models
 */
function getDefaultModelForTier(availableModels: string[]): string {
  if (availableModels.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet';
  } else if (availableModels.includes('claude-3-haiku')) {
    return 'claude-3-haiku';
  } else if (availableModels.includes('claude-3-opus')) {
    return 'claude-3-opus';
  }
  
  // Fallback
  return 'claude-3-haiku';
}

/**
 * Helper function to get user's subscription tier
 */
async function getUserTier(userId: string): Promise<string> {
  try {
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('tier')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    return subscription?.tier || 'free';
  } catch (error) {
    logger.error('Error getting user tier:', error);
    return 'free';
  }
}

/**
 * Function to get AI model pricing info (for cost tracking)
 */
export function getModelPricing(model: string): { inputCost: number; outputCost: number } {
  const pricing = {
    'claude-3-haiku': { inputCost: 0.00025, outputCost: 0.00125 }, // Per 1K tokens
    'claude-3-sonnet': { inputCost: 0.003, outputCost: 0.015 },
    'claude-3-opus': { inputCost: 0.015, outputCost: 0.075 },
  };

  return pricing[model] || pricing['claude-3-haiku'];
}

/**
 * Function to calculate and log AI usage costs
 */
export async function logAIUsageCost(
  userId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  sessionId?: string,
  appId?: string,
  screenId?: string
): Promise<void> {
  try {
    const pricing = getModelPricing(model);
    const inputCost = (inputTokens / 1000) * pricing.inputCost;
    const outputCost = (outputTokens / 1000) * pricing.outputCost;
    const totalCost = inputCost + outputCost;

    await supabase
      .from('ai_model_usage')
      .insert({
        user_id: userId,
        model_name: model,
        generation_type: 'ui_generation',
        tokens_used: inputTokens + outputTokens,
        cost_usd: totalCost,
        session_id: sessionId,
        app_id: appId,
        screen_id: screenId,
        used_at: new Date().toISOString(),
        metadata: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          input_cost: inputCost,
          output_cost: outputCost,
        },
      });

    logger.info(`AI usage logged: ${userId} used ${model} for $${totalCost.toFixed(6)}`);
  } catch (error) {
    logger.error('Error logging AI usage cost:', error);
  }
}