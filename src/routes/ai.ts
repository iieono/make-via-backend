import { Router } from 'express';
import { claudeService } from '@/services/claude';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth, checkUsageLimit } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import AIContextService from '@/services/ai-context-service';
import { conversationalAIAgent } from '@/services/conversational-ai-agent';
import { creditService } from '@/services/credit-service';
import type { AuthenticatedRequest, GenerateUIRequest } from '@/types';
import type { AIContextType } from '@/types/app-development';
import {
  ValidationError,
  NotFoundError,
  RateLimitError,
} from '@/middleware/errorHandler';

const router = Router();
const aiContextService = new AIContextService();

// Apply AI generation rate limiting to all routes
router.use(rateLimits.aiGeneration);

// =============================================================================
// NEW CONVERSATIONAL AI ROUTES
// =============================================================================

// Conversation-based AI chat endpoint
router.post('/chat', 
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { conversation_id, message, image_url, app_id } = req.body;

    // Validation
    if (!message || typeof message !== 'string') {
      throw new ValidationError('Message is required and must be a string');
    }

    if (message.length < 3) {
      throw new ValidationError('Message must be at least 3 characters long');
    }

    if (message.length > 10000) {
      throw new ValidationError('Message too long (max 10000 characters)');
    }

    if (!app_id) {
      throw new ValidationError('app_id is required');
    }

    try {
      const response = await conversationalAIAgent.handleMessage(
        conversation_id || null,
        message,
        image_url,
        app_id,
        user.id
      );

      res.json({
        success: true,
        data: response
      });
    } catch (error) {
      logger.error('AI chat error', { 
        userId: user.id, 
        appId: app_id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      
      if (error instanceof Error && error.message.includes('Insufficient credits')) {
        return res.status(402).json({
          success: false,
          error: 'insufficient_credits',
          message: error.message
        });
      }
      
      throw error;
    }
  })
);

// Get conversation history
router.get('/conversations/:conversationId/messages',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { conversationId } = req.params;

    // Verify user owns this conversation
    const { data: conversation } = await supabase
      .from('ai_conversations')
      .select('user_id')
      .eq('id', conversationId)
      .single();

    if (!conversation || conversation.user_id !== user.id) {
      throw new NotFoundError('Conversation not found');
    }

    const messages = await conversationalAIAgent.getConversationHistory(conversationId);

    res.json({
      success: true,
      data: messages
    });
  })
);

// Get user's credit balance and summary
router.get('/credits',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;

    const [creditSummary, recentTransactions] = await Promise.all([
      creditService.getUserCreditSummary(user.id),
      creditService.getCreditTransactions(user.id, 10, 0)
    ]);

    res.json({
      success: true,
      data: {
        summary: creditSummary,
        recentTransactions
      }
    });
  })
);

// Get credit usage analytics
router.get('/credits/analytics',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const days = parseInt(req.query.days as string) || 30;

    const analytics = await creditService.getCreditUsageAnalytics(user.id, days);

    res.json({
      success: true,
      data: analytics
    });
  })
);

// Get AI action status
router.get('/actions/:actionId/status',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { actionId } = req.params;

    // Get action with verification that user owns it
    const { data: action } = await supabase
      .from('ai_actions')
      .select(`
        *,
        ai_messages!inner (
          ai_conversations!inner (
            user_id
          )
        )
      `)
      .eq('id', actionId)
      .single();

    if (!action || action.ai_messages.ai_conversations.user_id !== user.id) {
      throw new NotFoundError('Action not found');
    }

    res.json({
      success: true,
      data: {
        id: action.id,
        status: action.status,
        actionType: action.action_type,
        creditsCost: action.credits_cost,
        errorMessage: action.error_message,
        createdAt: action.created_at,
        completedAt: action.completed_at
      }
    });
  })
);

// Initialize user credits (useful for new subscriptions)
router.post('/credits/initialize',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;

    await creditService.initializeUserCredits(user.id);

    const creditSummary = await creditService.getUserCreditSummary(user.id);

    res.json({
      success: true,
      message: 'Credits initialized successfully',
      data: creditSummary
    });
  })
);

// =============================================================================
// LEGACY ROUTES (for backward compatibility)
// =============================================================================

// Generate UI from prompt
router.post('/generate', 
  requireAuth,
  checkUsageLimit('claude_usage'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { prompt, screen_type, app_id, screen_id, context, preferred_model } = req.body;

    // Validate required fields
    if (!prompt || typeof prompt !== 'string') {
      throw ValidationError('Prompt is required and must be a string');
    }

    if (prompt.length < 10) {
      throw ValidationError('Prompt must be at least 10 characters long');
    }

    // Character limit will be checked in Claude service based on user's tier
    // Initial basic validation for extremely long prompts
    if (prompt.length > 10000) {
      throw ValidationError('Prompt is too long');
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

    // Validate preferred_model if provided
    if (preferred_model && typeof preferred_model !== 'string') {
      throw ValidationError('preferred_model must be a string');
    }

    // Build the generation request
    const generateRequest: GenerateUIRequest & { 
      preferred_model?: string; 
      theme?: any; 
      orientation?: string; 
    } = {
      prompt: prompt.trim(),
      screen_type,
      app_id,
      screen_id,
      preferred_model,
      theme: context?.theme,
      orientation: context?.orientation,
      context: context ? {
        app_name: context.app_name,
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

// Get available AI models for user's subscription tier
router.get('/models', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  const modelsInfo = await claudeService.getAvailableModelsForUser(user.id);

  res.json({
    success: true,
    data: modelsInfo,
    message: 'Available models retrieved successfully',
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
    const { prompt, context, preferred_model } = req.body;

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
    const generateRequest: GenerateUIRequest & { 
      preferred_model?: string; 
      theme?: any; 
      orientation?: string; 
    } = {
      prompt: finalPrompt,
      screen_type: screen.screen_type,
      app_id: screen.app_id,
      screen_id: screenId,
      preferred_model,
      theme: context?.theme,
      orientation: context?.orientation,
      context: context || {
        app_name: app.name,
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
  const { screen_type } = req.query;

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
      screen_type: screen_type || 'page',
    },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/ai/context-prompt
 * Generate contextual AI prompts based on current app state
 */
router.post('/context-prompt',
  requireAuth,
  rateLimits.api,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { 
      app_id, 
      context_type, 
      focused_entity_id, 
      user_prompt 
    } = req.body;

    // Validate required fields
    if (!app_id || typeof app_id !== 'string') {
      throw ValidationError('app_id is required');
    }

    if (!context_type || typeof context_type !== 'string') {
      throw ValidationError('context_type is required');
    }

    const validContextTypes: AIContextType[] = [
      'app_level',
      'page_focus', 
      'component_focus',
      'design_assistance',
      'code_generation',
      'generic'
    ];

    if (!validContextTypes.includes(context_type as AIContextType)) {
      throw ValidationError(`context_type must be one of: ${validContextTypes.join(', ')}`);
    }

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id')
      .eq('id', app_id)
      .or(`user_id.eq.${user.id},app_collaborators.user_id.eq.${user.id}`)
      .single();

    if (!app) {
      throw NotFoundError('App not found or access denied');
    }

    try {
      const contextualPrompt = await aiContextService.generateContextualPrompt(
        app_id,
        context_type as AIContextType,
        focused_entity_id,
        user_prompt
      );

      res.json({
        success: true,
        data: contextualPrompt,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Error generating contextual prompt:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate contextual prompt',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/ai/context-chat
 * Chat with AI using contextual information
 */
router.post('/context-chat',
  requireAuth,
  checkUsageLimit('claude_usage'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { 
      app_id, 
      context_type, 
      focused_entity_id, 
      user_prompt,
      preferred_model 
    } = req.body;

    // Validate required fields
    if (!app_id || typeof app_id !== 'string') {
      throw ValidationError('app_id is required');
    }

    if (!context_type || typeof context_type !== 'string') {
      throw ValidationError('context_type is required');
    }

    if (!user_prompt || typeof user_prompt !== 'string') {
      throw ValidationError('user_prompt is required');
    }

    if (user_prompt.length < 3) {
      throw ValidationError('user_prompt must be at least 3 characters long');
    }

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id')
      .eq('id', app_id)
      .or(`user_id.eq.${user.id},app_collaborators.user_id.eq.${user.id}`)
      .single();

    if (!app) {
      throw NotFoundError('App not found or access denied');
    }

    try {
      // Generate contextual prompt
      const contextualPrompt = await aiContextService.generateContextualPrompt(
        app_id,
        context_type as AIContextType,
        focused_entity_id,
        user_prompt
      );

      // Send to Claude with context
      const response = await claudeService.generateContextualResponse(
        user.id,
        contextualPrompt.system_prompt,
        user_prompt,
        preferred_model
      );

      // Log the interaction
      await aiContextService.logAIInteraction(
        app_id,
        user.id,
        context_type as AIContextType,
        user_prompt,
        response.content,
        focused_entity_id
      );

      res.json({
        success: true,
        data: {
          response: response.content,
          context_type,
          focused_entity_id,
          model_used: response.model,
          tokens_used: response.usage,
        },
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      logger.error('Context chat failed:', {
        appId: app_id,
        userId: user.id,
        contextType: context_type,
        error: error.message,
      });

      if (error.message?.includes('limit exceeded')) {
        throw RateLimitError('AI usage limit exceeded for current billing period');
      }

      res.status(500).json({
        success: false,
        error: 'Failed to generate AI response',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/ai/context-suggestions/:appId
 * Get smart suggestions based on app context
 */
router.get('/context-suggestions/:appId',
  requireAuth,
  rateLimits.api,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId } = req.params;
    const { page_id, component_id } = req.query;

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', appId)
      .or(`user_id.eq.${user.id},app_collaborators.user_id.eq.${user.id}`)
      .single();

    if (!app) {
      throw NotFoundError('App not found or access denied');
    }

    try {
      let suggestions: string[] = [];
      let contextType: AIContextType = 'app_level';

      if (component_id) {
        // Component-specific suggestions
        contextType = 'component_focus';
        suggestions = [
          'How can I improve this component\'s accessibility?',
          'What properties should I adjust for better UX?',
          'How can I make this component more interactive?',
          'What styling changes would improve the design?',
          'How can I add animation to this component?',
        ];
      } else if (page_id) {
        // Page-specific suggestions
        contextType = 'page_focus';
        suggestions = [
          'How can I improve the layout of this page?',
          'What components should I add to enhance functionality?',
          'How can I make this page more accessible?',
          'What navigation patterns work best here?',
          'How can I optimize this page for mobile?',
        ];
      } else {
        // App-level suggestions
        contextType = 'app_level';
        const appTypeSuggestions: Record<string, string[]> = {
          social: [
            'How can I improve user engagement in my social app?',
            'What features should I add to enhance social interaction?',
            'How can I implement a better content feed?',
            'What privacy settings should I include?',
          ],
          ecommerce: [
            'How can I improve the shopping experience?',
            'What payment methods should I integrate?',
            'How can I optimize the product discovery flow?',
            'What security features should I implement?',
          ],
          business: [
            'How can I create better data visualizations?',
            'What analytics should I track for my users?',
            'How can I improve the dashboard layout?',
            'What reporting features should I add?',
          ],
          default: [
            'How can I improve the overall user experience?',
            'What features would add the most value?',
            'How can I make my app more accessible?',
            'What performance optimizations should I consider?',
          ],
        };

        suggestions = appTypeSuggestions[app.app_type] || appTypeSuggestions.default;
      }

      res.json({
        success: true,
        data: {
          suggestions,
          context_type: contextType,
          app_info: {
            name: app.name,
            type: app.app_type,
            status: app.status,
          },
          focused_entity: page_id || component_id || null,
        },
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Error generating context suggestions:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate suggestions',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;