import { Router } from 'express';
import { claudeService } from '@/services/claude';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth, checkUsageLimit } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { AuthenticatedRequest, GenerateUIRequest } from '@/types';
import {
  ValidationError,
  NotFoundError,
  RateLimitError,
} from '@/middleware/errorHandler';

const router = Router();

// Apply AI generation rate limiting to all routes
router.use(rateLimits.aiGeneration);

// Generate UI from prompt
router.post('/generate', 
  requireAuth,
  checkUsageLimit('claude_usage'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { prompt, screen_type, app_id, screen_id, context } = req.body;

    // Validate required fields
    if (!prompt || typeof prompt !== 'string') {
      throw ValidationError('Prompt is required and must be a string');
    }

    if (prompt.length < 10) {
      throw ValidationError('Prompt must be at least 10 characters long');
    }

    if (prompt.length > 2000) {
      throw ValidationError('Prompt must be less than 2000 characters long');
    }

    // Validate screen_type if provided
    const validScreenTypes = ['page', 'modal', 'bottom_sheet', 'dialog'];
    if (screen_type && !validScreenTypes.includes(screen_type)) {
      throw ValidationError(`screen_type must be one of: ${validScreenTypes.join(', ')}`);
    }

    // Validate app_id if provided
    if (app_id) {
      const app = await supabase.getAppById(app_id, user.id);
      if (!app) {
        throw NotFoundError('App not found or access denied');
      }
    }

    // Validate screen_id if provided
    if (screen_id) {
      const screen = await supabase.getScreenById(screen_id);
      if (!screen) {
        throw NotFoundError('Screen not found');
      }
      
      // Verify user owns the app that contains this screen
      const app = await supabase.getAppById(screen.app_id, user.id);
      if (!app) {
        throw NotFoundError('Screen not found or access denied');
      }
    }

    // Build the generation request
    const generateRequest: GenerateUIRequest = {
      prompt: prompt.trim(),
      screen_type,
      app_id,
      screen_id,
      context: context ? {
        app_name: context.app_name,
        app_type: context.app_type,
        existing_screens: Array.isArray(context.existing_screens) ? context.existing_screens : undefined,
        brand_colors: Array.isArray(context.brand_colors) ? context.brand_colors : undefined,
        design_style: context.design_style,
      } : undefined,
    };

    logger.info(`Starting AI generation for user ${user.id}`, {
      promptLength: prompt.length,
      screenType: screen_type,
      appId: app_id,
      screenId: screen_id,
    });

    try {
      // Generate UI using Claude service
      const result = await claudeService.generateUI(user.id, generateRequest);

      logger.info(`AI generation completed for user ${user.id}`, {
        generationId: result.generation_id,
        cost: result.cost_usd,
        remainingGenerations: result.remaining_generations,
      });

      res.json({
        success: true,
        data: result,
        message: 'UI generated successfully',
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      logger.error('AI generation failed:', {
        userId: user.id,
        error: error.message,
        prompt: prompt.substring(0, 100) + '...',
      });

      // Check if it's a usage limit error
      if (error.message?.includes('limit exceeded')) {
        throw RateLimitError('AI generation limit exceeded for current billing period');
      }

      throw error;
    }
  })
);

// Check if user can generate (without actually generating)
router.get('/can-generate', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  const result = await claudeService.canUserGenerate(user.id);

  res.json({
    success: true,
    data: result,
    timestamp: new Date().toISOString(),
  });
}));

// Get user's AI generation history
router.get('/history', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { limit = 50, page = 1 } = req.query;

  // Validate pagination parameters
  const parsedLimit = Math.min(Math.max(parseInt(limit as string) || 50, 1), 100);
  const parsedPage = Math.max(parseInt(page as string) || 1, 1);
  const offset = (parsedPage - 1) * parsedLimit;

  try {
    const history = await claudeService.getUserGenerationHistory(user.id, parsedLimit);

    res.json({
      success: true,
      data: history,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total: history.length, // This would need to be actual total from database
        pages: Math.ceil(history.length / parsedLimit),
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('Failed to fetch generation history:', error);
    throw error;
  }
}));

// Regenerate UI for existing screen
router.post('/regenerate/:screenId', 
  requireAuth,
  checkUsageLimit('claude_usage'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { screenId } = req.params;
    const { prompt, context } = req.body;

    // Get the screen and verify ownership
    const screen = await supabase.getScreenById(screenId);
    if (!screen) {
      throw NotFoundError('Screen not found');
    }

    const app = await supabase.getAppById(screen.app_id, user.id);
    if (!app) {
      throw NotFoundError('Screen not found or access denied');
    }

    // Use provided prompt or fallback to original AI prompt
    const finalPrompt = prompt || screen.ai_prompt;
    if (!finalPrompt) {
      throw ValidationError('No prompt provided and screen has no original AI prompt');
    }

    // Build the generation request
    const generateRequest: GenerateUIRequest = {
      prompt: finalPrompt,
      screen_type: screen.screen_type,
      app_id: screen.app_id,
      screen_id: screenId,
      context: context || {
        app_name: app.name,
        app_type: app.metadata?.app_type,
        existing_screens: [], // Could fetch other screens in the app
        brand_colors: app.primary_color ? [app.primary_color] : undefined,
      },
    };

    logger.info(`Regenerating UI for screen ${screenId}, user ${user.id}`);

    try {
      const result = await claudeService.generateUI(user.id, generateRequest);

      // Update screen with new generated content
      await supabase.updateScreen(screenId, {
        ui_structure: result.ui_structure,
        styling: result.styling,
        logic: result.logic,
        ai_prompt: finalPrompt,
        ai_model_used: result.metadata.model_used,
        generation_timestamp: new Date().toISOString(),
        version: screen.version + 1,
      });

      logger.info(`Screen ${screenId} regenerated successfully for user ${user.id}`);

      res.json({
        success: true,
        data: {
          ...result,
          screen_id: screenId,
          version: screen.version + 1,
        },
        message: 'Screen regenerated successfully',
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      logger.error('Screen regeneration failed:', {
        screenId,
        userId: user.id,
        error: error.message,
      });

      if (error.message?.includes('limit exceeded')) {
        throw RateLimitError('AI generation limit exceeded for current billing period');
      }

      throw error;
    }
  })
);

// Get AI generation suggestions/templates
router.get('/suggestions', asyncHandler(async (req, res) => {
  const { app_type, screen_type } = req.query;

  // Pre-defined prompt suggestions based on app type and screen type
  const suggestions = {
    social: {
      page: [
        'Create a user profile page with avatar, bio, and stats',
        'Design a social feed with posts, likes, and comments',
        'Build a chat interface with message bubbles and input',
        'Create a friends list with search and filter options',
      ],
      modal: [
        'Design a post creation modal with image upload',
        'Create a user profile edit modal',
        'Build a comment composer modal',
        'Design a photo viewer modal with zoom',
      ],
    },
    ecommerce: {
      page: [
        'Create a product catalog with grid layout and filters',
        'Design a product detail page with images and reviews',
        'Build a shopping cart with item management',
        'Create a checkout page with payment forms',
      ],
      modal: [
        'Design a product quick view modal',
        'Create an add to cart confirmation modal',
        'Build a shipping address selection modal',
        'Design a payment method selection modal',
      ],
    },
    productivity: {
      page: [
        'Create a task list with checkboxes and priorities',
        'Design a calendar view with events and navigation',
        'Build a note-taking interface with formatting',
        'Create a project dashboard with progress indicators',
      ],
      modal: [
        'Design a task creation modal with due dates',
        'Create an event scheduling modal',
        'Build a file upload modal with progress',
        'Design a settings configuration modal',
      ],
    },
    general: {
      page: [
        'Create a welcome screen with onboarding steps',
        'Design a settings page with toggle options',
        'Build a notification center with action buttons',
        'Create a help and FAQ page with search',
      ],
      modal: [
        'Design a confirmation dialog with actions',
        'Create a loading modal with progress indicator',
        'Build an error alert modal with retry option',
        'Design a success confirmation modal',
      ],
    },
  };

  const appTypeSuggestions = suggestions[app_type as keyof typeof suggestions] || suggestions.general;
  const screenTypeSuggestions = appTypeSuggestions[screen_type as keyof typeof appTypeSuggestions] || appTypeSuggestions.page;

  res.json({
    success: true,
    data: {
      suggestions: screenTypeSuggestions,
      app_type: app_type || 'general',
      screen_type: screen_type || 'page',
    },
    timestamp: new Date().toISOString(),
  });
}));

export default router;