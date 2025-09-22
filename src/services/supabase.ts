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

  async upsertUserSubscription(subscriptionData: {
    userId: string;
    tier: string;
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    claudeUsageCount: number;
    claudeUsageLimit: number;
    screensLimit: number;
    appsLimit: number;
    stripeSubscriptionId?: string;
    stripePriceId?: string;
  }): Promise<UserSubscription> {
    try {
      const { data, error } = await this.serviceClient
        .from('user_subscriptions')
        .upsert({
          user_id: subscriptionData.userId,
          tier: subscriptionData.tier,
          status: subscriptionData.status,
          current_period_start: subscriptionData.currentPeriodStart,
          current_period_end: subscriptionData.currentPeriodEnd,
          claude_usage_count: subscriptionData.claudeUsageCount,
          claude_usage_limit: subscriptionData.claudeUsageLimit,
          screens_limit: subscriptionData.screensLimit,
          apps_limit: subscriptionData.appsLimit,
          stripe_subscription_id: subscriptionData.stripeSubscriptionId,
          stripe_price_id: subscriptionData.stripePriceId,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'user_id',
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error upserting user subscription:', error);
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
  async getStripeCustomer(userId: string): Promise<{stripe_customer_id: string} | null> {
    try {
      const { data, error } = await this.serviceClient
        .from('user_profiles')
        .select('stripe_customer_id')
        .eq('id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
      }

      // Return null if no stripe_customer_id is set
      if (!data?.stripe_customer_id) {
        return null;
      }

      return { stripe_customer_id: data.stripe_customer_id };
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
        .from('user_profiles')
        .update({
          stripe_customer_id: customerData.stripe_customer_id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', customerData.user_id);

      if (error) throw error;
    } catch (error) {
      logger.error('Error creating Stripe customer:', error);
      throw error;
    }
  }

  async getStripeProductById(productId: string): Promise<any | null> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('products')
        .select('*')
        .eq('id', productId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching Stripe product:', error);
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

  // File management operations
  async createFile(fileData: Omit<import('@/types').FileUpload, 'id' | 'created_at'>): Promise<import('@/types').FileUpload> {
    try {
      const { data, error } = await this.serviceClient
        .from('file_uploads')
        .insert({
          ...fileData,
          created_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating file record:', error);
      throw error;
    }
  }

  async getFileById(fileId: string): Promise<import('@/types').FileUpload | null> {
    try {
      const { data, error } = await this.serviceClient
        .from('file_uploads')
        .select('*')
        .eq('id', fileId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching file:', error);
      throw error;
    }
  }

  async getUserFiles(
    userId: string,
    appId?: string,
    fileType?: string,
    limit = 50,
    offset = 0
  ): Promise<import('@/types').FileUpload[]> {
    try {
      let query = this.serviceClient
        .from('file_uploads')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (appId) {
        query = query.eq('app_id', appId);
      }

      if (fileType) {
        query = query.eq('file_type', fileType);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching user files:', error);
      throw error;
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    try {
      const { error } = await this.serviceClient
        .from('file_uploads')
        .delete()
        .eq('id', fileId);

      if (error) throw error;
    } catch (error) {
      logger.error('Error deleting file record:', error);
      throw error;
    }
  }

  // Preview operations
  async createPreview(previewData: Omit<import('@/types').AppPreview, 'id' | 'created_at' | 'updated_at'>): Promise<import('@/types').AppPreview> {
    try {
      const { data, error } = await this.serviceClient
        .from('app_previews')
        .insert({
          ...previewData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating preview:', error);
      throw error;
    }
  }

  async getPreviewById(previewId: string): Promise<import('@/types').AppPreview | null> {
    try {
      const { data, error } = await this.serviceClient
        .from('app_previews')
        .select('*')
        .eq('id', previewId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching preview:', error);
      throw error;
    }
  }

  async getPreviewByShareToken(shareToken: string): Promise<import('@/types').AppPreview | null> {
    try {
      const { data, error } = await this.serviceClient
        .from('app_previews')
        .select('*')
        .eq('share_token', shareToken)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching preview by share token:', error);
      throw error;
    }
  }

  async getAppPreviews(appId: string, limit = 10): Promise<import('@/types').AppPreview[]> {
    try {
      const { data, error } = await this.serviceClient
        .from('app_previews')
        .select('*')
        .eq('app_id', appId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching app previews:', error);
      throw error;
    }
  }

  async updatePreview(previewId: string, updates: Partial<import('@/types').AppPreview>): Promise<import('@/types').AppPreview> {
    try {
      const { data, error } = await this.serviceClient
        .from('app_previews')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('id', previewId)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating preview:', error);
      throw error;
    }
  }

  async deletePreview(previewId: string): Promise<void> {
    try {
      const { error } = await this.serviceClient
        .from('app_previews')
        .delete()
        .eq('id', previewId);

      if (error) throw error;
    } catch (error) {
      logger.error('Error deleting preview:', error);
      throw error;
    }
  }

  async incrementPreviewViews(previewId: string): Promise<void> {
    try {
      const { error } = await this.serviceClient
        .rpc('increment_preview_views', { preview_uuid: previewId });

      if (error) throw error;
    } catch (error) {
      logger.error('Error incrementing preview views:', error);
      // Don't throw error for view count increment failures
    }
  }

  // Push notification operations
  async createPushToken(tokenData: Omit<import('@/types').PushToken, 'id' | 'created_at' | 'updated_at'>): Promise<import('@/types').PushToken> {
    try {
      const { data, error } = await this.serviceClient
        .from('push_tokens')
        .insert({
          ...tokenData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating push token:', error);
      throw error;
    }
  }

  async getUserPushTokens(userId: string): Promise<import('@/types').PushToken[]> {
    try {
      const { data, error } = await this.serviceClient
        .from('push_tokens')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching user push tokens:', error);
      throw error;
    }
  }

  async deactivatePushTokens(userId: string, deviceId?: string): Promise<void> {
    try {
      let query = this.serviceClient
        .from('push_tokens')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('user_id', userId);

      if (deviceId) {
        query = query.eq('device_id', deviceId);
      }

      const { error } = await query;
      if (error) throw error;
    } catch (error) {
      logger.error('Error deactivating push tokens:', error);
      throw error;
    }
  }

  async deactivateAllPushTokens(userId: string): Promise<void> {
    return this.deactivatePushTokens(userId);
  }

  async deactivatePushToken(tokenId: string): Promise<void> {
    try {
      const { error } = await this.serviceClient
        .from('push_tokens')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', tokenId);

      if (error) throw error;
    } catch (error) {
      logger.error('Error deactivating push token:', error);
      throw error;
    }
  }

  async createPushNotification(notificationData: Omit<import('@/types').PushNotification, 'id' | 'created_at'>): Promise<import('@/types').PushNotification> {
    try {
      const { data, error } = await this.serviceClient
        .from('push_notifications')
        .insert({
          ...notificationData,
          created_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating push notification:', error);
      throw error;
    }
  }

  async updatePushNotification(notificationId: string, updates: Partial<import('@/types').PushNotification>): Promise<void> {
    try {
      const { error } = await this.serviceClient
        .from('push_notifications')
        .update(updates)
        .eq('id', notificationId);

      if (error) throw error;
    } catch (error) {
      logger.error('Error updating push notification:', error);
      throw error;
    }
  }

  async getUserPushNotifications(userId: string, limit = 50, offset = 0): Promise<import('@/types').PushNotification[]> {
    try {
      const { data, error } = await this.serviceClient
        .from('push_notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching user push notifications:', error);
      throw error;
    }
  }

  async getScheduledNotifications(): Promise<import('@/types').PushNotification[]> {
    try {
      const { data, error } = await this.serviceClient
        .from('push_notifications')
        .select('*')
        .eq('status', 'pending')
        .not('scheduled_at', 'is', null)
        .lte('scheduled_at', new Date().toISOString());

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching scheduled notifications:', error);
      throw error;
    }
  }

  // =============================================================================
  // STRIPE WRAPPER METHODS - Fast access to Stripe data via existing wrapper
  // =============================================================================

  /**
   * Get Stripe customer by email using stripe schema (10x faster than API)
   */
  async getStripeCustomerByEmail(email: string): Promise<any | null> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('customers')
        .select('*')
        .eq('email', email)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        logger.error('Error fetching Stripe customer by email:', error);
        return null;
      }

      return data;
    } catch (error) {
      logger.error('Error in getStripeCustomerByEmail:', error);
      return null;
    }
  }

  /**
   * Get Stripe customer by ID using stripe schema
   */
  async getStripeCustomerById(customerId: string): Promise<any | null> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('customers')
        .select('*')
        .eq('id', customerId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        logger.error('Error fetching Stripe customer by ID:', error);
        return null;
      }

      return data;
    } catch (error) {
      logger.error('Error in getStripeCustomerById:', error);
      return null;
    }
  }

  /**
   * Get active Stripe subscription for customer using stripe schema
   */
  async getActiveStripeSubscription(customerId: string): Promise<any | null> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('subscriptions')
        .select('*')
        .eq('customer_id', customerId)
        .in('status', ['active', 'trialing'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        logger.error('Error fetching active Stripe subscription:', error);
        return null;
      }

      return data;
    } catch (error) {
      logger.error('Error in getActiveStripeSubscription:', error);
      return null;
    }
  }

  /**
   * Get Stripe subscription by ID using stripe schema
   */
  async getStripeSubscriptionById(subscriptionId: string): Promise<any | null> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('subscriptions')
        .select('*')
        .eq('id', subscriptionId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        logger.error('Error fetching Stripe subscription by ID:', error);
        return null;
      }

      return data;
    } catch (error) {
      logger.error('Error in getStripeSubscriptionById:', error);
      return null;
    }
  }

  /**
   * Get Stripe payment intent by ID using stripe schema
   */
  async getStripePaymentIntent(paymentIntentId: string): Promise<any | null> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('payment_intents')
        .select('*')
        .eq('id', paymentIntentId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        logger.error('Error fetching Stripe payment intent:', error);
        return null;
      }

      return data;
    } catch (error) {
      logger.error('Error in getStripePaymentIntent:', error);
      return null;
    }
  }

  /**
   * Get recent Stripe payments using stripe schema
   */
  async getRecentStripePayments(limit: number = 50): Promise<any[]> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('payment_intents')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('Error fetching recent Stripe payments:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('Error in getRecentStripePayments:', error);
      return [];
    }
  }

  /**
   * Get Stripe invoices for customer using stripe schema
   */
  async getStripeInvoicesForCustomer(customerId: string, limit: number = 10): Promise<any[]> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('invoices')
        .select('*')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('Error fetching Stripe invoices:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('Error in getStripeInvoicesForCustomer:', error);
      return [];
    }
  }

  /**
   * Get Stripe products using stripe schema
   */
  async getStripeProducts(): Promise<any[]> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('products')
        .select('*')
        .eq('active', true);

      if (error) {
        logger.error('Error fetching Stripe products:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('Error in getStripeProducts:', error);
      return [];
    }
  }

  /**
   * Get Stripe prices for product using stripe schema
   */
  async getStripePricesForProduct(productId: string): Promise<any[]> {
    try {
      const { data, error } = await this.serviceClient
        .schema('stripe')
        .from('prices')
        .select('*')
        .eq('product_id', productId)
        .eq('active', true);

      if (error) {
        logger.error('Error fetching Stripe prices:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('Error in getStripePricesForProduct:', error);
      return [];
    }
  }

  // Getter for storage client (for file service)
  get storage() {
    return this.serviceClient.storage;
  }
}

export const supabase = new SupabaseService();