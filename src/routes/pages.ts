import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { CreatePageRequest, AppPage } from '@/types/app-development';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/apps/:appId/pages
 * Get all pages for an app
 */
router.get('/',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id, user_id')
      .eq('id', appId)
      .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
      .single();

    if (!app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { data: pages, error } = await supabase.serviceClient
      .from('app_pages')
      .select(`
        *,
        _count_components:page_components(count)
      `)
      .eq('app_id', appId)
      .order('created_at');

    if (error) {
      logger.error('Error fetching pages:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch pages',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: pages,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /api/apps/:appId/pages/:pageId
 * Get a specific page with components
 */
router.get('/:pageId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId } = req.params;

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id')
      .eq('id', appId)
      .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
      .single();

    if (!app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { data: page, error } = await supabase.serviceClient
      .from('app_pages')
      .select(`
        *,
        page_components(
          *,
          component_library(name, category, flutter_widget_name)
        )
      `)
      .eq('id', pageId)
      .eq('app_id', appId)
      .single();

    if (error || !page) {
      res.status(404).json({
        success: false,
        error: 'Page not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: page,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/apps/:appId/pages
 * Create a new page
 */
router.post('/',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const pageData: CreatePageRequest = req.body;

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id')
      .eq('id', appId)
      .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
      .single();

    if (!app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate required fields
    if (!pageData.name || !pageData.title || !pageData.route_path) {
      res.status(400).json({
        success: false,
        error: 'Name, title, and route_path are required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check for duplicate route paths
    const { data: existingPage } = await supabase.serviceClient
      .from('app_pages')
      .select('id')
      .eq('app_id', appId)
      .eq('route_path', pageData.route_path)
      .single();

    if (existingPage) {
      res.status(400).json({
        success: false,
        error: 'Route path already exists',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { data: page, error } = await supabase.serviceClient
      .from('app_pages')
      .insert({
        app_id: appId,
        ...pageData,
      })
      .select()
      .single();

    if (error) {
      logger.error('Error creating page:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create page',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Create canvas node for visual representation
    await supabase.serviceClient
      .from('canvas_nodes')
      .insert({
        app_id: appId,
        page_id: page.id,
        title: page.title,
        description: page.description,
        node_type: 'page',
        position_x: Math.random() * 800,
        position_y: Math.random() * 600,
      });

    // Log activity
    await supabase.serviceClient
      .from('app_activity_log')
      .insert({
        app_id: appId,
        user_id: userId,
        action_type: 'page_created',
        action_description: `Created page: ${page.name}`,
        affected_entity: page.id,
        after_state: page,
      });

    res.status(201).json({
      success: true,
      data: page,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * PUT /api/apps/:appId/pages/:pageId
 * Update a page
 */
router.put('/:pageId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId } = req.params;
    const updateData = req.body;

    // Verify access
    const { data: page } = await supabase.serviceClient
      .from('app_pages')
      .select('*, apps!inner(user_id)')
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

    const { data: updatedPage, error } = await supabase.serviceClient
      .from('app_pages')
      .update({
        ...updateData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', pageId)
      .select()
      .single();

    if (error) {
      logger.error('Error updating page:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update page',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Update canvas node
    await supabase.serviceClient
      .from('canvas_nodes')
      .update({
        title: updatedPage.title,
        description: updatedPage.description,
      })
      .eq('page_id', pageId);

    // Log activity
    await supabase.serviceClient
      .from('app_activity_log')
      .insert({
        app_id: appId,
        user_id: userId,
        action_type: 'page_updated',
        action_description: `Updated page: ${updatedPage.name}`,
        affected_entity: pageId,
        before_state: page,
        after_state: updatedPage,
      });

    res.json({
      success: true,
      data: updatedPage,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * DELETE /api/apps/:appId/pages/:pageId
 * Delete a page
 */
router.delete('/:pageId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, pageId } = req.params;

    // Verify access and prevent deleting home page
    const { data: page } = await supabase.serviceClient
      .from('app_pages')
      .select('*, apps!inner(user_id)')
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

    if (page.is_home_page) {
      res.status(400).json({
        success: false,
        error: 'Cannot delete home page',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { error } = await supabase.serviceClient
      .from('app_pages')
      .delete()
      .eq('id', pageId);

    if (error) {
      logger.error('Error deleting page:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete page',
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
        action_type: 'page_deleted',
        action_description: `Deleted page: ${page.name}`,
        affected_entity: pageId,
        before_state: page,
      });

    res.json({
      success: true,
      message: 'Page deleted successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

export default router;