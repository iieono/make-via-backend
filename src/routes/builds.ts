import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import BuildService from '@/services/build-service';
import { creditService } from '@/services/credit-service';
import { supabaseStorageService } from '@/services/supabase-storage-service';
import type { BuildRequest } from '@/types/app-development';
import path from 'path';
import fs from 'fs/promises';
import Stripe from 'stripe';

const router = Router();
const buildService = new BuildService();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
});

// Helper function to get content type for build files
function getContentType(buildType: string): string {
  switch (buildType) {
    case 'apk':
      return 'application/vnd.android.package-archive';
    case 'aab':
      return 'application/x-authorware-bin';
    case 'source_code':
      return 'application/zip';
    case 'ipa':
      return 'application/octet-stream'; // iOS IPA files
    default:
      return 'application/octet-stream';
  }
}

router.use(requireAuth);

/**
 * GET /api/apps/:appId/builds/eligibility
 * Check if user is eligible for free build or needs to pay
 */
router.get('/eligibility',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id, name, status')
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

    // Get user's subscription tier
    const { data: subscription } = await supabase.serviceClient
      .from('user_subscriptions')
      .select('tier, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const subscriptionTier = subscription?.tier || 'free';
    const isBuildFree = creditService.isBuildFree(subscriptionTier);
    const buildPricing = creditService.getBuildPricing();

    res.json({
      success: true,
      data: {
        subscription_tier: subscriptionTier,
        is_build_free: isBuildFree,
        build_pricing: buildPricing,
        app_name: app.name,
        needs_payment: !isBuildFree,
      },
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/apps/:appId/builds/payment
 * Create payment session for build (free tier users only)
 */
router.post('/payment',
  rateLimits.payment,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { build_type } = req.body;

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id, name')
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

    // Get user's subscription tier
    const { data: subscription } = await supabase.serviceClient
      .from('user_subscriptions')
      .select('tier, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const subscriptionTier = subscription?.tier || 'free';
    
    // Check if build should be free
    if (creditService.isBuildFree(subscriptionTier)) {
      res.status(400).json({
        success: false,
        error: 'Builds are free for your subscription tier',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate build type
    if (!build_type || !['apk', 'aab', 'source_code', 'ipa'].includes(build_type)) {
      res.status(400).json({
        success: false,
        error: 'build_type must be apk, aab, source_code, or ipa',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const buildPricing = creditService.getBuildPricing();
    const price = buildPricing[build_type];

    if (!price) {
      res.status(400).json({
        success: false,
        error: 'Invalid build type',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // Get user profile for Stripe customer info
      const { data: userProfile } = await supabase.serviceClient
        .from('user_profiles')
        .select('email, full_name, stripe_customer_id')
        .eq('id', userId)
        .single();

      if (!userProfile) {
        res.status(404).json({
          success: false,
          error: 'User profile not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Create Stripe checkout session
      const session = await stripe.checkout.sessions.create({
        customer: userProfile.stripe_customer_id || undefined,
        customer_email: userProfile.stripe_customer_id ? undefined : userProfile.email,
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `${build_type.toUpperCase()} Build - ${app.name}`,
                description: `Mobile app build for ${app.name}`,
              },
              unit_amount: Math.round(price * 100), // Convert to cents
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.FRONTEND_URL}/apps/${appId}/builds?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL}/apps/${appId}/builds?payment=cancelled`,
        metadata: {
          user_id: userId,
          app_id: appId,
          build_type: build_type,
          purpose: 'app_build',
        },
      });

      // Store payment session for verification
      await supabase.serviceClient
        .from('app_build_purchases')
        .insert({
          user_id: userId,
          app_id: appId,
          purchase_type: 'free_build',
          stripe_payment_intent_id: session.id,
          price_paid: price,
          status: 'pending',
          metadata: {
            build_type: build_type,
            session_id: session.id,
          },
        });

      res.json({
        success: true,
        data: {
          session_id: session.id,
          session_url: session.url,
          price: price,
          build_type: build_type,
        },
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Error creating payment session:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create payment session',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/apps/:appId/builds
 * Start a new build for an app
 */
router.post('/',
  rateLimits.build,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const buildRequest: BuildRequest = req.body;

    // Verify app access
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id, name, status')
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

    // Validate build request
    if (!buildRequest.build_type || !['apk', 'aab', 'source_code', 'ipa'].includes(buildRequest.build_type)) {
      res.status(400).json({
        success: false,
        error: 'build_type must be "apk", "aab", "source_code", or "ipa"',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!buildRequest.build_mode || !['debug', 'release'].includes(buildRequest.build_mode)) {
      res.status(400).json({
        success: false,
        error: 'build_mode must be either "debug" or "release"',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (buildRequest.target_platform && !['android-arm', 'android-arm64', 'android-x64'].includes(buildRequest.target_platform)) {
      res.status(400).json({
        success: false,
        error: 'target_platform must be android-arm, android-arm64, or android-x64',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check for concurrent builds
    const { data: activeBuild } = await supabase.serviceClient
      .from('app_builds')
      .select('id')
      .eq('app_id', appId)
      .in('status', ['queued', 'building'])
      .single();

    if (activeBuild) {
      res.status(400).json({
        success: false,
        error: 'Another build is already in progress for this app',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get user's subscription tier to check build eligibility
    const { data: subscription } = await supabase.serviceClient
      .from('user_subscriptions')
      .select('tier, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const subscriptionTier = subscription?.tier || 'free';
    const isBuildFree = creditService.isBuildFree(subscriptionTier);

    // For free tier users, check if they have a valid payment
    if (!isBuildFree) {
      const { payment_session_id } = req.body;
      
      if (!payment_session_id) {
        res.status(400).json({
          success: false,
          error: 'Payment required for builds. Please complete payment first.',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Verify payment session
      const { data: purchase } = await supabase.serviceClient
        .from('app_build_purchases')
        .select('*')
        .eq('stripe_payment_intent_id', payment_session_id)
        .eq('user_id', userId)
        .eq('app_id', appId)
        .eq('status', 'completed')
        .is('used_at', null)
        .single();

      if (!purchase) {
        res.status(400).json({
          success: false,
          error: 'Invalid or expired payment session',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Mark purchase as used
      await supabase.serviceClient
        .from('app_build_purchases')
        .update({ used_at: new Date().toISOString() })
        .eq('id', purchase.id);
    }

    try {
      // Set app_id from route parameter
      buildRequest.app_id = appId;

      // Start the build
      const buildId = await buildService.startBuild(buildRequest, userId);

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'build_started',
          action_description: `Started ${buildRequest.build_type.toUpperCase()} build in ${buildRequest.build_mode} mode`,
          affected_entity: buildId,
        });

      res.status(201).json({
        success: true,
        data: {
          build_id: buildId,
          status: 'queued',
          message: 'Build started successfully',
        },
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Error starting build:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to start build',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/apps/:appId/builds
 * Get build history for an app
 */
router.get('/',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { appId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

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

    const builds = await buildService.getAppBuilds(appId, Number(limit));

    res.json({
      success: true,
      data: builds,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        total: builds.length,
      },
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /api/builds/:buildId/status
 * Get build status
 */
router.get('/:buildId/status',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { buildId } = req.params;

    const build = await buildService.getBuildStatus(buildId);

    if (!build) {
      res.status(404).json({
        success: false,
        error: 'Build not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify user has access to this build
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id')
      .eq('id', build.app_id)
      .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
      .single();

    if (!app) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: {
        build_id: build.build_id,
        status: build.status,
        build_type: build.build_type,
        build_mode: build.build_mode,
        target_platform: build.target_platform,
        created_at: build.created_at,
        completed_at: build.completed_at,
        download_url: build.download_url,
        error_message: build.error_message,
      },
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /api/builds/:buildId/download
 * Download build artifact
 */
router.get('/:buildId/download',
  rateLimits.download,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { buildId } = req.params;

    const build = await buildService.getBuildStatus(buildId);

    if (!build) {
      res.status(404).json({
        success: false,
        error: 'Build not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify user has access to this build
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id, name')
      .eq('id', build.app_id)
      .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
      .single();

    if (!app) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (build.status !== 'completed') {
      res.status(400).json({
        success: false,
        error: 'Build is not completed',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!build.download_url) {
      res.status(404).json({
        success: false,
        error: 'Build artifact not available',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // For Supabase storage, redirect to signed URL
      if (build.download_url && build.download_url.startsWith('http')) {
        // Log download
        await supabase.serviceClient
          .from('app_activity_log')
          .insert({
            app_id: build.app_id,
            user_id: userId,
            action_type: 'build_downloaded',
            action_description: `Downloaded ${build.build_type.toUpperCase()} build`,
            affected_entity: buildId,
          });

        // Redirect to Supabase Storage signed URL
        res.redirect(302, build.download_url);
        return;
      }

      // Fallback: try local file system (legacy support)
      const outputDir = process.env.OUTPUT_DIRECTORY || '/tmp/makevia-outputs';
      const fileName = `${buildId}.${build.build_type}`;
      const filePath = path.join(outputDir, fileName);

      // Check if file exists locally
      await fs.access(filePath);

      // Set appropriate headers
      const downloadName = `${app.name.replace(/[^a-zA-Z0-9]/g, '_')}_${build.build_mode}.${build.build_type}`;
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Type', getContentType(build.build_type));

      // Stream the file
      const fs_stream = await import('fs');
      const fileStream = fs_stream.createReadStream(filePath);
      fileStream.pipe(res);

      // Log download
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: build.app_id,
          user_id: userId,
          action_type: 'build_downloaded',
          action_description: `Downloaded ${build.build_type.toUpperCase()} build`,
          affected_entity: buildId,
        });

    } catch (error) {
      logger.error('Error serving build download:', error);
      res.status(404).json({
        success: false,
        error: 'Build file not found',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * DELETE /api/builds/:buildId
 * Cancel a build
 */
router.delete('/:buildId',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { buildId } = req.params;

    const build = await buildService.getBuildStatus(buildId);

    if (!build) {
      res.status(404).json({
        success: false,
        error: 'Build not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify user has access to this build
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('id')
      .eq('id', build.app_id)
      .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
      .single();

    if (!app) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!['queued', 'building'].includes(build.status)) {
      res.status(400).json({
        success: false,
        error: 'Cannot cancel build that is not in progress',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      await buildService.cancelBuild(buildId);

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: build.app_id,
          user_id: userId,
          action_type: 'build_cancelled',
          action_description: `Cancelled ${build.build_type.toUpperCase()} build`,
          affected_entity: buildId,
        });

      res.json({
        success: true,
        message: 'Build cancelled successfully',
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Error cancelling build:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to cancel build',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * POST /api/builds/webhook/stripe
 * Stripe webhook for build payment processing
 */
router.post('/webhook/stripe',
  // No auth required for webhooks, but verify signature
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !webhookSecret) {
      res.status(400).send('Missing signature or webhook secret');
      return;
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      logger.error('Webhook signature verification failed:', err);
      res.status(400).send(`Webhook Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return;
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      
      if (session.metadata?.purpose === 'app_build') {
        try {
          // Update purchase status to completed
          const { error } = await supabase.serviceClient
            .from('app_build_purchases')
            .update({
              status: 'completed',
              stripe_payment_intent_id: session.payment_intent as string || session.id,
            })
            .eq('stripe_payment_intent_id', session.id);

          if (error) {
            logger.error('Error updating build purchase:', error);
          } else {
            logger.info(`Build payment completed for session ${session.id}`);
          }
        } catch (error) {
          logger.error('Error processing build payment webhook:', error);
        }
      }
    }

    res.json({ received: true });
  })
);

/**
 * GET /api/builds/queue/status
 * Get build queue status (admin/monitoring)
 */
router.get('/queue/status',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // Get user's builds in queue
    const { data: userBuilds } = await supabase.serviceClient
      .from('app_builds')
      .select(`
        build_id,
        status,
        build_type,
        build_mode,
        created_at,
        cached_from_build_id,
        apps!inner(name)
      `)
      .eq('user_id', userId)
      .in('status', ['queued', 'building'])
      .order('created_at');

    // Get overall queue stats
    const { data: queueStats } = await supabase.serviceClient
      .from('app_builds')
      .select('status')
      .in('status', ['queued', 'building']);

    const stats = {
      queued: queueStats?.filter(b => b.status === 'queued').length || 0,
      building: queueStats?.filter(b => b.status === 'building').length || 0,
    };

    res.json({
      success: true,
      data: {
        user_builds: userBuilds || [],
        queue_stats: stats,
      },
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/builds/cleanup
 * Clean up old cached builds and storage
 */
router.post('/cleanup',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const { app_name, older_than_days } = req.body;
    
    try {
      // Clean up build cache
      await buildService.cleanupOldBuilds(req.body.app_id);
      
      // Clean up Supabase storage
      const deletedCount = await supabaseStorageService.cleanupOldArtifacts(
        app_name,
        older_than_days || 30,
        5 // Keep last 5 builds
      );
      
      // Get updated storage stats
      const stats = await supabaseStorageService.getStorageStats();
      
      res.json({
        success: true,
        message: app_name 
          ? `Cleaned up builds for app ${app_name}` 
          : 'Cleaned up builds across all apps',
        data: {
          deleted_artifacts: deletedCount,
          storage_stats: {
            total_files: stats.totalFiles,
            total_size_mb: Math.round(stats.totalSize / 1024 / 1024 * 100) / 100,
            apps: stats.appBreakdown.length
          }
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error cleaning up builds:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to cleanup builds',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

/**
 * GET /api/builds/storage/stats
 * Get storage usage statistics
 */
router.get('/storage/stats',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    try {
      const stats = await supabaseStorageService.getStorageStats();
      
      res.json({
        success: true,
        data: {
          total_files: stats.totalFiles,
          total_size_bytes: stats.totalSize,
          total_size_mb: Math.round(stats.totalSize / 1024 / 1024 * 100) / 100,
          apps: stats.appBreakdown.map(app => ({
            name: app.app,
            files: app.files,
            size_mb: Math.round(app.size / 1024 / 1024 * 100) / 100
          }))
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error getting storage stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get storage statistics',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

export default router;