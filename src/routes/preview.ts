import { Router } from 'express';
import { previewService } from '@/services/preview-service';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth, optionalAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { AuthenticatedRequest } from '@/types';
import {
  ValidationError,
  NotFoundError,
} from '@/middleware/errorHandler';
import { body, param, query, validationResult } from 'express-validator';

const router = Router();

// Validation middleware
const validateRequest = (req: any, res: any, next: any) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

// Apply preview rate limiting to session creation
router.use('/sessions', rateLimits.preview);

// Create new preview session
router.post('/sessions',
  requireAuth,
  [
    body('appId').isUUID().withMessage('Valid app ID required'),
    body('deviceType').optional().isIn(['android', 'ios', 'web']).withMessage('Invalid device type')
  ],
  validateRequest,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { appId, deviceType = 'android' } = req.body;

    logger.info('Creating preview session', { appId, userId: user.id, deviceType });

    const session = await previewService.createPreviewSession(
      appId,
      user.id,
      deviceType
    );

    res.status(201).json({
      success: true,
      data: {
        sessionId: session.id,
        appId: session.appId,
        deviceType: session.deviceType,
        expiresAt: session.expiresAt,
        sessionData: session.sessionData
      },
      message: 'Preview session created successfully',
      timestamp: new Date().toISOString()
    });
  })
);

// Get preview session details
router.get('/sessions/:sessionId',
  requireAuth,
  [
    param('sessionId').isUUID().withMessage('Valid session ID required')
  ],
  validateRequest,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { sessionId } = req.params;

    const session = await previewService.getPreviewSession(sessionId);

    if (!session) {
      throw NotFoundError('Preview session not found or expired');
    }

    // Verify ownership
    if (session.userId !== user.id) {
      throw NotFoundError('Access denied');
    }

    res.json({
      success: true,
      data: {
        sessionId: session.id,
        appId: session.appId,
        deviceType: session.deviceType,
        sessionData: session.sessionData,
        status: session.status,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt
      },
      timestamp: new Date().toISOString(),
    });
  })
);

// Get app render data for preview
router.get('/sessions/:sessionId/app-data',
  requireAuth,
  [
    param('sessionId').isUUID().withMessage('Valid session ID required')
  ],
  validateRequest,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { sessionId } = req.params;

    // Verify session ownership
    const session = await previewService.getPreviewSession(sessionId);
    if (!session || session.userId !== user.id) {
      throw NotFoundError('Preview session not found');
    }

    const appData = await previewService.getAppRenderData(session.appId);

    res.json({
      success: true,
      data: appData,
      timestamp: new Date().toISOString(),
    });
  })
);

// Update preview session state
router.put('/sessions/:sessionId/state',
  requireAuth,
  [
    param('sessionId').isUUID().withMessage('Valid session ID required'),
    body('currentPage').optional().isString(),
    body('navigationStack').optional().isArray(),
    body('appState').optional().isObject()
  ],
  validateRequest,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { sessionId } = req.params;
    const { currentPage, navigationStack, appState } = req.body;

    // Verify session ownership
    const session = await previewService.getPreviewSession(sessionId);
    if (!session || session.userId !== user.id) {
      throw NotFoundError('Preview session not found');
    }

    await previewService.updateSessionState(sessionId, {
      currentPage,
      navigationStack,
      appState
    });

    res.json({
      success: true,
      message: 'Session state updated successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Log console message for preview session
router.post('/sessions/:sessionId/console',
  requireAuth,
  [
    param('sessionId').isUUID().withMessage('Valid session ID required'),
    body('level').isIn(['debug', 'info', 'warn', 'error']).withMessage('Valid log level required'),
    body('type').isIn(['interaction', 'navigation', 'form_input', 'api_call', 'performance', 'error', 'warning', 'debug']).withMessage('Valid log type required'),
    body('message').isString().notEmpty().withMessage('Message is required'),
    body('componentId').optional().isString(),
    body('pageId').optional().isString(),
    body('interactionData').optional().isObject(),
    body('stackTrace').optional().isString()
  ],
  validateRequest,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { sessionId } = req.params;
    const { level, type, message, componentId, pageId, interactionData, stackTrace } = req.body;

    // Verify session ownership
    const session = await previewService.getPreviewSession(sessionId);
    if (!session || session.userId !== user.id) {
      throw NotFoundError('Preview session not found');
    }

    await previewService.logConsoleMessage(sessionId, level, type, message, {
      componentId,
      pageId,
      interactionData,
      stackTrace
    });

    res.json({
      success: true,
      message: 'Console message logged',
      timestamp: new Date().toISOString(),
    });
  })
);

// Get console logs for session
router.get('/sessions/:sessionId/console',
  requireAuth,
  [
    param('sessionId').isUUID().withMessage('Valid session ID required'),
    query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be between 1 and 500'),
    query('offset').optional().isInt({ min: 0 }).withMessage('Offset must be non-negative')
  ],
  validateRequest,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    // Verify session ownership
    const session = await previewService.getPreviewSession(sessionId);
    if (!session || session.userId !== user.id) {
      throw NotFoundError('Preview session not found');
    }

    const logs = await previewService.getConsoleLogs(sessionId, limit, offset);

    res.json({
      success: true,
      data: {
        logs,
        pagination: {
          limit,
          offset,
          total: logs.length
        }
      },
      timestamp: new Date().toISOString(),
    });
  })
);

// End/expire a preview session
router.delete('/sessions/:sessionId',
  requireAuth,
  [
    param('sessionId').isUUID().withMessage('Valid session ID required')
  ],
  validateRequest,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { sessionId } = req.params;

    // Verify session ownership
    const session = await previewService.getPreviewSession(sessionId);
    if (!session || session.userId !== user.id) {
      throw NotFoundError('Preview session not found');
    }

    await previewService.expireSession(sessionId);

    logger.info(`Preview session ended: ${sessionId} by user ${user.id}`);

    res.json({
      success: true,
      message: 'Preview session ended',
      timestamp: new Date().toISOString(),
    });
  })
);

export default router;