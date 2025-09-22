import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import appArchivingService from '@/services/app-archiving-service';
import type { 
  ArchiveAppRequest,
  ArchivedAppAccessRequest 
} from '@/types/app-development';

const router = Router();

router.use(requireAuth);

/**
 * POST /api/apps/:appId/archive
 * Archive an app manually
 */
router.post('/:appId/archive',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const archiveData: ArchiveAppRequest = req.body;

    try {
      await appArchivingService.archiveApp(appId, userId, archiveData);

      res.json({
        success: true,
        message: 'App archived successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error archiving app:', error);
      const statusCode = error.message.includes('permissions') ? 403 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to archive app',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/restore
 * Restore an archived app
 */
router.post('/:appId/restore',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      await appArchivingService.restoreApp(appId, userId);

      res.json({
        success: true,
        message: 'App restored successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error restoring app:', error);
      const statusCode = error.message.includes('permissions') ? 403 : 
                        error.message.includes('limit') ? 402 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to restore app',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/archived-access
 * Grant access to archived app
 */
router.post('/:appId/archived-access',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { target_user_id } = req.body;
    const accessData: ArchivedAppAccessRequest = req.body;

    try {
      if (!target_user_id) {
        return res.status(400).json({
          success: false,
          error: 'Target user ID is required',
          timestamp: new Date().toISOString(),
        });
      }

      const accessId = await appArchivingService.grantArchivedAppAccess(
        appId,
        target_user_id,
        userId,
        accessData
      );

      res.json({
        success: true,
        message: 'Archived app access granted successfully',
        data: { access_id: accessId },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error granting archived app access:', error);
      const statusCode = error.message.includes('permissions') ? 403 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to grant archived app access',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/archived
 * Get user's archived apps
 */
router.get('/archived',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      const archivedApps = await appArchivingService.getUserArchivedApps(userId);

      res.json({
        success: true,
        data: archivedApps,
        count: archivedApps.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting archived apps:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get archived apps',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/archived-access
 * Get apps where user has archived access
 */
router.get('/archived-access',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      const archivedAccess = await appArchivingService.getUserArchivedAccess(userId);

      res.json({
        success: true,
        data: archivedAccess,
        count: archivedAccess.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting archived access:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get archived access',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/archive-excess
 * Archive excess apps based on subscription limits
 */
router.post('/archive-excess',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      const archivedCount = await appArchivingService.archiveExcessApps(userId);

      res.json({
        success: true,
        message: `${archivedCount} apps archived due to subscription limits`,
        data: { archived_count: archivedCount },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error archiving excess apps:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to archive excess apps',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/archived-access/:accessId/use
 * Mark archived app access as used
 */
router.post('/archived-access/:accessId/use',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { accessId } = req.params;

    try {
      await appArchivingService.useArchivedAppAccess(accessId, userId);

      res.json({
        success: true,
        message: 'Archived app access used successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error using archived app access:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to use archived app access',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/archiving-stats
 * Get app archiving statistics for user
 */
router.get('/archiving-stats',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      const stats = await appArchivingService.getArchivingStats(userId);

      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting archiving stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get archiving stats',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;