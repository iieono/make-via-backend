import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { CreateComponentRequest, PageComponent } from '@/types/app-development';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/apps/:appId/pages/:pageId/components
 * Get all components for a page
 */
router.get('/',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId } = req.params;

    // Verify access
    const { data: page } = await supabase.serviceClient
      .from('app_pages')
      .select('id, apps!inner(user_id)')
      .eq('id', pageId)
      .eq('app_id', appId)
      .single();

    if (!page) {
      res.status(404).json({
        success: false,
        error: 'Page not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { data: components, error } = await supabase.serviceClient
      .from('page_components')
      .select(`
        *,
        component_library(name, category, flutter_widget_name, properties_schema, default_properties)
      `)
      .eq('page_id', pageId)
      .order('z_index', { ascending: true });

    if (error) {
      logger.error('Error fetching components:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch components',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: components,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /api/apps/:appId/pages/:pageId/components/:componentId
 * Get a specific component
 */
router.get('/:componentId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId, componentId } = req.params;

    const { data: component, error } = await supabase.serviceClient
      .from('page_components')
      .select(`
        *,
        component_library(*),
        app_pages!inner(app_id, apps!inner(user_id))
      `)
      .eq('id', componentId)
      .eq('page_id', pageId)
      .single();

    if (error || !component) {
      res.status(404).json({
        success: false,
        error: 'Component not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: component,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/apps/:appId/pages/:pageId/components
 * Create a new component
 */
router.post('/',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId } = req.params;
    const componentData: CreateComponentRequest = req.body;

    // Verify access
    const { data: page } = await supabase.serviceClient
      .from('app_pages')
      .select('id, name, apps!inner(user_id)')
      .eq('id', pageId)
      .eq('app_id', appId)
      .single();

    if (!page) {
      res.status(404).json({
        success: false,
        error: 'Page not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate required fields
    if (!componentData.component_type || !componentData.component_name || !componentData.flutter_widget_name) {
      res.status(400).json({
        success: false,
        error: 'component_type, component_name, and flutter_widget_name are required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get next z_index
    const { data: maxZComponent } = await supabase.serviceClient
      .from('page_components')
      .select('z_index')
      .eq('page_id', pageId)
      .order('z_index', { ascending: false })
      .limit(1)
      .single();

    const nextZIndex = maxZComponent ? maxZComponent.z_index + 1 : 0;

    // Get component library defaults if provided
    let defaultProperties = {};
    if (componentData.component_library_id) {
      const { data: libraryComponent } = await supabase.serviceClient
        .from('component_library')
        .select('default_properties')
        .eq('id', componentData.component_library_id)
        .single();
      
      if (libraryComponent) {
        defaultProperties = libraryComponent.default_properties || {};
      }
    }

    const { data: component, error } = await supabase.serviceClient
      .from('page_components')
      .insert({
        page_id: pageId,
        component_library_id: componentData.component_library_id,
        component_type: componentData.component_type,
        component_name: componentData.component_name,
        flutter_widget_name: componentData.flutter_widget_name,
        position_x: componentData.position_x,
        position_y: componentData.position_y,
        width: componentData.width || 100,
        height: componentData.height || 50,
        z_index: nextZIndex,
        properties: { ...defaultProperties, ...(componentData.properties || {}) },
        styling: componentData.styling || {},
      })
      .select()
      .single();

    if (error) {
      logger.error('Error creating component:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create component',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Log activity
    await supabase.serviceClient
      .from('app_activity_log')
      .insert({
        app_id: appId,
        user_id: userId,
        action_type: 'component_created',
        action_description: `Added ${componentData.component_type} component to ${page.name}`,
        affected_entity: component.id,
        after_state: component,
      });

    res.status(201).json({
      success: true,
      data: component,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * PUT /api/apps/:appId/pages/:pageId/components/:componentId
 * Update a component
 */
router.put('/:componentId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId, componentId } = req.params;
    const updateData = req.body;

    // Verify access
    const { data: component } = await supabase.serviceClient
      .from('page_components')
      .select(`
        *,
        app_pages!inner(name, app_id, apps!inner(user_id))
      `)
      .eq('id', componentId)
      .eq('page_id', pageId)
      .single();

    if (!component) {
      res.status(404).json({
        success: false,
        error: 'Component not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { data: updatedComponent, error } = await supabase.serviceClient
      .from('page_components')
      .update({
        ...updateData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', componentId)
      .select()
      .single();

    if (error) {
      logger.error('Error updating component:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update component',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Log activity for significant changes
    if (updateData.properties || updateData.position_x !== undefined || updateData.position_y !== undefined) {
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'component_updated',
          action_description: `Updated ${component.component_type} component`,
          affected_entity: componentId,
          before_state: component,
          after_state: updatedComponent,
        });
    }

    res.json({
      success: true,
      data: updatedComponent,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * PUT /api/apps/:appId/pages/:pageId/components/:componentId/focus
 * Focus a component (for context-aware AI)
 */
router.put('/:componentId/focus',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId, componentId } = req.params;

    // Get component with full context
    const { data: component, error } = await supabase.serviceClient
      .from('page_components')
      .select(`
        *,
        component_library(*),
        app_pages!inner(
          *,
          apps!inner(*)
        )
      `)
      .eq('id', componentId)
      .eq('page_id', pageId)
      .single();

    if (error || !component) {
      res.status(404).json({
        success: false,
        error: 'Component not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get related components on the same page
    const { data: pageComponents } = await supabase.serviceClient
      .from('page_components')
      .select('id, component_type, component_name, position_x, position_y')
      .eq('page_id', pageId)
      .neq('id', componentId);

    // Get all pages in the app for navigation context
    const { data: appPages } = await supabase.serviceClient
      .from('app_pages')
      .select('id, name, route_path, page_type')
      .eq('app_id', appId);

    // Create context for AI prompting
    const context = {
      focused_component: component,
      page_components: pageComponents || [],
      app_pages: appPages || [],
      app: component.app_pages.apps,
      page: {
        id: component.app_pages.id,
        name: component.app_pages.name,
        title: component.app_pages.title,
        page_type: component.app_pages.page_type,
      },
    };

    res.json({
      success: true,
      data: context,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * DELETE /api/apps/:appId/pages/:pageId/components/:componentId
 * Delete a component
 */
router.delete('/:componentId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId, componentId } = req.params;

    // Verify access
    const { data: component } = await supabase.serviceClient
      .from('page_components')
      .select(`
        *,
        app_pages!inner(name, apps!inner(user_id))
      `)
      .eq('id', componentId)
      .eq('page_id', pageId)
      .single();

    if (!component) {
      res.status(404).json({
        success: false,
        error: 'Component not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { error } = await supabase.serviceClient
      .from('page_components')
      .delete()
      .eq('id', componentId);

    if (error) {
      logger.error('Error deleting component:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete component',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Log activity
    await supabase.serviceClient
      .from('app_activity_log')
      .insert({
        app_id: appId,
        user_id: userId,
        action_type: 'component_deleted',
        action_description: `Deleted ${component.component_type} component`,
        affected_entity: componentId,
        before_state: component,
      });

    res.json({
      success: true,
      message: 'Component deleted successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/apps/:appId/pages/:pageId/components/bulk-update
 * Bulk update component positions (for drag-and-drop)
 */
router.post('/bulk-update',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId } = req.params;
    const { updates } = req.body; // Array of {id, position_x, position_y, z_index}

    if (!Array.isArray(updates)) {
      res.status(400).json({
        success: false,
        error: 'Updates must be an array',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify page access
    const { data: page } = await supabase.serviceClient
      .from('app_pages')
      .select('id, apps!inner(user_id)')
      .eq('id', pageId)
      .eq('app_id', appId)
      .single();

    if (!page) {
      res.status(404).json({
        success: false,
        error: 'Page not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Perform bulk updates
    const updatePromises = updates.map(update => 
      supabase.serviceClient
        .from('page_components')
        .update({
          position_x: update.position_x,
          position_y: update.position_y,
          z_index: update.z_index,
          updated_at: new Date().toISOString(),
        })
        .eq('id', update.id)
        .eq('page_id', pageId)
    );

    try {
      await Promise.all(updatePromises);
    } catch (error) {
      logger.error('Error bulk updating components:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update components',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Log activity
    await supabase.serviceClient
      .from('app_activity_log')
      .insert({
        app_id: appId,
        user_id: userId,
        action_type: 'components_repositioned',
        action_description: `Repositioned ${updates.length} components`,
        affected_entity: pageId,
      });

    res.json({
      success: true,
      message: `Updated ${updates.length} components`,
      timestamp: new Date().toISOString(),
    });
  })
);

export default router;