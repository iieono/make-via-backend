import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import CanvasService from '@/services/canvas-service';

const router = Router();
const canvasService = new CanvasService();

router.use(requireAuth);

/**
 * GET /api/apps/:appId/canvas
 * Get canvas state for an app
 */
router.get('/',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      const canvasState = await canvasService.getCanvasState(appId, userId);

      res.json({
        success: true,
        data: canvasState,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting canvas state:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get canvas state',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * PUT /api/apps/:appId/canvas/nodes/:nodeId/position
 * Update canvas node position
 */
router.put('/nodes/:nodeId/position',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { nodeId } = req.params;
    const { x, y } = req.body;

    if (typeof x !== 'number' || typeof y !== 'number') {
      res.status(400).json({
        success: false,
        error: 'x and y coordinates must be numbers',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      await canvasService.updateNodePosition(nodeId, { x, y }, userId);

      res.json({
        success: true,
        message: 'Node position updated successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error updating node position:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update node position',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/canvas/connections
 * Create canvas connection between nodes
 */
router.post('/connections',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { from_node_id, to_node_id, trigger_type, trigger_config, animation_type } = req.body;

    // Validate required fields
    if (!from_node_id || !to_node_id || !trigger_type) {
      res.status(400).json({
        success: false,
        error: 'from_node_id, to_node_id, and trigger_type are required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const validTriggerTypes = ['navigation', 'action', 'condition'];
    if (!validTriggerTypes.includes(trigger_type)) {
      res.status(400).json({
        success: false,
        error: `trigger_type must be one of: ${validTriggerTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const connectionId = await canvasService.createConnection(
        appId,
        from_node_id,
        to_node_id,
        {
          trigger_type,
          trigger_config: trigger_config || {},
          animation_type,
        },
        userId
      );

      res.status(201).json({
        success: true,
        data: { connection_id: connectionId },
        message: 'Connection created successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error creating canvas connection:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create connection',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * DELETE /api/apps/:appId/canvas/connections/:connectionId
 * Delete canvas connection
 */
router.delete('/connections/:connectionId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { connectionId } = req.params;

    try {
      await canvasService.deleteConnection(connectionId, userId);

      res.json({
        success: true,
        message: 'Connection deleted successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error deleting canvas connection:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete connection',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/canvas/pages/:pageId/components
 * Get page components for canvas view
 */
router.get('/pages/:pageId/components',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { pageId } = req.params;

    try {
      const components = await canvasService.getPageComponents(pageId, userId);

      res.json({
        success: true,
        data: components,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting page components:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get page components',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * PUT /api/apps/:appId/canvas/components/positions
 * Update multiple component positions (batch update for drag and drop)
 */
router.put('/components/positions',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { updates } = req.body;

    if (!Array.isArray(updates)) {
      res.status(400).json({
        success: false,
        error: 'updates must be an array',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate update structure
    for (const update of updates) {
      if (!update.component_id || 
          typeof update.position_x !== 'number' ||
          typeof update.position_y !== 'number' ||
          typeof update.width !== 'number' ||
          typeof update.height !== 'number' ||
          typeof update.z_index !== 'number') {
        res.status(400).json({
          success: false,
          error: 'Each update must have component_id, position_x, position_y, width, height, and z_index',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    try {
      await canvasService.updateComponentPositions(updates, userId);

      res.json({
        success: true,
        message: `Updated ${updates.length} component positions`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error updating component positions:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update component positions',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/canvas/pages/:pageId/components
 * Create component on canvas
 */
router.post('/pages/:pageId/components',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { pageId } = req.params;
    const {
      component_type,
      component_name,
      flutter_widget_name,
      position_x,
      position_y,
      width,
      height,
      properties,
      styling,
    } = req.body;

    // Validate required fields
    if (!component_type || !component_name || !flutter_widget_name) {
      res.status(400).json({
        success: false,
        error: 'component_type, component_name, and flutter_widget_name are required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (typeof position_x !== 'number' || typeof position_y !== 'number') {
      res.status(400).json({
        success: false,
        error: 'position_x and position_y must be numbers',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const componentId = await canvasService.createComponent(
        pageId,
        {
          component_type,
          component_name,
          flutter_widget_name,
          position_x,
          position_y,
          width: width || 100,
          height: height || 50,
          properties,
          styling,
        },
        userId
      );

      res.status(201).json({
        success: true,
        data: { component_id: componentId },
        message: 'Component created successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error creating component on canvas:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create component',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * DELETE /api/apps/:appId/canvas/components/:componentId
 * Delete component from canvas
 */
router.delete('/components/:componentId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { componentId } = req.params;

    try {
      await canvasService.deleteComponent(componentId, userId);

      res.json({
        success: true,
        message: 'Component deleted successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error deleting component from canvas:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete component',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/canvas/components/:componentId/duplicate
 * Duplicate component on canvas
 */
router.post('/components/:componentId/duplicate',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { componentId } = req.params;

    try {
      const newComponentId = await canvasService.duplicateComponent(componentId, userId);

      res.status(201).json({
        success: true,
        data: { component_id: newComponentId },
        message: 'Component duplicated successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error duplicating component:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to duplicate component',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * PUT /api/apps/:appId/canvas/viewport
 * Update canvas viewport (zoom, pan)
 */
router.put('/viewport',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { x, y, zoom } = req.body;

    if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') {
      res.status(400).json({
        success: false,
        error: 'x, y, and zoom must be numbers',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (zoom < 0.1 || zoom > 5) {
      res.status(400).json({
        success: false,
        error: 'zoom must be between 0.1 and 5',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      await canvasService.updateViewport(appId, { x, y, zoom }, userId);

      res.json({
        success: true,
        message: 'Viewport updated successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error updating canvas viewport:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update viewport',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/canvas/grid-settings
 * Get canvas grid settings
 */
router.get('/grid-settings',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      const settings = await canvasService.getGridSettings(userId);

      res.json({
        success: true,
        data: settings,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting grid settings:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get grid settings',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * PUT /api/apps/:appId/canvas/grid-settings
 * Update canvas grid settings
 */
router.put('/grid-settings',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { enabled, size, snap_enabled, snap_threshold } = req.body;

    if (typeof enabled !== 'boolean' ||
        typeof snap_enabled !== 'boolean' ||
        typeof size !== 'number' ||
        typeof snap_threshold !== 'number') {
      res.status(400).json({
        success: false,
        error: 'Invalid grid settings format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (size < 1 || size > 100) {
      res.status(400).json({
        success: false,
        error: 'Grid size must be between 1 and 100',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      await canvasService.updateGridSettings(userId, {
        enabled,
        size,
        snap_enabled,
        snap_threshold,
      });

      res.json({
        success: true,
        message: 'Grid settings updated successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error updating grid settings:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update grid settings',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/canvas/component-library
 * Get component library for canvas toolbox
 */
router.get('/component-library',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    try {
      const library = await canvasService.getComponentLibrary();

      res.json({
        success: true,
        data: library,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting component library:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get component library',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;