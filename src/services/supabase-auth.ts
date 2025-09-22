import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';

export interface AuthUser {
  id: string;
  email: string;
  email_verified: boolean;
  created_at: string;
  last_sign_in_at?: string;
  user_metadata: Record<string, any>;
  app_metadata: Record<string, any>;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user: AuthUser;
}

export class SupabaseAuthService {
  private supabase: SupabaseClient;

  constructor() {
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }

  /**
   * Verify JWT token and return user information
   */
  async verifyToken(token: string): Promise<AuthUser | null> {
    try {
      const { data: { user }, error } = await this.supabase.auth.getUser(token);
      
      if (error) {
        logger.error('Token verification error:', error);
        return null;
      }

      if (!user) {
        return null;
      }

      return {
        id: user.id,
        email: user.email || '',
        email_verified: user.email_confirmed_at !== null,
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at,
        user_metadata: user.user_metadata || {},
        app_metadata: user.app_metadata || {},
      };
    } catch (error) {
      logger.error('Token verification error:', error);
      return null;
    }
  }

  /**
   * Sign up a new user
   */
  async signUp(email: string, password: string, metadata?: Record<string, any>): Promise<AuthSession | null> {
    try {
      const { data, error } = await this.supabase.auth.signUp({
        email,
        password,
        options: {
          data: metadata,
        },
      });

      if (error) {
        logger.error('Sign up error:', error);
        return null;
      }

      if (!data.user || !data.session) {
        return null;
      }

      return {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        token_type: data.session.token_type,
        user: {
          id: data.user.id,
          email: data.user.email || '',
          email_verified: data.user.email_confirmed_at !== null,
          created_at: data.user.created_at,
          last_sign_in_at: data.user.last_sign_in_at,
          user_metadata: data.user.user_metadata || {},
          app_metadata: data.user.app_metadata || {},
        },
      };
    } catch (error) {
      logger.error('Sign up error:', error);
      return null;
    }
  }

  /**
   * Sign in user with email and password
   */
  async signIn(email: string, password: string): Promise<AuthSession | null> {
    try {
      const { data, error } = await this.supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        logger.error('Sign in error:', error);
        return null;
      }

      if (!data.user || !data.session) {
        return null;
      }

      return {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        token_type: data.session.token_type,
        user: {
          id: data.user.id,
          email: data.user.email || '',
          email_verified: data.user.email_confirmed_at !== null,
          created_at: data.user.created_at,
          last_sign_in_at: data.user.last_sign_in_at,
          user_metadata: data.user.user_metadata || {},
          app_metadata: data.user.app_metadata || {},
        },
      };
    } catch (error) {
      logger.error('Sign in error:', error);
      return null;
    }
  }

  /**
   * Sign out user
   */
  async signOut(token: string): Promise<boolean> {
    try {
      const { error } = await this.supabase.auth.admin.signOut(token);
      
      if (error) {
        logger.error('Sign out error:', error);
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Sign out error:', error);
      return false;
    }
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<AuthSession | null> {
    try {
      const { data, error } = await this.supabase.auth.refreshSession({
        refresh_token: refreshToken,
      });

      if (error) {
        logger.error('Token refresh error:', error);
        return null;
      }

      if (!data.user || !data.session) {
        return null;
      }

      return {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        token_type: data.session.token_type,
        user: {
          id: data.user.id,
          email: data.user.email || '',
          email_verified: data.user.email_confirmed_at !== null,
          created_at: data.user.created_at,
          last_sign_in_at: data.user.last_sign_in_at,
          user_metadata: data.user.user_metadata || {},
          app_metadata: data.user.app_metadata || {},
        },
      };
    } catch (error) {
      logger.error('Token refresh error:', error);
      return null;
    }
  }

  /**
   * Reset password
   */
  async resetPassword(email: string): Promise<boolean> {
    try {
      const { error } = await this.supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${config.frontend.url}/reset-password`,
      });

      if (error) {
        logger.error('Password reset error:', error);
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Password reset error:', error);
      return false;
    }
  }

  /**
   * Update user password
   */
  async updatePassword(token: string, newPassword: string): Promise<boolean> {
    try {
      const { error } = await this.supabase.auth.admin.updateUserById(
        token,
        { password: newPassword }
      );

      if (error) {
        logger.error('Password update error:', error);
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Password update error:', error);
      return false;
    }
  }

  /**
   * Update user metadata
   */
  async updateUserMetadata(token: string, metadata: Record<string, any>): Promise<AuthUser | null> {
    try {
      const { data, error } = await this.supabase.auth.admin.updateUserById(
        token,
        { user_metadata: metadata }
      );

      if (error) {
        logger.error('User metadata update error:', error);
        return null;
      }

      if (!data.user) {
        return null;
      }

      return {
        id: data.user.id,
        email: data.user.email || '',
        email_verified: data.user.email_confirmed_at !== null,
        created_at: data.user.created_at,
        last_sign_in_at: data.user.last_sign_in_at,
        user_metadata: data.user.user_metadata || {},
        app_metadata: data.user.app_metadata || {},
      };
    } catch (error) {
      logger.error('User metadata update error:', error);
      return null;
    }
  }

  /**
   * Get user by ID
   */
  async getUserById(userId: string): Promise<AuthUser | null> {
    try {
      const { data: { user }, error } = await this.supabase.auth.admin.getUserById(userId);

      if (error) {
        logger.error('Get user error:', error);
        return null;
      }

      if (!user) {
        return null;
      }

      return {
        id: user.id,
        email: user.email || '',
        email_verified: user.email_confirmed_at !== null,
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at,
        user_metadata: user.user_metadata || {},
        app_metadata: user.app_metadata || {},
      };
    } catch (error) {
      logger.error('Get user error:', error);
      return null;
    }
  }
}

export const supabaseAuthService = new SupabaseAuthService();