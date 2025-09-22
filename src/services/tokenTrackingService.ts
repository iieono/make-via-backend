/**
 * Token Tracking Service
 * Handles all Claude API token usage tracking and cost calculation
 */

import { supabase } from '@/config/supabase';
import { logger } from '@/utils/logger';

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

export interface TokenTrackingData {
  userId: string;
  generationId?: string;
  promptText: string;
  modelUsed: string;
  usage: ClaudeUsage;
  requestDurationMs?: number;
  claudeRequestId?: string;
  subscriptionTier?: string;
  ipAddress?: string;
  status?: 'completed' | 'failed' | 'timeout';
  errorMessage?: string;
  responseMetadata?: any;
}

export interface CostCalculation {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  costPerInputToken: number;
  costPerOutputToken: number;
}

class TokenTrackingService {
  /**
   * Get current pricing for a Claude model
   */
  async getModelPricing(modelName: string): Promise<{
    input_cost_per_token: number;
    output_cost_per_token: number;
  } | null> {
    try {
      const { data, error } = await supabase
        .from('claude_pricing')
        .select('input_cost_per_token, output_cost_per_token')
        .eq('model_name', modelName)
        .eq('is_active', true)
        .single();

      if (error) {
        logger.warn(`Pricing not found for model ${modelName}, falling back to Haiku`, error);
        
        // Fallback to Haiku pricing
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('claude_pricing')
          .select('input_cost_per_token, output_cost_per_token')
          .eq('model_name', 'haiku')
          .eq('is_active', true)
          .single();

        if (fallbackError) {
          logger.error('Failed to get fallback pricing', fallbackError);
          return null;
        }
        
        return fallbackData;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching model pricing:', error);
      return null;
    }
  }

  /**
   * Calculate cost based on token usage and current pricing
   */
  async calculateCost(modelName: string, usage: ClaudeUsage): Promise<CostCalculation | null> {
    const pricing = await this.getModelPricing(modelName);
    if (!pricing) {
      return null;
    }

    const inputCost = usage.input_tokens * pricing.input_cost_per_token;
    const outputCost = usage.output_tokens * pricing.output_cost_per_token;
    const totalCost = inputCost + outputCost;

    return {
      inputCost: Number(inputCost.toFixed(4)),
      outputCost: Number(outputCost.toFixed(4)),
      totalCost: Number(totalCost.toFixed(4)),
      costPerInputToken: pricing.input_cost_per_token,
      costPerOutputToken: pricing.output_cost_per_token
    };
  }

  /**
   * Log AI request with detailed token tracking
   */
  async logTokenUsage(data: TokenTrackingData): Promise<string | null> {
    try {
      const cost = await this.calculateCost(data.modelUsed, data.usage);
      if (!cost) {
        logger.error(`Failed to calculate cost for model ${data.modelUsed}`);
        return null;
      }

      // Calculate total tokens if not provided
      const totalTokens = data.usage.total_tokens || 
        (data.usage.input_tokens + data.usage.output_tokens);

      const { data: logData, error } = await supabase
        .from('ai_request_logs')
        .insert({
          user_id: data.userId,
          generation_id: data.generationId,
          prompt_text: data.promptText,
          prompt_char_count: data.promptText.length,
          subscription_tier: data.subscriptionTier || 'free',
          model_requested: data.modelUsed,
          model_used: data.modelUsed,
          input_tokens: data.usage.input_tokens,
          output_tokens: data.usage.output_tokens,
          total_tokens: totalTokens,
          cost_per_input_token: cost.costPerInputToken,
          cost_per_output_token: cost.costPerOutputToken,
          input_cost_usd: cost.inputCost,
          output_cost_usd: cost.outputCost,
          total_cost_usd: cost.totalCost,
          request_duration_ms: data.requestDurationMs || 0,
          claude_request_id: data.claudeRequestId,
          status: data.status || 'completed',
          error_message: data.errorMessage,
          ip_address: data.ipAddress,
          claude_response_metadata: data.responseMetadata,
          completed_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (error) {
        logger.error('Failed to log token usage:', error);
        return null;
      }

      logger.info(`Logged token usage: ${totalTokens} tokens, $${cost.totalCost} for user ${data.userId}`);
      return logData.id;

    } catch (error) {
      logger.error('Error logging token usage:', error);
      return null;
    }
  }

  /**
   * Get user's current month usage
   */
  async getUserMonthlyUsage(userId: string): Promise<{
    requests: number;
    tokens: number;
    cost: number;
    limit: number;
    remaining: number;
  } | null> {
    try {
      const currentDate = new Date();
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth() + 1;

      const { data, error } = await supabase
        .from('monthly_token_usage')
        .select('*')
        .eq('user_id', userId)
        .eq('billing_year', year)
        .eq('billing_month', month)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
        logger.error('Error fetching monthly usage:', error);
        return null;
      }

      // Get user's subscription limits
      const { data: profileData, error: profileError } = await supabase
        .from('user_profiles')
        .select('subscription_tier')
        .eq('id', userId)
        .single();

      if (profileError) {
        logger.error('Error fetching user profile:', profileError);
        return null;
      }

      // Get subscription limits
      const { data: limitsData, error: limitsError } = await supabase
        .from('subscription_plans')
        .select('limits')
        .eq('name', profileData.subscription_tier)
        .single();

      const limit = limitsData?.limits?.ai_generations || 25; // Default to free tier limit

      if (!data) {
        // No usage yet this month
        return {
          requests: 0,
          tokens: 0,
          cost: 0,
          limit,
          remaining: limit
        };
      }

      return {
        requests: data.total_requests || 0,
        tokens: data.total_tokens || 0,
        cost: parseFloat(data.total_cost_usd || '0'),
        limit,
        remaining: Math.max(0, limit - (data.total_requests || 0))
      };

    } catch (error) {
      logger.error('Error getting user monthly usage:', error);
      return null;
    }
  }

  /**
   * Check if user has exceeded their monthly limits
   */
  async checkUsageLimits(userId: string): Promise<{
    withinLimits: boolean;
    usage: number;
    limit: number;
    remaining: number;
  }> {
    const monthlyUsage = await this.getUserMonthlyUsage(userId);
    
    if (!monthlyUsage) {
      // If we can't get usage data, default to allowing the request
      logger.warn(`Could not fetch usage data for user ${userId}, allowing request`);
      return {
        withinLimits: true,
        usage: 0,
        limit: 25,
        remaining: 25
      };
    }

    return {
      withinLimits: monthlyUsage.remaining > 0,
      usage: monthlyUsage.requests,
      limit: monthlyUsage.limit,
      remaining: monthlyUsage.remaining
    };
  }

  /**
   * Get detailed usage analytics for admin/billing
   */
  async getUsageAnalytics(options: {
    userId?: string;
    startDate?: Date;
    endDate?: Date;
    groupBy?: 'day' | 'month' | 'model';
  } = {}) {
    try {
      let query = supabase
        .from('ai_request_logs')
        .select(`
          user_id,
          model_used,
          input_tokens,
          output_tokens,
          total_tokens,
          total_cost_usd,
          created_at,
          status
        `)
        .eq('status', 'completed');

      if (options.userId) {
        query = query.eq('user_id', options.userId);
      }

      if (options.startDate) {
        query = query.gte('created_at', options.startDate.toISOString());
      }

      if (options.endDate) {
        query = query.lte('created_at', options.endDate.toISOString());
      }

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) {
        logger.error('Error fetching usage analytics:', error);
        return null;
      }

      return data;
    } catch (error) {
      logger.error('Error getting usage analytics:', error);
      return null;
    }
  }

  /**
   * Get top users by cost/usage for billing insights
   */
  async getTopUsersByUsage(limit = 50) {
    try {
      const { data, error } = await supabase
        .from('user_usage_summary')
        .select('*')
        .order('total_cost_usd', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('Error fetching top users:', error);
        return null;
      }

      return data;
    } catch (error) {
      logger.error('Error getting top users by usage:', error);
      return null;
    }
  }

  /**
   * Update pricing for a model (admin function)
   */
  async updateModelPricing(
    modelName: string, 
    inputCostPerToken: number, 
    outputCostPerToken: number
  ): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('claude_pricing')
        .upsert({
          model_name: modelName,
          input_cost_per_token: inputCostPerToken,
          output_cost_per_token: outputCostPerToken,
          is_active: true,
          effective_from: new Date().toISOString()
        });

      if (error) {
        logger.error('Error updating model pricing:', error);
        return false;
      }

      logger.info(`Updated pricing for ${modelName}: input $${inputCostPerToken}, output $${outputCostPerToken}`);
      return true;
    } catch (error) {
      logger.error('Error updating model pricing:', error);
      return false;
    }
  }
}

export const tokenTrackingService = new TokenTrackingService();
export default tokenTrackingService;