import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import type { 
  PageConnection,
  PageConnectionType,
  PageConnectionsResponse
} from '@/types/app-development';

class PageConnectionsService {

  /**
   * Detect and create page connections automatically
   */
  async detectPageConnections(appId: string): Promise<PageConnection[]> {
    try {
      // Use the database function to detect connections
      const { error } = await supabase.serviceClient.rpc('detect_page_connections', {
        app_uuid: appId
      });

      if (error) {
        throw error;
      }

      // Get the newly detected connections
      const connections = await this.getPageConnections(appId);
      
      logger.info(`Detected ${connections.length} page connections for app ${appId}`);
      return connections;
    } catch (error) {
      logger.error('Error detecting page connections:', error);
      throw error;
    }
  }

  /**
   * Get all page connections for an app
   */
  async getPageConnections(appId: string): Promise<PageConnection[]> {
    try {
      const { data: connections, error } = await supabase.serviceClient
        .from('page_connections')
        .select(`
          id,
          app_id,
          from_page_id,
          to_page_id,
          connection_type,
          connection_data,
          is_auto_detected,
          detected_at,
          created_by_user_id,
          created_at,
          updated_at
        `)
        .eq('app_id', appId)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return connections || [];
    } catch (error) {
      logger.error('Error getting page connections:', error);
      throw error;
    }
  }

  /**
   * Get page connections with navigation graph
   */
  async getPageConnectionsWithGraph(appId: string): Promise<PageConnectionsResponse> {
    try {
      // Get connections and pages
      const [connectionsResult, pagesResult] = await Promise.all([
        supabase.serviceClient
          .from('page_connections')
          .select(`
            id,
            app_id,
            from_page_id,
            to_page_id,
            connection_type,
            connection_data,
            is_auto_detected,
            detected_at,
            created_by_user_id,
            created_at,
            updated_at
          `)
          .eq('app_id', appId),
        
        supabase.serviceClient
          .from('app_pages')
          .select('id, name, page_type, route_path')
          .eq('app_id', appId)
      ]);

      if (connectionsResult.error) {
        throw connectionsResult.error;
      }
      if (pagesResult.error) {
        throw pagesResult.error;
      }

      const connections = connectionsResult.data || [];
      const pages = pagesResult.data || [];

      // Build navigation graph
      const nodes = pages.map(page => ({
        id: page.id,
        label: page.name,
        type: page.page_type,
        route: page.route_path
      }));

      const edges = connections.map(conn => ({
        from: conn.from_page_id,
        to: conn.to_page_id,
        type: conn.connection_type,
        label: this.getConnectionLabel(conn.connection_type, conn.connection_data)
      }));

      return {
        connections,
        navigation_graph: {
          nodes,
          edges
        }
      };
    } catch (error) {
      logger.error('Error getting page connections with graph:', error);
      throw error;
    }
  }

  /**
   * Create a manual page connection
   */
  async createPageConnection(
    appId: string,
    fromPageId: string,
    toPageId: string,
    connectionType: PageConnectionType,
    connectionData: Record<string, any> = {},
    createdByUserId: string
  ): Promise<string> {
    try {
      // Verify pages exist and belong to the app
      const { data: pages, error: pagesError } = await supabase.serviceClient
        .from('app_pages')
        .select('id')
        .eq('app_id', appId)
        .in('id', [fromPageId, toPageId]);

      if (pagesError || !pages || pages.length !== 2) {
        throw new Error('Invalid page IDs or pages do not belong to the app');
      }

      // Check if connection already exists
      const { data: existingConnection } = await supabase.serviceClient
        .from('page_connections')
        .select('id')
        .eq('app_id', appId)
        .eq('from_page_id', fromPageId)
        .eq('to_page_id', toPageId)
        .eq('connection_type', connectionType)
        .single();

      if (existingConnection) {
        throw new Error('Connection already exists between these pages');
      }

      // Create the connection
      const { data: connection, error } = await supabase.serviceClient
        .from('page_connections')
        .insert({
          app_id: appId,
          from_page_id: fromPageId,
          to_page_id: toPageId,
          connection_type: connectionType,
          connection_data: connectionData,
          is_auto_detected: false,
          created_by_user_id: createdByUserId
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      logger.info(`Created manual page connection between ${fromPageId} and ${toPageId} in app ${appId}`);
      return connection.id;
    } catch (error) {
      logger.error('Error creating page connection:', error);
      throw error;
    }
  }

  /**
   * Delete a page connection
   */
  async deletePageConnection(connectionId: string, userId: string): Promise<void> {
    try {
      // Get connection details to verify access
      const { data: connection, error: fetchError } = await supabase.serviceClient
        .from('page_connections')
        .select('app_id, is_auto_detected')
        .eq('id', connectionId)
        .single();

      if (fetchError || !connection) {
        throw new Error('Connection not found');
      }

      // Verify user has access to the app
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('user_id')
        .eq('id', connection.app_id)
        .single();

      if (!app || app.user_id !== userId) {
        // Check if user is a collaborator with editor+ access
        const { data: collaborator } = await supabase.serviceClient
          .from('app_collaborators')
          .select('role')
          .eq('app_id', connection.app_id)
          .eq('user_id', userId)
          .eq('is_active', true)
          .single();

        if (!collaborator || collaborator.role === 'viewer') {
          throw new Error('Insufficient permissions to delete connection');
        }
      }

      // Delete the connection
      const { error } = await supabase.serviceClient
        .from('page_connections')
        .delete()
        .eq('id', connectionId);

      if (error) {
        throw error;
      }

      logger.info(`Deleted page connection ${connectionId} by user ${userId}`);
    } catch (error) {
      logger.error('Error deleting page connection:', error);
      throw error;
    }
  }

  /**
   * Update page connection data
   */
  async updatePageConnection(
    connectionId: string,
    connectionData: Record<string, any>,
    userId: string
  ): Promise<void> {
    try {
      // Get connection details to verify access
      const { data: connection, error: fetchError } = await supabase.serviceClient
        .from('page_connections')
        .select('app_id')
        .eq('id', connectionId)
        .single();

      if (fetchError || !connection) {
        throw new Error('Connection not found');
      }

      // Verify user has access to the app
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('user_id')
        .eq('id', connection.app_id)
        .single();

      if (!app || app.user_id !== userId) {
        // Check if user is a collaborator with editor+ access
        const { data: collaborator } = await supabase.serviceClient
          .from('app_collaborators')
          .select('role')
          .eq('app_id', connection.app_id)
          .eq('user_id', userId)
          .eq('is_active', true)
          .single();

        if (!collaborator || collaborator.role === 'viewer') {
          throw new Error('Insufficient permissions to update connection');
        }
      }

      // Update the connection
      const { error } = await supabase.serviceClient
        .from('page_connections')
        .update({
          connection_data: connectionData,
          updated_at: new Date().toISOString()
        })
        .eq('id', connectionId);

      if (error) {
        throw error;
      }

      logger.info(`Updated page connection ${connectionId} by user ${userId}`);
    } catch (error) {
      logger.error('Error updating page connection:', error);
      throw error;
    }
  }

  /**
   * Get page connections by type
   */
  async getConnectionsByType(appId: string, connectionType: PageConnectionType): Promise<PageConnection[]> {
    try {
      const { data: connections, error } = await supabase.serviceClient
        .from('page_connections')
        .select(`
          id,
          app_id,
          from_page_id,
          to_page_id,
          connection_type,
          connection_data,
          is_auto_detected,
          detected_at,
          created_by_user_id,
          created_at,
          updated_at
        `)
        .eq('app_id', appId)
        .eq('connection_type', connectionType)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return connections || [];
    } catch (error) {
      logger.error('Error getting connections by type:', error);
      throw error;
    }
  }

  /**
   * Get connections for a specific page
   */
  async getPageConnections_ForPage(appId: string, pageId: string): Promise<{
    outgoing: PageConnection[];
    incoming: PageConnection[];
  }> {
    try {
      const [outgoingResult, incomingResult] = await Promise.all([
        supabase.serviceClient
          .from('page_connections')
          .select(`
            id,
            app_id,
            from_page_id,
            to_page_id,
            connection_type,
            connection_data,
            is_auto_detected,
            detected_at,
            created_by_user_id,
            created_at,
            updated_at
          `)
          .eq('app_id', appId)
          .eq('from_page_id', pageId),
        
        supabase.serviceClient
          .from('page_connections')
          .select(`
            id,
            app_id,
            from_page_id,
            to_page_id,
            connection_type,
            connection_data,
            is_auto_detected,
            detected_at,
            created_by_user_id,
            created_at,
            updated_at
          `)
          .eq('app_id', appId)
          .eq('to_page_id', pageId)
      ]);

      if (outgoingResult.error) {
        throw outgoingResult.error;
      }
      if (incomingResult.error) {
        throw incomingResult.error;
      }

      return {
        outgoing: outgoingResult.data || [],
        incoming: incomingResult.data || []
      };
    } catch (error) {
      logger.error('Error getting connections for page:', error);
      throw error;
    }
  }

  /**
   * Generate app navigation report
   */
  async generateNavigationReport(appId: string): Promise<any> {
    try {
      const { connections, navigation_graph } = await this.getPageConnectionsWithGraph(appId);

      // Analyze navigation patterns
      const connectionsByType = connections.reduce((acc, conn) => {
        acc[conn.connection_type] = (acc[conn.connection_type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const autoDetectedCount = connections.filter(c => c.is_auto_detected).length;
      const manualCount = connections.length - autoDetectedCount;

      // Find isolated pages (no connections)
      const connectedPageIds = new Set([
        ...connections.map(c => c.from_page_id),
        ...connections.map(c => c.to_page_id)
      ]);
      
      const isolatedPages = navigation_graph.nodes.filter(
        node => !connectedPageIds.has(node.id)
      );

      // Find hub pages (most connections)
      const pageConnectionCounts = navigation_graph.nodes.map(node => {
        const outgoingCount = connections.filter(c => c.from_page_id === node.id).length;
        const incomingCount = connections.filter(c => c.to_page_id === node.id).length;
        return {
          page: node,
          outgoing: outgoingCount,
          incoming: incomingCount,
          total: outgoingCount + incomingCount
        };
      }).sort((a, b) => b.total - a.total);

      return {
        summary: {
          total_pages: navigation_graph.nodes.length,
          total_connections: connections.length,
          auto_detected: autoDetectedCount,
          manual: manualCount,
          isolated_pages: isolatedPages.length
        },
        connections_by_type: connectionsByType,
        isolated_pages: isolatedPages,
        hub_pages: pageConnectionCounts.slice(0, 5), // Top 5 most connected pages
        navigation_graph
      };
    } catch (error) {
      logger.error('Error generating navigation report:', error);
      throw error;
    }
  }

  /**
   * Bulk delete auto-detected connections
   */
  async clearAutoDetectedConnections(appId: string): Promise<number> {
    try {
      const { data, error } = await supabase.serviceClient
        .from('page_connections')
        .delete()
        .eq('app_id', appId)
        .eq('is_auto_detected', true)
        .select('id');

      if (error) {
        throw error;
      }

      const deletedCount = data?.length || 0;
      logger.info(`Cleared ${deletedCount} auto-detected connections for app ${appId}`);
      return deletedCount;
    } catch (error) {
      logger.error('Error clearing auto-detected connections:', error);
      throw error;
    }
  }

  /**
   * Get connection statistics for an app
   */
  async getConnectionStats(appId: string): Promise<any> {
    try {
      const connections = await this.getPageConnections(appId);
      
      const stats = {
        total: connections.length,
        by_type: {} as Record<string, number>,
        auto_detected: connections.filter(c => c.is_auto_detected).length,
        manual: connections.filter(c => !c.is_auto_detected).length,
        recent_24h: connections.filter(c => 
          new Date(c.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
        ).length
      };

      // Count by type
      connections.forEach(conn => {
        stats.by_type[conn.connection_type] = (stats.by_type[conn.connection_type] || 0) + 1;
      });

      return stats;
    } catch (error) {
      logger.error('Error getting connection stats:', error);
      return {
        total: 0,
        by_type: {},
        auto_detected: 0,
        manual: 0,
        recent_24h: 0
      };
    }
  }

  /**
   * Helper: Get display label for connection type
   */
  private getConnectionLabel(connectionType: PageConnectionType, connectionData: Record<string, any>): string {
    switch (connectionType) {
      case 'navigation':
        return connectionData.label || 'Navigate';
      case 'tab_group':
        return 'Tab';
      case 'modal_parent':
        return 'Modal';
      case 'flow_sequence':
        return `Step ${connectionData.step || ''}`;
      case 'shared_component':
        return 'Shared';
      default:
        return connectionType;
    }
  }
}

const pageConnectionsService = new PageConnectionsService();
export { PageConnectionsService };
export default pageConnectionsService;