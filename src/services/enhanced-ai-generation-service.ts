import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import { notificationService } from '@/services/notifications';
import type { 
  AIModel,
  GenerationStatus,
  EnhancedGenerationRequest,
  EnhancedGenerationResponse
} from '@/types/app-development';

class EnhancedAIGenerationService {

  /**
   * Create enhanced AI generation request with detailed tracking
   */
  async createEnhancedGeneration(
    userId: string,
    request: EnhancedGenerationRequest
  ): Promise<EnhancedGenerationResponse> {
    try {
      const generationId = this.generateId();
      const now = new Date().toISOString();

      // Calculate character count and estimate processing time
      const charCount = request.prompt.length;
      const estimatedTimeMs = this.estimateProcessingTime(request.model, charCount);

      // Create generation record with enhanced tracking
      const { data: generation, error } = await supabase.serviceClient
        .from('ai_generations')
        .insert({
          id: generationId,
          user_id: userId,
          app_id: request.app_id || null,
          page_id: request.page_id || null,
          request_prompt: request.prompt,
          generation_mode: 'enhanced',
          model_used: request.model,
          status: 'queued' as GenerationStatus,
          prompt_text: request.prompt,
          prompt_char_count: charCount,
          subscription_tier: await this.getUserTier(userId),
          metadata: request.context || {},
          queued_at: now,
          created_at: now,
          updated_at: now
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      // Get current queue position
      const queuePosition = await this.getQueuePosition(userId, request.model);

      // Log the request
      await this.logAIRequest(userId, generationId, request, estimatedTimeMs);

      logger.info(`Enhanced AI generation queued: ${generationId} for user ${userId}`);

      return {
        generation_id: generationId,
        status: 'queued',
        estimated_time_ms: estimatedTimeMs,
        queue_position: queuePosition,
        model_used: request.model
      };
    } catch (error) {
      logger.error('Error creating enhanced AI generation:', error);
      throw error;
    }
  }

  /**
   * Update generation status with detailed tracking
   */
  async updateGenerationStatus(
    generationId: string,
    status: GenerationStatus,
    additionalData?: {
      processing_time_ms?: number;
      tokens_used?: number;
      cost_usd?: number;
      error_message?: string;
      generated_code?: string;
      confidence_score?: number;
    }
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      const updateData: any = {
        status,
        updated_at: now
      };

      // Add status-specific timestamps
      switch (status) {
        case 'processing':
          updateData.started_at = now;
          break;
        case 'completed':
        case 'failed':
        case 'timeout':
          updateData.completed_at = now;
          break;
      }

      // Add additional data if provided
      if (additionalData) {
        Object.assign(updateData, additionalData);
      }

      const { error } = await supabase.serviceClient
        .from('ai_generations')
        .update(updateData)
        .eq('id', generationId);

      if (error) {
        throw error;
      }

      // Send notification for completed generations
      if (status === 'completed' && additionalData?.generated_code) {
        const { data: generation } = await supabase.serviceClient
          .from('ai_generations')
          .select('user_id, app_id, page_id')
          .eq('id', generationId)
          .single();

        if (generation) {
          await notificationService.sendNotification(generation.user_id, {
            title: '🎨 AI Generation Complete!',
            body: 'Your AI-generated content is ready for review',
            type: 'success',
            category: 'ai_generation',
            data: {
              action: 'view_generation',
              generation_id: generationId,
              app_id: generation.app_id,
              page_id: generation.page_id,
            },
          });
        }
      }

      logger.info(`AI generation ${generationId} status updated to ${status}`);
    } catch (error) {
      logger.error('Error updating generation status:', error);
      throw error;
    }
  }

  /**
   * Get generation status with detailed information
   */
  async getGenerationStatus(generationId: string, userId: string): Promise<any> {
    try {
      const { data: generation, error } = await supabase.serviceClient
        .from('ai_generations')
        .select(`
          id,
          status,
          model_used,
          prompt_char_count,
          processing_time_ms,
          tokens_used,
          cost_usd,
          confidence_score,
          error_message,
          queued_at,
          started_at,
          completed_at,
          created_at,
          updated_at
        `)
        .eq('id', generationId)
        .eq('user_id', userId)
        .single();

      if (error || !generation) {
        throw new Error('Generation not found');
      }

      // Calculate additional metrics
      const result = {
        ...generation,
        queue_time_ms: generation.started_at ? 
          new Date(generation.started_at).getTime() - new Date(generation.queued_at).getTime() : null,
        total_time_ms: generation.completed_at ?
          new Date(generation.completed_at).getTime() - new Date(generation.queued_at).getTime() : null,
        is_completed: ['completed', 'failed', 'timeout', 'canceled'].includes(generation.status),
        estimated_completion: this.estimateCompletion(generation)
      };

      return result;
    } catch (error) {
      logger.error('Error getting generation status:', error);
      throw error;
    }
  }

  /**
   * Get user's generation history with enhanced filtering
   */
  async getUserGenerationHistory(
    userId: string,
    filters?: {
      status?: GenerationStatus;
      model?: AIModel;
      app_id?: string;
      limit?: number;
      offset?: number;
      date_from?: string;
      date_to?: string;
    }
  ): Promise<any> {
    try {
      let query = supabase.serviceClient
        .from('ai_generations')
        .select(`
          id,
          status,
          model_used,
          prompt_char_count,
          processing_time_ms,
          tokens_used,
          cost_usd,
          confidence_score,
          app_id,
          page_id,
          created_at,
          completed_at,
          apps(name),
          app_pages(name)
        `)
        .eq('user_id', userId);

      // Apply filters
      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.model) {
        query = query.eq('model_used', filters.model);
      }
      if (filters?.app_id) {
        query = query.eq('app_id', filters.app_id);
      }
      if (filters?.date_from) {
        query = query.gte('created_at', filters.date_from);
      }
      if (filters?.date_to) {
        query = query.lte('created_at', filters.date_to);
      }

      // Apply pagination
      const limit = filters?.limit || 50;
      const offset = filters?.offset || 0;
      query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

      const { data: generations, error } = await query;

      if (error) {
        throw error;
      }

      // Get summary statistics
      const statsQuery = supabase.serviceClient
        .from('ai_generations')
        .select('status, model_used, cost_usd, processing_time_ms', { count: 'exact' })
        .eq('user_id', userId);

      if (filters?.date_from) {
        statsQuery.gte('created_at', filters.date_from);
      }
      if (filters?.date_to) {
        statsQuery.lte('created_at', filters.date_to);
      }

      const { data: statsData, count: totalCount, error: statsError } = await statsQuery;

      if (statsError) {
        throw statsError;
      }

      // Calculate summary statistics
      const stats = this.calculateSummaryStats(statsData || []);

      return {
        generations: generations || [],
        pagination: {
          total: totalCount || 0,
          limit,
          offset,
          has_more: (totalCount || 0) > offset + limit
        },
        summary: stats
      };
    } catch (error) {
      logger.error('Error getting user generation history:', error);
      throw error;
    }
  }

  /**
   * Get active generations queue information
   */
  async getActiveGenerationsQueue(userId: string): Promise<any> {
    try {
      const { data: activeGenerations, error } = await supabase.serviceClient
        .from('ai_generations')
        .select('id, status, model_used, queued_at, started_at, estimated_completion_at')
        .eq('user_id', userId)
        .in('status', ['queued', 'processing'])
        .order('queued_at', { ascending: true });

      if (error) {
        throw error;
      }

      const queue = (activeGenerations || []).map((gen, index) => ({
        ...gen,
        queue_position: index + 1,
        estimated_wait_time_ms: this.estimateWaitTime(gen, index)
      }));

      return {
        active_generations: queue,
        total_active: queue.length,
        estimated_total_wait_time_ms: queue.reduce((sum, gen) => sum + gen.estimated_wait_time_ms, 0)
      };
    } catch (error) {
      logger.error('Error getting active generations queue:', error);
      throw error;
    }
  }

  /**
   * Cancel a pending generation
   */
  async cancelGeneration(generationId: string, userId: string): Promise<void> {
    try {
      const { data: generation, error: fetchError } = await supabase.serviceClient
        .from('ai_generations')
        .select('status')
        .eq('id', generationId)
        .eq('user_id', userId)
        .single();

      if (fetchError || !generation) {
        throw new Error('Generation not found');
      }

      if (!['queued', 'processing'].includes(generation.status)) {
        throw new Error('Generation cannot be canceled in current status');
      }

      await this.updateGenerationStatus(generationId, 'canceled');

      logger.info(`AI generation ${generationId} canceled by user ${userId}`);
    } catch (error) {
      logger.error('Error canceling generation:', error);
      throw error;
    }
  }

  /**
   * Get model availability for user's subscription tier
   */
  async getAvailableModels(userId: string): Promise<{
    available: AIModel[];
    unavailable: AIModel[];
    tier_limits: any;
  }> {
    try {
      const userTier = await this.getUserTier(userId);
      
      const allModels: AIModel[] = [
        'claude-3-haiku',
        'claude-3-sonnet', 
        'claude-3-opus',
        'claude-3-5-haiku',
        'claude-3-5-sonnet',
        'claude-3-5-opus',
        'claude-4'
      ];

      // Define model availability by tier
      const tierModels = {
        free: ['claude-3-haiku'],
        creator: ['claude-3-haiku', 'claude-3-sonnet', 'claude-3-5-haiku', 'claude-3-5-sonnet'],
        power: allModels
      };

      const availableModels = tierModels[userTier] || tierModels.free;
      const unavailableModels = allModels.filter(model => !availableModels.includes(model));

      return {
        available: availableModels,
        unavailable: unavailableModels,
        tier_limits: {
          current_tier: userTier,
          upgrade_required_for: unavailableModels
        }
      };
    } catch (error) {
      logger.error('Error getting available models:', error);
      throw error;
    }
  }

  /**
   * Get generation usage statistics
   */
  async getGenerationStats(userId: string, timeframe?: 'day' | 'week' | 'month'): Promise<any> {
    try {
      const timeframeDays = {
        day: 1,
        week: 7,
        month: 30
      };

      const days = timeframeDays[timeframe || 'month'];
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const { data: generations, error } = await supabase.serviceClient
        .from('ai_generations')
        .select('status, model_used, cost_usd, processing_time_ms, tokens_used, created_at')
        .eq('user_id', userId)
        .gte('created_at', startDate);

      if (error) {
        throw error;
      }

      return this.calculateDetailedStats(generations || [], timeframe || 'month');
    } catch (error) {
      logger.error('Error getting generation stats:', error);
      throw error;
    }
  }

  // Private helper methods

  private generateId(): string {
    return `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private estimateProcessingTime(model: AIModel, charCount: number): number {
    // Rough estimates based on model complexity and prompt length
    const baseTimeMs = {
      'claude-3-haiku': 2000,
      'claude-3-sonnet': 5000,
      'claude-3-opus': 10000,
      'claude-3-5-haiku': 3000,
      'claude-3-5-sonnet': 6000,
      'claude-3-5-opus': 12000,
      'claude-4': 15000
    };

    const base = baseTimeMs[model] || 5000;
    const charMultiplier = Math.min(charCount / 1000, 5); // Max 5x for very long prompts
    
    return Math.round(base * (1 + charMultiplier * 0.5));
  }

  private async getUserTier(userId: string): Promise<'free' | 'creator' | 'power'> {
    try {
      const { data: subscription } = await supabase.serviceClient
        .from('user_subscriptions')
        .select('tier')
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      return subscription?.tier || 'free';
    } catch (error) {
      return 'free';
    }
  }

  private async getQueuePosition(userId: string, model: AIModel): Promise<number> {
    try {
      const { count } = await supabase.serviceClient
        .from('ai_generations')
        .select('id', { count: 'exact' })
        .eq('model_used', model)
        .in('status', ['queued', 'processing']);

      return (count || 0) + 1;
    } catch (error) {
      return 1;
    }
  }

  private async logAIRequest(
    userId: string,
    generationId: string,
    request: EnhancedGenerationRequest,
    estimatedTimeMs: number
  ): Promise<void> {
    try {
      await supabase.serviceClient
        .from('ai_request_logs')
        .insert({
          user_id: userId,
          generation_id: generationId,
          prompt_text: request.prompt,
          prompt_char_count: request.prompt.length,
          subscription_tier: await this.getUserTier(userId),
          model_requested: request.model,
          model_used: request.model,
          status: 'pending',
          created_at: new Date().toISOString(),
          billing_month: new Date().getMonth() + 1,
          billing_year: new Date().getFullYear()
        });
    } catch (error) {
      logger.error('Error logging AI request:', error);
    }
  }

  private estimateCompletion(generation: any): string | null {
    if (generation.status !== 'processing') return null;

    const startedAt = new Date(generation.started_at);
    const estimatedDuration = this.estimateProcessingTime(generation.model_used, generation.prompt_char_count);
    const estimatedCompletion = new Date(startedAt.getTime() + estimatedDuration);

    return estimatedCompletion.toISOString();
  }

  private estimateWaitTime(generation: any, queuePosition: number): number {
    const avgProcessingTime = this.estimateProcessingTime(generation.model_used, 1000); // Average prompt
    return queuePosition * avgProcessingTime;
  }

  private calculateSummaryStats(generations: any[]): any {
    const total = generations.length;
    const completed = generations.filter(g => g.status === 'completed').length;
    const failed = generations.filter(g => g.status === 'failed').length;
    const totalCost = generations.reduce((sum, g) => sum + (g.cost_usd || 0), 0);
    const avgProcessingTime = generations
      .filter(g => g.processing_time_ms)
      .reduce((sum, g, _, arr) => sum + g.processing_time_ms / arr.length, 0);

    const modelUsage = generations.reduce((acc, g) => {
      acc[g.model_used] = (acc[g.model_used] || 0) + 1;
      return acc;
    }, {});

    return {
      total_generations: total,
      completed_count: completed,
      failed_count: failed,
      success_rate: total > 0 ? (completed / total * 100).toFixed(1) : 0,
      total_cost_usd: totalCost.toFixed(4),
      avg_processing_time_ms: Math.round(avgProcessingTime),
      model_usage: modelUsage
    };
  }

  private calculateDetailedStats(generations: any[], timeframe: string): any {
    const basicStats = this.calculateSummaryStats(generations);
    
    // Group by date for trend analysis
    const dailyStats = generations.reduce((acc, g) => {
      const date = g.created_at.split('T')[0];
      if (!acc[date]) {
        acc[date] = { count: 0, cost: 0, processing_time: 0 };
      }
      acc[date].count++;
      acc[date].cost += g.cost_usd || 0;
      if (g.processing_time_ms) {
        acc[date].processing_time += g.processing_time_ms;
      }
      return acc;
    }, {});

    return {
      ...basicStats,
      timeframe,
      daily_breakdown: dailyStats,
      peak_usage_day: Object.entries(dailyStats)
        .sort(([,a], [,b]) => b.count - a.count)[0]?.[0] || null
    };
  }
}

const enhancedAIGenerationService = new EnhancedAIGenerationService();
export { EnhancedAIGenerationService };
export default enhancedAIGenerationService;