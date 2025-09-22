import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';
import type { AppPreview, PreviewConfiguration } from '@/types';

class PreviewService {
  async createPreview(
    userId: string,
    appId: string,
    configuration: PreviewConfiguration
  ): Promise<AppPreview> {
    try {
      // Get app and verify ownership
      const app = await supabase.getAppById(appId, userId);
      if (!app) {
        throw new Error('App not found or access denied');
      }

      // Get all screens for the app
      const screens = await supabase.getAppScreens(appId);
      
      // Build preview data
      const previewData = {
        app: {
          id: app.id,
          name: app.name,
          description: app.description,
          primary_color: app.primary_color,
          theme_mode: app.theme_mode,
          config: app.config,
        },
        screens: screens.map(screen => ({
          id: screen.id,
          name: screen.name,
          screen_type: screen.screen_type,
          ui_structure: screen.ui_structure,
          styling: screen.styling,
          logic: screen.logic,
          canvas_x: screen.canvas_x,
          canvas_y: screen.canvas_y,
          is_start_screen: screen.is_start_screen,
          requires_auth: screen.requires_auth,
        })),
        configuration,
        generated_at: new Date().toISOString(),
      };

      // Create preview record
      const preview = await supabase.createPreview({
        app_id: appId,
        user_id: userId,
        preview_data: previewData,
        share_enabled: false,
        view_count: 0,
      });

      // Update app preview count
      await supabase.updateApp(appId, {
        preview_count: app.preview_count + 1,
        last_previewed_at: new Date().toISOString(),
      });

      logger.info(`Preview created for app ${appId} by user ${userId}`);
      return preview;

    } catch (error) {
      logger.error('Error creating preview:', error);
      throw error;
    }
  }

  async getPreview(previewId: string, userId?: string): Promise<AppPreview | null> {
    try {
      const preview = await supabase.getPreviewById(previewId);
      
      if (!preview) {
        return null;
      }

      // Check access permissions
      if (userId && preview.user_id !== userId && !preview.share_enabled) {
        throw new Error('Preview not found or access denied');
      }

      // Increment view count for shared previews
      if (!userId || preview.user_id !== userId) {
        await supabase.incrementPreviewViews(previewId);
      }

      return preview;

    } catch (error) {
      logger.error('Error fetching preview:', error);
      throw error;
    }
  }

  async getAppPreviews(
    userId: string,
    appId: string,
    limit = 10
  ): Promise<AppPreview[]> {
    try {
      // Verify app ownership
      const app = await supabase.getAppById(appId, userId);
      if (!app) {
        throw new Error('App not found or access denied');
      }

      return await supabase.getAppPreviews(appId, limit);

    } catch (error) {
      logger.error('Error fetching app previews:', error);
      throw error;
    }
  }

  async sharePreview(
    userId: string,
    previewId: string,
    expiresIn?: number // minutes
  ): Promise<{ share_token: string; share_url: string; expires_at?: string }> {
    try {
      const preview = await supabase.getPreviewById(previewId);
      
      if (!preview || preview.user_id !== userId) {
        throw new Error('Preview not found or access denied');
      }

      const shareToken = uuidv4();
      const expiresAt = expiresIn 
        ? new Date(Date.now() + expiresIn * 60 * 1000).toISOString()
        : undefined;

      // Update preview with sharing info
      await supabase.updatePreview(previewId, {
        share_token: shareToken,
        share_enabled: true,
        expires_at: expiresAt,
      });

      const shareUrl = `${process.env.FRONTEND_URL || 'https://app.makevia.com'}/preview/${shareToken}`;

      logger.info(`Preview shared: ${previewId} by user ${userId}`);

      return {
        share_token: shareToken,
        share_url: shareUrl,
        expires_at: expiresAt,
      };

    } catch (error) {
      logger.error('Error sharing preview:', error);
      throw error;
    }
  }

  async getSharedPreview(shareToken: string): Promise<AppPreview | null> {
    try {
      const preview = await supabase.getPreviewByShareToken(shareToken);
      
      if (!preview) {
        return null;
      }

      // Check if preview has expired
      if (preview.expires_at && new Date(preview.expires_at) < new Date()) {
        return null;
      }

      // Check if sharing is enabled
      if (!preview.share_enabled) {
        return null;
      }

      // Increment view count
      await supabase.incrementPreviewViews(preview.id);

      return preview;

    } catch (error) {
      logger.error('Error fetching shared preview:', error);
      throw error;
    }
  }

  async deletePreview(userId: string, previewId: string): Promise<void> {
    try {
      const preview = await supabase.getPreviewById(previewId);
      
      if (!preview || preview.user_id !== userId) {
        throw new Error('Preview not found or access denied');
      }

      await supabase.deletePreview(previewId);

      logger.info(`Preview deleted: ${previewId} by user ${userId}`);

    } catch (error) {
      logger.error('Error deleting preview:', error);
      throw error;
    }
  }

  async disableSharing(userId: string, previewId: string): Promise<void> {
    try {
      const preview = await supabase.getPreviewById(previewId);
      
      if (!preview || preview.user_id !== userId) {
        throw new Error('Preview not found or access denied');
      }

      await supabase.updatePreview(previewId, {
        share_enabled: false,
        share_token: null,
        expires_at: null,
      });

      logger.info(`Preview sharing disabled: ${previewId} by user ${userId}`);

    } catch (error) {
      logger.error('Error disabling preview sharing:', error);
      throw error;
    }
  }

  // Generate optimized preview data for mobile
  async getOptimizedPreviewData(previewId: string): Promise<any> {
    try {
      const preview = await supabase.getPreviewById(previewId);
      
      if (!preview) {
        throw new Error('Preview not found');
      }

      // Optimize data for mobile consumption
      const optimizedData = {
        ...preview.preview_data,
        screens: preview.preview_data.screens.map((screen: any) => ({
          ...screen,
          // Remove heavy data that mobile doesn't need immediately
          ui_structure: this.optimizeUIStructure(screen.ui_structure),
          // Keep styling minimal for initial load
          styling: this.optimizeStyling(screen.styling),
        })),
      };

      return optimizedData;

    } catch (error) {
      logger.error('Error getting optimized preview data:', error);
      throw error;
    }
  }

  private optimizeUIStructure(structure: any): any {
    // Remove non-essential properties for mobile preview
    if (typeof structure !== 'object' || !structure) {
      return structure;
    }

    const optimized = { ...structure };
    
    // Remove heavy properties
    delete optimized.metadata;
    delete optimized.debug_info;
    
    // Recursively optimize children
    if (optimized.children) {
      optimized.children = optimized.children.map((child: any) => 
        this.optimizeUIStructure(child)
      );
    }

    return optimized;
  }

  private optimizeStyling(styling: any): any {
    // Keep only essential styling for preview
    if (typeof styling !== 'object' || !styling) {
      return styling;
    }

    return {
      backgroundColor: styling.backgroundColor,
      textColor: styling.textColor,
      primaryColor: styling.primaryColor,
      fontFamily: styling.fontFamily,
      // Remove complex styling for initial load
    };
  }

  // Get preview analytics
  async getPreviewAnalytics(userId: string, appId: string): Promise<{
    total_previews: number;
    total_views: number;
    shared_previews: number;
    recent_activity: any[];
  }> {
    try {
      // Verify app ownership
      const app = await supabase.getAppById(appId, userId);
      if (!app) {
        throw new Error('App not found or access denied');
      }

      const previews = await supabase.getAppPreviews(appId, 100);

      const analytics = {
        total_previews: previews.length,
        total_views: previews.reduce((sum, p) => sum + p.view_count, 0),
        shared_previews: previews.filter(p => p.share_enabled).length,
        recent_activity: previews
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, 10)
          .map(p => ({
            id: p.id,
            created_at: p.created_at,
            view_count: p.view_count,
            is_shared: p.share_enabled,
          })),
      };

      return analytics;

    } catch (error) {
      logger.error('Error getting preview analytics:', error);
      throw error;
    }
  }
}

export const previewService = new PreviewService();