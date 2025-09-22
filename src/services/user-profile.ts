import { createClient } from '@supabase/supabase-js';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';

const supabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey
);

export interface UserProfile {
  id: string;
  email: string;
  name?: string;
  full_name?: string;
  display_email?: string;
  email_verified: boolean;
  email_confirmed?: boolean; // Legacy field
  email_confirmed_at?: string;
  image?: string;
  created_at: string;
  updated_at: string;
  last_login_at?: string;
  last_activity?: string;
  deleted_at?: string;
  credits: number;
  subscription_status: 'free' | 'active' | 'canceled' | 'past_due';
  subscription_type: 'free' | 'creator' | 'power';
  subscription_ends_at?: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
}

export interface UpdateUserProfileRequest {
  name?: string;
  full_name?: string;
  image?: string;
  display_email?: string;
}

export interface CreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  type: 'earned' | 'spent' | 'purchased' | 'refunded';
  description: string;
  created_at: string;
}

export class UserProfileService {
  /**
   * Get user profile by ID
   */
  async getUserProfile(userId: string): Promise<UserProfile | null> {
    try {
      const { data, error } = await supabaseClient
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
      logger.error('Error fetching user profile:', error);
      return null;
    }
  }

  /**
   * Get user profile by email
   */
  async getUserProfileByEmail(email: string): Promise<UserProfile | null> {
    try {
      const { data, error } = await supabaseClient
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
      logger.error('Error fetching user profile by email:', error);
      return null;
    }
  }

  /**
   * Update user profile
   */
  async updateUserProfile(userId: string, updates: UpdateUserProfileRequest): Promise<UserProfile> {
    try {
      const updateData: any = {
        ...updates,
        updated_at: new Date().toISOString(),
      };

      // Handle name/full_name compatibility
      if (updates.name && !updates.full_name) {
        updateData.full_name = updates.name;
      } else if (updates.full_name && !updates.name) {
        updateData.name = updates.full_name;
      }

      const { data, error } = await supabaseClient
        .from('user_profiles')
        .update(updateData)
        .eq('id', userId)
        .select('*')
        .single();

      if (error) {
        logger.error('Error updating user profile:', error);
        throw error;
      }

      logger.info(`User profile updated for user: ${userId}`);
      return data;
    } catch (error) {
      logger.error('Error updating user profile:', error);
      throw error;
    }
  }

  /**
   * Update user subscription
   */
  async updateSubscription(
    userId: string,
    subscriptionData: {
      status: UserProfile['subscription_status'];
      type: UserProfile['subscription_type'];
      ends_at?: string;
      stripe_customer_id?: string;
      stripe_subscription_id?: string;
    }
  ): Promise<UserProfile> {
    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .update({
          subscription_status: subscriptionData.status,
          subscription_type: subscriptionData.type,
          subscription_ends_at: subscriptionData.ends_at,
          stripe_customer_id: subscriptionData.stripe_customer_id,
          stripe_subscription_id: subscriptionData.stripe_subscription_id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
        .select('*')
        .single();

      if (error) {
        logger.error('Error updating user subscription:', error);
        throw error;
      }

      logger.info(`Subscription updated for user: ${userId}`, subscriptionData);
      return data;
    } catch (error) {
      logger.error('Error updating user subscription:', error);
      throw error;
    }
  }

  /**
   * Add credits to user account
   */
  async addCredits(
    userId: string,
    amount: number,
    description: string,
    type: CreditTransaction['type'] = 'purchased'
  ): Promise<UserProfile> {
    try {
      // Start a transaction
      const { data: profile, error: fetchError } = await supabaseClient
        .from('user_profiles')
        .select('*')
        .eq('id', userId)
        .is('deleted_at', null)
        .single();

      if (fetchError) {
        logger.error('Error fetching user profile for credit update:', fetchError);
        throw fetchError;
      }

      const newCredits = profile.credits + amount;

      // Update user credits
      const { data: updatedProfile, error: updateError } = await supabaseClient
        .from('user_profiles')
        .update({
          credits: newCredits,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
        .select('*')
        .single();

      if (updateError) {
        logger.error('Error updating user credits:', updateError);
        throw updateError;
      }

      // Record credit transaction
      const { error: transactionError } = await supabaseClient
        .from('credit_transactions')
        .insert({
          user_id: userId,
          amount: amount,
          type: type,
          description: description,
          created_at: new Date().toISOString(),
        });

      if (transactionError) {
        logger.error('Error recording credit transaction:', transactionError);
        // Don't throw here - the credit update was successful
      }

      logger.info(`Credits added to user: ${userId}`, { amount, description, newCredits });
      return updatedProfile;
    } catch (error) {
      logger.error('Error adding credits:', error);
      throw error;
    }
  }

  /**
   * Deduct credits from user account
   */
  async deductCredits(
    userId: string,
    amount: number,
    description: string,
    type: CreditTransaction['type'] = 'spent'
  ): Promise<UserProfile> {
    try {
      // Check if user has enough credits
      const { data: profile, error: fetchError } = await supabaseClient
        .from('user_profiles')
        .select('*')
        .eq('id', userId)
        .is('deleted_at', null)
        .single();

      if (fetchError) {
        logger.error('Error fetching user profile for credit deduction:', fetchError);
        throw fetchError;
      }

      if (profile.credits < amount) {
        throw new Error(`Insufficient credits. Required: ${amount}, Available: ${profile.credits}`);
      }

      const newCredits = profile.credits - amount;

      // Update user credits
      const { data: updatedProfile, error: updateError } = await supabaseClient
        .from('user_profiles')
        .update({
          credits: newCredits,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
        .select('*')
        .single();

      if (updateError) {
        logger.error('Error updating user credits:', updateError);
        throw updateError;
      }

      // Record credit transaction
      const { error: transactionError } = await supabaseClient
        .from('credit_transactions')
        .insert({
          user_id: userId,
          amount: -amount, // Negative for deduction
          type: type,
          description: description,
          created_at: new Date().toISOString(),
        });

      if (transactionError) {
        logger.error('Error recording credit transaction:', transactionError);
        // Don't throw here - the credit update was successful
      }

      logger.info(`Credits deducted from user: ${userId}`, { amount, description, newCredits });
      return updatedProfile;
    } catch (error) {
      logger.error('Error deducting credits:', error);
      throw error;
    }
  }

  /**
   * Get user credit transactions
   */
  async getCreditTransactions(userId: string, limit: number = 50): Promise<CreditTransaction[]> {
    try {
      const { data, error } = await supabaseClient
        .from('credit_transactions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('Error fetching credit transactions:', error);
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('Error fetching credit transactions:', error);
      throw error;
    }
  }

  /**
   * Deactivate user account (soft delete)
   */
  async deactivateUser(userId: string): Promise<void> {
    try {
      const { error } = await supabaseClient
        .from('user_profiles')
        .update({
          deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId);

      if (error) {
        logger.error('Error deactivating user:', error);
        throw error;
      }

      logger.info(`User deactivated: ${userId}`);
    } catch (error) {
      logger.error('Error deactivating user:', error);
      throw error;
    }
  }

  /**
   * Reactivate user account
   */
  async reactivateUser(userId: string): Promise<UserProfile> {
    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .update({
          deleted_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
        .select('*')
        .single();

      if (error) {
        logger.error('Error reactivating user:', error);
        throw error;
      }

      logger.info(`User reactivated: ${userId}`);
      return data;
    } catch (error) {
      logger.error('Error reactivating user:', error);
      throw error;
    }
  }

  /**
   * Update last activity timestamp
   */
  async updateLastActivity(userId: string): Promise<void> {
    try {
      const { error } = await supabaseClient
        .from('user_profiles')
        .update({
          last_activity: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId);

      if (error) {
        logger.error('Error updating last activity:', error);
        // Don't throw for activity updates
      }
    } catch (error) {
      logger.error('Error updating last activity:', error);
      // Don't throw for activity updates
    }
  }

  /**
   * Check if user has active subscription
   */
  async hasActiveSubscription(userId: string): Promise<boolean> {
    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .select('subscription_status, subscription_ends_at')
        .eq('id', userId)
        .is('deleted_at', null)
        .single();

      if (error) {
        logger.error('Error checking subscription status:', error);
        return false;
      }

      if (data.subscription_status !== 'active') {
        return false;
      }

      if (data.subscription_ends_at) {
        return new Date(data.subscription_ends_at) > new Date();
      }

      return true;
    } catch (error) {
      logger.error('Error checking subscription status:', error);
      return false;
    }
  }

  /**
   * Get user subscription tier
   */
  async getSubscriptionTier(userId: string): Promise<'free' | 'creator' | 'power'> {
    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .select('subscription_type, subscription_status, subscription_ends_at')
        .eq('id', userId)
        .is('deleted_at', null)
        .single();

      if (error) {
        logger.error('Error getting subscription tier:', error);
        return 'free';
      }

      if (data.subscription_status !== 'active') {
        return 'free';
      }

      if (data.subscription_ends_at && new Date(data.subscription_ends_at) <= new Date()) {
        return 'free';
      }

      return data.subscription_type || 'free';
    } catch (error) {
      logger.error('Error getting subscription tier:', error);
      return 'free';
    }
  }
}

export const userProfileService = new UserProfileService();