import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import GitHubIntegrationService from '@/services/github-integration';

const router = Router();
router.use(requireAuth);

/**
 * POST /api/apps/:appId/github/connect
 * Connect app to GitHub (create repository)
 */
router.post('/connect',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { access_token, is_private = true } = req.body;

    if (!access_token) {
      res.status(400).json({
        success: false,
        error: 'GitHub access token is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify app ownership
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', appId)
      .eq('user_id', userId)
      .single();

    if (!app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check if GitHub integration already exists
    const { data: existingRepo } = await supabase.serviceClient
      .from('github_repositories')
      .select('id')
      .eq('app_id', appId)
      .single();

    if (existingRepo) {
      res.status(400).json({
        success: false,
        error: 'GitHub integration already exists for this app',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // Create GitHub repository
      const githubService = new GitHubIntegrationService(access_token);
      const { repo_url, owner_username } = await githubService.createRepository(
        app.name,
        app.description,
        is_private
      );

      // Store repository information
      const { data: githubRepo, error } = await supabase.serviceClient
        .from('github_repositories')
        .insert({
          app_id: appId,
          repo_name: app.name,
          repo_url,
          owner_username,
          access_token_encrypted: access_token, // TODO: Encrypt this
          auto_sync: false,
          sync_status: 'pending',
        })
        .select()
        .single();

      if (error) {
        logger.error('Error saving GitHub repository:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to save repository information',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Update app GitHub integration settings
      await supabase.serviceClient
        .from('apps')
        .update({
          github_integration: {
            enabled: true,
            auto_sync: false,
            branch: 'main',
          },
        })
        .eq('id', appId);

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'github_connected',
          action_description: `Connected app to GitHub repository: ${repo_url}`,
        });

      res.status(201).json({
        success: true,
        data: {
          repo_url,
          owner_username,
          auto_sync: false,
        },
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Error connecting to GitHub:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create GitHub repository',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/github/sync
 * Sync app to GitHub repository
 */
router.post('/sync',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('*')
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

    // Get GitHub repository
    const { data: githubRepo } = await supabase.serviceClient
      .from('github_repositories')
      .select('*')
      .eq('app_id', appId)
      .single();

    if (!githubRepo) {
      res.status(400).json({
        success: false,
        error: 'GitHub integration not configured',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // Update sync status to syncing
      await supabase.serviceClient
        .from('github_repositories')
        .update({
          sync_status: 'syncing',
          sync_error_message: null,
        })
        .eq('app_id', appId);

      // Perform sync in background
      const githubService = new GitHubIntegrationService(githubRepo.access_token_encrypted);
      await githubService.syncAppToGitHub(appId, userId);

      res.json({
        success: true,
        message: 'Sync started successfully',
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Error syncing to GitHub:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to sync to GitHub',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/github/status
 * Get GitHub integration status
 */
router.get('/status',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

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

    const { data: githubRepo } = await supabase.serviceClient
      .from('github_repositories')
      .select('repo_url, owner_username, branch, auto_sync, last_sync_at, sync_status, sync_error_message')
      .eq('app_id', appId)
      .single();

    if (!githubRepo) {
      res.json({
        success: true,
        data: {
          connected: false,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: {
        connected: true,
        ...githubRepo,
      },
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * PUT /api/apps/:appId/github/settings
 * Update GitHub integration settings
 */
router.put('/settings',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { auto_sync, branch } = req.body;

    // Verify app ownership
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id')
      .eq('id', appId)
      .eq('user_id', userId)
      .single();

    if (!app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const updates: any = {};
    if (auto_sync !== undefined) updates.auto_sync = auto_sync;
    if (branch !== undefined) updates.branch = branch;

    const { data: updatedRepo, error } = await supabase.serviceClient
      .from('github_repositories')
      .update(updates)
      .eq('app_id', appId)
      .select()
      .single();

    if (error) {
      logger.error('Error updating GitHub settings:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update settings',
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
        action_type: 'github_settings_updated',
        action_description: `Updated GitHub settings: auto_sync=${auto_sync}, branch=${branch}`,
      });

    res.json({
      success: true,
      data: updatedRepo,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * DELETE /api/apps/:appId/github/disconnect
 * Disconnect GitHub integration
 */
router.delete('/disconnect',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    // Verify app ownership
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id')
      .eq('id', appId)
      .eq('user_id', userId)
      .single();

    if (!app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Remove GitHub integration
    const { error } = await supabase.serviceClient
      .from('github_repositories')
      .delete()
      .eq('app_id', appId);

    if (error) {
      logger.error('Error disconnecting GitHub:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to disconnect GitHub',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Update app settings
    await supabase.serviceClient
      .from('apps')
      .update({
        github_integration: {
          enabled: false,
          auto_sync: false,
          branch: 'main',
        },
      })
      .eq('id', appId);

    // Log activity
    await supabase.serviceClient
      .from('app_activity_log')
      .insert({
        app_id: appId,
        user_id: userId,
        action_type: 'github_disconnected',
        action_description: 'Disconnected GitHub integration',
      });

    res.json({
      success: true,
      message: 'GitHub integration disconnected successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/apps/:appId/github/import
 * Import app from existing GitHub repository
 */
router.post('/import',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { repo_url, access_token } = req.body;

    if (!repo_url || !access_token) {
      res.status(400).json({
        success: false,
        error: 'Repository URL and access token are required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify app ownership
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', appId)
      .eq('user_id', userId)
      .single();

    if (!app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // Parse repository URL
      const urlParts = repo_url.replace('https://github.com/', '').split('/');
      const owner_username = urlParts[0];
      const repo_name = urlParts[1];

      // Store repository information
      const { data: githubRepo, error } = await supabase.serviceClient
        .from('github_repositories')
        .insert({
          app_id: appId,
          repo_name,
          repo_url,
          owner_username,
          access_token_encrypted: access_token, // TODO: Encrypt this
          auto_sync: false,
          sync_status: 'completed',
        })
        .select()
        .single();

      if (error) {
        logger.error('Error saving imported repository:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to save repository information',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Update app settings
      await supabase.serviceClient
        .from('apps')
        .update({
          github_integration: {
            enabled: true,
            auto_sync: false,
            branch: 'main',
          },
        })
        .eq('id', appId);

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'github_imported',
          action_description: `Imported app from GitHub repository: ${repo_url}`,
        });

      res.status(201).json({
        success: true,
        data: githubRepo,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Error importing from GitHub:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to import from GitHub',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;