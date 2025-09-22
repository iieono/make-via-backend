import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import type { PushNotification, PushToken } from '@/types';

// Mock FCM service - in production, replace with actual Firebase Admin SDK
class FCMService {
  async sendToDevice(token: string, notification: any, data?: any): Promise<boolean> {
    // This is a mock implementation
    // In production, use Firebase Admin SDK:
    // const admin = require('firebase-admin');
    // return admin.messaging().sendToDevice(token, { notification, data });
    
    logger.info(`Mock FCM: Sending notification to ${token}`, { notification, data });
    
    // Simulate 95% success rate
    return Math.random() > 0.05;
  }

  async sendToTopic(topic: string, notification: any, data?: any): Promise<boolean> {
    logger.info(`Mock FCM: Sending notification to topic ${topic}`, { notification, data });
    return Math.random() > 0.05;
  }
}

class NotificationService {
  private fcm: FCMService;

  constructor() {
    this.fcm = new FCMService();
  }

  async registerPushToken(
    userId: string,
    token: string,
    platform: 'ios' | 'android',
    deviceId: string
  ): Promise<PushToken> {
    try {
      // Deactivate existing tokens for this device
      await supabase.deactivatePushTokens(userId, deviceId);

      // Register new token
      const pushToken = await supabase.createPushToken({
        user_id: userId,
        token,
        platform,
        device_id: deviceId,
        is_active: true,
      });

      logger.info(`Push token registered for user ${userId}: ${deviceId}`);
      return pushToken;

    } catch (error) {
      logger.error('Error registering push token:', error);
      throw error;
    }
  }

  async unregisterPushToken(userId: string, deviceId?: string): Promise<void> {
    try {
      if (deviceId) {
        await supabase.deactivatePushTokens(userId, deviceId);
      } else {
        await supabase.deactivateAllPushTokens(userId);
      }

      logger.info(`Push tokens unregistered for user ${userId}${deviceId ? ` device ${deviceId}` : ''}`);

    } catch (error) {
      logger.error('Error unregistering push token:', error);
      throw error;
    }
  }

  async sendNotification(
    userId: string,
    notification: {
      title: string;
      body: string;
      type?: 'info' | 'success' | 'warning' | 'error';
      category?: 'ai_generation' | 'subscription' | 'usage' | 'system' | 'marketing';
      data?: Record<string, any>;
      scheduled_at?: string;
    }
  ): Promise<PushNotification> {
    try {
      // Create notification record
      const pushNotification = await supabase.createPushNotification({
        user_id: userId,
        title: notification.title,
        body: notification.body,
        type: notification.type || 'info',
        category: notification.category || 'system',
        data: notification.data,
        scheduled_at: notification.scheduled_at,
        status: notification.scheduled_at ? 'pending' : 'sent',
      });

      // If not scheduled, send immediately
      if (!notification.scheduled_at) {
        await this.sendNotificationNow(pushNotification);
      }

      return pushNotification;

    } catch (error) {
      logger.error('Error creating notification:', error);
      throw error;
    }
  }

  private async sendNotificationNow(notification: PushNotification): Promise<void> {
    try {
      // Get user's active push tokens
      const tokens = await supabase.getUserPushTokens(notification.user_id);
      
      if (tokens.length === 0) {
        logger.info(`No push tokens found for user ${notification.user_id}`);
        await supabase.updatePushNotification(notification.id, {
          status: 'failed',
          error_message: 'No push tokens available',
        });
        return;
      }

      const fcmPayload = {
        title: notification.title,
        body: notification.body,
        sound: 'default',
        badge: '1',
      };

      const fcmData = {
        type: notification.type,
        category: notification.category,
        notification_id: notification.id,
        ...notification.data,
      };

      let successCount = 0;
      let failures: string[] = [];

      // Send to all user's devices
      for (const token of tokens) {
        try {
          const success = await this.fcm.sendToDevice(token.token, fcmPayload, fcmData);
          
          if (success) {
            successCount++;
          } else {
            failures.push(`Token ${token.id}: Failed to send`);
          }
        } catch (error) {
          failures.push(`Token ${token.id}: ${error}`);
          
          // If token is invalid, deactivate it
          if (error instanceof Error && error.message.includes('invalid')) {
            await supabase.deactivatePushToken(token.id);
          }
        }
      }

      // Update notification status
      if (successCount > 0) {
        await supabase.updatePushNotification(notification.id, {
          status: 'sent',
          sent_at: new Date().toISOString(),
          error_message: failures.length > 0 ? failures.join('; ') : undefined,
        });
        
        logger.info(`Notification sent to ${successCount}/${tokens.length} devices for user ${notification.user_id}`);
      } else {
        await supabase.updatePushNotification(notification.id, {
          status: 'failed',
          error_message: failures.join('; ') || 'All sends failed',
        });
        
        logger.warn(`Failed to send notification to user ${notification.user_id}: ${failures.join('; ')}`);
      }

    } catch (error) {
      logger.error('Error sending notification:', error);
      
      await supabase.updatePushNotification(notification.id, {
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Send notification to multiple users
  async sendBulkNotification(
    userIds: string[],
    notification: {
      title: string;
      body: string;
      type?: 'info' | 'success' | 'warning' | 'error';
      category?: 'ai_generation' | 'subscription' | 'usage' | 'system' | 'marketing';
      data?: Record<string, any>;
    }
  ): Promise<PushNotification[]> {
    try {
      const notifications: PushNotification[] = [];

      for (const userId of userIds) {
        const pushNotification = await this.sendNotification(userId, notification);
        notifications.push(pushNotification);
      }

      logger.info(`Bulk notification sent to ${userIds.length} users`);
      return notifications;

    } catch (error) {
      logger.error('Error sending bulk notification:', error);
      throw error;
    }
  }

  // Predefined notification templates
  async sendAIGenerationComplete(
    userId: string,
    appName: string,
    screenName: string
  ): Promise<void> {
    await this.sendNotification(userId, {
      title: '🎨 UI Generated!',
      body: `Your ${screenName} screen for ${appName} is ready to preview`,
      type: 'success',
      category: 'ai_generation',
      data: {
        action: 'open_app',
        screen_name: screenName,
        app_name: appName,
      },
    });
  }

  async sendUsageLimitWarning(
    userId: string,
    usedPercentage: number,
    limitType: string
  ): Promise<void> {
    await this.sendNotification(userId, {
      title: '⚠️ Usage Limit Warning',
      body: `You've used ${usedPercentage}% of your ${limitType} limit this month`,
      type: 'warning',
      category: 'usage',
      data: {
        action: 'open_usage',
        limit_type: limitType,
        used_percentage: usedPercentage,
      },
    });
  }

  async sendSubscriptionExpiring(
    userId: string,
    daysRemaining: number
  ): Promise<void> {
    await this.sendNotification(userId, {
      title: '💳 Subscription Expiring',
      body: `Your subscription expires in ${daysRemaining} days. Renew to keep your apps running.`,
      type: 'warning',
      category: 'subscription',
      data: {
        action: 'open_subscription',
        days_remaining: daysRemaining,
      },
    });
  }

  async sendAppBuildComplete(
    userId: string,
    appName: string,
    buildType: string,
    success: boolean
  ): Promise<void> {
    await this.sendNotification(userId, {
      title: success ? '📱 App Build Complete!' : '❌ App Build Failed',
      body: success 
        ? `Your ${appName} ${buildType.toUpperCase()} is ready for download`
        : `Failed to build ${appName}. Check the build logs for details.`,
      type: success ? 'success' : 'error',
      category: 'system',
      data: {
        action: success ? 'download_build' : 'view_build_logs',
        app_name: appName,
        build_type: buildType,
        success,
      },
    });
  }

  // Get user's notification history
  async getUserNotifications(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<PushNotification[]> {
    try {
      return await supabase.getUserPushNotifications(userId, limit, offset);
    } catch (error) {
      logger.error('Error fetching user notifications:', error);
      throw error;
    }
  }

  // Mark notification as read (if implementing read status)
  async markNotificationAsRead(
    userId: string,
    notificationId: string
  ): Promise<void> {
    try {
      // This would require adding a read status to the notification table
      // For now, just log it
      logger.info(`Notification marked as read: ${notificationId} by user ${userId}`);
    } catch (error) {
      logger.error('Error marking notification as read:', error);
      throw error;
    }
  }

  // Collaboration notification templates
  async sendCollaborationInvite(
    inviteeEmail: string,
    inviterName: string,
    appName: string,
    role: string,
    inviteId: string
  ): Promise<void> {
    try {
      // For now, we'll store this as a system notification
      // In production, this would send an actual email
      
      // Find user by email to send push notification
      const { data: user } = await supabase.serviceClient
        .from('user_profiles')
        .select('id, email')
        .eq('email', inviteeEmail)
        .single();

      if (user) {
        await this.sendNotification(user.id, {
          title: '🤝 Collaboration Invitation',
          body: `${inviterName} invited you to collaborate on ${appName} as ${role}`,
          type: 'info',
          category: 'system',
          data: {
            action: 'open_collaboration_invite',
            invite_id: inviteId,
            app_name: appName,
            inviter_name: inviterName,
            role: role,
          },
        });
      }

      // Create in-app notification record
      await supabase.serviceClient
        .from('notifications')
        .insert({
          user_id: user?.id || null,
          title: 'Collaboration Invitation',
          message: `${inviterName} invited you to collaborate on ${appName} as ${role}`,
          type: 'info',
          category: 'collaboration',
          action_url: `/collaboration/invitations/${inviteId}`,
          action_label: 'View Invitation',
          metadata: {
            invite_id: inviteId,
            app_name: appName,
            inviter_name: inviterName,
            role: role,
            email: inviteeEmail,
          },
        });

      logger.info(`Collaboration invite notification sent to ${inviteeEmail} for app ${appName}`);

    } catch (error) {
      logger.error('Error sending collaboration invite notification:', error);
      // Don't throw error to avoid breaking the invitation flow
    }
  }

  async sendCollaborationAccepted(
    appOwnerId: string,
    collaboratorName: string,
    appName: string,
    role: string
  ): Promise<void> {
    try {
      await this.sendNotification(appOwnerId, {
        title: '✅ Collaboration Accepted',
        body: `${collaboratorName} accepted your invitation to collaborate on ${appName}`,
        type: 'success',
        category: 'system',
        data: {
          action: 'open_app_collaborators',
          app_name: appName,
          collaborator_name: collaboratorName,
          role: role,
        },
      });

      logger.info(`Collaboration accepted notification sent to owner for app ${appName}`);

    } catch (error) {
      logger.error('Error sending collaboration accepted notification:', error);
    }
  }

  async sendCollaborationDeclined(
    appOwnerId: string,
    collaboratorEmail: string,
    appName: string,
    role: string
  ): Promise<void> {
    try {
      await this.sendNotification(appOwnerId, {
        title: '❌ Collaboration Declined',
        body: `${collaboratorEmail} declined your invitation to collaborate on ${appName}`,
        type: 'warning',
        category: 'system',
        data: {
          action: 'open_app_collaborators',
          app_name: appName,
          collaborator_email: collaboratorEmail,
          role: role,
        },
      });

      logger.info(`Collaboration declined notification sent to owner for app ${appName}`);

    } catch (error) {
      logger.error('Error sending collaboration declined notification:', error);
    }
  }

  async sendCollaboratorRemoved(
    collaboratorId: string,
    appName: string,
    removedByName: string
  ): Promise<void> {
    try {
      await this.sendNotification(collaboratorId, {
        title: '🚫 Removed from Collaboration',
        body: `You were removed from ${appName} by ${removedByName}`,
        type: 'warning',
        category: 'system',
        data: {
          action: 'open_my_apps',
          app_name: appName,
          removed_by: removedByName,
        },
      });

      logger.info(`Collaborator removed notification sent for app ${appName}`);

    } catch (error) {
      logger.error('Error sending collaborator removed notification:', error);
    }
  }

  async sendRoleUpdated(
    collaboratorId: string,
    appName: string,
    newRole: string,
    updatedByName: string
  ): Promise<void> {
    try {
      await this.sendNotification(collaboratorId, {
        title: '🔄 Role Updated',
        body: `Your role in ${appName} was updated to ${newRole} by ${updatedByName}`,
        type: 'info',
        category: 'system',
        data: {
          action: 'open_app',
          app_name: appName,
          new_role: newRole,
          updated_by: updatedByName,
        },
      });

      logger.info(`Role updated notification sent for app ${appName}`);

    } catch (error) {
      logger.error('Error sending role updated notification:', error);
    }
  }

  // NEW: Enhanced collaboration notification templates
  async sendAdminRoleAssigned(
    userId: string,
    appName: string,
    assignedByName: string
  ): Promise<void> {
    try {
      await this.sendNotification(userId, {
        title: '👑 Admin Role Assigned',
        body: `You've been assigned admin role in ${appName} by ${assignedByName}`,
        type: 'success',
        category: 'system',
        data: {
          action: 'open_app',
          app_name: appName,
          assigned_by: assignedByName,
          role: 'admin',
        },
      });

      logger.info(`Admin role assigned notification sent for app ${appName}`);

    } catch (error) {
      logger.error('Error sending admin role assigned notification:', error);
    }
  }

  async sendAppArchived(
    userId: string,
    appName: string,
    reason: string
  ): Promise<void> {
    try {
      await this.sendNotification(userId, {
        title: '📦 App Archived',
        body: `Your app ${appName} has been archived. ${reason === 'subscription_limit_exceeded' ? 'Upgrade to restore access.' : ''}`,
        type: 'warning',
        category: 'system',
        data: {
          action: reason === 'subscription_limit_exceeded' ? 'upgrade_subscription' : 'view_archived_apps',
          app_name: appName,
          reason: reason,
        },
      });

      logger.info(`App archived notification sent for app ${appName}`);

    } catch (error) {
      logger.error('Error sending app archived notification:', error);
    }
  }

  async sendAppRestored(
    userId: string,
    appName: string
  ): Promise<void> {
    try {
      await this.sendNotification(userId, {
        title: '🔄 App Restored',
        body: `Your app ${appName} has been restored from archive`,
        type: 'success',
        category: 'system',
        data: {
          action: 'open_app',
          app_name: appName,
        },
      });

      logger.info(`App restored notification sent for app ${appName}`);

    } catch (error) {
      logger.error('Error sending app restored notification:', error);
    }
  }

  async sendArchivedAppAccess(
    userId: string,
    appName: string,
    accessType: string,
    grantedByName: string
  ): Promise<void> {
    try {
      await this.sendNotification(userId, {
        title: '🔓 Archived App Access Granted',
        body: `You've been granted ${accessType} access to archived app ${appName} by ${grantedByName}`,
        type: 'info',
        category: 'system',
        data: {
          action: 'view_archived_access',
          app_name: appName,
          access_type: accessType,
          granted_by: grantedByName,
        },
      });

      logger.info(`Archived app access notification sent for app ${appName}`);

    } catch (error) {
      logger.error('Error sending archived app access notification:', error);
    }
  }

  async sendPageConnectionsDetected(
    userId: string,
    appName: string,
    connectionsCount: number
  ): Promise<void> {
    try {
      await this.sendNotification(userId, {
        title: '🔗 Page Connections Detected',
        body: `${connectionsCount} page connections automatically detected in ${appName}`,
        type: 'info',
        category: 'system',
        data: {
          action: 'view_page_connections',
          app_name: appName,
          connections_count: connectionsCount,
        },
      });

      logger.info(`Page connections detected notification sent for app ${appName}`);

    } catch (error) {
      logger.error('Error sending page connections detected notification:', error);
    }
  }

  async sendAIGenerationQueued(
    userId: string,
    model: string,
    estimatedTimeMs: number,
    queuePosition: number
  ): Promise<void> {
    try {
      const estimatedMinutes = Math.ceil(estimatedTimeMs / 60000);
      
      await this.sendNotification(userId, {
        title: '⏳ AI Generation Queued',
        body: `Your ${model} generation is queued (position ${queuePosition}). Estimated time: ${estimatedMinutes}min`,
        type: 'info',
        category: 'ai_generation',
        data: {
          action: 'view_generation_queue',
          model: model,
          estimated_time_ms: estimatedTimeMs,
          queue_position: queuePosition,
        },
      });

      logger.info(`AI generation queued notification sent for ${model}`);

    } catch (error) {
      logger.error('Error sending AI generation queued notification:', error);
    }
  }

  async sendAIGenerationStarted(
    userId: string,
    model: string,
    generationId: string
  ): Promise<void> {
    try {
      await this.sendNotification(userId, {
        title: '🚀 AI Generation Started',
        body: `Your ${model} generation is now being processed`,
        type: 'info',
        category: 'ai_generation',
        data: {
          action: 'view_generation_status',
          model: model,
          generation_id: generationId,
        },
      });

      logger.info(`AI generation started notification sent for ${model}`);

    } catch (error) {
      logger.error('Error sending AI generation started notification:', error);
    }
  }

  async sendAIGenerationFailed(
    userId: string,
    model: string,
    error: string
  ): Promise<void> {
    try {
      await this.sendNotification(userId, {
        title: '❌ AI Generation Failed',
        body: `Your ${model} generation failed: ${error}`,
        type: 'error',
        category: 'ai_generation',
        data: {
          action: 'retry_generation',
          model: model,
          error: error,
        },
      });

      logger.info(`AI generation failed notification sent for ${model}`);

    } catch (error) {
      logger.error('Error sending AI generation failed notification:', error);
    }
  }

  async sendCollaboratorOnline(
    userIds: string[],
    collaboratorName: string,
    appName: string
  ): Promise<void> {
    try {
      for (const userId of userIds) {
        await this.sendNotification(userId, {
          title: '🟢 Collaborator Online',
          body: `${collaboratorName} is now working on ${appName}`,
          type: 'info',
          category: 'system',
          data: {
            action: 'view_app_collaborators',
            app_name: appName,
            collaborator_name: collaboratorName,
          },
        });
      }

      logger.info(`Collaborator online notification sent for ${collaboratorName} in ${appName}`);

    } catch (error) {
      logger.error('Error sending collaborator online notification:', error);
    }
  }

  async sendSubscriptionLimitReached(
    userId: string,
    limitType: string,
    currentTier: string
  ): Promise<void> {
    try {
      await this.sendNotification(userId, {
        title: '🚫 Subscription Limit Reached',
        body: `You've reached your ${limitType} limit for ${currentTier} tier. Some apps may be archived.`,
        type: 'warning',
        category: 'subscription',
        data: {
          action: 'upgrade_subscription',
          limit_type: limitType,
          current_tier: currentTier,
        },
      });

      logger.info(`Subscription limit reached notification sent for ${limitType}`);

    } catch (error) {
      logger.error('Error sending subscription limit reached notification:', error);
    }
  }

  // Process scheduled notifications (would be called by a cron job)
  async processScheduledNotifications(): Promise<void> {
    try {
      const scheduledNotifications = await supabase.getScheduledNotifications();
      
      for (const notification of scheduledNotifications) {
        if (new Date(notification.scheduled_at!) <= new Date()) {
          await this.sendNotificationNow(notification);
        }
      }

      logger.info(`Processed ${scheduledNotifications.length} scheduled notifications`);

    } catch (error) {
      logger.error('Error processing scheduled notifications:', error);
    }
  }
}

export const notificationService = new NotificationService();