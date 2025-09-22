import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import collaborationService from '@/services/collaboration-service';
import { notificationService } from '@/services/notifications';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/collaboration/invitations
 * Get user's pending collaboration invitations
 */
router.get('/invitations',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      const invitations = await collaborationService.getUserInvitations(userId);

      res.json({
        success: true,
        data: invitations,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting user invitations:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get invitations',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/collaboration/invitations/:inviteId/accept
 * Accept a collaboration invitation
 */
router.post('/invitations/:inviteId/accept',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { inviteId } = req.params;

    try {
      await collaborationService.acceptInvitation(inviteId, userId);

      res.json({
        success: true,
        message: 'Invitation accepted successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error accepting invitation:', error);
      
      if (error instanceof Error) {
        if (error.message.includes('not found') || 
            error.message.includes('already processed')) {
          res.status(404).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        
        if (error.message.includes('expired')) {
          res.status(400).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      res.status(500).json({
        success: false,
        error: 'Failed to accept invitation',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/collaboration/invitations/:inviteId/decline
 * Decline a collaboration invitation
 */
router.post('/invitations/:inviteId/decline',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { inviteId } = req.params;

    try {
      // Get invitation details to verify user email
      const { data: invite, error: inviteError } = await supabase.serviceClient
        .from('collaboration_invites')
        .select(`
          email, 
          app_id, 
          status, 
          role,
          invited_by_user_id,
          apps(name, user_id)
        `)
        .eq('id', inviteId)
        .eq('status', 'pending')
        .single();

      if (inviteError || !invite) {
        res.status(404).json({
          success: false,
          error: 'Invitation not found or already processed',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Get user email to verify invitation
      const { data: user } = await supabase.serviceClient
        .from('user_profiles')
        .select('email')
        .eq('id', userId)
        .single();

      if (!user || user.email !== invite.email) {
        res.status(403).json({
          success: false,
          error: 'Invitation email does not match user email',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Update invitation status
      const { error } = await supabase.serviceClient
        .from('collaboration_invites')
        .update({
          status: 'declined',
          declined_at: new Date().toISOString(),
          declined_by_user_id: userId,
        })
        .eq('id', inviteId);

      if (error) {
        throw error;
      }

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: invite.app_id,
          user_id: userId,
          action_type: 'invitation_declined',
          action_description: 'Declined collaboration invitation',
          affected_entity: inviteId,
        });

      // Send notification to app owner
      await notificationService.sendCollaborationDeclined(
        invite.apps.user_id,
        invite.email,
        invite.apps.name,
        invite.role
      );

      res.json({
        success: true,
        message: 'Invitation declined successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error declining invitation:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to decline invitation',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/collaboration/apps
 * Get apps where user is a collaborator
 */
router.get('/apps',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { role } = req.query;

    try {
      let query = supabase.serviceClient
        .from('app_collaborators')
        .select(`
          *,
          apps(
            id,
            name,
            description,
            app_type,
            status,
            primary_color,
            created_at,
            updated_at,
            user_profiles!apps_user_id_fkey(full_name)
          )
        `)
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('joined_at', { ascending: false });

      if (role) {
        query = query.eq('role', role);
      }

      const { data: collaborations, error } = await query;

      if (error) {
        throw error;
      }

      const apps = (collaborations || []).map(collab => ({
        ...collab.apps,
        collaboration: {
          role: collab.role,
          joined_at: collab.joined_at,
          invited_by: collab.invited_by_user_id,
        },
      }));

      res.json({
        success: true,
        data: apps,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting collaboration apps:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get collaboration apps',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/collaboration/stats
 * Get collaboration statistics for user
 */
router.get('/stats',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
      // Get owned apps count
      const { count: ownedAppsCount } = await supabase.serviceClient
        .from('apps')
        .select('id', { count: 'exact' })
        .eq('user_id', userId);

      // Get collaboration count by role
      const { data: collaborations } = await supabase.serviceClient
        .from('app_collaborators')
        .select('role')
        .eq('user_id', userId)
        .eq('is_active', true);

      const collaborationStats = (collaborations || []).reduce((acc, collab) => {
        acc[collab.role] = (acc[collab.role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Get pending invitations count
      const { data: user } = await supabase.serviceClient
        .from('user_profiles')
        .select('email')
        .eq('id', userId)
        .single();

      let pendingInvitationsCount = 0;
      if (user) {
        const { count } = await supabase.serviceClient
          .from('collaboration_invites')
          .select('id', { count: 'exact' })
          .eq('email', user.email)
          .eq('status', 'pending')
          .gte('expires_at', new Date().toISOString());

        pendingInvitationsCount = count || 0;
      }

      // Get recent activity count
      const { count: recentActivityCount } = await supabase.serviceClient
        .from('app_activity_log')
        .select('id', { count: 'exact' })
        .eq('user_id', userId)
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

      res.json({
        success: true,
        data: {
          owned_apps: ownedAppsCount || 0,
          collaborations: {
            total: Object.values(collaborationStats).reduce((sum, count) => (sum as number) + (count as number), 0),
            by_role: collaborationStats,
          },
          pending_invitations: pendingInvitationsCount,
          recent_activity_count: recentActivityCount || 0,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting collaboration stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get collaboration statistics',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;