import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { authService } from '@/services/auth';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { AuthenticatedRequest } from '@/types';

const router = Router();

// Apply rate limiting to all auth routes
router.use(rateLimits.auth);

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', [
  body('email')
    .isEmail()
    .withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
  body('fullName')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Full name is required and must be less than 100 characters'),
  body('deviceInfo')
    .optional()
    .isObject()
    .withMessage('Device info must be an object'),
], asyncHandler(async (req, res) => {
  // Check validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array(),
      timestamp: new Date().toISOString(),
    });
  }

  const { email, password, fullName, deviceInfo } = req.body;

  try {
    const result = await authService.register({
      email,
      password,
      fullName,
      deviceInfo,
    });

    logger.info(`User registration successful: ${email}`);

    if (result.needsVerification) {
      res.status(201).json({
        success: true,
        message: 'Registration successful. Please check your email to verify your account.',
        data: {
          user: {
            id: result.user.id,
            email: result.user.email,
            full_name: result.user.full_name,
            email_confirmed: result.user.email_confirmed,
          },
          needsVerification: true,
        },
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(201).json({
        success: true,
        message: 'Registration and login successful',
        data: {
          user: result.user,
          session: {
            token: result.session.access_token,
            expiresAt: result.session.expires_at,
          },
        },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    logger.error('Registration failed:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Registration failed',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * POST /api/auth/login
 * Login a user
 */
router.post('/login', [
  body('email')
    .isEmail()
    .withMessage('Valid email is required'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  body('deviceInfo')
    .optional()
    .isObject()
    .withMessage('Device info must be an object'),
], asyncHandler(async (req, res) => {
  // Check validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array(),
      timestamp: new Date().toISOString(),
    });
  }

  const { email, password, deviceInfo } = req.body;

  try {
    const result = await authService.login({
      email,
      password,
      deviceInfo,
    });

    logger.info(`User login successful: ${email}`);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: result.user,
        session: {
          token: result.session.access_token,
          expiresAt: result.session.expires_at,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'EMAIL_NOT_VERIFIED') {
      logger.warn(`Login attempt with unverified email: ${email}`);
      return res.status(403).json({
        success: false,
        error: 'EMAIL_NOT_VERIFIED',
        message: 'Email not verified. Please check your email and click the verification link.',
        data: {
          email: email,
          needsVerification: true,
        },
        timestamp: new Date().toISOString(),
      });
    }
    
    logger.error('Login failed:', error);
    res.status(401).json({
      success: false,
      error: error.message || 'Login failed',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * POST /api/auth/logout
 * Logout a user
 */
router.post('/logout', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.substring(7); // Remove 'Bearer ' prefix

  if (!token) {
    return res.status(400).json({
      success: false,
      error: 'No token provided',
      timestamp: new Date().toISOString(),
    });
  }

  try {
    await authService.logout(token);

    logger.info(`User logout successful: ${req.user!.email}`);

    res.json({
      success: true,
      message: 'Logout successful',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Logout failed:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Logout failed',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * POST /api/auth/verify-email
 * Verify email with token
 */
router.post('/verify-email', [
  body('token')
    .notEmpty()
    .withMessage('Verification token is required'),
  body('type')
    .optional()
    .isIn(['signup', 'recovery'])
    .withMessage('Type must be signup or recovery'),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array(),
      timestamp: new Date().toISOString(),
    });
  }

  const { token, type = 'signup' } = req.body;

  try {
    const user = await authService.verifyEmail(token, type);

    logger.info(`Email verification successful: ${user.email}`);

    res.json({
      success: true,
      message: 'Email verified successfully',
      data: {
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          email_confirmed: user.email_confirmed,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Email verification failed:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Email verification failed',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * POST /api/auth/resend-verification
 * Resend verification email
 */
router.post('/resend-verification', [
  body('email')
    .isEmail()
    .withMessage('Valid email is required'),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array(),
      timestamp: new Date().toISOString(),
    });
  }

  const { email } = req.body;

  try {
    await authService.resendVerificationEmail(email);

    logger.info(`Verification email resent: ${email}`);

    res.json({
      success: true,
      message: 'Verification email sent successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Resend verification failed:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to resend verification email',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * POST /api/auth/forgot-password
 * Send password reset email
 */
router.post('/forgot-password', [
  body('email')
    .isEmail()
    .withMessage('Valid email is required'),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array(),
      timestamp: new Date().toISOString(),
    });
  }

  const { email } = req.body;

  try {
    await authService.sendPasswordResetEmail(email);

    logger.info(`Password reset email sent: ${email}`);

    // Always return success to avoid revealing if email exists
    res.json({
      success: true,
      message: 'If an account with this email exists, a password reset link has been sent',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Password reset email failed:', error);
    // Still return success to avoid revealing if email exists
    res.json({
      success: true,
      message: 'If an account with this email exists, a password reset link has been sent',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * POST /api/auth/reset-password
 * Reset password with token
 */
router.post('/reset-password', [
  body('token')
    .notEmpty()
    .withMessage('Reset token is required'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array(),
      timestamp: new Date().toISOString(),
    });
  }

  const { token, password } = req.body;

  try {
    await authService.resetPassword(token, password);

    logger.info('Password reset successful');

    res.json({
      success: true,
      message: 'Password reset successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Password reset failed:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Password reset failed',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * POST /api/auth/change-password
 * Change password (authenticated)
 */
router.post('/change-password', requireAuth, [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long'),
], asyncHandler(async (req: AuthenticatedRequest, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array(),
      timestamp: new Date().toISOString(),
    });
  }

  const { currentPassword, newPassword } = req.body;

  try {
    await authService.changePassword(req.user!.id, currentPassword, newPassword);

    logger.info(`Password changed successfully: ${req.user!.email}`);

    res.json({
      success: true,
      message: 'Password changed successfully. Please log in again.',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Password change failed:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Password change failed',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * GET /api/auth/session
 * Get current session and user data (optimized for speed)
 */
router.get('/session', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  try {
    // Return comprehensive session data in single response
    res.json({
      success: true,
      data: {
        user: req.user,
        subscription: req.subscription,
        session: {
          isExpiring: false, // Infinite sessions with Supabase auto-refresh
          expiresIn: 'infinite (auto-refresh)',
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Session check failed:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Session check failed',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * GET /api/auth/session-data
 * Ultra-fast combined endpoint for app startup
 */
router.get('/session-data', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  try {
    // Return everything the app needs in one request
    // Note: User apps can be fetched separately if needed
    res.json({
      success: true,
      data: {
        user: req.user,
        subscription: req.subscription,
        session: {
          isExpiring: false,
          expiresIn: 'infinite (auto-refresh)',
        },
        apps: [], // Apps will be fetched separately
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Session data fetch failed:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch session data',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * POST /api/auth/refresh
 * Session refresh is handled automatically by Supabase
 * This endpoint is kept for compatibility but not needed
 */
router.post('/refresh', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    message: 'Session refresh is handled automatically by Supabase. No action needed.',
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/auth/sessions
 * Get active sessions - simplified since Supabase manages sessions
 */
router.get('/sessions', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  try {
    // Return current session info only since Supabase handles session management
    const sessionData = [
      {
        id: 'current',
        lastActivity: req.user!.last_activity || new Date().toISOString(),
        deviceInfo: { platform: 'current_device' },
        createdAt: req.user!.last_login_at || req.user!.created_at,
        current: true,
      }
    ];

    res.json({
      success: true,
      data: {
        sessions: sessionData,
        total: sessionData.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Failed to get user sessions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get sessions',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * DELETE /api/auth/sessions/all
 * Logout from all devices via Supabase
 */
router.delete('/sessions/all', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.substring(7); // Remove 'Bearer ' prefix

  if (!token) {
    return res.status(400).json({
      success: false,
      error: 'No token provided',
      timestamp: new Date().toISOString(),
    });
  }

  try {
    await authService.logout(token);

    logger.info(`All sessions invalidated for user: ${req.user!.email}`);

    res.json({
      success: true,
      message: 'Logged out from all devices successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Failed to invalidate all sessions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to logout from all devices',
      timestamp: new Date().toISOString(),
    });
  }
}));

/**
 * GET /api/auth/check-verification-status
 * Check email verification status without triggering authentication
 */
router.get('/check-verification-status', asyncHandler(async (req, res) => {
  const email = req.query.email as string;
  
  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Email parameter is required',
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const verified = await authService.checkEmailVerificationStatus(email);

    res.json({
      success: true,
      data: {
        verified,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Check verification status failed:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check verification status',
      timestamp: new Date().toISOString(),
    });
  }
}));

export default router;