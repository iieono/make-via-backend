import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth, requireCredits, aiRateLimit } from '@/middleware/supabase-auth';
import rateLimits from '@/middleware/rateLimit';
import { reactNativeAIAgent } from '@/services/react-native-ai-agent';
import { expoEASService } from '@/services/expo-eas-service';
import { userProfileService } from '@/services/user-profile';
import type { AuthenticatedRequest } from '@/middleware/supabase-auth';
import {
  ValidationError,
  NotFoundError,
  RateLimitError,
} from '@/middleware/errorHandler';

const router = Router();

// Apply rate limiting to all routes
router.use(rateLimits.apiGeneration);

// =============================================================================
// USER PROFILE ENDPOINTS
// =============================================================================

// Get user profile
router.get('/profile',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    
    // Get full user profile
    const profile = await userProfileService.getUserProfile(user.id);
    
    if (!profile) {
      throw new NotFoundError('User profile not found');
    }

    res.json({
      success: true,
      data: profile,
    });
  })
);

// Update user profile
router.put('/profile',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const updates = req.body;
    
    const updatedProfile = await userProfileService.updateUserProfile(user.id, updates);

    res.json({
      success: true,
      data: updatedProfile,
      message: 'Profile updated successfully',
    });
  })
);

// Get user credit transactions
router.get('/credits/transactions',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { limit = 50 } = req.query;
    
    const transactions = await userProfileService.getCreditTransactions(
      user.id, 
      parseInt(limit as string)
    );

    res.json({
      success: true,
      data: transactions,
    });
  })
);

// =============================================================================
// REACT NATIVE APP MANAGEMENT
// =============================================================================

// Create new React Native app
router.post('/apps',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { name, slug, description, bundle_id, package_name } = req.body;

    // Validation
    if (!name || typeof name !== 'string') {
      throw new ValidationError('App name is required');
    }

    if (!slug || typeof slug !== 'string') {
      throw new ValidationError('App slug is required');
    }

    // Generate slug if not provided
    const appSlug = slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    // Create React Native app
    const { data: app, error } = await supabase
      .from('rn_apps')
      .insert({
        user_id: user.id,
        name,
        slug: appSlug,
        description: description || '',
        bundle_id: bundle_id || `com.user.${appSlug}`,
        package_name: package_name || `com.user.${appSlug}`,
        expo_config: {
          expo: {
            name,
            slug: appSlug,
            version: '1.0.0',
          }
        }
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: app,
      message: 'React Native app created successfully',
    });
  })
);

// Get user's React Native apps
router.get('/apps',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { limit = 20, page = 1 } = req.query;

    const offset = (page - 1) * limit;

    const { data: apps, error } = await supabase
      .from('rn_apps')
      .select('*', { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      success: true,
      data: apps,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: apps.length,
      },
    });
  })
);

// Get specific React Native app
router.get('/apps/:appId',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId } = req.params;

    const { data: app, error } = await supabase
      .from('rn_apps')
      .select('*')
      .eq('id', appId)
      .eq('user_id', user.id)
      .single();

    if (error) throw new NotFoundError('App not found');

    res.json({
      success: true,
      data: app,
    });
  })
);

// Update React Native app
router.put('/apps/:appId',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId } = req.params;
    const updates = req.body;

    // Verify ownership
    const { data: existingApp } = await supabase
      .from('rn_apps')
      .select('user_id')
      .eq('id', appId)
      .eq('user_id', user.id)
      .single();

    if (!existingApp) {
      throw new NotFoundError('App not found');
    }

    const { data: app, error } = await supabase
      .from('rn_apps')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', appId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: app,
      message: 'App updated successfully',
    });
  })
);

// Delete React Native app
router.delete('/apps/:appId',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId } = req.params;

    // Verify ownership
    const { data: existingApp } = await supabase
      .from('rn_apps')
      .select('user_id')
      .eq('id', appId)
      .eq('user_id', user.id)
      .single();

    if (!existingApp) {
      throw new NotFoundError('App not found');
    }

    const { error } = await supabase
      .from('rn_apps')
      .delete()
      .eq('id', appId);

    if (error) throw error;

    res.json({
      success: true,
      message: 'App deleted successfully',
    });
  })
);

// =============================================================================
// REACT NATIVE AI AGENT
// =============================================================================

// React Native AI chat endpoint
router.post('/chat',
  requireAuth,
  aiRateLimit,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { conversation_id, message, image_url, app_id } = req.body;

    // Validation
    if (!message || typeof message !== 'string') {
      throw new ValidationError('Message is required');
    }

    if (message.length < 3) {
      throw new ValidationError('Message must be at least 3 characters');
    }

    if (!app_id) {
      throw new ValidationError('app_id is required');
    }

    // Verify app ownership
    const { data: app } = await supabase
      .from('rn_apps')
      .select('id')
      .eq('id', app_id)
      .eq('user_id', user.id)
      .single();

    if (!app) {
      throw new NotFoundError('App not found');
    }

    try {
      // Get user subscription tier to calculate AI cost
      const subscriptionTier = await userProfileService.getSubscriptionTier(user.id);
      const aiCost = calculateAICost(message.length, subscriptionTier);
      
      // Check credits
      if (user.credits < aiCost) {
        return res.status(402).json({
          success: false,
          error: 'insufficient_credits',
          message: `You need ${aiCost} credits but only have ${user.credits}`,
          requiredCredits: aiCost,
          availableCredits: user.credits,
        });
      }

      const response = await reactNativeAIAgent.handleRNMessage(
        conversation_id || null,
        message,
        image_url,
        app_id,
        user.id
      );

      // Deduct credits after successful AI response
      await userProfileService.deductCredits(
        user.id,
        aiCost,
        `AI chat: ${message.substring(0, 50)}...`,
        'spent'
      );

      // Update user activity
      await userProfileService.updateLastActivity(user.id);

      res.json({
        success: true,
        data: response,
        creditsRemaining: user.credits - aiCost,
      });
    } catch (error) {
      logger.error('React Native AI chat error', { 
        userId: user.id, 
        appId: app_id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      
      if (error instanceof Error && error.message.includes('credits')) {
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

// Get React Native conversation history
router.get('/conversations/:conversationId/messages',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { conversationId } = req.params;

    // Verify ownership
    const { data: conversation } = await supabase
      .from('rn_ai_conversations')
      .select('user_id')
      .eq('id', conversationId)
      .single();

    if (!conversation || conversation.user_id !== user.id) {
      throw new NotFoundError('Conversation not found');
    }

    const { data: messages, error } = await supabase
      .from('rn_ai_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: messages,
    });
  })
);

// =============================================================================
// REACT NATIVE BUILD SYSTEM
// =============================================================================

// Start EAS build
router.post('/builds',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { app_id, platform, profile, environment } = req.body;

    // Validation
    if (!app_id) {
      throw new ValidationError('app_id is required');
    }

    if (!['ios', 'android', 'all'].includes(platform)) {
      throw new ValidationError('platform must be ios, android, or all');
    }

    if (!['development', 'preview', 'production'].includes(profile)) {
      throw new ValidationError('profile must be development, preview, or production');
    }

    // Verify app ownership
    const { data: app } = await supabase
      .from('rn_apps')
      .select('id')
      .eq('id', app_id)
      .eq('user_id', user.id)
      .single();

    if (!app) {
      throw new NotFoundError('App not found');
    }

    // Check credits
    const buildCost = calculateBuildCost(platform, profile);
    
    if (user.credits < buildCost) {
      return res.status(402).json({
        success: false,
        error: 'insufficient_credits',
        message: `You need ${buildCost} credits for ${platform} build but only have ${user.credits}`,
        requiredCredits: buildCost,
        availableCredits: user.credits,
      });
    }

    try {
      const buildId = await expoEASService.startEASBuild({
        appId: app_id,
        platform: platform as 'ios' | 'android' | 'all',
        profile: profile as 'development' | 'preview' | 'production',
        environment: environment || {}
      }, user.id);

      // Deduct credits
      await userProfileService.deductCredits(
        user.id,
        buildCost,
        `EAS build: ${platform} ${profile}`,
        'spent'
      );

      // Update user activity
      await userProfileService.updateLastActivity(user.id);

      res.json({
        success: true,
        data: { buildId },
        message: 'Build started successfully',
        creditsRemaining: user.credits - buildCost,
      });
    } catch (error) {
      logger.error('EAS build start error', { 
        userId: user.id, 
        appId: app_id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  })
);

// Get build status
router.get('/builds/:buildId',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { buildId } = req.params;

    const build = await expoEASService.getBuildStatus(buildId);

    // Verify user owns this build
    if (build.user_id !== user.id) {
      throw new NotFoundError('Build not found');
    }

    res.json({
      success: true,
      data: build,
    });
  })
);

// Get app's builds
router.get('/apps/:appId/builds',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId } = req.params;

    // Verify app ownership
    const { data: app } = await supabase
      .from('rn_apps')
      .select('id')
      .eq('id', appId)
      .eq('user_id', user.id)
      .single();

    if (!app) {
      throw new NotFoundError('App not found');
    }

    const builds = await expoEASService.getAppBuilds(appId);

    res.json({
      success: true,
      data: builds,
    });
  })
);

// Cancel build
router.post('/builds/:buildId/cancel',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { buildId } = req.params;

    const build = await expoEASService.getBuildStatus(buildId);

    // Verify user owns this build
    if (build.user_id !== user.id) {
      throw new NotFoundError('Build not found');
    }

    await expoEASService.cancelBuild(buildId);

    res.json({
      success: true,
      message: 'Build cancelled successfully',
    });
  })
);

// =============================================================================
// REACT NATIVE SCREENS
// =============================================================================

// Get app's screens
router.get('/apps/:appId/screens',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId } = req.params;

    // Verify app ownership
    const { data: app } = await supabase
      .from('rn_apps')
      .select('id')
      .eq('id', appId)
      .eq('user_id', user.id)
      .single();

    if (!app) {
      throw new NotFoundError('App not found');
    }

    const { data: screens, error } = await supabase
      .from('rn_screens')
      .select('*')
      .eq('app_id', appId)
      .order('order_index', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: screens,
    });
  })
);

// Create screen
router.post('/apps/:appId/screens',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId } = req.params;
    const screenData = req.body;

    // Verify app ownership
    const { data: app } = await supabase
      .from('rn_apps')
      .select('id')
      .eq('id', appId)
      .eq('user_id', user.id)
      .single();

    if (!app) {
      throw new NotFoundError('App not found');
    }

    const { data: screen, error } = await supabase
      .from('rn_screens')
      .insert({
        app_id: appId,
        ...screenData,
        order_index: 0 // Will be updated by AI
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: screen,
      message: 'Screen created successfully',
    });
  })
);

// =============================================================================
// REACT NATIVE COMPONENTS
// =============================================================================

// Get app's components
router.get('/apps/:appId/components',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId } = req.params;

    // Verify app ownership
    const { data: app } = await supabase
      .from('rn_apps')
      .select('id')
      .eq('id', appId)
      .eq('user_id', user.id)
      .single();

    if (!app) {
      throw new NotFoundError('App not found');
    }

    const { data: components, error } = await supabase
      .from('rn_components')
      .select('*')
      .eq('app_id', appId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: components,
    });
  })
);

// =============================================================================
// REACT NATIVE PACKAGES
// =============================================================================

// Get app's packages
router.get('/apps/:appId/packages',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId } = req.params;

    // Verify app ownership
    const { data: app } = await supabase
      .from('rn_apps')
      .select('id')
      .eq('id', appId)
      .eq('user_id', user.id)
      .single();

    if (!app) {
      throw new NotFoundError('App not found');
    }

    const { data: packages, error } = await supabase
      .from('rn_packages')
      .select('*')
      .eq('app_id', appId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: packages,
    });
  })
);

// =============================================================================
// HELPER METHODS
// =============================================================================

function calculateBuildCost(platform: string, profile: string): number {
  let baseCost = 10; // Base cost for any build
  
  // Platform modifiers
  if (platform === 'ios') baseCost *= 1.5;
  if (platform === 'all') baseCost *= 2;
  
  // Profile modifiers
  if (profile === 'production') baseCost *= 1.5;
  if (profile === 'preview') baseCost *= 1.2;
  
  return Math.round(baseCost);
}

function calculateAICost(messageLength: number, subscriptionTier: 'free' | 'creator' | 'power'): number {
  // Base cost calculation based on message length
  const baseCost = Math.ceil(messageLength / 100); // 1 credit per 100 characters
  
  // Subscription tier discounts
  const discounts = {
    free: 1.0,      // No discount
    creator: 0.7,   // 30% discount
    power: 0.5,    // 50% discount
  };
  
  return Math.max(1, Math.round(baseCost * discounts[subscriptionTier]));
}

export default router;