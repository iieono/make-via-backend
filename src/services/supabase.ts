import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import type { User, UserSubscription, App, Screen } from '@/types';

class SupabaseService {
  private client: SupabaseClient;
  private serviceClient: SupabaseClient;

  constructor() {
    // Client with anon key (for public operations)
    this.client = createClient(
      config.supabase.url,
      config.supabase.anonKey
    );

    // Service client with elevated permissions
    this.serviceClient = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey
    );
  }

  // User operations
  async getUserById(userId: string): Promise<User | null> {
    try {
      const { data, error } = await this.serviceClient
        .from('user_profiles')
        .select('*')
        .eq('id', userId)
        .is('deleted_at', null)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching user:', error);
      throw error;
    }
  }

  async getUserByEmail(email: string): Promise<User | null> {
    try {
      const { data, error } = await this.serviceClient
        .from('user_profiles')
        .select('*')
        .eq('email', email)
        .is('deleted_at', null)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching user by email:', error);
      throw error;
    }
  }

  async updateUser(userId: string, updates: Partial<User>): Promise<User> {
    try {
      const { data, error } = await this.serviceClient
        .from('user_profiles')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating user:', error);
      throw error;
    }
  }

  // Subscription operations
  async getUserSubscription(userId: string): Promise<UserSubscription | null> {
    try {
      const { data, error } = await this.serviceClient
        .from('user_subscriptions')
        .select('*')
        .eq('user_id', userId)
        .gte('current_period_end', new Date().toISOString().split('T')[0])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching user subscription:', error);
      throw error;
    }
  }

  async updateUserSubscription(
    userId: string,
    updates: Partial<UserSubscription>
  ): Promise<UserSubscription> {
    try {
      const { data, error } = await this.serviceClient
        .from('user_subscriptions')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .gte('current_period_end', new Date().toISOString().split('T')[0])
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating user subscription:', error);
      throw error;
    }
  }

  async incrementClaudeUsage(userId: string): Promise<boolean> {
    try {
      const { data, error } = await this.serviceClient
        .rpc('increment_claude_usage', { user_uuid: userId });

      if (error) throw error;
      return data; // Returns true if successful, false if limit exceeded
    } catch (error) {
      logger.error('Error incrementing Claude usage:', error);
      throw error;
    }
  }

  // App operations
  async getUserApps(userId: string, limit = 50, offset = 0): Promise<App[]> {
    try {
      const { data, error } = await this.serviceClient
        .from('apps')
        .select('*')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching user apps:', error);
      throw error;
    }
  }

  async getAppById(appId: string, userId?: string): Promise<App | null> {
    try {
      let query = this.serviceClient
        .from('apps')
        .select('*')
        .eq('id', appId)
        .is('deleted_at', null);

      if (userId) {
        query = query.eq('user_id', userId);
      }

      const { data, error } = await query.single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching app:', error);
      throw error;
    }
  }

  async createApp(appData: Omit<App, 'id' | 'created_at' | 'updated_at'>): Promise<App> {
    try {
      const { data, error } = await this.serviceClient
        .from('apps')
        .insert({
          ...appData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating app:', error);
      throw error;
    }
  }

  async updateApp(appId: string, updates: Partial<App>): Promise<App> {
    try {
      const { data, error } = await this.serviceClient
        .from('apps')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('id', appId)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating app:', error);
      throw error;
    }
  }

  // Screen operations
  async getAppScreens(appId: string): Promise<Screen[]> {
    try {
      const { data, error } = await this.serviceClient
        .from('screens')
        .select('*')
        .eq('app_id', appId)
        .is('deleted_at', null)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching app screens:', error);
      throw error;
    }
  }

  async getScreenById(screenId: string): Promise<Screen | null> {
    try {
      const { data, error } = await this.serviceClient
        .from('screens')
        .select('*')
        .eq('id', screenId)
        .is('deleted_at', null)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching screen:', error);
      throw error;
    }
  }

  async createScreen(screenData: Omit<Screen, 'id' | 'created_at' | 'updated_at'>): Promise<Screen> {
    try {
      const { data, error } = await this.serviceClient
        .from('screens')
        .insert({
          ...screenData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating screen:', error);
      throw error;
    }
  }

  async updateScreen(screenId: string, updates: Partial<Screen>): Promise<Screen> {
    try {
      const { data, error } = await this.serviceClient
        .from('screens')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('id', screenId)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating screen:', error);
      throw error;
    }
  }

  // AI generation logging
  async logAIGeneration(logData: {
    user_id: string;
    app_id?: string;
    screen_id?: string;
    prompt_text: string;
    model_used: string;
    response_text?: string;
    tokens_used: number;
    processing_time_ms?: number;
    status: 'pending' | 'success' | 'failed' | 'timeout';
    error_message?: string;
    cost_usd: number;
  }): Promise<void> {
    try {
      const { error } = await this.serviceClient
        .from('ai_generation_logs')
        .insert({
          ...logData,
          created_at: new Date().toISOString(),
        });

      if (error) throw error;
    } catch (error) {
      logger.error('Error logging AI generation:', error);
      throw error;
    }
  }

  // Stripe integration
  async getStripeCustomer(userId: string): Promise<any | null> {
    try {
      const { data, error } = await this.serviceClient
        .from('stripe_customers')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching Stripe customer:', error);
      throw error;
    }
  }

  async createStripeCustomer(customerData: {
    user_id: string;
    stripe_customer_id: string;
    email: string;
    name?: string;
  }): Promise<void> {
    try {
      const { error } = await this.serviceClient
        .from('stripe_customers')
        .insert({
          ...customerData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (error) throw error;
    } catch (error) {
      logger.error('Error creating Stripe customer:', error);
      throw error;
    }
  }

  async handleStripeSubscriptionChange(
    stripeSubscriptionId: string,
    status: string,
    currentPeriodStart: string,
    currentPeriodEnd: string,
    tier: 'free' | 'pro' | 'power',
    cancelAtPeriodEnd = false
  ): Promise<void> {
    try {
      const { error } = await this.serviceClient
        .rpc('handle_stripe_subscription_change', {
          p_stripe_subscription_id: stripeSubscriptionId,
          p_status: status,
          p_current_period_start: currentPeriodStart,
          p_current_period_end: currentPeriodEnd,
          p_tier: tier,
          p_cancel_at_period_end: cancelAtPeriodEnd,
        });

      if (error) throw error;
    } catch (error) {
      logger.error('Error handling Stripe subscription change:', error);
      throw error;
    }
  }
}

export const supabase = new SupabaseService();