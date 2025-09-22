import { Router } from 'express';
import { supabaseAuthService } from '@/services/supabase-auth';
import { userProfileService } from '@/services/user-profile';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { ValidationError } from '@/middleware/errorHandler';
import rateLimits from '@/middleware/rateLimit';

const router = Router();

// Apply rate limiting to auth routes
router.use(rateLimits.auth);

/**
 * POST /api/auth/signup
 * Sign up a new user
 */
router.post('/signup',
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body;

    // Validation
    if (!email || typeof email !== 'string') {
      throw new ValidationError('Email is required');
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters');
    }

    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      throw new ValidationError('Invalid email format');
    }

    try {
      // Sign up with Supabase Auth
      const session = await supabaseAuthService.signUp(email, password, {
        name: name || email.split('@')[0],
      });

      if (!session) {
        throw new ValidationError('Failed to create account');
      }

      // Create user profile in our database
      await userProfileService.updateUserProfile(session.user.id, {
        name: name || email.split('@')[0],
        email: email,
        full_name: name || email.split('@')[0],
        display_email: email,
      });

      res.json({
        success: true,
        data: {
          user: session.user,
          session: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: session.expires_in,
          },
        },
        message: 'Account created successfully',
      });
    } catch (error) {
      logger.error('Signup error:', error);
      
      if (error instanceof ValidationError) {
        res.status(400).json({
          success: false,
          error: error.name,
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'server_error',
        message: 'Failed to create account',
      });
    }
  })
);

/**
 * POST /api/auth/signin
 * Sign in user
 */
router.post('/signin',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Validation
    if (!email || typeof email !== 'string') {
      throw new ValidationError('Email is required');
    }

    if (!password || typeof password !== 'string') {
      throw new ValidationError('Password is required');
    }

    try {
      // Sign in with Supabase Auth
      const session = await supabaseAuthService.signIn(email, password);

      if (!session) {
        throw new ValidationError('Invalid email or password');
      }

      // Update user activity
      await userProfileService.updateLastActivity(session.user.id);

      res.json({
        success: true,
        data: {
          user: session.user,
          session: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: session.expires_in,
          },
        },
        message: 'Signed in successfully',
      });
    } catch (error) {
      logger.error('Signin error:', error);
      
      if (error instanceof ValidationError) {
        res.status(400).json({
          success: false,
          error: error.name,
          message: error.message,
        });
        return;
      }

      res.status(401).json({
        success: false,
        error: 'invalid_credentials',
        message: 'Invalid email or password',
      });
    }
  })
);

/**
 * POST /api/auth/refresh
 * Refresh access token
 */
router.post('/refresh',
  asyncHandler(async (req, res) => {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      throw new ValidationError('Refresh token is required');
    }

    try {
      const session = await supabaseAuthService.refreshToken(refresh_token);

      if (!session) {
        throw new ValidationError('Invalid refresh token');
      }

      res.json({
        success: true,
        data: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_in: session.expires_in,
        },
        message: 'Token refreshed successfully',
      });
    } catch (error) {
      logger.error('Token refresh error:', error);
      
      res.status(401).json({
        success: false,
        error: 'invalid_refresh_token',
        message: 'Invalid or expired refresh token',
      });
    }
  })
);

/**
 * POST /api/auth/signout
 * Sign out user
 */
router.post('/signout',
  asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ValidationError('Invalid authorization header');
    }

    const token = authHeader.substring(7);

    try {
      const success = await supabaseAuthService.signOut(token);

      if (!success) {
        throw new ValidationError('Failed to sign out');
      }

      res.json({
        success: true,
        message: 'Signed out successfully',
      });
    } catch (error) {
      logger.error('Signout error:', error);
      
      res.status(500).json({
        success: false,
        error: 'server_error',
        message: 'Failed to sign out',
      });
    }
  })
);

/**
 * POST /api/auth/reset-password
 * Request password reset
 */
router.post('/reset-password',
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      throw new ValidationError('Email is required');
    }

    try {
      const success = await supabaseAuthService.resetPassword(email);

      if (!success) {
        throw new ValidationError('Failed to send password reset email');
      }

      res.json({
        success: true,
        message: 'Password reset email sent successfully',
      });
    } catch (error) {
      logger.error('Password reset error:', error);
      
      res.status(500).json({
        success: false,
        error: 'server_error',
        message: 'Failed to send password reset email',
      });
    }
  })
);

/**
 * POST /api/auth/update-password
 * Update user password
 */
router.post('/update-password',
  asyncHandler(async (req, res) => {
    const { current_password, new_password } = req.body;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ValidationError('Invalid authorization header');
    }

    const token = authHeader.substring(7);

    if (!current_password || !new_password) {
      throw new ValidationError('Current password and new password are required');
    }

    if (new_password.length < 8) {
      throw new ValidationError('New password must be at least 8 characters');
    }

    try {
      // First verify current password by attempting to sign in
      const user = await supabaseAuthService.verifyToken(token);
      if (!user) {
        throw new ValidationError('Invalid user token');
      }

      // Update password
      const success = await supabaseAuthService.updatePassword(token, new_password);

      if (!success) {
        throw new ValidationError('Failed to update password');
      }

      res.json({
        success: true,
        message: 'Password updated successfully',
      });
    } catch (error) {
      logger.error('Password update error:', error);
      
      res.status(400).json({
        success: false,
        error: 'password_update_failed',
        message: 'Failed to update password',
      });
    }
  })
);

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me',
  asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ValidationError('Invalid authorization header');
    }

    const token = authHeader.substring(7);

    try {
      const user = await supabaseAuthService.verifyToken(token);

      if (!user) {
        throw new ValidationError('Invalid token');
      }

      const profile = await userProfileService.getUserProfile(user.id);

      res.json({
        success: true,
        data: {
          user,
          profile,
        },
      });
    } catch (error) {
      logger.error('Get user info error:', error);
      
      res.status(401).json({
        success: false,
        error: 'invalid_token',
        message: 'Invalid or expired token',
      });
    }
  })
);

export default router;