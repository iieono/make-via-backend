/**
 * AI Controller with Token Tracking
 * Handles AI generation requests with comprehensive usage tracking
 */

import { Request, Response } from 'express';
import { claudeService } from '@/services/claudeService';
import { tokenTrackingService } from '@/services/tokenTrackingService';
import { supabase } from '@/config/supabase';
import { logger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    subscription_tier: string;
  };
}

export class AIController {
  /**
   * Generate AI content for page creation
   */
  async generatePage(req: AuthenticatedRequest, res: Response) {
    try {
      const { prompt, model, pageId, projectId } = req.body;
      const userId = req.user?.id;
      const subscriptionTier = req.user?.subscription_tier || 'free';
      const ipAddress = req.ip;

      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Prompt is required and must be a string' });
      }

      // Validate prompt length for subscription tier
      const characterLimit = claudeService.getCharacterLimit(subscriptionTier);
      if (prompt.length > characterLimit) {
        return res.status(400).json({ 
          error: `Prompt exceeds ${characterLimit} character limit for ${subscriptionTier} tier. Current length: ${prompt.length}`,
          characterLimit,
          currentLength: prompt.length,
          subscriptionTier
        });
      }

      // Check if user can make request (rate limits + usage limits)
      const canMakeRequest = await claudeService.canMakeRequest(userId, ipAddress);
      if (!canMakeRequest.allowed) {
        return res.status(429).json({ 
          error: canMakeRequest.reason,
          remainingRequests: canMakeRequest.remainingRequests,
          resetTime: canMakeRequest.resetTime
        });
      }

      // Create AI generation record
      const generationId = uuidv4();
      const { data: generation, error: generationError } = await supabase
        .from('ai_generations')
        .insert({
          id: generationId,
          user_id: userId,
          page_id: pageId,
          project_id: projectId,
          prompt: prompt,
          model_used: model || 'haiku',
          status: 'processing',
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (generationError) {
        logger.error('Failed to create AI generation record:', generationError);
        return res.status(500).json({ error: 'Failed to create generation record' });
      }

      // Generate content using Claude
      const response = await claudeService.generateContent({
        prompt,
        model: model || 'haiku',
        userId,
        generationId,
        subscriptionTier,
        ipAddress
      });

      if (!response) {
        // Update generation record to failed
        await supabase
          .from('ai_generations')
          .update({ 
            status: 'failed',
            error_message: 'Claude API request failed',
            updated_at: new Date().toISOString()
          })
          .eq('id', generationId);

        return res.status(500).json({ error: 'AI generation failed' });
      }

      // Update generation record with results
      await supabase
        .from('ai_generations')
        .update({
          status: 'completed',
          response: response.content,
          total_tokens: response.usage.total_tokens,
          total_cost_usd: response.cost.totalCost,
          updated_at: new Date().toISOString()
        })
        .eq('id', generationId);

      // Get updated usage information
      const usage = await tokenTrackingService.getUserMonthlyUsage(userId);

      res.json({
        success: true,
        generationId,
        content: response.content,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens
        },
        cost: response.cost,
        model: response.model,
        duration: response.duration,
        monthlyUsage: usage ? {
          requests: usage.requests,
          remaining: usage.remaining,
          limit: usage.limit,
          totalCost: usage.cost
        } : null
      });

    } catch (error) {
      logger.error('Error in generatePage:', error);
      res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * Generate AI content with streaming for real-time responses
   */
  async streamGenerate(req: AuthenticatedRequest, res: Response) {
    try {
      const { prompt, model, pageId, projectId } = req.body;
      const userId = req.user?.id;
      const subscriptionTier = req.user?.subscription_tier || 'free';
      const ipAddress = req.ip;

      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Prompt is required and must be a string' });
      }

      // Validate prompt length
      const characterLimit = claudeService.getCharacterLimit(subscriptionTier);
      if (prompt.length > characterLimit) {
        return res.status(400).json({ 
          error: `Prompt exceeds ${characterLimit} character limit for ${subscriptionTier} tier`,
          characterLimit,
          currentLength: prompt.length
        });
      }

      // Check request permissions
      const canMakeRequest = await claudeService.canMakeRequest(userId, ipAddress);
      if (!canMakeRequest.allowed) {
        return res.status(429).json({ error: canMakeRequest.reason });
      }

      // Set up server-sent events
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const generationId = uuidv4();

      // Create generation record
      await supabase
        .from('ai_generations')
        .insert({
          id: generationId,
          user_id: userId,
          page_id: pageId,
          project_id: projectId,
          prompt: prompt,
          model_used: model || 'haiku',
          status: 'processing'
        });

      // Send initial status
      res.write(`data: ${JSON.stringify({ 
        type: 'status', 
        message: 'Starting generation...',
        generationId 
      })}\n\n`);

      // Stream content generation
      const response = await claudeService.streamContent({
        prompt,
        model: model || 'haiku',
        userId,
        generationId,
        subscriptionTier,
        ipAddress
      }, (chunk) => {
        // Send each chunk to client
        res.write(`data: ${JSON.stringify({ 
          type: 'content', 
          chunk 
        })}\n\n`);
      });

      if (response) {
        // Update generation record
        await supabase
          .from('ai_generations')
          .update({
            status: 'completed',
            response: response.content,
            total_tokens: response.usage.total_tokens,
            total_cost_usd: response.cost.totalCost,
            updated_at: new Date().toISOString()
          })
          .eq('id', generationId);

        // Send completion status
        res.write(`data: ${JSON.stringify({ 
          type: 'complete',
          usage: response.usage,
          cost: response.cost,
          duration: response.duration
        })}\n\n`);
      } else {
        // Update to failed status
        await supabase
          .from('ai_generations')
          .update({ 
            status: 'failed',
            error_message: 'Streaming generation failed'
          })
          .eq('id', generationId);

        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          message: 'Generation failed' 
        })}\n\n`);
      }

      res.end();

    } catch (error) {
      logger.error('Error in streamGenerate:', error);
      res.write(`data: ${JSON.stringify({ 
        type: 'error', 
        message: 'Internal server error' 
      })}\n\n`);
      res.end();
    }
  }

  /**
   * Get user's AI usage statistics
   */
  async getUsageStats(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const monthlyUsage = await tokenTrackingService.getUserMonthlyUsage(userId);
      
      // Get available models for user's subscription
      const subscriptionTier = req.user?.subscription_tier || 'free';
      const availableModels = claudeService.getAvailableModels(subscriptionTier);
      const characterLimit = claudeService.getCharacterLimit(subscriptionTier);

      // Get recent generation history
      const { data: recentGenerations, error } = await supabase
        .from('ai_generations')
        .select('id, prompt, model_used, status, total_tokens, total_cost_usd, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) {
        logger.error('Error fetching recent generations:', error);
      }

      res.json({
        monthlyUsage,
        availableModels,
        characterLimit,
        subscriptionTier,
        recentGenerations: recentGenerations || []
      });

    } catch (error) {
      logger.error('Error in getUsageStats:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Get detailed usage analytics (admin/premium feature)
   */
  async getUsageAnalytics(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      const subscriptionTier = req.user?.subscription_tier || 'free';
      
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Only allow detailed analytics for paid tiers
      if (subscriptionTier === 'free') {
        return res.status(403).json({ error: 'Premium feature - upgrade to access detailed analytics' });
      }

      const { startDate, endDate, groupBy } = req.query;
      
      const analytics = await tokenTrackingService.getUsageAnalytics({
        userId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        groupBy: groupBy as 'day' | 'month' | 'model'
      });

      res.json({ analytics });

    } catch (error) {
      logger.error('Error in getUsageAnalytics:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Check if user can make AI request (for frontend validation)
   */
  async checkRequestPermissions(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const canMakeRequest = await claudeService.canMakeRequest(userId, req.ip);
      const monthlyUsage = await tokenTrackingService.getUserMonthlyUsage(userId);
      
      res.json({
        canMakeRequest: canMakeRequest.allowed,
        reason: canMakeRequest.reason,
        remainingRequests: canMakeRequest.remainingRequests,
        resetTime: canMakeRequest.resetTime,
        monthlyUsage
      });

    } catch (error) {
      logger.error('Error checking request permissions:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export const aiController = new AIController();