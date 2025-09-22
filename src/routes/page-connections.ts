import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import pageConnectionsService from '@/services/page-connections-service';
import type { 
  PageConnectionType,
  PageConnectionsResponse 
} from '@/types/app-development';

const router = Router();

router.use(requireAuth);

/**
 * POST /api/apps/:appId/page-connections/detect
 * Detect and create page connections automatically
 */
router.post('/:appId/page-connections/detect',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      // Verify user has access to the app
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('user_id')
        .eq('id', appId)
        .single();

      if (!app || app.user_id !== userId) {
        // Check if user is a collaborator with editor+ access
        const { data: collaborator } = await supabase.serviceClient
          .from('app_collaborators')
          .select('role')
          .eq('app_id', appId)
          .eq('user_id', userId)
          .eq('is_active', true)
          .single();

        if (!collaborator || collaborator.role === 'viewer') {
          return res.status(403).json({
            success: false,
            error: 'Insufficient permissions to detect page connections',
            timestamp: new Date().toISOString(),
          });
        }
      }

      const connections = await pageConnectionsService.detectPageConnections(appId);

      res.json({
        success: true,
        message: `Detected ${connections.length} page connections`,
        data: connections,
        count: connections.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error detecting page connections:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to detect page connections',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/page-connections
 * Get all page connections for an app
 */
router.get('/:appId/page-connections',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { include_graph } = req.query;

    try {
      // Verify user has access to the app
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('user_id')
        .eq('id', appId)
        .single();

      if (!app || app.user_id !== userId) {
        // Check if user is a collaborator
        const { data: collaborator } = await supabase.serviceClient
          .from('app_collaborators')
          .select('role')
          .eq('app_id', appId)
          .eq('user_id', userId)
          .eq('is_active', true)
          .single();

        if (!collaborator) {
          return res.status(403).json({
            success: false,
            error: 'Insufficient permissions to view page connections',
            timestamp: new Date().toISOString(),
          });
        }
      }

      let data;
      if (include_graph === 'true') {
        data = await pageConnectionsService.getPageConnectionsWithGraph(appId);
      } else {
        const connections = await pageConnectionsService.getPageConnections(appId);
        data = { connections };
      }

      res.json({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting page connections:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get page connections',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/page-connections
 * Create a manual page connection
 */
router.post('/:appId/page-connections',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { from_page_id, to_page_id, connection_type, connection_data } = req.body;

    try {
      // Validate required fields
      if (!from_page_id || !to_page_id || !connection_type) {
        return res.status(400).json({
          success: false,
          error: 'from_page_id, to_page_id, and connection_type are required',
          timestamp: new Date().toISOString(),
        });
      }

      // Validate connection type
      const validTypes: PageConnectionType[] = ['navigation', 'tab_group', 'modal_parent', 'flow_sequence', 'shared_component'];
      if (!validTypes.includes(connection_type)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid connection type',
          timestamp: new Date().toISOString(),
        });
      }

      const connectionId = await pageConnectionsService.createPageConnection(
        appId,
        from_page_id,
        to_page_id,
        connection_type,
        connection_data || {},
        userId
      );

      res.json({
        success: true,
        message: 'Page connection created successfully',
        data: { connection_id: connectionId },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error creating page connection:', error);
      const statusCode = error.message.includes('permissions') ? 403 : 
                        error.message.includes('Invalid') || error.message.includes('already exists') ? 400 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to create page connection',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * PUT /api/apps/:appId/page-connections/:connectionId
 * Update page connection data
 */
router.put('/:appId/page-connections/:connectionId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { connectionId } = req.params;
    const { connection_data } = req.body;

    try {
      if (!connection_data) {
        return res.status(400).json({
          success: false,
          error: 'connection_data is required',
          timestamp: new Date().toISOString(),
        });
      }

      await pageConnectionsService.updatePageConnection(connectionId, connection_data, userId);

      res.json({
        success: true,
        message: 'Page connection updated successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error updating page connection:', error);
      const statusCode = error.message.includes('permissions') ? 403 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to update page connection',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * DELETE /api/apps/:appId/page-connections/:connectionId
 * Delete a page connection
 */
router.delete('/:appId/page-connections/:connectionId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { connectionId } = req.params;

    try {
      await pageConnectionsService.deletePageConnection(connectionId, userId);

      res.json({
        success: true,
        message: 'Page connection deleted successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error deleting page connection:', error);
      const statusCode = error.message.includes('permissions') ? 403 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to delete page connection',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/page-connections/by-type/:connectionType
 * Get page connections by type
 */
router.get('/:appId/page-connections/by-type/:connectionType',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, connectionType } = req.params;

    try {
      // Validate connection type
      const validTypes: PageConnectionType[] = ['navigation', 'tab_group', 'modal_parent', 'flow_sequence', 'shared_component'];
      if (!validTypes.includes(connectionType as PageConnectionType)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid connection type',
          timestamp: new Date().toISOString(),
        });
      }

      const connections = await pageConnectionsService.getConnectionsByType(appId, connectionType as PageConnectionType);

      res.json({
        success: true,
        data: connections,
        count: connections.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting connections by type:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get connections by type',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/page-connections/for-page/:pageId
 * Get connections for a specific page
 */
router.get('/:appId/page-connections/for-page/:pageId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId } = req.params;

    try {
      const connections = await pageConnectionsService.getPageConnections_ForPage(appId, pageId);

      res.json({
        success: true,
        data: connections,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting connections for page:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get connections for page',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/navigation-report
 * Generate comprehensive navigation report
 */
router.get('/:appId/navigation-report',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      const report = await pageConnectionsService.generateNavigationReport(appId);

      res.json({
        success: true,
        data: report,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error generating navigation report:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate navigation report',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * DELETE /api/apps/:appId/page-connections/auto-detected
 * Clear all auto-detected connections
 */
router.delete('/:appId/page-connections/auto-detected',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      // Verify user has admin access
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('user_id')
        .eq('id', appId)
        .single();

      if (!app || app.user_id !== userId) {
        // Check if user is a collaborator with admin+ access
        const { data: collaborator } = await supabase.serviceClient
          .from('app_collaborators')
          .select('role')
          .eq('app_id', appId)
          .eq('user_id', userId)
          .eq('is_active', true)
          .single();

        if (!collaborator || !['admin', 'owner'].includes(collaborator.role)) {
          return res.status(403).json({
            success: false,
            error: 'Insufficient permissions to clear auto-detected connections',
            timestamp: new Date().toISOString(),
          });
        }
      }

      const deletedCount = await pageConnectionsService.clearAutoDetectedConnections(appId);

      res.json({
        success: true,
        message: `Cleared ${deletedCount} auto-detected connections`,
        data: { deleted_count: deletedCount },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error clearing auto-detected connections:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to clear auto-detected connections',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/page-connections/stats
 * Get connection statistics for an app
 */
router.get('/:appId/page-connections/stats',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      const stats = await pageConnectionsService.getConnectionStats(appId);

      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting connection stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get connection stats',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;