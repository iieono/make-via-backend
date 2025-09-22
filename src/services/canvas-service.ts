import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import type { 
  AppPage, 
  PageComponent, 
  CanvasNode,
  CanvasConnection,
  CanvasState,
  ComponentUpdate
} from '@/types/app-development';

export class CanvasService {

  /**
   * Get canvas state for an app
   */
  async getCanvasState(appId: string, userId: string): Promise<CanvasState> {
    try {
      // Verify app access
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id, name')
        .eq('id', appId)
        .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
        .single();

      if (!app) {
        throw new Error('App not found or access denied');
      }

      // Get canvas nodes (page representations)
      const { data: nodes } = await supabase.serviceClient
        .from('canvas_nodes')
        .select('*')
        .eq('app_id', appId)
        .order('created_at');

      // Get canvas connections (page navigation)
      const { data: connections } = await supabase.serviceClient
        .from('canvas_connections')
        .select('*')
        .eq('app_id', appId);

      // Get all pages with component counts
      const { data: pages } = await supabase.serviceClient
        .from('app_pages')
        .select(`
          *,
          _count_components:page_components(count)
        `)
        .eq('app_id', appId)
        .order('created_at');

      return {
        app_id: appId,
        app_name: app.name,
        nodes: nodes || [],
        connections: connections || [],
        pages: pages || [],
        viewport: {
          x: 0,
          y: 0,
          zoom: 1.0,
        },
        selection: {
          type: 'none',
          selected_items: [],
        },
      };
    } catch (error) {
      logger.error('Error getting canvas state:', error);
      throw error;
    }
  }

  /**
   * Update canvas node position
   */
  async updateNodePosition(
    nodeId: string,
    position: { x: number; y: number },
    userId: string
  ): Promise<void> {
    try {
      const { error } = await supabase.serviceClient
        .from('canvas_nodes')
        .update({
          position_x: position.x,
          position_y: position.y,
          updated_at: new Date().toISOString(),
        })
        .eq('id', nodeId);

      if (error) {
        throw error;
      }

      logger.info(`Canvas node ${nodeId} position updated by user ${userId}`);
    } catch (error) {
      logger.error('Error updating node position:', error);
      throw error;
    }
  }

  /**
   * Create canvas connection between pages
   */
  async createConnection(
    appId: string,
    fromNodeId: string,
    toNodeId: string,
    connectionData: {
      trigger_type: 'navigation' | 'action' | 'condition';
      trigger_config: Record<string, any>;
      animation_type?: string;
    },
    userId: string
  ): Promise<string> {
    try {
      const { data: connection, error } = await supabase.serviceClient
        .from('canvas_connections')
        .insert({
          app_id: appId,
          from_node_id: fromNodeId,
          to_node_id: toNodeId,
          connection_type: connectionData.trigger_type,
          trigger_config: connectionData.trigger_config,
          animation_config: {
            type: connectionData.animation_type || 'slide',
            duration: 300,
          },
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'canvas_connection_created',
          action_description: `Created ${connectionData.trigger_type} connection between pages`,
          affected_entity: connection.id,
        });

      logger.info(`Canvas connection created between ${fromNodeId} and ${toNodeId}`);
      return connection.id;
    } catch (error) {
      logger.error('Error creating canvas connection:', error);
      throw error;
    }
  }

  /**
   * Delete canvas connection
   */
  async deleteConnection(connectionId: string, userId: string): Promise<void> {
    try {
      const { error } = await supabase.serviceClient
        .from('canvas_connections')
        .delete()
        .eq('id', connectionId);

      if (error) {
        throw error;
      }

      logger.info(`Canvas connection ${connectionId} deleted by user ${userId}`);
    } catch (error) {
      logger.error('Error deleting canvas connection:', error);
      throw error;
    }
  }

  /**
   * Get page components with positioning for canvas view
   */
  async getPageComponents(pageId: string, userId: string): Promise<PageComponent[]> {
    try {
      // Verify page access
      const { data: page } = await supabase.serviceClient
        .from('app_pages')
        .select('id, app_id, apps!inner(user_id)')
        .eq('id', pageId)
        .single();

      if (!page) {
        throw new Error('Page not found');
      }

      const { data: components, error } = await supabase.serviceClient
        .from('page_components')
        .select(`
          *,
          component_library(name, category, flutter_widget_name, properties_schema)
        `)
        .eq('page_id', pageId)
        .order('z_index');

      if (error) {
        throw error;
      }

      return components || [];
    } catch (error) {
      logger.error('Error getting page components:', error);
      throw error;
    }
  }

  /**
   * Update component positioning for drag and drop
   */
  async updateComponentPositions(
    updates: ComponentUpdate[],
    userId: string
  ): Promise<void> {
    try {
      const updatePromises = updates.map(update => 
        supabase.serviceClient
          .from('page_components')
          .update({
            position_x: update.position_x,
            position_y: update.position_y,
            width: update.width,
            height: update.height,
            z_index: update.z_index,
            updated_at: new Date().toISOString(),
          })
          .eq('id', update.component_id)
      );

      await Promise.all(updatePromises);

      logger.info(`Updated positions for ${updates.length} components by user ${userId}`);
    } catch (error) {
      logger.error('Error updating component positions:', error);
      throw error;
    }
  }

  /**
   * Create component on canvas
   */
  async createComponent(
    pageId: string,
    componentData: {
      component_type: string;
      component_name: string;
      flutter_widget_name: string;
      position_x: number;
      position_y: number;
      width: number;
      height: number;
      properties?: Record<string, any>;
      styling?: Record<string, any>;
    },
    userId: string
  ): Promise<string> {
    try {
      // Verify page access
      const { data: page } = await supabase.serviceClient
        .from('app_pages')
        .select('id, app_id, apps!inner(user_id)')
        .eq('id', pageId)
        .single();

      if (!page) {
        throw new Error('Page not found');
      }

      // Get next z-index
      const { data: maxZComponent } = await supabase.serviceClient
        .from('page_components')
        .select('z_index')
        .eq('page_id', pageId)
        .order('z_index', { ascending: false })
        .limit(1)
        .single();

      const nextZIndex = maxZComponent ? maxZComponent.z_index + 1 : 0;

      const { data: component, error } = await supabase.serviceClient
        .from('page_components')
        .insert({
          page_id: pageId,
          component_type: componentData.component_type,
          component_name: componentData.component_name,
          flutter_widget_name: componentData.flutter_widget_name,
          position_x: componentData.position_x,
          position_y: componentData.position_y,
          width: componentData.width,
          height: componentData.height,
          z_index: nextZIndex,
          properties: componentData.properties || {},
          styling: componentData.styling || {},
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: page.app_id,
          user_id: userId,
          action_type: 'component_created_on_canvas',
          action_description: `Created ${componentData.component_type} component on canvas`,
          affected_entity: component.id,
        });

      logger.info(`Component ${component.id} created on canvas for page ${pageId}`);
      return component.id;
    } catch (error) {
      logger.error('Error creating component on canvas:', error);
      throw error;
    }
  }

  /**
   * Delete component from canvas
   */
  async deleteComponent(componentId: string, userId: string): Promise<void> {
    try {
      // Get component info for logging
      const { data: component } = await supabase.serviceClient
        .from('page_components')
        .select('component_type, app_pages!inner(app_id)')
        .eq('id', componentId)
        .single();

      const { error } = await supabase.serviceClient
        .from('page_components')
        .delete()
        .eq('id', componentId);

      if (error) {
        throw error;
      }

      // Log activity
      if (component) {
        await supabase.serviceClient
          .from('app_activity_log')
          .insert({
            app_id: component.app_pages.app_id,
            user_id: userId,
            action_type: 'component_deleted_from_canvas',
            action_description: `Deleted ${component.component_type} component from canvas`,
            affected_entity: componentId,
          });
      }

      logger.info(`Component ${componentId} deleted from canvas by user ${userId}`);
    } catch (error) {
      logger.error('Error deleting component from canvas:', error);
      throw error;
    }
  }

  /**
   * Duplicate component on canvas
   */
  async duplicateComponent(componentId: string, userId: string): Promise<string> {
    try {
      // Get original component
      const { data: original, error: fetchError } = await supabase.serviceClient
        .from('page_components')
        .select('*')
        .eq('id', componentId)
        .single();

      if (fetchError || !original) {
        throw new Error('Component not found');
      }

      // Create duplicate with offset position
      const { data: duplicate, error: createError } = await supabase.serviceClient
        .from('page_components')
        .insert({
          page_id: original.page_id,
          component_library_id: original.component_library_id,
          component_type: original.component_type,
          component_name: `${original.component_name} Copy`,
          flutter_widget_name: original.flutter_widget_name,
          position_x: original.position_x + 20,
          position_y: original.position_y + 20,
          width: original.width,
          height: original.height,
          z_index: original.z_index + 1,
          properties: original.properties,
          styling: original.styling,
        })
        .select()
        .single();

      if (createError) {
        throw createError;
      }

      logger.info(`Component ${componentId} duplicated as ${duplicate.id} by user ${userId}`);
      return duplicate.id;
    } catch (error) {
      logger.error('Error duplicating component:', error);
      throw error;
    }
  }

  /**
   * Update canvas viewport (zoom, pan)
   */
  async updateViewport(
    appId: string,
    viewport: { x: number; y: number; zoom: number },
    userId: string
  ): Promise<void> {
    try {
      // Store viewport state in user preferences or app settings
      await supabase.serviceClient
        .from('user_preferences')
        .upsert({
          user_id: userId,
          preference_type: 'canvas_viewport',
          preference_key: `app_${appId}`,
          preference_value: viewport,
          updated_at: new Date().toISOString(),
        });

      logger.info(`Canvas viewport updated for app ${appId} by user ${userId}`);
    } catch (error) {
      logger.error('Error updating canvas viewport:', error);
      throw error;
    }
  }

  /**
   * Get canvas grid settings
   */
  async getGridSettings(userId: string): Promise<{
    enabled: boolean;
    size: number;
    snap_enabled: boolean;
    snap_threshold: number;
  }> {
    try {
      const { data: settings } = await supabase.serviceClient
        .from('user_preferences')
        .select('preference_value')
        .eq('user_id', userId)
        .eq('preference_type', 'canvas_grid')
        .single();

      const defaultSettings = {
        enabled: true,
        size: 8,
        snap_enabled: true,
        snap_threshold: 4,
      };

      return settings?.preference_value || defaultSettings;
    } catch (error) {
      logger.error('Error getting grid settings:', error);
      return {
        enabled: true,
        size: 8,
        snap_enabled: true,
        snap_threshold: 4,
      };
    }
  }

  /**
   * Update canvas grid settings
   */
  async updateGridSettings(
    userId: string,
    settings: {
      enabled: boolean;
      size: number;
      snap_enabled: boolean;
      snap_threshold: number;
    }
  ): Promise<void> {
    try {
      await supabase.serviceClient
        .from('user_preferences')
        .upsert({
          user_id: userId,
          preference_type: 'canvas_grid',
          preference_key: 'global',
          preference_value: settings,
          updated_at: new Date().toISOString(),
        });

      logger.info(`Canvas grid settings updated for user ${userId}`);
    } catch (error) {
      logger.error('Error updating grid settings:', error);
      throw error;
    }
  }

  /**
   * Get component library for canvas toolbox
   */
  async getComponentLibrary(): Promise<any[]> {
    try {
      const { data: components, error } = await supabase.serviceClient
        .from('component_library')
        .select('*')
        .eq('is_active', true)
        .order('category')
        .order('name');

      if (error) {
        throw error;
      }

      // Group by category
      const grouped = (components || []).reduce((acc, component) => {
        if (!acc[component.category]) {
          acc[component.category] = [];
        }
        acc[component.category].push(component);
        return acc;
      }, {} as Record<string, any[]>);

      return Object.entries(grouped).map(([category, items]) => ({
        category,
        components: items,
      }));
    } catch (error) {
      logger.error('Error getting component library:', error);
      throw error;
    }
  }
}

export default CanvasService;