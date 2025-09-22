import { Router } from 'express';
import { notificationService } from '@/services/notifications';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { AuthenticatedRequest } from '@/types';
import {
  ValidationError,
} from '@/middleware/errorHandler';

const router = Router();

// Apply general rate limiting to all routes
router.use(rateLimits.general);

// Register push token
router.post('/register-token',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { token, platform, device_id } = req.body;

    if (!token || typeof token !== 'string') {
      throw ValidationError('Push token is required');
    }

    if (!platform || !['ios', 'android'].includes(platform)) {
      throw ValidationError('Platform must be either ios or android');
    }

    if (!device_id || typeof device_id !== 'string') {
      throw ValidationError('Device ID is required');
    }

    const pushToken = await notificationService.registerPushToken(
      user.id,
      token,
      platform,
      device_id
    );

    logger.info(`Push token registered for user ${user.id}: ${device_id}`);

    res.status(201).json({
      success: true,
      data: pushToken,
      message: 'Push token registered successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Unregister push token
router.delete('/unregister-token',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { device_id } = req.body;

    await notificationService.unregisterPushToken(user.id, device_id);

    logger.info(`Push token unregistered for user ${user.id}${device_id ? ` device ${device_id}` : ''}`);

    res.json({
      success: true,
      message: 'Push token unregistered successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Send custom notification (admin only or self-notification for testing)
router.post('/send',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { title, body, type, category, data, scheduled_at } = req.body;

    if (!title || typeof title !== 'string') {
      throw ValidationError('Title is required');
    }

    if (!body || typeof body !== 'string') {
      throw ValidationError('Body is required');
    }

    if (type && !['info', 'success', 'warning', 'error'].includes(type)) {
      throw ValidationError('Type must be one of: info, success, warning, error');
    }

    if (category && !['ai_generation', 'subscription', 'usage', 'system', 'marketing'].includes(category)) {
      throw ValidationError('Invalid category');
    }

    if (scheduled_at && isNaN(new Date(scheduled_at).getTime())) {
      throw ValidationError('Invalid scheduled_at date');
    }

    const notification = await notificationService.sendNotification(user.id, {
      title,
      body,
      type,
      category,
      data,
      scheduled_at,
    });

    logger.info(`Custom notification sent to user ${user.id}: ${notification.id}`);

    res.status(201).json({
      success: true,
      data: notification,
      message: 'Notification sent successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Get user's notification history
router.get('/history',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { page = 1, limit = 20 } = req.query;

    // Validate pagination parameters
    const parsedPage = Math.max(parseInt(page as string) || 1, 1);
    const parsedLimit = Math.min(Math.max(parseInt(limit as string) || 20, 1), 100);
    const offset = (parsedPage - 1) * parsedLimit;

    const notifications = await notificationService.getUserNotifications(
      user.id,
      parsedLimit,
      offset
    );

    res.json({
      success: true,
      data: notifications,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total: notifications.length, // Would need actual count from database
        pages: Math.ceil(notifications.length / parsedLimit),
      },
      timestamp: new Date().toISOString(),
    });
  })
);

// Mark notification as read
router.post('/:id/read',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { id } = req.params;

    await notificationService.markNotificationAsRead(user.id, id);

    res.json({
      success: true,
      message: 'Notification marked as read',
      timestamp: new Date().toISOString(),
    });
  })
);

// Test notification endpoints (development only)
if (process.env.NODE_ENV === 'development') {
  // Send AI generation complete test notification
  router.post('/test/ai-complete',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const user = req.user!;
      const { app_name = 'Test App', screen_name = 'Test Screen' } = req.body;

      await notificationService.sendAIGenerationComplete(user.id, app_name, screen_name);

      res.json({
        success: true,
        message: 'Test AI generation complete notification sent',
        timestamp: new Date().toISOString(),
      });
    })
  );

  // Send usage warning test notification
  router.post('/test/usage-warning',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const user = req.user!;
      const { percentage = 85, limit_type = 'AI generations' } = req.body;

      await notificationService.sendUsageLimitWarning(user.id, percentage, limit_type);

      res.json({
        success: true,
        message: 'Test usage warning notification sent',
        timestamp: new Date().toISOString(),
      });
    })
  );

  // Send subscription expiring test notification
  router.post('/test/subscription-expiring',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const user = req.user!;
      const { days = 3 } = req.body;

      await notificationService.sendSubscriptionExpiring(user.id, days);

      res.json({
        success: true,
        message: 'Test subscription expiring notification sent',
        timestamp: new Date().toISOString(),
      });
    })
  );

  // Send build complete test notification
  router.post('/test/build-complete',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const user = req.user!;
      const { app_name = 'Test App', build_type = 'apk', success = true } = req.body;

      await notificationService.sendAppBuildComplete(user.id, app_name, build_type, success);

      res.json({
        success: true,
        message: 'Test build complete notification sent',
        timestamp: new Date().toISOString(),
      });
    })
  );
}

// Admin endpoints (would require admin auth middleware)
if (process.env.NODE_ENV === 'development') {
  // Process scheduled notifications manually (for testing)
  router.post('/admin/process-scheduled',
    requireAuth, // In production, use admin auth middleware
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      await notificationService.processScheduledNotifications();

      res.json({
        success: true,
        message: 'Scheduled notifications processed',
        timestamp: new Date().toISOString(),
      });
    })
  );

  // Send bulk notification (admin only)
  router.post('/admin/bulk-send',
    requireAuth, // In production, use admin auth middleware
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { user_ids, title, body, type, category, data } = req.body;

      if (!Array.isArray(user_ids) || user_ids.length === 0) {
        throw ValidationError('user_ids array is required');
      }

      if (!title || !body) {
        throw ValidationError('title and body are required');
      }

      const notifications = await notificationService.sendBulkNotification(user_ids, {
        title,
        body,
        type,
        category,
        data,
      });

      res.json({
        success: true,
        data: {
          sent_count: notifications.length,
          notifications: notifications.map(n => ({ id: n.id, user_id: n.user_id })),
        },
        message: `Bulk notification sent to ${notifications.length} users`,
        timestamp: new Date().toISOString(),
      });
    })
  );
}

export default router;