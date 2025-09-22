import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import type { User } from '@/types';

const supabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey
);

export interface RegisterRequest {
  email: string;
  password: string;
  fullName: string;
  deviceInfo?: any;
}

export interface LoginRequest {
  email: string;
  password: string;
  deviceInfo?: any;
}

export interface AuthResponse {
  user: User;
  session: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    expires_in: number;
    token_type: string;
  };
  needsVerification?: boolean;
}

export class AuthService {
  /**
   * Register a new user
   */
  async register(request: RegisterRequest): Promise<AuthResponse> {
    try {
      const { email, password, fullName, deviceInfo } = request;

      // Validate input
      if (!email || !password || !fullName) {
        throw new Error('Email, password, and full name are required');
      }

      if (!this.isValidEmail(email)) {
        throw new Error('Invalid email format');
      }

      if (password.length < 6) {
        throw new Error('Password must be at least 6 characters long');
      }

      // Check if user already exists (including deleted users)
      const existingUserIncludingDeleted = await this.getUserByEmailIncludingDeleted(email);
      if (existingUserIncludingDeleted) {
        if (existingUserIncludingDeleted.deleted_at) {
          // User exists but is deleted
          throw new Error('ACCOUNT_DELETED');
        }
        
        if (existingUserIncludingDeleted.email_confirmed) {
          throw new Error('User with this email already exists');
        } else {
          // User exists but email not confirmed - resend verification
          await this.sendVerificationEmail(email);
          return {
            user: existingUserIncludingDeleted,
            session: null!,
            needsVerification: true,
          };
        }
      }

      // Create user in Supabase Auth
      const { data: authData, error: authError } = await supabaseClient.auth.admin.createUser({
        email: email,
        password,
        email_confirm: false, // We'll handle verification manually
        user_metadata: {
          full_name: fullName,
        },
      });

      if (authError || !authData.user) {
        logger.error('Failed to create user in Supabase Auth:', authError);
        throw new Error('Failed to create user account');
      }

      // Log the UUID being used
      logger.info(`Creating profile for user ID: ${authData.user.id}, email: ${email}`);

      // This should not happen if getUserByEmail works correctly
      // But if it does, it means we have orphaned data - clean it up
      const { data: existingProfile } = await supabaseClient
        .from('user_profiles')
        .select('id, email, deleted_at')
        .eq('id', authData.user.id)
        .maybeSingle();

      if (existingProfile) {
        logger.error(`CRITICAL: Found orphaned profile with same UUID: ${existingProfile.id}`);
        // Clean up both the new auth user and existing profile
        await supabaseClient.auth.admin.deleteUser(authData.user.id);
        await supabaseClient.from('user_profiles').delete().eq('id', existingProfile.id);
        throw new Error('Database inconsistency detected. Please try again.');
      }

      // Create user profile
      const { data: userData, error: profileError } = await supabaseClient
        .from('user_profiles')
        .insert({
          id: authData.user.id,
          email: authData.user.email || email, // Use Supabase's normalized email
          display_email: email, // Store original email for display
          full_name: fullName,
          email_confirmed: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (profileError || !userData) {
        logger.error('Failed to create user profile:', {
          error: profileError,
          userId: authData.user.id,
          email: email
        });
        // Clean up auth user if profile creation fails
        try {
          await supabaseClient.auth.admin.deleteUser(authData.user.id);
          logger.info(`Cleaned up auth user after profile creation failure: ${email}`);
        } catch (cleanupError) {
          logger.error('Failed to cleanup auth user:', cleanupError);
        }
        throw new Error('Failed to create user profile');
      }

      // Send verification email
      await this.sendVerificationEmail(email);

      // Handle auto-confirmed users (if enabled in Supabase)
      let session: any = null;
      if (authData.user.email_confirmed_at) {
        // Update profile to reflect confirmation
        await supabaseClient
          .from('user_profiles')
          .update({
            email_confirmed: true,
            email_confirmed_at: authData.user.email_confirmed_at,
            last_activity: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', authData.user.id);

        // Create Supabase session via signInWithPassword
        const { data: signInData, error: signInError } = await supabaseClient.auth.signInWithPassword({
          email: email,
          password,
        });

        if (!signInError && signInData.session) {
          session = {
            access_token: signInData.session.access_token,
            refresh_token: signInData.session.refresh_token,
            expires_at: signInData.session.expires_at || Date.now() + 3600000,
            expires_in: signInData.session.expires_in || 3600,
            token_type: signInData.session.token_type || 'bearer',
          };
        }

        userData.email_confirmed = true;
        userData.email_confirmed_at = authData.user.email_confirmed_at;
      }

      logger.info(`User registered successfully: ${email}`);

      return {
        user: userData,
        session: session!,
        needsVerification: !authData.user.email_confirmed_at,
      };
    } catch (error) {
      logger.error('Registration error:', error);
      throw error;
    }
  }

  /**
   * Login a user
   */
  async login(request: LoginRequest): Promise<AuthResponse> {
    try {
      const { email, password, deviceInfo } = request;

      // Validate input
      if (!email || !password) {
        throw new Error('Email and password are required');
      }

      // First, check if user exists (including deleted users)
      const existingUserIncludingDeleted = await this.getUserByEmailIncludingDeleted(email.toLowerCase());
      
      if (!existingUserIncludingDeleted) {
        // User doesn't exist at all
        logger.warn(`Login attempt with non-existent email: ${email}`);
        throw new Error('Invalid email or password');
      }
      
      if (existingUserIncludingDeleted.deleted_at) {
        // User exists but is deleted
        logger.warn(`Login attempt with deleted account: ${email}`);
        throw new Error('ACCOUNT_DELETED');
      }
      
      const existingUser = existingUserIncludingDeleted;

      // User exists, now try to sign in to verify password
      const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
        email: email.toLowerCase(),
        password,
      });

      // If sign in failed, check why
      if (authError || !authData.user) {
        logger.info(`Sign in failed for ${email}. Auth error: ${authError?.message}`);
        
        // Check the specific error from Supabase
        if (authError?.message?.includes('email_not_confirmed') || 
            authError?.message?.includes('Email not confirmed')) {
          // Supabase specifically says email not confirmed
          logger.info(`Supabase confirms email not verified for: ${email}`);
          // Don't automatically resend verification email to avoid rate limits
          throw new Error('EMAIL_NOT_VERIFIED');
        } else if (!existingUser.email_confirmed && 
                   (authError?.message?.includes('Invalid login credentials') || 
                    authError?.message?.includes('invalid_credentials'))) {
          // User exists, email unverified, and Supabase says invalid credentials
          // This could be either wrong password OR email not verified
          // Be conservative and assume wrong password unless we have clear evidence
          logger.warn(`Ambiguous login failure for unverified user: ${email}`);
          throw new Error('Invalid email or password');
        } else {
          // Other sign in failure - wrong password or other issue
          logger.warn(`Failed login attempt for: ${email}`);
          throw new Error('Invalid email or password');
        }
      }

      // Sign in successful, sync email verification status from Supabase auth to our profile
      const isEmailVerified = !!authData.user.email_confirmed_at;
      
      if (!isEmailVerified) {
        logger.info(`Login successful but email not verified: ${email}`);
        // Don't automatically resend verification email to avoid rate limits
        throw new Error('EMAIL_NOT_VERIFIED');
      }

      // Get user profile
      let userData = await this.getUserById(authData.user.id);
      if (!userData) {
        logger.error(`User profile not found for: ${authData.user.id}`);
        throw new Error('User profile not found');
      }

      // Sync email verification status if it's different
      if (!userData.email_confirmed && isEmailVerified) {
        logger.info(`Syncing email verification status for user: ${email}`);
        const { data: updatedData, error: updateError } = await supabaseClient
          .from('user_profiles')
          .update({
            email_confirmed: true,
            email_confirmed_at: authData.user.email_confirmed_at,
            updated_at: new Date().toISOString(),
          })
          .eq('id', authData.user.id)
          .select('*')
          .single();

        if (!updateError && updatedData) {
          userData = updatedData;
        }
      }

      // Check if user is soft-deleted
      if (userData.deleted_at) {
        throw new Error('This account has been deactivated');
      }

      // Extract session data from Supabase
      const session = {
        access_token: authData.session.access_token,
        refresh_token: authData.session.refresh_token,
        expires_at: authData.session.expires_at || Date.now() + 3600000,
        expires_in: authData.session.expires_in || 3600,
        token_type: authData.session.token_type || 'bearer',
      };

      // Update last login and activity
      await supabaseClient
        .from('user_profiles')
        .update({
          last_login_at: new Date().toISOString(),
          last_activity: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', authData.user.id);

      logger.info(`User logged in successfully: ${email}`);

      return {
        user: userData,
        session,
      };
    } catch (error) {
      logger.error('Login error:', error);
      throw error;
    }
  }

  /**
   * Logout a user (invalidate session)
   */
  async logout(token: string): Promise<void> {
    try {
      // Get user ID from token first
      const { data: { user: authUser } } = await supabaseClient.auth.getUser(token);
      
      if (authUser) {
        // Sign out the user from Supabase (invalidates all sessions)
        await supabaseClient.auth.admin.signOut(authUser.id);
        logger.info(`User logged out successfully: ${authUser.id}`);
      }
    } catch (error) {
      logger.error('Logout error:', error);
      // Don't throw error for logout failures
    }
  }

  /**
   * Verify email with token
   */
  async verifyEmail(token: string, type: 'signup' | 'recovery' = 'signup'): Promise<User> {
    try {
      // Verify the token with Supabase
      const { data, error } = await supabaseClient.auth.verifyOtp({
        token_hash: token,
        type: type,
      });

      if (error || !data.user) {
        logger.error('Email verification failed:', error);
        throw new Error('Invalid or expired verification token');
      }

      // Update user profile
      const { data: userData, error: updateError } = await supabaseClient
        .from('user_profiles')
        .update({
          email_confirmed: true,
          email_confirmed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', data.user.id)
        .select('*')
        .single();

      if (updateError || !userData) {
        logger.error('Failed to update user profile after verification:', updateError);
        throw new Error('Failed to update user profile');
      }

      logger.info(`Email verified successfully for user: ${data.user.email}`);
      return userData;
    } catch (error) {
      logger.error('Email verification error:', error);
      throw error;
    }
  }

  /**
   * Resend verification email
   */
  async resendVerificationEmail(email: string): Promise<void> {
    try {
      const user = await this.getUserByEmail(email);
      if (!user) {
        throw new Error('User not found');
      }

      if (user.email_confirmed) {
        throw new Error('Email is already verified');
      }

      await this.sendVerificationEmail(email);
      logger.info(`Verification email resent to: ${email}`);
    } catch (error) {
      logger.error('Resend verification error:', error);
      throw error;
    }
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(email: string): Promise<void> {
    try {
      const user = await this.getUserByEmail(email);
      if (!user) {
        // Don't reveal if user exists or not
        logger.info(`Password reset requested for non-existent email: ${email}`);
        return;
      }

      const { error } = await supabaseClient.auth.resetPasswordForEmail(
        email.toLowerCase(),
        {
          redirectTo: `${config.urls.frontend}/auth/reset-password`,
        }
      );

      if (error) {
        logger.error('Failed to send password reset email:', error);
        throw new Error('Failed to send password reset email');
      }

      logger.info(`Password reset email sent to: ${email}`);
    } catch (error) {
      logger.error('Password reset error:', error);
      throw error;
    }
  }

  /**
   * Reset password with token
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    try {
      if (newPassword.length < 6) {
        throw new Error('Password must be at least 6 characters long');
      }

      // Verify token and update password
      const { data, error } = await supabaseClient.auth.verifyOtp({
        token_hash: token,
        type: 'recovery',
      });

      if (error || !data.user) {
        logger.error('Password reset token verification failed:', error);
        throw new Error('Invalid or expired reset token');
      }

      // Update password
      const { error: updateError } = await supabaseClient.auth.admin.updateUserById(
        data.user.id,
        { password: newPassword }
      );

      if (updateError) {
        logger.error('Failed to update password:', updateError);
        throw new Error('Failed to update password');
      }

      // Invalidate all existing sessions via Supabase
      await supabaseClient.auth.admin.signOut(data.user.id);

      logger.info(`Password reset successfully for user: ${data.user.email}`);
    } catch (error) {
      logger.error('Password reset error:', error);
      throw error;
    }
  }

  /**
   * Change user password (authenticated)
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    try {
      const user = await this.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Verify current password by attempting sign in
      const { error: verifyError } = await supabaseClient.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });

      if (verifyError) {
        throw new Error('Current password is incorrect');
      }

      if (newPassword.length < 6) {
        throw new Error('New password must be at least 6 characters long');
      }

      // Update password
      const { error: updateError } = await supabaseClient.auth.admin.updateUserById(
        userId,
        { password: newPassword }
      );

      if (updateError) {
        logger.error('Failed to change password:', updateError);
        throw new Error('Failed to change password');
      }

      // Invalidate all existing sessions via Supabase (force re-login)
      await supabaseClient.auth.admin.signOut(userId);

      logger.info(`Password changed successfully for user: ${user.email}`);
    } catch (error) {
      logger.error('Change password error:', error);
      throw error;
    }
  }

  /**
   * Get user by ID
   */
  private async getUserById(userId: string): Promise<User | null> {
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
      logger.error('Error fetching user by ID:', error);
      return null;
    }
  }

  /**
   * Get user by email
   */
  private async getUserByEmail(email: string): Promise<User | null> {
    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .select('*')
        .eq('email', email)
        .maybeSingle();

      if (error) {
        logger.error('Error fetching user by email:', error);
        return null;
      }

      // Return only non-deleted users
      return data && !data.deleted_at ? data : null;
    } catch (error) {
      logger.error('Error fetching user by email:', error);
      return null;
    }
  }

  /**
   * Check if user exists (including deleted users)
   */
  private async getUserByEmailIncludingDeleted(email: string): Promise<User | null> {
    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .select('*')
        .eq('email', email)
        .maybeSingle();

      if (error) {
        logger.error('Error fetching user by email (including deleted):', error);
        return null;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching user by email (including deleted):', error);
      return null;
    }
  }

  /**
   * Send verification email
   */
  private async sendVerificationEmail(email: string): Promise<void> {
    logger.info(`Attempting to send verification email to: ${email}`);
    
    const { data, error } = await supabaseClient.auth.resend({
      type: 'signup',
      email: email.toLowerCase(),
      options: {
        emailRedirectTo: `${config.urls.frontend}/auth/verify-email`,
      },
    });

    logger.info(`Supabase resend response - data: ${JSON.stringify(data)}, error: ${JSON.stringify(error)}`);

    if (error) {
      logger.error('Failed to send verification email - Supabase error:', error);
      logger.error('Error details:', {
        message: error.message,
        status: error.status,
        code: error.code,
      });
      throw new Error(`Failed to send verification email: ${error.message}`);
    }
    
    logger.info('Verification email sent successfully via Supabase');
  }

  /**
   * Check email verification status without triggering authentication
   */
  async checkEmailVerificationStatus(email: string): Promise<boolean> {
    try {
      const user = await this.getUserByEmail(email);
      if (!user) {
        return false;
      }
      
      // Now that we have database triggers auto-syncing verification status,
      // we can trust the email_confirmed field in user_profiles
      logger.info(`Email verification status for ${email}: ${user.email_confirmed}`);
      return user.email_confirmed;
    } catch (error) {
      logger.error('Check verification status error:', error);
      return false;
    }
  }

  /**
   * Validate email format
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
}

export const authService = new AuthService();