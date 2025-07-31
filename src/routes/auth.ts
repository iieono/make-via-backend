import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth, optionalAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { AuthenticatedRequest, User } from '@/types';
import {
  ValidationError,
  NotFoundError,
  AuthenticationError,
} from '@/middleware/errorHandler';

const router = Router();

// Apply auth rate limiting to all routes
router.use(rateLimits.auth);

// Get current user profile
router.get('/me', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;

  logger.info(`Fetched profile for user: ${user.id}`);

  res.json({
    success: true,
    data: {
      user,
      subscription,
    },
    timestamp: new Date().toISOString(),
  });
}));

// Update user profile
router.patch('/me', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const updates = req.body;

  // Validate allowed fields
  const allowedFields = ['full_name', 'avatar_url'];
  const filteredUpdates: Partial<User> = {};

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      filteredUpdates[field as keyof User] = updates[field];
    }
  }

  if (Object.keys(filteredUpdates).length === 0) {
    throw ValidationError('No valid fields provided for update');
  }

  // Validate full_name if provided
  if (filteredUpdates.full_name !== undefined) {
    if (typeof filteredUpdates.full_name !== 'string') {
      throw ValidationError('full_name must be a string');
    }
    if (filteredUpdates.full_name.length < 1 || filteredUpdates.full_name.length > 100) {
      throw ValidationError('full_name must be between 1 and 100 characters');
    }
  }

  // Validate avatar_url if provided
  if (filteredUpdates.avatar_url !== undefined) {
    if (typeof filteredUpdates.avatar_url !== 'string') {
      throw ValidationError('avatar_url must be a string');
    }
    if (filteredUpdates.avatar_url && !isValidUrl(filteredUpdates.avatar_url)) {
      throw ValidationError('avatar_url must be a valid URL');
    }
  }

  const updatedUser = await supabase.updateUser(user.id, filteredUpdates);

  logger.info(`Updated profile for user: ${user.id}`);

  res.json({
    success: true,
    data: updatedUser,
    message: 'Profile updated successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Complete onboarding
router.post('/onboarding/complete', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  if (user.onboarding_completed) {
    throw ValidationError('Onboarding already completed');
  }

  const updatedUser = await supabase.updateUser(user.id, {
    onboarding_completed: true,
  });

  logger.info(`Completed onboarding for user: ${user.id}`);

  res.json({
    success: true,
    data: updatedUser,
    message: 'Onboarding completed successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Get user statistics
router.get('/stats', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;

  // Get user's apps and compute stats
  const apps = await supabase.getUserApps(user.id, 1000); // Get all apps for stats
  
  const stats = {
    apps: {
      total: apps.length,
      draft: apps.filter(app => app.status === 'draft').length,
      preview: apps.filter(app => app.status === 'preview').length,
      published: apps.filter(app => app.status === 'published').length,
    },
    screens: {
      total: 0, // Would need to query screens table
    },
    usage: {
      claude_generations_used: subscription?.claude_usage_count || 0,
      claude_generations_limit: subscription?.claude_usage_limit || 0,
      tier: subscription?.tier || 'free',
      period_start: subscription?.current_period_start,
      period_end: subscription?.current_period_end,
    },
    account: {
      created_at: user.created_at,
      onboarding_completed: user.onboarding_completed,
      subscription_tier: user.subscription_tier,
    },
  };

  logger.info(`Fetched stats for user: ${user.id}`);

  res.json({
    success: true,
    data: stats,
    timestamp: new Date().toISOString(),
  });
}));

// Refresh user session
router.post('/refresh', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  // Get fresh user data and subscription
  const [freshUser, freshSubscription] = await Promise.all([
    supabase.getUserById(user.id),
    supabase.getUserSubscription(user.id),
  ]);

  if (!freshUser) {
    throw NotFoundError('User');
  }

  logger.info(`Refreshed session for user: ${user.id}`);

  res.json({
    success: true,
    data: {
      user: freshUser,
      subscription: freshSubscription,
    },
    message: 'Session refreshed successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Delete user account (soft delete)
router.delete('/me', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { confirm } = req.body;

  if (confirm !== 'DELETE_MY_ACCOUNT') {
    throw ValidationError('Account deletion not confirmed. Please provide confirm: "DELETE_MY_ACCOUNT"');
  }

  // Soft delete user by setting deleted_at timestamp
  await supabase.updateUser(user.id, {
    deleted_at: new Date().toISOString(),
  });

  logger.warn(`User account deleted: ${user.id}`);

  res.json({
    success: true,
    message: 'Account deleted successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Check if user exists by email (public endpoint with rate limiting)
router.post('/check-email', asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string') {
    throw ValidationError('Email is required');
  }

  if (!isValidEmail(email)) {
    throw ValidationError('Invalid email format');
  }

  const user = await supabase.getUserByEmail(email.toLowerCase());
  
  res.json({
    success: true,
    data: {
      exists: !!user,
      email: email.toLowerCase(),
    },
    timestamp: new Date().toISOString(),
  });
}));

// Get public user profile (for sharing/collaboration features)
router.get('/public/:userId', optionalAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { userId } = req.params;

  if (!userId) {
    throw ValidationError('User ID is required');
  }

  const user = await supabase.getUserById(userId);
  
  if (!user) {
    throw NotFoundError('User');
  }

  // Return only public information
  const publicProfile = {
    id: user.id,
    full_name: user.full_name,
    avatar_url: user.avatar_url,
    created_at: user.created_at,
  };

  res.json({
    success: true,
    data: publicProfile,
    timestamp: new Date().toISOString(),
  });
}));

// Helper functions
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export default router;