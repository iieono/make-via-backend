import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import type { AuthenticatedRequest } from '@/types';

const router = Router();

/**
 * POST /api/analytics/activity
 * Track user activity
 */
router.post('/activity', requireAuth, [
  body('type')
    .notEmpty()
    .withMessage('Activity type is required'),
  body('description')
    .notEmpty()
    .withMessage('Activity description is required'),
  body('timestamp')
    .isISO8601()
    .withMessage('Valid timestamp is required'),
  body('metadata')
    .optional()
    .isObject()
    .withMessage('Metadata must be an object'),
], asyncHandler(async (req: AuthenticatedRequest, res) => {
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

  const { type, description, timestamp, metadata } = req.body;

  try {
    // For now, just log the activity
    // In the future, you might want to store this in a database
    logger.info(`User activity tracked: ${req.user!.email}`, {
      userId: req.user!.id,
      type,
      description,
      timestamp,
      metadata,
    });

    res.json({
      success: true,
      message: 'Activity tracked successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Failed to track activity:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to track activity',
      timestamp: new Date().toISOString(),
    });
  }
}));

export default router;