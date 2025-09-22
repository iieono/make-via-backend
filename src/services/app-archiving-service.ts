import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import { notificationService } from '@/services/notifications';
import type { 
  AppStatus,
  ArchiveAppRequest,
  ArchivedAppAccess,
  ArchivedAppAccessRequest
} from '@/types/app-development';

class AppArchivingService {

  /**
   * Archive apps when user exceeds subscription limits
   */
  async archiveExcessApps(userId: string): Promise<number> {
    try {
      const { data, error } = await supabase.serviceClient.rpc('archive_excess_apps', {
        user_uuid: userId
      });

      if (error) {
        throw error;
      }

      const archivedCount = data || 0;

      if (archivedCount > 0) {
        // Send notification to user
        await notificationService.sendNotification(userId, {
          title: '📦 Apps Archived',
          body: `${archivedCount} app(s) were archived due to subscription limits. Upgrade to restore access.`,
          type: 'warning',
          category: 'subscription',
          data: {
            action: 'upgrade_subscription',
            archived_count: archivedCount,
          },
        });

        logger.info(`Archived ${archivedCount} apps for user ${userId} due to subscription limits`);
      }

      return archivedCount;
    } catch (error) {
      logger.error('Error archiving excess apps:', error);
      throw error;
    }
  }

  /**
   * Manually archive an app
   */
  async archiveApp(
    appId: string,
    userId: string,
    archiveData: ArchiveAppRequest
  ): Promise<void> {
    try {
      // Verify user is the owner
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id, name, user_id')
        .eq('id', appId)
        .eq('user_id', userId)
        .single();

      if (!app) {
        throw new Error('App not found or insufficient permissions');
      }

      // Update app status to archived
      const { error } = await supabase.serviceClient
        .from('apps')
        .update({
          status: 'archived' as AppStatus,
          archived_at: new Date().toISOString(),
          archived_reason: archiveData.reason || 'manually_archived',
          archived_by_user_id: userId,
          updated_at: new Date().toISOString()
        })
        .eq('id', appId);

      if (error) {
        throw error;
      }

      // Log the activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'app_archived',
          action_description: 'App manually archived',
          affected_entity_type: 'app',
          affected_entity_id: appId,
          change_summary: archiveData.reason || 'Manually archived by owner',
          metadata: { reason: archiveData.reason }
        });

      logger.info(`App ${appId} archived by user ${userId}`);
    } catch (error) {
      logger.error('Error archiving app:', error);
      throw error;
    }
  }

  /**
   * Restore an archived app (if subscription allows)
   */
  async restoreApp(appId: string, userId: string): Promise<void> {
    try {
      // Verify user is the owner and app is archived
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id, name, user_id, status')
        .eq('id', appId)
        .eq('user_id', userId)
        .eq('status', 'archived')
        .single();

      if (!app) {
        throw new Error('Archived app not found or insufficient permissions');
      }

      // Check if user's subscription allows more apps
      const canRestore = await this.canRestoreApp(userId);
      if (!canRestore) {
        throw new Error('Cannot restore app: subscription limit reached. Please upgrade your plan.');
      }

      // Restore the app
      const { error } = await supabase.serviceClient
        .from('apps')
        .update({
          status: 'draft' as AppStatus,
          archived_at: null,
          archived_reason: null,
          archived_by_user_id: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', appId);

      if (error) {
        throw error;
      }

      // Log the activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'app_restored',
          action_description: 'App restored from archive',
          affected_entity_type: 'app',
          affected_entity_id: appId,
          change_summary: 'App restored and set to draft status'
        });

      logger.info(`App ${appId} restored by user ${userId}`);
    } catch (error) {
      logger.error('Error restoring app:', error);
      throw error;
    }
  }

  /**
   * Grant access to archived app
   */
  async grantArchivedAppAccess(
    appId: string,
    targetUserId: string,
    grantedByUserId: string,
    accessData: ArchivedAppAccessRequest
  ): Promise<string> {
    try {
      // Verify the granter is the app owner
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id, name, user_id, status')
        .eq('id', appId)
        .eq('user_id', grantedByUserId)
        .eq('status', 'archived')
        .single();

      if (!app) {
        throw new Error('Archived app not found or insufficient permissions');
      }

      // Check if access already exists
      const { data: existingAccess } = await supabase.serviceClient
        .from('archived_app_access')
        .select('id')
        .eq('app_id', appId)
        .eq('user_id', targetUserId)
        .eq('access_type', accessData.access_type)
        .single();

      if (existingAccess) {
        throw new Error('Access already granted for this app and access type');
      }

      // Create access record
      const { data: access, error } = await supabase.serviceClient
        .from('archived_app_access')
        .insert({
          app_id: appId,
          user_id: targetUserId,
          access_type: accessData.access_type,
          granted_by_user_id: grantedByUserId,
          granted_at: new Date().toISOString(),
          payment_required: accessData.payment_amount ? true : false,
          payment_amount: accessData.payment_amount || null,
          payment_status: accessData.payment_amount ? 'pending' : 'completed',
          metadata: { granted_reason: 'owner_granted' }
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      // Log the activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: grantedByUserId,
          action_type: 'archived_access_granted',
          action_description: `Granted ${accessData.access_type} access to archived app`,
          affected_entity_type: 'user',
          affected_entity_id: targetUserId,
          change_summary: `${accessData.access_type} access granted for archived app`
        });

      logger.info(`Granted ${accessData.access_type} access to archived app ${appId} for user ${targetUserId}`);
      return access.id;
    } catch (error) {
      logger.error('Error granting archived app access:', error);
      throw error;
    }
  }

  /**
   * Get user's archived apps
   */
  async getUserArchivedApps(userId: string): Promise<any[]> {
    try {
      const { data: apps, error } = await supabase.serviceClient
        .from('apps')
        .select(`
          id,
          name,
          description,
          status,
          archived_at,
          archived_reason,
          created_at,
          updated_at,
          app_icon_url,
          primary_color
        `)
        .eq('user_id', userId)
        .eq('status', 'archived')
        .order('archived_at', { ascending: false });

      if (error) {
        throw error;
      }

      return apps || [];
    } catch (error) {
      logger.error('Error getting user archived apps:', error);
      throw error;
    }
  }

  /**
   * Get apps where user has archived access
   */
  async getUserArchivedAccess(userId: string): Promise<any[]> {
    try {
      const { data: accessList, error } = await supabase.serviceClient
        .from('archived_app_access')
        .select(`
          id,
          access_type,
          granted_at,
          expires_at,
          payment_required,
          payment_status,
          used_at,
          apps (
            id,
            name,
            description,
            app_icon_url,
            primary_color,
            archived_at
          )
        `)
        .eq('user_id', userId)
        .eq('payment_status', 'completed')
        .order('granted_at', { ascending: false });

      if (error) {
        throw error;
      }

      return accessList || [];
    } catch (error) {
      logger.error('Error getting user archived access:', error);
      throw error;
    }
  }

  /**
   * Process payment for archived app export
   */
  async processArchivedAppPayment(
    accessId: string,
    stripePaymentIntentId: string
  ): Promise<void> {
    try {
      const { error } = await supabase.serviceClient
        .from('archived_app_access')
        .update({
          payment_status: 'completed',
          stripe_payment_intent_id: stripePaymentIntentId
        })
        .eq('id', accessId);

      if (error) {
        throw error;
      }

      logger.info(`Processed payment for archived app access ${accessId}`);
    } catch (error) {
      logger.error('Error processing archived app payment:', error);
      throw error;
    }
  }

  /**
   * Use archived app access (mark as used)
   */
  async useArchivedAppAccess(accessId: string, userId: string): Promise<void> {
    try {
      const { error } = await supabase.serviceClient
        .from('archived_app_access')
        .update({
          used_at: new Date().toISOString()
        })
        .eq('id', accessId)
        .eq('user_id', userId);

      if (error) {
        throw error;
      }

      logger.info(`Used archived app access ${accessId} by user ${userId}`);
    } catch (error) {
      logger.error('Error using archived app access:', error);
      throw error;
    }
  }

  /**
   * Check if user can restore more apps
   */
  private async canRestoreApp(userId: string): Promise<boolean> {
    try {
      // Get user's subscription and current app count
      const [subscriptionResult, appCountResult] = await Promise.all([
        supabase.serviceClient
          .from('user_subscriptions')
          .select('tier, apps_limit')
          .eq('user_id', userId)
          .eq('status', 'active')
          .single(),
        supabase.serviceClient
          .from('apps')
          .select('id')
          .eq('user_id', userId)
          .neq('status', 'archived')
      ]);

      const subscription = subscriptionResult.data;
      const currentAppCount = appCountResult.data?.length || 0;

      if (!subscription) {
        // No subscription, assume free tier limits
        return currentAppCount < 3;
      }

      return currentAppCount < subscription.apps_limit;
    } catch (error) {
      logger.error('Error checking if user can restore app:', error);
      return false;
    }
  }

  /**
   * Clean up expired archived access
   */
  async cleanupExpiredAccess(): Promise<number> {
    try {
      const { data, error } = await supabase.serviceClient
        .from('archived_app_access')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .select('id');

      if (error) {
        throw error;
      }

      const cleanedCount = data?.length || 0;
      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} expired archived app access records`);
      }

      return cleanedCount;
    } catch (error) {
      logger.error('Error cleaning up expired access:', error);
      return 0;
    }
  }

  /**
   * Get app archiving statistics for user
   */
  async getArchivingStats(userId: string): Promise<any> {
    try {
      const [archivedCount, accessGrantedCount, accessReceivedCount] = await Promise.all([
        // Count of user's archived apps
        supabase.serviceClient
          .from('apps')
          .select('id', { count: 'exact' })
          .eq('user_id', userId)
          .eq('status', 'archived'),
        
        // Count of access granted by user
        supabase.serviceClient
          .from('archived_app_access')
          .select('id', { count: 'exact' })
          .eq('granted_by_user_id', userId),
        
        // Count of access received by user
        supabase.serviceClient
          .from('archived_app_access')
          .select('id', { count: 'exact' })
          .eq('user_id', userId)
      ]);

      return {
        archived_apps: archivedCount.count || 0,
        access_granted: accessGrantedCount.count || 0,
        access_received: accessReceivedCount.count || 0
      };
    } catch (error) {
      logger.error('Error getting archiving stats:', error);
      return {
        archived_apps: 0,
        access_granted: 0,
        access_received: 0
      };
    }
  }
}

const appArchivingService = new AppArchivingService();
export { AppArchivingService };
export default appArchivingService;