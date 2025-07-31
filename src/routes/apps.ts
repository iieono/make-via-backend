import { Router } from 'express';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth, requireOwnership, optionalAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { AuthenticatedRequest, App, Screen } from '@/types';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from '@/middleware/errorHandler';

const router = Router();

// Apply general rate limiting to all routes
router.use(rateLimits.general);

// Get user's apps
router.get('/', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { page = 1, limit = 20, status, search } = req.query;

  // Validate pagination parameters
  const parsedPage = Math.max(parseInt(page as string) || 1, 1);
  const parsedLimit = Math.min(Math.max(parseInt(limit as string) || 20, 1), 100);
  const offset = (parsedPage - 1) * parsedLimit;

  let apps = await supabase.getUserApps(user.id, parsedLimit, offset);

  // Filter by status if provided
  if (status && typeof status === 'string') {
    const validStatuses = ['draft', 'preview', 'published', 'archived'];
    if (validStatuses.includes(status)) {
      apps = apps.filter(app => app.status === status);
    }
  }

  // Filter by search term if provided
  if (search && typeof search === 'string') {
    const searchTerm = search.toLowerCase();
    apps = apps.filter(app => 
      app.name.toLowerCase().includes(searchTerm) ||
      app.description?.toLowerCase().includes(searchTerm)
    );
  }

  res.json({
    success: true,
    data: apps,
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      total: apps.length, // This would need actual total count from database
      pages: Math.ceil(apps.length / parsedLimit),
    },
    timestamp: new Date().toISOString(),
  });
}));

// Create new app
router.post('/', 
  requireAuth,
  rateLimits.appCreation,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { name, description, app_type, primary_color, package_name } = req.body;

    // Validate required fields
    if (!name || typeof name !== 'string') {
      throw ValidationError('App name is required');
    }

    if (name.length < 1 || name.length > 100) {
      throw ValidationError('App name must be between 1 and 100 characters');
    }

    // Validate optional fields
    if (description && (typeof description !== 'string' || description.length > 500)) {
      throw ValidationError('Description must be a string with max 500 characters');
    }

    if (app_type && !['social', 'ecommerce', 'productivity', 'utility', 'game', 'other'].includes(app_type)) {
      throw ValidationError('Invalid app type');
    }

    if (primary_color && (typeof primary_color !== 'string' || !isValidHexColor(primary_color))) {
      throw ValidationError('Primary color must be a valid hex color');
    }

    if (package_name && (typeof package_name !== 'string' || !isValidPackageName(package_name))) {
      throw ValidationError('Invalid package name format');
    }

    // Check user's app limit
    const userApps = await supabase.getUserApps(user.id, 1000);
    const subscription = req.subscription;
    const appLimit = subscription?.apps_limit || 1; // Free tier limit

    if (userApps.length >= appLimit) {
      throw ConflictError(`App limit reached. Your ${subscription?.tier || 'free'} plan allows ${appLimit} apps.`);
    }

    const appData: Omit<App, 'id' | 'created_at' | 'updated_at'> = {
      user_id: user.id,
      name: name.trim(),
      description: description?.trim(),
      package_name: package_name || generatePackageName(name),
      version: '1.0.0',
      status: 'draft',
      primary_color: primary_color || '#2196F3',
      theme_mode: 'system',
      config: {
        app_type: app_type || 'other',
        target_sdk: 34,
        min_sdk: 21,
      },
      metadata: {
        app_type: app_type || 'other',
        created_by: user.id,
        created_from: 'api',
      },
      preview_count: 0,
      build_count: 0,
      is_public: false,
      sharing_enabled: false,
      visibility: 'private',
    };

    const newApp = await supabase.createApp(appData);

    logger.info(`Created new app for user ${user.id}: ${newApp.id}`);

    res.status(201).json({
      success: true,
      data: newApp,
      message: 'App created successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Get specific app
router.get('/:id', 
  requireAuth,
  requireOwnership('app'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { id } = req.params;
    const { include_screens } = req.query;

    const app = await supabase.getAppById(id, user.id);
    if (!app) {
      throw NotFoundError('App');
    }

    let screens: Screen[] = [];
    if (include_screens === 'true') {
      screens = await supabase.getAppScreens(id);
    }

    res.json({
      success: true,
      data: {
        ...app,
        ...(include_screens === 'true' && { screens }),
      },
      timestamp: new Date().toISOString(),
    });
  })
);

// Update app
router.patch('/:id',
  requireAuth,
  requireOwnership('app'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { id } = req.params;
    const updates = req.body;

    // Validate allowed fields
    const allowedFields = [
      'name', 'description', 'primary_color', 'theme_mode', 
      'config', 'metadata', 'is_public', 'sharing_enabled', 'visibility'
    ];
    
    const filteredUpdates: Partial<App> = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        filteredUpdates[field as keyof App] = updates[field];
      }
    }

    if (Object.keys(filteredUpdates).length === 0) {
      throw ValidationError('No valid fields provided for update');
    }

    // Validate individual fields
    if (filteredUpdates.name) {
      if (typeof filteredUpdates.name !== 'string' || 
          filteredUpdates.name.length < 1 || 
          filteredUpdates.name.length > 100) {
        throw ValidationError('App name must be between 1 and 100 characters');
      }
    }

    if (filteredUpdates.primary_color && !isValidHexColor(filteredUpdates.primary_color)) {
      throw ValidationError('Primary color must be a valid hex color');
    }

    if (filteredUpdates.theme_mode && !['light', 'dark', 'system'].includes(filteredUpdates.theme_mode)) {
      throw ValidationError('Theme mode must be light, dark, or system');
    }

    if (filteredUpdates.visibility && !['private', 'organization', 'public'].includes(filteredUpdates.visibility)) {
      throw ValidationError('Visibility must be private, organization, or public');
    }

    const updatedApp = await supabase.updateApp(id, filteredUpdates);

    logger.info(`Updated app ${id} for user ${user.id}`);

    res.json({
      success: true,
      data: updatedApp,
      message: 'App updated successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Delete app (soft delete)
router.delete('/:id',
  requireAuth,
  requireOwnership('app'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { id } = req.params;
    const { confirm } = req.body;

    if (confirm !== 'DELETE_APP') {
      throw ValidationError('App deletion not confirmed. Please provide confirm: "DELETE_APP"');
    }

    await supabase.updateApp(id, {
      deleted_at: new Date().toISOString(),
      status: 'archived',
    });

    logger.warn(`Deleted app ${id} for user ${user.id}`);

    res.json({
      success: true,
      message: 'App deleted successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Duplicate app
router.post('/:id/duplicate',
  requireAuth,
  requireOwnership('app'),
  rateLimits.appCreation,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { id } = req.params;
    const { name } = req.body;

    const originalApp = await supabase.getAppById(id, user.id);
    if (!originalApp) {
      throw NotFoundError('App');
    }

    // Check user's app limit
    const userApps = await supabase.getUserApps(user.id, 1000);
    const subscription = req.subscription;
    const appLimit = subscription?.apps_limit || 1;

    if (userApps.length >= appLimit) {
      throw ConflictError(`App limit reached. Your ${subscription?.tier || 'free'} plan allows ${appLimit} apps.`);
    }

    const duplicatedAppData: Omit<App, 'id' | 'created_at' | 'updated_at'> = {
      ...originalApp,
      name: name || `${originalApp.name} (Copy)`,
      package_name: generatePackageName(name || `${originalApp.name} Copy`),
      status: 'draft',
      preview_count: 0,
      build_count: 0,
      last_previewed_at: undefined,
      last_built_at: undefined,
      metadata: {
        ...originalApp.metadata,
        duplicated_from: originalApp.id,
        created_from: 'duplication',
      },
    };

    const newApp = await supabase.createApp(duplicatedAppData);

    // Duplicate screens as well
    const originalScreens = await supabase.getAppScreens(id);
    for (const screen of originalScreens) {
      const duplicatedScreenData: Omit<Screen, 'id' | 'created_at' | 'updated_at'> = {
        ...screen,
        app_id: newApp.id,
        version: 1,
      };
      await supabase.createScreen(duplicatedScreenData);
    }

    logger.info(`Duplicated app ${id} to ${newApp.id} for user ${user.id}`);

    res.status(201).json({
      success: true,
      data: newApp,
      message: 'App duplicated successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Get app screens
router.get('/:id/screens',
  requireAuth,
  requireOwnership('app'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { id } = req.params;

    const screens = await supabase.getAppScreens(id);

    res.json({
      success: true,
      data: screens,
      timestamp: new Date().toISOString(),
    });
  })
);

// Create screen in app
router.post('/:id/screens',
  requireAuth,
  requireOwnership('app'),
  rateLimits.screenCreation,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { id: appId } = req.params;
    const { name, description, screen_type, canvas_position } = req.body;

    // Validate required fields
    if (!name || typeof name !== 'string') {
      throw ValidationError('Screen name is required');
    }

    if (!screen_type || !['page', 'modal', 'bottom_sheet', 'dialog'].includes(screen_type)) {
      throw ValidationError('Valid screen type is required');
    }

    // Check screen limit
    const existingScreens = await supabase.getAppScreens(appId);
    const subscription = req.subscription;
    const screenLimit = subscription?.screens_limit || 5; // Free tier limit

    if (existingScreens.length >= screenLimit) {
      throw ConflictError(`Screen limit reached. Your ${subscription?.tier || 'free'} plan allows ${screenLimit} screens per app.`);
    }

    const screenData: Omit<Screen, 'id' | 'created_at' | 'updated_at'> = {
      app_id: appId,
      name: name.trim(),
      description: description?.trim(),
      screen_type,
      ui_structure: { type: 'Container', children: [] },
      styling: { backgroundColor: '#FFFFFF' },
      logic: { state: {}, actions: {} },
      canvas_x: canvas_position?.x || 0,
      canvas_y: canvas_position?.y || 0,
      canvas_width: 375,
      canvas_height: 812,
      is_start_screen: existingScreens.length === 0, // First screen is start screen
      requires_auth: false,
      config: {},
      version: 1,
    };

    const newScreen = await supabase.createScreen(screenData);

    logger.info(`Created screen ${newScreen.id} in app ${appId} for user ${user.id}`);

    res.status(201).json({
      success: true,
      data: newScreen,
      message: 'Screen created successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Get public app (for sharing)
router.get('/public/:id', 
  optionalAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { id } = req.params;

    const app = await supabase.getAppById(id);
    if (!app || (!app.is_public && app.visibility === 'private')) {
      throw NotFoundError('App not found or not public');
    }

    // Return only public information
    const publicApp = {
      id: app.id,
      name: app.name,
      description: app.description,
      version: app.version,
      status: app.status,
      icon_url: app.icon_url,
      primary_color: app.primary_color,
      theme_mode: app.theme_mode,
      preview_count: app.preview_count,
      created_at: app.created_at,
      updated_at: app.updated_at,
    };

    res.json({
      success: true,
      data: publicApp,
      timestamp: new Date().toISOString(),
    });
  })
);

// Helper functions
function isValidHexColor(color: string): boolean {
  return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
}

function isValidPackageName(packageName: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName);
}

function generatePackageName(appName: string): string {
  const sanitized = appName.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 20);
  return `com.makevia.${sanitized}`;
}

export default router;