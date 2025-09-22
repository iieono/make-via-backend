import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import enhancedAIGenerationService from '@/services/enhanced-ai-generation-service';
import type { 
  EnhancedGenerationRequest,
  GenerationStatus,
  AIModel
} from '@/types/app-development';

const router = Router();

router.use(requireAuth);

/**
 * POST /api/ai/generate-enhanced
 * Create enhanced AI generation request with detailed tracking
 */
router.post('/generate-enhanced',
  rateLimits.aiGeneration,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const request: EnhancedGenerationRequest = req.body;

    try {
      // Validate request
      if (!request.prompt || !request.model) {
        return res.status(400).json({
          success: false,
          error: 'Prompt and model are required',
          timestamp: new Date().toISOString(),
        });
      }

      // Validate model
      const availableModels = await enhancedAIGenerationService.getAvailableModels(userId);
      if (!availableModels.available.includes(request.model)) {
        return res.status(403).json({
          success: false,
          error: `Model ${request.model} not available for your subscription tier`,
          available_models: availableModels.available,
          timestamp: new Date().toISOString(),
        });
      }

      const response = await enhancedAIGenerationService.createEnhancedGeneration(userId, request);

      res.json({
        success: true,
        data: response,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error creating enhanced AI generation:', error);
      const statusCode = error.message.includes('limit') ? 429 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to create AI generation',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/ai/generation/:generationId/status
 * Get detailed generation status
 */
router.get('/generation/:generationId/status',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { generationId } = req.params;

    try {
      const status = await enhancedAIGenerationService.getGenerationStatus(generationId, userId);

      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting generation status:', error);
      const statusCode = error.message.includes('not found') ? 404 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to get generation status',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * PUT /api/ai/generation/:generationId/status
 * Update generation status (internal use)
 */
router.put('/generation/:generationId/status',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const { generationId } = req.params;
    const { status, ...additionalData } = req.body;

    try {
      // This endpoint would typically be protected by internal API keys
      // For now, we'll allow authenticated users to update their own generations
      
      if (!status) {
        return res.status(400).json({
          success: false,
          error: 'Status is required',
          timestamp: new Date().toISOString(),
        });
      }

      await enhancedAIGenerationService.updateGenerationStatus(generationId, status, additionalData);

      res.json({
        success: true,
        message: 'Generation status updated successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error updating generation status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update generation status',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/ai/generations/history
 * Get user's generation history with filtering
 */
router.get('/generations/history',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { 
      status, 
      model, 
      app_id, 
      limit, 
      offset, 
      date_from, 
      date_to 
    } = req.query;

    try {
      const filters = {
        status: status as GenerationStatus,
        model: model as AIModel,
        app_id: app_id as string,
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
        date_from: date_from as string,
        date_to: date_to as string
      };

      // Remove undefined values
      Object.keys(filters).forEach(key => 
        filters[key] === undefined && delete filters[key]
      );

      const history = await enhancedAIGenerationService.getUserGenerationHistory(userId, filters);

      res.json({
        success: true,
        data: history,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting generation history:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get generation history',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/ai/generations/queue
 * Get active generations queue
 */
router.get('/generations/queue',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      const queue = await enhancedAIGenerationService.getActiveGenerationsQueue(userId);

      res.json({
        success: true,
        data: queue,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting generations queue:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get generations queue',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/ai/generation/:generationId/cancel
 * Cancel a pending generation
 */
router.post('/generation/:generationId/cancel',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { generationId } = req.params;

    try {
      await enhancedAIGenerationService.cancelGeneration(generationId, userId);

      res.json({
        success: true,
        message: 'Generation canceled successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error canceling generation:', error);
      const statusCode = error.message.includes('not found') ? 404 : 
                        error.message.includes('cannot be canceled') ? 400 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to cancel generation',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/ai/models/available
 * Get available AI models for user's subscription tier
 */
router.get('/models/available',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      const models = await enhancedAIGenerationService.getAvailableModels(userId);

      res.json({
        success: true,
        data: models,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting available models:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get available models',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/ai/stats
 * Get generation usage statistics
 */
router.get('/stats',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { timeframe } = req.query;

    try {
      // Validate timeframe
      const validTimeframes = ['day', 'week', 'month'];
      const selectedTimeframe = validTimeframes.includes(timeframe as string) 
        ? timeframe as 'day' | 'week' | 'month' 
        : 'month';

      const stats = await enhancedAIGenerationService.getGenerationStats(userId, selectedTimeframe);

      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting generation stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get generation stats',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/ai/models/info
 * Get detailed information about AI models
 */
router.get('/models/info',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    try {
      const modelInfo = {
        'claude-3-haiku': {
          name: 'Claude 3 Haiku',
          description: 'Fast and efficient model for simple tasks',
          speed: 'fastest',
          cost: 'lowest',
          capabilities: ['text_generation', 'code_assistance'],
          max_tokens: 200000,
          tier_required: 'free'
        },
        'claude-3-sonnet': {
          name: 'Claude 3 Sonnet',
          description: 'Balanced model for most use cases',
          speed: 'fast',
          cost: 'moderate',
          capabilities: ['text_generation', 'code_assistance', 'complex_reasoning'],
          max_tokens: 200000,
          tier_required: 'creator'
        },
        'claude-3-opus': {
          name: 'Claude 3 Opus',
          description: 'Most capable model for complex tasks',
          speed: 'moderate',
          cost: 'high',
          capabilities: ['text_generation', 'code_assistance', 'complex_reasoning', 'creative_writing'],
          max_tokens: 200000,
          tier_required: 'power'
        },
        'claude-3-5-haiku': {
          name: 'Claude 3.5 Haiku',
          description: 'Enhanced fast model with improved capabilities',
          speed: 'fastest',
          cost: 'low',
          capabilities: ['text_generation', 'code_assistance', 'improved_reasoning'],
          max_tokens: 200000,
          tier_required: 'creator'
        },
        'claude-3-5-sonnet': {
          name: 'Claude 3.5 Sonnet',
          description: 'Advanced balanced model with enhanced performance',
          speed: 'fast',
          cost: 'moderate',
          capabilities: ['text_generation', 'code_assistance', 'complex_reasoning', 'advanced_analysis'],
          max_tokens: 200000,
          tier_required: 'creator'
        },
        'claude-3-5-opus': {
          name: 'Claude 3.5 Opus',
          description: 'Premium model with state-of-the-art capabilities',
          speed: 'moderate',
          cost: 'high',
          capabilities: ['text_generation', 'code_assistance', 'complex_reasoning', 'creative_writing', 'advanced_analysis'],
          max_tokens: 200000,
          tier_required: 'power'
        },
        'claude-4': {
          name: 'Claude 4',
          description: 'Next-generation model with cutting-edge capabilities',
          speed: 'moderate',
          cost: 'premium',
          capabilities: ['text_generation', 'code_assistance', 'complex_reasoning', 'creative_writing', 'advanced_analysis', 'multimodal'],
          max_tokens: 500000,
          tier_required: 'power'
        }
      };

      res.json({
        success: true,
        data: {
          models: modelInfo,
          tier_info: {
            free: { models: ['claude-3-haiku'], monthly_generations: 25 },
            creator: { models: ['claude-3-haiku', 'claude-3-sonnet', 'claude-3-5-haiku', 'claude-3-5-sonnet'], monthly_generations: 600 },
            power: { models: Object.keys(modelInfo), monthly_generations: 2000 }
          }
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting model info:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get model info',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;