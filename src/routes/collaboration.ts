import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import collaborationService from '@/services/collaboration-service';
import type { 
  CollaboratorRole, 
  UpdatePresenceRequest,
  PresenceResponse 
} from '@/types/app-development';

const router = Router();

router.use(requireAuth);

/**
 * POST /api/apps/:appId/collaborators/invite
 * Invite a user to collaborate on an app
 */
router.post('/invite',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { email, role, message } = req.body;

    // Validate required fields
    if (!email || typeof email !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Email is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!role || typeof role !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Role is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const validRoles: CollaboratorRole[] = ['editor', 'viewer'];
    if (!validRoles.includes(role as CollaboratorRole)) {
      res.status(400).json({
        success: false,
        error: `Role must be one of: ${validRoles.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      res.status(400).json({
        success: false,
        error: 'Invalid email format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const inviteId = await collaborationService.inviteCollaborator(
        appId,
        userId,
        {
          email: email.toLowerCase().trim(),
          role: role as CollaboratorRole,
          message: message?.trim(),
        }
      );

      res.status(201).json({
        success: true,
        data: { invite_id: inviteId },
        message: 'Collaboration invitation sent successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error inviting collaborator:', error);
      
      if (error instanceof Error) {
        if (error.message.includes('already a collaborator') || 
            error.message.includes('already pending')) {
          res.status(400).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        
        if (error.message.includes('not found') || 
            error.message.includes('insufficient permissions')) {
          res.status(404).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      res.status(500).json({
        success: false,
        error: 'Failed to send collaboration invitation',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/collaborators
 * Get app collaborators
 */
router.get('/',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      const collaborators = await collaborationService.getAppCollaborators(appId, userId);

      res.json({
        success: true,
        data: collaborators,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting app collaborators:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get app collaborators',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/collaborators/invitations
 * Get pending invitations for an app
 */
router.get('/invitations',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      const invitations = await collaborationService.getPendingInvitations(appId, userId);

      res.json({
        success: true,
        data: invitations,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting pending invitations:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get pending invitations',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * PUT /api/apps/:appId/collaborators/:collaboratorId/role
 * Update collaborator role
 */
router.put('/:collaboratorId/role',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, collaboratorId } = req.params;
    const { role } = req.body;

    if (!role || typeof role !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Role is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const validRoles: CollaboratorRole[] = ['editor', 'viewer'];
    if (!validRoles.includes(role as CollaboratorRole)) {
      res.status(400).json({
        success: false,
        error: `Role must be one of: ${validRoles.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      await collaborationService.updateCollaboratorRole(
        appId,
        collaboratorId,
        role as CollaboratorRole,
        userId
      );

      res.json({
        success: true,
        message: 'Collaborator role updated successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error updating collaborator role:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update collaborator role',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * DELETE /api/apps/:appId/collaborators/:collaboratorId
 * Remove collaborator from app
 */
router.delete('/:collaboratorId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, collaboratorId } = req.params;

    try {
      await collaborationService.removeCollaborator(appId, collaboratorId, userId);

      res.json({
        success: true,
        message: 'Collaborator removed successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error removing collaborator:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to remove collaborator',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/collaborators/leave
 * Leave an app as a collaborator
 */
router.post('/leave',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      await collaborationService.leaveApp(appId, userId);

      res.json({
        success: true,
        message: 'Successfully left the app',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error leaving app:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to leave app',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/collaborators/activity
 * Get collaboration activity for an app
 */
router.get('/activity',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { limit = 50 } = req.query;

    try {
      const activity = await collaborationService.getCollaborationActivity(
        appId,
        userId,
        Number(limit)
      );

      res.json({
        success: true,
        data: activity,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting collaboration activity:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get collaboration activity',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/collaborators/permissions
 * Get user permissions for an app
 */
router.get('/permissions',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      const permissions = await collaborationService.getUserPermissions(appId, userId);

      res.json({
        success: true,
        data: permissions,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting user permissions:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get user permissions',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/collaborators/presence
 * Update user presence for an app
 */
router.post('/presence',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const presenceData: UpdatePresenceRequest = req.body;

    try {
      // Validate request data
      if (!presenceData.status) {
        return res.status(400).json({
          success: false,
          error: 'Status is required',
          timestamp: new Date().toISOString(),
        });
      }

      await collaborationService.updatePresence(appId, userId, presenceData);

      res.json({
        success: true,
        message: 'Presence updated successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error updating presence:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update presence',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/collaborators/presence
 * Get collaborators with presence information
 */
router.get('/presence',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    try {
      const presenceData: PresenceResponse = await collaborationService.getCollaboratorsWithPresence(appId, userId);

      res.json({
        success: true,
        data: presenceData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting collaborators with presence:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get collaborators with presence',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * DELETE /api/apps/:appId/collaborators/presence
 * Remove user presence (when disconnecting)
 */
router.delete('/presence',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { session_id } = req.query;

    try {
      await collaborationService.removePresence(appId, userId, session_id as string);

      res.json({
        success: true,
        message: 'Presence removed successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error removing presence:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to remove presence',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * PUT /api/apps/:appId/collaborators/:collaboratorId/role-enhanced
 * Update collaborator role with enhanced admin permissions check
 */
router.put('/:collaboratorId/role-enhanced',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId, collaboratorId } = req.params;
    const { role } = req.body;

    try {
      // Validate role
      const validRoles: CollaboratorRole[] = ['viewer', 'editor', 'admin', 'owner'];
      if (!role || !validRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          error: 'Valid role is required (viewer, editor, admin, owner)',
          timestamp: new Date().toISOString(),
        });
      }

      await collaborationService.updateCollaboratorRoleEnhanced(
        appId,
        collaboratorId,
        role,
        userId
      );

      res.json({
        success: true,
        message: 'Collaborator role updated successfully',
        data: { role },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error updating collaborator role (enhanced):', error);
      const statusCode = error.message.includes('permissions') ? 403 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message || 'Failed to update collaborator role',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;