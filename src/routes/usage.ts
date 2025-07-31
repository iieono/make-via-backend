import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { AuthenticatedRequest, UsageStats } from '@/types';

const router = Router();

// Apply general rate limiting to all routes
router.use(rateLimits.general);

// Get current usage statistics
router.get('/', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;

  // Get user's apps and screens
  const apps = await supabase.getUserApps(user.id, 1000);
  
  // Calculate total screens across all apps
  let totalScreens = 0;
  for (const app of apps) {
    const screens = await supabase.getAppScreens(app.id);
    totalScreens += screens.length;
  }

  // Build usage statistics
  const usage: UsageStats = {
    claude_generations_used: subscription?.claude_usage_count || 0,
    claude_generations_limit: subscription?.claude_usage_limit || 10,
    apps_created: apps.length,
    apps_limit: subscription?.apps_limit || 1,
    screens_created: totalScreens,
    screens_limit: subscription?.screens_limit || 5,
    period_start: subscription?.current_period_start || new Date().toISOString(),
    period_end: subscription?.current_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };

  res.json({
    success: true,
    data: usage,
    timestamp: new Date().toISOString(),
  });
}));

// Get detailed usage breakdown
router.get('/detailed', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;
  const { period = 'current' } = req.query;

  // Get user's apps with detailed information
  const apps = await supabase.getUserApps(user.id, 1000);
  
  // Build detailed app usage
  const appUsage = await Promise.all(
    apps.map(async (app) => {
      const screens = await supabase.getAppScreens(app.id);
      return {
        app_id: app.id,
        app_name: app.name,
        status: app.status,
        screens_count: screens.length,
        preview_count: app.preview_count,
        build_count: app.build_count,
        last_previewed_at: app.last_previewed_at,
        last_built_at: app.last_built_at,
        created_at: app.created_at,
        updated_at: app.updated_at,
      };
    })
  );

  // Calculate totals
  const totalScreens = appUsage.reduce((sum, app) => sum + app.screens_count, 0);
  const totalPreviews = appUsage.reduce((sum, app) => sum + app.preview_count, 0);
  const totalBuilds = appUsage.reduce((sum, app) => sum + app.build_count, 0);

  // Build limits based on subscription tier
  const limits = {
    claude_generations: subscription?.claude_usage_limit || 10,
    apps: subscription?.apps_limit || 1,
    screens: subscription?.screens_limit || 5,
  };

  const detailedUsage = {
    summary: {
      tier: subscription?.tier || 'free',
      claude_generations_used: subscription?.claude_usage_count || 0,
      claude_generations_remaining: Math.max(0, limits.claude_generations - (subscription?.claude_usage_count || 0)),
      apps_created: apps.length,
      apps_remaining: Math.max(0, limits.apps - apps.length),
      screens_created: totalScreens,
      screens_remaining: Math.max(0, limits.screens - totalScreens),
      total_previews: totalPreviews,
      total_builds: totalBuilds,
    },
    limits: limits,
    period: {
      start: subscription?.current_period_start || new Date().toISOString(),
      end: subscription?.current_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
    apps: appUsage,
  };

  res.json({
    success: true,
    data: detailedUsage,
    timestamp: new Date().toISOString(),
  });
}));

// Get usage history (for analytics)
router.get('/history', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { period = '30d', metric = 'all' } = req.query;

  // This would typically query historical usage data
  // For now, return mock data structure
  const history = {
    period: period,
    metric: metric,
    data_points: [
      // Would contain historical usage data points
      // e.g., daily/weekly/monthly aggregated usage
    ],
    summary: {
      total_ai_generations: subscription?.claude_usage_count || 0,
      total_apps_created: 0, // Would track over time
      total_screens_created: 0, // Would track over time
      peak_usage_day: null,
      average_daily_usage: 0,
    },
  };

  res.json({
    success: true,
    data: history,
    message: 'Usage history retrieved successfully',
    timestamp: new Date().toISOString(),
  });
}));

// Get usage alerts/warnings
router.get('/alerts', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;

  const alerts = [];

  if (subscription) {
    // Check Claude usage
    const claudeUsagePercent = (subscription.claude_usage_count / subscription.claude_usage_limit) * 100;
    if (claudeUsagePercent >= 90) {
      alerts.push({
        type: 'warning',
        category: 'claude_usage',
        message: `You've used ${claudeUsagePercent.toFixed(0)}% of your AI generations this billing period`,
        remaining: subscription.claude_usage_limit - subscription.claude_usage_count,
        limit: subscription.claude_usage_limit,
        action: 'Consider upgrading your plan or wait for next billing period',
      });
    } else if (claudeUsagePercent >= 75) {
      alerts.push({
        type: 'info',
        category: 'claude_usage',
        message: `You've used ${claudeUsagePercent.toFixed(0)}% of your AI generations this billing period`,
        remaining: subscription.claude_usage_limit - subscription.claude_usage_count,
        limit: subscription.claude_usage_limit,
        action: 'Monitor your usage to avoid hitting limits',
      });
    }
  }

  // Check app limit
  const apps = await supabase.getUserApps(user.id, 1000);
  const appLimit = subscription?.apps_limit || 1;
  const appUsagePercent = (apps.length / appLimit) * 100;

  if (appUsagePercent >= 100) {
    alerts.push({
      type: 'error',
      category: 'app_limit',
      message: 'You have reached your app creation limit',
      current: apps.length,
      limit: appLimit,
      action: 'Delete unused apps or upgrade your plan to create more',
    });
  } else if (appUsagePercent >= 80) {
    alerts.push({
      type: 'warning',
      category: 'app_limit',
      message: `You've created ${apps.length} of ${appLimit} allowed apps`,
      current: apps.length,
      limit: appLimit,
      action: 'Consider upgrading your plan if you need more apps',
    });
  }

  res.json({
    success: true,
    data: {
      alerts: alerts,
      total_alerts: alerts.length,
      has_critical_alerts: alerts.some(alert => alert.type === 'error'),
    },
    timestamp: new Date().toISOString(),
  });
}));

// Get usage recommendations
router.get('/recommendations', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const subscription = req.subscription;

  const recommendations = [];

  // Get user's apps and usage patterns
  const apps = await supabase.getUserApps(user.id, 1000);
  
  // Analyze usage patterns and provide recommendations
  if (subscription?.tier === 'free') {
    if (apps.length >= 1) {
      recommendations.push({
        type: 'upgrade',
        title: 'Upgrade to Pro for More Apps',
        description: 'Create up to 10 apps with Pro plan',
        action: 'upgrade_to_pro',
        priority: 'high',
      });
    }

    if ((subscription.claude_usage_count / subscription.claude_usage_limit) > 0.8) {
      recommendations.push({
        type: 'upgrade',
        title: 'Need More AI Generations?',
        description: 'Pro plan includes 500 AI generations per month',
        action: 'upgrade_to_pro',
        priority: 'medium',
      });
    }
  }

  // Check for unused apps
  const unusedApps = apps.filter(app => 
    app.status === 'draft' && 
    new Date(app.updated_at) < new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  );

  if (unusedApps.length > 0) {
    recommendations.push({
      type: 'optimization',
      title: 'Clean Up Unused Apps',
      description: `You have ${unusedApps.length} draft apps that haven't been updated in 30+ days`,
      action: 'review_unused_apps',
      priority: 'low',
    });
  }

  // Check for apps without recent activity
  const inactiveApps = apps.filter(app => 
    app.preview_count === 0 && 
    new Date(app.created_at) < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  );

  if (inactiveApps.length > 0) {
    recommendations.push({
      type: 'engagement',
      title: 'Test Your Apps',
      description: `${inactiveApps.length} apps haven't been previewed yet`,
      action: 'preview_apps',
      priority: 'medium',
    });
  }

  res.json({
    success: true,
    data: {
      recommendations: recommendations,
      total_recommendations: recommendations.length,
    },
    timestamp: new Date().toISOString(),
  });
}));

// Export usage data
router.get('/export', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { format = 'json', period = '30d' } = req.query;

  // Get comprehensive usage data
  const apps = await supabase.getUserApps(user.id, 1000);
  const subscription = req.subscription;

  const exportData = {
    user_id: user.id,
    export_timestamp: new Date().toISOString(),
    period: period,
    subscription: {
      tier: subscription?.tier || 'free',
      status: subscription?.status || 'active',
      period_start: subscription?.current_period_start,
      period_end: subscription?.current_period_end,
    },
    usage: {
      claude_generations: {
        used: subscription?.claude_usage_count || 0,
        limit: subscription?.claude_usage_limit || 10,
      },
      apps: {
        created: apps.length,
        limit: subscription?.apps_limit || 1,
        details: apps.map(app => ({
          id: app.id,
          name: app.name,
          status: app.status,
          created_at: app.created_at,
          updated_at: app.updated_at,
          preview_count: app.preview_count,
          build_count: app.build_count,
        })),
      },
    },
  };

  if (format === 'csv') {
    // Convert to CSV format
    const csv = convertToCSV(exportData);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="makevia-usage-${Date.now()}.csv"`);
    res.send(csv);
  } else {
    // Return JSON format
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="makevia-usage-${Date.now()}.json"`);
    res.json({
      success: true,
      data: exportData,
      timestamp: new Date().toISOString(),
    });
  }
}));

// Helper function to convert data to CSV
function convertToCSV(data: any): string {
  // Simple CSV conversion for apps data
  const headers = ['App ID', 'App Name', 'Status', 'Created At', 'Updated At', 'Preview Count', 'Build Count'];
  const rows = data.usage.apps.details.map((app: any) => [
    app.id,
    app.name,
    app.status,
    app.created_at,
    app.updated_at,
    app.preview_count,
    app.build_count,
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map((row: any) => row.map((field: any) => `"${field}"`).join(',')),
  ].join('\n');

  return csvContent;
}

export default router;