import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import { notificationService } from '@/services/notifications';
import type { 
  AppCollaborator, 
  CollaboratorRole,
  CollaborationInvite,
  CollaborationActivity,
  AppPresence,
  PresenceStatus,
  CollaboratorWithPresence,
  UpdatePresenceRequest,
  PresenceResponse
} from '@/types/app-development';

class CollaborationService {

  /**
   * Invite user to collaborate on an app
   */
  async inviteCollaborator(
    appId: string,
    inviterUserId: string,
    inviteData: {
      email: string;
      role: CollaboratorRole;
      message?: string;
    }
  ): Promise<string> {
    try {
      // Verify app ownership
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id, name, user_id')
        .eq('id', appId)
        .eq('user_id', inviterUserId)
        .single();

      if (!app) {
        throw new Error('App not found or insufficient permissions');
      }

      // Check if user is already a collaborator
      const { data: existingCollaborator } = await supabase.serviceClient
        .from('app_collaborators')
        .select('id')
        .eq('app_id', appId)
        .eq('email', inviteData.email)
        .single();

      if (existingCollaborator) {
        throw new Error('User is already a collaborator on this app');
      }

      // Check for existing pending invite
      const { data: existingInvite } = await supabase.serviceClient
        .from('collaboration_invites')
        .select('id')
        .eq('app_id', appId)
        .eq('email', inviteData.email)
        .eq('status', 'pending')
        .single();

      if (existingInvite) {
        throw new Error('Invitation already pending for this email');
      }

      // Create invitation
      const { data: invite, error } = await supabase.serviceClient
        .from('collaboration_invites')
        .insert({
          app_id: appId,
          invited_by_user_id: inviterUserId,
          email: inviteData.email,
          role: inviteData.role,
          message: inviteData.message,
          status: 'pending',
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
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
          user_id: inviterUserId,
          action_type: 'collaborator_invited',
          action_description: `Invited ${inviteData.email} as ${inviteData.role}`,
          affected_entity: invite.id,
        });

      // Send email/push notification
      const { data: inviterProfile } = await supabase.serviceClient
        .from('user_profiles')
        .select('full_name')
        .eq('id', inviterUserId)
        .single();

      const inviterName = inviterProfile?.full_name || 'Someone';

      await notificationService.sendCollaborationInvite(
        inviteData.email,
        inviterName,
        app.name,
        inviteData.role,
        invite.id
      );

      logger.info(`Collaboration invite sent to ${inviteData.email} for app ${appId}`);

      return invite.id;
    } catch (error) {
      logger.error('Error inviting collaborator:', error);
      throw error;
    }
  }

  /**
   * Accept collaboration invitation
   */
  async acceptInvitation(inviteId: string, userId: string): Promise<void> {
    try {
      // Get invitation details
      const { data: invite, error: inviteError } = await supabase.serviceClient
        .from('collaboration_invites')
        .select(`
          *,
          apps(name, user_id),
          user_profiles!invited_by_user_id(full_name)
        `)
        .eq('id', inviteId)
        .eq('status', 'pending')
        .single();

      if (inviteError || !invite) {
        throw new Error('Invitation not found or already processed');
      }

      // Check if invitation is expired
      if (new Date(invite.expires_at) < new Date()) {
        throw new Error('Invitation has expired');
      }

      // Get user email to verify invitation
      const { data: user } = await supabase.serviceClient
        .from('user_profiles')
        .select('email')
        .eq('id', userId)
        .single();

      if (!user || user.email !== invite.email) {
        throw new Error('Invitation email does not match user email');
      }

      // Add collaborator
      const { error: collaboratorError } = await supabase.serviceClient
        .from('app_collaborators')
        .insert({
          app_id: invite.app_id,
          user_id: userId,
          role: invite.role,
          invited_by_user_id: invite.invited_by_user_id,
          joined_at: new Date().toISOString(),
          is_active: true,
        });

      if (collaboratorError) {
        throw collaboratorError;
      }

      // Update invitation status
      await supabase.serviceClient
        .from('collaboration_invites')
        .update({
          status: 'accepted',
          accepted_at: new Date().toISOString(),
          accepted_by_user_id: userId,
        })
        .eq('id', inviteId);

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: invite.app_id,
          user_id: userId,
          action_type: 'collaborator_joined',
          action_description: `Joined as ${invite.role}`,
          affected_entity: userId,
        });

      // Send notification to app owner
      const { data: collaboratorProfile } = await supabase.serviceClient
        .from('user_profiles')
        .select('full_name')
        .eq('id', userId)
        .single();

      const collaboratorName = collaboratorProfile?.full_name || 'Someone';

      await notificationService.sendCollaborationAccepted(
        invite.apps.user_id,
        collaboratorName,
        invite.apps.name,
        invite.role
      );

      logger.info(`User ${userId} accepted collaboration invite for app ${invite.app_id}`);
    } catch (error) {
      logger.error('Error accepting invitation:', error);
      throw error;
    }
  }

  /**
   * Remove collaborator from app
   */
  async removeCollaborator(
    appId: string,
    collaboratorUserId: string,
    removedByUserId: string
  ): Promise<void> {
    try {
      // Verify ownership or admin permissions
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id, user_id')
        .eq('id', appId)
        .single();

      if (!app) {
        throw new Error('App not found');
      }

      // Only owner can remove collaborators
      if (app.user_id !== removedByUserId) {
        throw new Error('Only app owner can remove collaborators');
      }

      // Cannot remove the owner
      if (collaboratorUserId === app.user_id) {
        throw new Error('Cannot remove app owner');
      }

      // Remove collaborator
      const { error } = await supabase.serviceClient
        .from('app_collaborators')
        .delete()
        .eq('app_id', appId)
        .eq('user_id', collaboratorUserId);

      if (error) {
        throw error;
      }

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: removedByUserId,
          action_type: 'collaborator_removed',
          action_description: `Removed collaborator`,
          affected_entity: collaboratorUserId,
        });

      // Send notification to removed collaborator
      const { data: removedByProfile } = await supabase.serviceClient
        .from('user_profiles')
        .select('full_name')
        .eq('id', removedByUserId)
        .single();

      const removedByName = removedByProfile?.full_name || 'App owner';

      await notificationService.sendCollaboratorRemoved(
        collaboratorUserId,
        app.name || 'the app',
        removedByName
      );

      logger.info(`Collaborator ${collaboratorUserId} removed from app ${appId}`);
    } catch (error) {
      logger.error('Error removing collaborator:', error);
      throw error;
    }
  }

  /**
   * Update collaborator role
   */
  async updateCollaboratorRole(
    appId: string,
    collaboratorUserId: string,
    newRole: CollaboratorRole,
    updatedByUserId: string
  ): Promise<void> {
    try {
      // Verify ownership
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id, user_id')
        .eq('id', appId)
        .single();

      if (!app) {
        throw new Error('App not found');
      }

      if (app.user_id !== updatedByUserId) {
        throw new Error('Only app owner can update collaborator roles');
      }

      // Cannot change owner role
      if (collaboratorUserId === app.user_id) {
        throw new Error('Cannot change app owner role');
      }

      // Update role
      const { error } = await supabase.serviceClient
        .from('app_collaborators')
        .update({
          role: newRole,
          updated_at: new Date().toISOString(),
        })
        .eq('app_id', appId)
        .eq('user_id', collaboratorUserId);

      if (error) {
        throw error;
      }

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: updatedByUserId,
          action_type: 'collaborator_role_updated',
          action_description: `Updated collaborator role to ${newRole}`,
          affected_entity: collaboratorUserId,
        });

      // Send notification to collaborator about role change
      const { data: updatedByProfile } = await supabase.serviceClient
        .from('user_profiles')
        .select('full_name')
        .eq('id', updatedByUserId)
        .single();

      const updatedByName = updatedByProfile?.full_name || 'App owner';

      await notificationService.sendRoleUpdated(
        collaboratorUserId,
        app.name || 'the app',
        newRole,
        updatedByName
      );

      logger.info(`Collaborator ${collaboratorUserId} role updated to ${newRole} in app ${appId}`);
    } catch (error) {
      logger.error('Error updating collaborator role:', error);
      throw error;
    }
  }

  /**
   * Get app collaborators
   */
  async getAppCollaborators(appId: string, userId: string): Promise<AppCollaborator[]> {
    try {
      // Verify app access
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id')
        .eq('id', appId)
        .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
        .single();

      if (!app) {
        throw new Error('App not found or access denied');
      }

      const { data: collaborators, error } = await supabase.serviceClient
        .from('app_collaborators')
        .select(`
          *,
          user_profiles(id, full_name, email, avatar_url)
        `)
        .eq('app_id', appId)
        .eq('is_active', true)
        .order('joined_at');

      if (error) {
        throw error;
      }

      return collaborators || [];
    } catch (error) {
      logger.error('Error getting app collaborators:', error);
      throw error;
    }
  }

  /**
   * Get pending invitations for an app
   */
  async getPendingInvitations(appId: string, userId: string): Promise<CollaborationInvite[]> {
    try {
      // Verify app ownership
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id, user_id')
        .eq('id', appId)
        .eq('user_id', userId)
        .single();

      if (!app) {
        throw new Error('App not found or insufficient permissions');
      }

      const { data: invites, error } = await supabase.serviceClient
        .from('collaboration_invites')
        .select(`
          *,
          user_profiles!invited_by_user_id(full_name)
        `)
        .eq('app_id', appId)
        .eq('status', 'pending')
        .gte('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return invites || [];
    } catch (error) {
      logger.error('Error getting pending invitations:', error);
      throw error;
    }
  }

  /**
   * Get user's collaboration invitations
   */
  async getUserInvitations(userId: string): Promise<CollaborationInvite[]> {
    try {
      // Get user email
      const { data: user } = await supabase.serviceClient
        .from('user_profiles')
        .select('email')
        .eq('id', userId)
        .single();

      if (!user) {
        throw new Error('User not found');
      }

      const { data: invites, error } = await supabase.serviceClient
        .from('collaboration_invites')
        .select(`
          *,
          apps(name, description),
          user_profiles!invited_by_user_id(full_name)
        `)
        .eq('email', user.email)
        .eq('status', 'pending')
        .gte('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return invites || [];
    } catch (error) {
      logger.error('Error getting user invitations:', error);
      throw error;
    }
  }

  /**
   * Get collaboration activity for an app
   */
  async getCollaborationActivity(
    appId: string,
    userId: string,
    limit = 50
  ): Promise<CollaborationActivity[]> {
    try {
      // Verify app access
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('id')
        .eq('id', appId)
        .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
        .single();

      if (!app) {
        throw new Error('App not found or access denied');
      }

      const { data: activities, error } = await supabase.serviceClient
        .from('app_activity_log')
        .select(`
          *,
          user_profiles(full_name, avatar_url)
        `)
        .eq('app_id', appId)
        .in('action_type', [
          'collaborator_invited',
          'collaborator_joined',
          'collaborator_removed',
          'collaborator_role_updated',
          'component_created',
          'component_updated',
          'component_deleted',
          'page_created',
          'page_updated',
          'page_deleted',
          'app_updated'
        ])
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      return activities || [];
    } catch (error) {
      logger.error('Error getting collaboration activity:', error);
      throw error;
    }
  }

  /**
   * Check user permissions for an app
   */
  async getUserPermissions(appId: string, userId: string): Promise<{
    role: CollaboratorRole | 'owner';
    permissions: {
      can_edit: boolean;
      can_view: boolean;
      can_build: boolean;
      can_manage_collaborators: boolean;
      can_delete_app: boolean;
    };
  }> {
    try {
      // Check if user is the owner
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('user_id')
        .eq('id', appId)
        .single();

      if (!app) {
        throw new Error('App not found');
      }

      if (app.user_id === userId) {
        return {
          role: 'owner',
          permissions: {
            can_edit: true,
            can_view: true,
            can_build: true,
            can_manage_collaborators: true,
            can_delete_app: true,
          },
        };
      }

      // Check collaborator role
      const { data: collaborator } = await supabase.serviceClient
        .from('app_collaborators')
        .select('role')
        .eq('app_id', appId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      if (!collaborator) {
        throw new Error('Access denied');
      }

      const permissions = this.getRolePermissions(collaborator.role);

      return {
        role: collaborator.role,
        permissions,
      };
    } catch (error) {
      logger.error('Error getting user permissions:', error);
      throw error;
    }
  }

  /**
   * Get permissions for a role
   */
  private getRolePermissions(role: CollaboratorRole): {
    can_edit: boolean;
    can_view: boolean;
    can_build: boolean;
    can_manage_collaborators: boolean;
    can_delete_app: boolean;
  } {
    switch (role) {
      case 'editor':
        return {
          can_edit: true,
          can_view: true,
          can_build: true,
          can_manage_collaborators: false,
          can_delete_app: false,
        };
      case 'viewer':
        return {
          can_edit: false,
          can_view: true,
          can_build: false,
          can_manage_collaborators: false,
          can_delete_app: false,
        };
      default:
        return {
          can_edit: false,
          can_view: false,
          can_build: false,
          can_manage_collaborators: false,
          can_delete_app: false,
        };
    }
  }

  /**
   * Leave an app as a collaborator
   */
  async leaveApp(appId: string, userId: string): Promise<void> {
    try {
      // Check if user is a collaborator (not owner)
      const { data: collaborator } = await supabase.serviceClient
        .from('app_collaborators')
        .select('id')
        .eq('app_id', appId)
        .eq('user_id', userId)
        .single();

      if (!collaborator) {
        throw new Error('Not a collaborator on this app');
      }

      // Remove collaborator
      const { error } = await supabase.serviceClient
        .from('app_collaborators')
        .delete()
        .eq('app_id', appId)
        .eq('user_id', userId);

      if (error) {
        throw error;
      }

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'collaborator_left',
          action_description: 'Left the app',
          affected_entity: userId,
        });

      logger.info(`User ${userId} left app ${appId}`);
    } catch (error) {
      logger.error('Error leaving app:', error);
      throw error;
    }
  }

  /**
   * NEW: Update user presence for an app
   */
  async updatePresence(
    appId: string,
    userId: string,
    presenceData: UpdatePresenceRequest
  ): Promise<void> {
    try {
      // Verify user has access to the app
      const access = await this.getUserAppAccess(userId, appId);
      if (access === 'none') {
        throw new Error('User does not have access to this app');
      }

      // Use the database function to update presence
      const { error } = await supabase.serviceClient.rpc('update_app_presence', {
        app_uuid: appId,
        user_uuid: userId,
        status_val: presenceData.status,
        page_uuid: presenceData.current_page_id || null,
        session_id_val: presenceData.session_id || null
      });

      if (error) {
        throw error;
      }

      logger.info(`Updated presence for user ${userId} in app ${appId}: ${presenceData.status}`);
    } catch (error) {
      logger.error('Error updating presence:', error);
      throw error;
    }
  }

  /**
   * NEW: Get app collaborators with presence information
   */
  async getCollaboratorsWithPresence(appId: string, requestingUserId: string): Promise<PresenceResponse> {
    try {
      // Verify user has access to the app
      const access = await this.getUserAppAccess(requestingUserId, appId);
      if (access === 'none') {
        throw new Error('User does not have access to this app');
      }

      // Use the database function to get collaborators with presence
      const { data, error } = await supabase.serviceClient.rpc('get_app_collaborators_with_presence', {
        app_uuid: appId
      });

      if (error) {
        throw error;
      }

      const collaborators: CollaboratorWithPresence[] = data || [];
      const totalOnline = collaborators.filter(c => c.is_online).length;

      return {
        app_id: appId,
        collaborators,
        total_online: totalOnline
      };
    } catch (error) {
      logger.error('Error getting collaborators with presence:', error);
      throw error;
    }
  }

  /**
   * NEW: Check if user has admin or owner permissions
   */
  async hasAdminAccess(userId: string, appId: string): Promise<boolean> {
    try {
      const { data: collaborator } = await supabase.serviceClient
        .from('app_collaborators')
        .select('role')
        .eq('app_id', appId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      return collaborator?.role === 'admin' || collaborator?.role === 'owner';
    } catch (error) {
      logger.error('Error checking admin access:', error);
      return false;
    }
  }

  /**
   * ENHANCED: Check user's role for an app
   */
  async getUserRole(userId: string, appId: string): Promise<CollaboratorRole | null> {
    try {
      const { data: collaborator } = await supabase.serviceClient
        .from('app_collaborators')
        .select('role')
        .eq('app_id', appId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      return collaborator?.role || null;
    } catch (error) {
      logger.error('Error getting user role:', error);
      return null;
    }
  }

  /**
   * ENHANCED: Get detailed app access level using database function
   */
  async getUserAppAccess(userId: string, appId: string): Promise<string> {
    try {
      const { data, error } = await supabase.serviceClient.rpc('get_user_app_access', {
        user_uuid: userId,
        app_uuid: appId
      });

      if (error) {
        throw error;
      }

      return data || 'none';
    } catch (error) {
      logger.error('Error getting user app access:', error);
      return 'none';
    }
  }

  /**
   * NEW: Remove user presence when they disconnect
   */
  async removePresence(appId: string, userId: string, sessionId?: string): Promise<void> {
    try {
      let query = supabase.serviceClient
        .from('app_presence')
        .delete()
        .eq('app_id', appId)
        .eq('user_id', userId);

      if (sessionId) {
        query = query.eq('session_id', sessionId);
      }

      const { error } = await query;

      if (error) {
        throw error;
      }

      logger.info(`Removed presence for user ${userId} in app ${appId}`);
    } catch (error) {
      logger.error('Error removing presence:', error);
      throw error;
    }
  }

  /**
   * NEW: Enhanced role update with admin permissions check
   */
  async updateCollaboratorRoleEnhanced(
    appId: string,
    collaboratorUserId: string,
    newRole: CollaboratorRole,
    updatedByUserId: string
  ): Promise<void> {
    try {
      // Check if requesting user has admin or owner permissions
      const hasPermission = await this.hasAdminAccess(updatedByUserId, appId);
      if (!hasPermission) {
        throw new Error('Only admins and owners can update collaborator roles');
      }

      // Cannot change owner role
      const currentRole = await this.getUserRole(collaboratorUserId, appId);
      if (currentRole === 'owner') {
        throw new Error('Cannot change the role of the app owner');
      }

      // Only owners can assign admin role
      const updaterRole = await this.getUserRole(updatedByUserId, appId);
      if (newRole === 'admin' && updaterRole !== 'owner') {
        throw new Error('Only owners can assign admin role');
      }

      // Update the role
      await this.updateCollaboratorRole(appId, collaboratorUserId, newRole, updatedByUserId);

      logger.info(`Enhanced role update: User ${collaboratorUserId} role updated to ${newRole} in app ${appId} by ${updatedByUserId}`);
    } catch (error) {
      logger.error('Error in enhanced role update:', error);
      throw error;
    }
  }
}

const collaborationService = new CollaborationService();
export { CollaborationService };
export default collaborationService;