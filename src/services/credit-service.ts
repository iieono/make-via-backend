import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';

export interface CreditTransaction {
  id: string;
  userId: string;
  amount: number; // positive for additions, negative for usage
  transactionType: 'subscription_renewal' | 'bonus_credits' | 'action_usage' | 'refund' | 'admin_adjustment';
  description?: string;
  aiActionId?: string;
  createdAt: Date;
}

export interface UserCreditSummary {
  availableCredits: number;
  creditsUsedThisPeriod: number;
  creditsResetDate: Date;
  subscriptionTier: string;
  monthlyAllocation: number;
}

export class CreditService {
  private db = supabase;

  /**
   * Get credit costs for different action types
   * Based on Claude API costs with 3-5x markup for profitability
   */
  getCreditCosts(): Record<string, number> {
    return {
      // Planning costs (charged at plan generation)
      plan_simple: 2,        // 1-3 steps
      plan_medium: 5,        // 4-7 steps  
      plan_complex: 8,       // 8+ steps
      plan_analysis: 3,      // Additional per analysis
      
      // Free actions (navigation, organization)
      delete_page: 0,
      rename_page: 0,
      navigate_to_page: 0,
      organize_pages: 0,
      view_analytics: 0,
      
      // Low cost actions (simple edits, ~$0.004 Claude cost)
      edit_text: 1,
      change_color: 1,
      change_font: 1,
      adjust_padding: 1,
      add_simple_widget: 1,
      remove_widget: 0,
      duplicate_widget: 1,
      
      // Medium cost actions (component/page creation, ~$0.008-0.015 Claude cost)
      create_page: 5,
      create_simple_component: 3,
      create_complex_component: 8,
      setup_navigation: 5,
      create_form: 6,
      add_validation: 3,
      integrate_simple_api: 10,
      
      // High cost actions (complex operations, ~$0.021+ Claude cost)
      analyze_entire_app: 15,
      optimize_performance: 25,
      debug_complex_issue: 20,
      refactor_multiple_pages: 30,
      create_advanced_animation: 15,
      implement_complex_logic: 25,
      integrate_complex_api: 20,
      generate_full_feature: 50,
      
      // Premium actions (very high cost, Sonnet/Opus usage)
      complete_app_redesign: 100,
      migrate_app_architecture: 80,
      advanced_ai_analysis: 50,
      custom_code_generation: 60,
      
      // Image processing (additional cost per image)
      image_analysis: 5,
      image_optimization: 3,
      ui_from_image: 10,
    };
  }

  /**
   * Get subscription credit allocations (updated tiers)
   */
  getSubscriptionCredits(): Record<string, { monthly: number; rollover: boolean; maxRollover?: number }> {
    return {
      free: { 
        monthly: 100, 
        rollover: false 
      },
      creator: { 
        monthly: 1500, 
        rollover: true, 
        maxRollover: 750 
      },
      power: { 
        monthly: 5000, 
        rollover: true, 
        maxRollover: 2500 
      }
    };
  }

  /**
   * Check if user has enough credits for an operation
   */
  async checkCredits(userId: string, requiredCredits: number): Promise<boolean> {
    if (requiredCredits <= 0) return true;

    try {
      const availableCredits = await this.getUserAvailableCredits(userId);
      return availableCredits >= requiredCredits;
    } catch (error) {
      logger.error('Error checking user credits', { userId, requiredCredits, error });
      return false;
    }
  }

  /**
   * Get user's available credits
   */
  async getUserAvailableCredits(userId: string): Promise<number> {
    const { data, error } = await this.db.rpc('get_user_credits', { 
      p_user_id: userId 
    });

    if (error) {
      logger.error('Error getting user credits', { userId, error });
      throw error;
    }

    return data || 0;
  }

  /**
   * Get comprehensive user credit summary
   */
  async getUserCreditSummary(userId: string): Promise<UserCreditSummary> {
    const { data: subscription, error } = await this.db
      .from('user_subscriptions')
      .select(`
        available_credits,
        credits_used_this_period,
        credits_reset_date,
        tier,
        subscription_plans!inner (
          name,
          features
        )
      `)
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !subscription) {
      logger.warn('No active subscription found for user', { userId });
      // Return default free plan values
      return {
        availableCredits: 0,
        creditsUsedThisPeriod: 0,
        creditsResetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        subscriptionTier: 'free',
        monthlyAllocation: 100
      };
    }

    const creditAllocation = this.getSubscriptionCredits();
    const tierAllocation = creditAllocation[subscription.tier] || creditAllocation.free;

    return {
      availableCredits: subscription.available_credits || 0,
      creditsUsedThisPeriod: subscription.credits_used_this_period || 0,
      creditsResetDate: new Date(subscription.credits_reset_date),
      subscriptionTier: subscription.tier,
      monthlyAllocation: tierAllocation.monthly
    };
  }

  /**
   * Consume credits atomically
   */
  async consumeCredits(
    userId: string,
    amount: number,
    description?: string,
    aiActionId?: string
  ): Promise<boolean> {
    if (amount <= 0) return true;

    try {
      const { data: success, error } = await this.db.rpc('consume_user_credits', {
        p_user_id: userId,
        p_amount: amount,
        p_description: description,
        p_action_id: aiActionId
      });

      if (error) {
        logger.error('Error consuming credits', { userId, amount, error });
        throw error;
      }

      if (success) {
        logger.info('Credits consumed successfully', { 
          userId, 
          amount, 
          description 
        });
      } else {
        logger.warn('Failed to consume credits - insufficient balance', { 
          userId, 
          amount, 
          description 
        });
      }

      return success;
    } catch (error) {
      logger.error('Credit consumption error', { userId, amount, error });
      throw error;
    }
  }

  /**
   * Add credits to user account (for subscriptions, bonuses, refunds)
   */
  async addCredits(
    userId: string,
    amount: number,
    transactionType: 'subscription_renewal' | 'bonus_credits' | 'refund' | 'admin_adjustment',
    description?: string
  ): Promise<boolean> {
    if (amount <= 0) return false;

    try {
      // Update user subscription credits
      const { error: updateError } = await this.db
        .from('user_subscriptions')
        .update({
          available_credits: this.db.raw('available_credits + ?', [amount])
        })
        .eq('user_id', userId)
        .eq('status', 'active');

      if (updateError) {
        logger.error('Error updating user credits', { userId, amount, updateError });
        throw updateError;
      }

      // Log the transaction
      const { error: logError } = await this.db
        .from('credit_transactions')
        .insert({
          user_id: userId,
          amount: amount,
          transaction_type: transactionType,
          description: description || `Added ${amount} credits`
        });

      if (logError) {
        logger.error('Error logging credit transaction', { userId, amount, logError });
        // Don't throw here as the main operation succeeded
      }

      logger.info('Credits added successfully', { 
        userId, 
        amount, 
        transactionType,
        description 
      });

      return true;
    } catch (error) {
      logger.error('Credit addition error', { userId, amount, error });
      throw error;
    }
  }

  /**
   * Initialize user credits based on subscription
   */
  async initializeUserCredits(userId: string): Promise<void> {
    try {
      const { error } = await this.db.rpc('initialize_user_credits', {
        p_user_id: userId
      });

      if (error) {
        logger.error('Error initializing user credits', { userId, error });
        throw error;
      }

      logger.info('User credits initialized', { userId });
    } catch (error) {
      logger.error('Credit initialization error', { userId, error });
      throw error;
    }
  }

  /**
   * Get user's credit transaction history
   */
  async getCreditTransactions(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<CreditTransaction[]> {
    const { data, error } = await this.db
      .from('credit_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('Error fetching credit transactions', { userId, error });
      throw error;
    }

    return (data || []).map(transaction => ({
      id: transaction.id,
      userId: transaction.user_id,
      amount: transaction.amount,
      transactionType: transaction.transaction_type,
      description: transaction.description,
      aiActionId: transaction.ai_action_id,
      createdAt: new Date(transaction.created_at)
    }));
  }

  /**
   * Calculate smart credit cost based on complexity
   */
  calculateSmartCreditCost(
    actionType: string,
    complexityFactors: {
      appSize?: 'small' | 'medium' | 'large';
      componentComplexity?: 'simple' | 'moderate' | 'complex';
      integrationCount?: number;
      userTier?: 'free' | 'creator' | 'power';
    } = {}
  ): number {
    const baseCosts = this.getCreditCosts();
    const baseCost = baseCosts[actionType] || 1;

    if (baseCost === 0) return 0; // Free actions stay free

    let multiplier = 1.0;

    // App size factor
    if (complexityFactors.appSize === 'large') multiplier *= 1.3;
    else if (complexityFactors.appSize === 'medium') multiplier *= 1.1;

    // Component complexity factor
    if (complexityFactors.componentComplexity === 'complex') multiplier *= 1.4;
    else if (complexityFactors.componentComplexity === 'moderate') multiplier *= 1.2;

    // Integration complexity
    if (complexityFactors.integrationCount && complexityFactors.integrationCount > 5) {
      multiplier *= 1.2;
    }

    // User tier benefit (power users get slight discount)
    if (complexityFactors.userTier === 'power') multiplier *= 0.9;

    // Ensure reasonable bounds
    multiplier = Math.max(0.5, Math.min(3.0, multiplier));

    return Math.max(1, Math.round(baseCost * multiplier));
  }

  /**
   * Check if user needs credit renewal
   */
  async checkCreditRenewal(userId: string): Promise<boolean> {
    const { data: subscription } = await this.db
      .from('user_subscriptions')
      .select('credits_reset_date, tier')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (!subscription) return false;

    const now = new Date();
    const resetDate = new Date(subscription.credits_reset_date);

    if (now >= resetDate) {
      // Time for renewal
      await this.initializeUserCredits(userId);
      return true;
    }

    return false;
  }

  /**
   * Get credit usage analytics for user
   */
  async getCreditUsageAnalytics(
    userId: string,
    days: number = 30
  ): Promise<{
    totalUsed: number;
    averagePerDay: number;
    topActions: { actionType: string; count: number; creditsUsed: number }[];
    projectedMonthlyUsage: number;
  }> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Get credit transactions for the period
    const { data: transactions } = await this.db
      .from('credit_transactions')
      .select(`
        amount,
        description,
        ai_actions (
          action_type
        )
      `)
      .eq('user_id', userId)
      .eq('transaction_type', 'action_usage')
      .gte('created_at', since.toISOString());

    if (!transactions || transactions.length === 0) {
      return {
        totalUsed: 0,
        averagePerDay: 0,
        topActions: [],
        projectedMonthlyUsage: 0
      };
    }

    const totalUsed = Math.abs(transactions.reduce((sum, t) => sum + t.amount, 0));
    const averagePerDay = totalUsed / days;

    // Analyze action types
    const actionStats = new Map<string, { count: number; creditsUsed: number }>();
    
    transactions.forEach(transaction => {
      const actionType = transaction.ai_actions?.action_type || 'unknown';
      const existing = actionStats.get(actionType) || { count: 0, creditsUsed: 0 };
      existing.count += 1;
      existing.creditsUsed += Math.abs(transaction.amount);
      actionStats.set(actionType, existing);
    });

    const topActions = Array.from(actionStats.entries())
      .map(([actionType, stats]) => ({ actionType, ...stats }))
      .sort((a, b) => b.creditsUsed - a.creditsUsed)
      .slice(0, 10);

    const projectedMonthlyUsage = Math.round(averagePerDay * 30);

    return {
      totalUsed,
      averagePerDay: Math.round(averagePerDay * 10) / 10,
      topActions,
      projectedMonthlyUsage
    };
  }

  /**
   * Calculate planning costs based on complexity and analysis requirements
   */
  calculatePlanningCosts(stepCount: number, hasAnalysis: boolean = false, imageCount: number = 0): number {
    const costs = this.getCreditCosts();
    
    let baseCost = 0;
    if (stepCount <= 3) {
      baseCost = costs.plan_simple;
    } else if (stepCount <= 7) {
      baseCost = costs.plan_medium;
    } else {
      baseCost = costs.plan_complex;
    }
    
    let totalCost = baseCost;
    
    // Add analysis cost if plan includes analysis
    if (hasAnalysis) {
      totalCost += costs.plan_analysis;
    }
    
    // Add image processing costs
    if (imageCount > 0) {
      totalCost += (imageCount * costs.image_analysis);
    }
    
    return totalCost;
  }

  /**
   * Check if builds should be free for user's subscription tier
   */
  isBuildFree(subscriptionTier: string): boolean {
    return subscriptionTier === 'creator' || subscriptionTier === 'power';
  }

  /**
   * Get build pricing for free tier users
   */
  getBuildPricing(): Record<string, number> {
    return {
      apk: 2.99,
      aab: 4.99,
      source_code: 1.99,
      ipa: 6.99, // iOS builds are more expensive due to cloud infrastructure
    };
  }
}

export const creditService = new CreditService();