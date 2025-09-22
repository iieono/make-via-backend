import { Router } from 'express';
import multer from 'multer';
import { supabase } from '@/services/supabase';
import { fileService } from '@/services/files';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { 
  CreateAppRequest, 
  UpdateAppRequest, 
  AppConfig, 
  AppContext 
} from '@/types/app-development';

const router = Router();

// Configure multer for app icon uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit for app icons
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    // Log file info for debugging
    logger.info(`File upload - Name: ${file.originalname}, MIME: ${file.mimetype}, Field: ${file.fieldname}`);
    
    // Accept image files and common icon formats
    const allowedMimes = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
      'image/svg+xml', 'image/bmp', 'image/tiff',
      'application/octet-stream' // Sometimes images are sent as this
    ];
    
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico'];
    
    const hasValidMime = file.mimetype.startsWith('image/') || allowedMimes.includes(file.mimetype);
    const hasValidExtension = allowedExtensions.some(ext => 
      file.originalname.toLowerCase().endsWith(ext)
    );
    
    if (hasValidMime || hasValidExtension) {
      cb(null, true);
    } else {
      logger.error(`Invalid file type - MIME: ${file.mimetype}, Name: ${file.originalname}`);
      cb(new Error('Only image files are allowed for app icons'));
    }
  },
});

// Apply authentication to all routes
router.use(requireAuth);

/**
 * GET /api/apps
 * Get all apps for the authenticated user
 */
router.get('/', 
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { status, limit = 50, offset = 0 } = req.query;

    let query = supabase.serviceClient
      .from('apps')
      .select(`
        *,
        app_templates(name, category),
        _count_pages:app_pages(count),
        _count_collaborators:app_collaborators(count)
      `)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

    const { data: apps, error, count } = await query;

    if (error) {
      logger.error('Error fetching apps:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch apps',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: apps,
      pagination: {
        total: count,
        limit: Number(limit),
        offset: Number(offset),
      },
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /api/apps/:id
 * Get a specific app by ID
 */
router.get('/:id',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id: appId } = req.params;

    // First check if user owns the app directly
    const { data: app, error } = await supabase.serviceClient
      .from('apps')
      .select(`
        *,
        app_templates(*),
        app_dependencies(*),
        github_repositories(*)
      `)
      .eq('id', appId)
      .eq('user_id', userId)
      .single();

    if (error || !app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: app,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /api/apps/:id/full-context
 * Get complete app context for AI prompting
 */
router.get('/:id/full-context',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id: appId } = req.params;

    // Get app with all related data
    const { data: app, error: appError } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', appId)
      .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
      .single();

    if (appError || !app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get all pages
    const { data: pages } = await supabase.serviceClient
      .from('app_pages')
      .select('*')
      .eq('app_id', appId)
      .order('created_at');

    // Get all components
    const { data: components } = await supabase.serviceClient
      .from('page_components')
      .select(`
        *,
        app_pages!inner(app_id)
      `)
      .eq('app_pages.app_id', appId);

    // Get recent activity
    const { data: activity } = await supabase.serviceClient
      .from('app_activity_log')
      .select('*')
      .eq('app_id', appId)
      .order('created_at', { ascending: false })
      .limit(20);

    // Get dependencies
    const { data: dependencies } = await supabase.serviceClient
      .from('app_dependencies')
      .select('*')
      .eq('app_id', appId)
      .eq('is_active', true);

    const context: AppContext = {
      app: app as AppConfig,
      all_pages: pages || [],
      all_components: components || [],
      recent_activity: activity || [],
      dependencies: dependencies || [],
    };

    res.json({
      success: true,
      data: context,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/apps
 * Create a new app (supports both JSON and multipart form data with app icon)
 */
router.post('/',
  rateLimits.api,
  upload.single('file'), // Handle optional app icon upload (Flutter sends as 'file')
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    
    // Handle both JSON and form data
    let requestData: CreateAppRequest;
    
    // Handle both JSON and form data (multer parses form data into req.body)
    requestData = {
      name: req.body.name,
      description: req.body.description,
      package_name: req.body.package_name,
      primary_color: req.body.primary_color,
      accent_color: req.body.accent_color,
      theme_mode: req.body.theme_mode,
      target_platforms: req.body.target_platforms ? 
        (Array.isArray(req.body.target_platforms) ? req.body.target_platforms : req.body.target_platforms.split(',')) : 
        undefined,
      min_sdk_version: req.body.min_sdk_version ? parseInt(req.body.min_sdk_version) : undefined,
      target_sdk_version: req.body.target_sdk_version ? parseInt(req.body.target_sdk_version) : undefined,
      version_name: req.body.version_name,
      version_code: req.body.version_code ? parseInt(req.body.version_code) : undefined,
      tags: req.body.tags ? 
        (Array.isArray(req.body.tags) ? req.body.tags : req.body.tags.split(',')) : 
        undefined,
      metadata: req.body.metadata ? 
        (typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : req.body.metadata) : 
        undefined,
    };

    // Validate required fields
    if (!requestData.name) {
      res.status(400).json({
        success: false,
        error: 'App name is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Generate package name if not provided
    const packageName = requestData.package_name || 
      `com.makevia.${requestData.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    // Handle app icon upload if provided
    let appIconUrl = requestData.app_icon_url;
    let uploadedFileId: string | null = null;
    if (req.file) {
      try {
        const uploadedFile = await fileService.uploadFile(
          userId,
          {
            buffer: req.file.buffer,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
          },
          {
            file_type: 'icon',
            metadata: {
              description: `App icon for ${requestData.name}`,
            },
          }
        );
        appIconUrl = uploadedFile.public_url;
        uploadedFileId = uploadedFile.id;
        logger.info(`App icon uploaded successfully: ${uploadedFile.public_url}`);
      } catch (uploadError) {
        logger.error('Error uploading app icon:', uploadError);
        res.status(500).json({
          success: false,
          error: `Failed to upload app icon`,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    const appData = {
      user_id: userId,
      name: requestData.name,
      description: requestData.description,
      package_name: packageName,
      template_id: requestData.template_id,
      app_icon_url: appIconUrl,
      primary_color: requestData.primary_color || '#2196F3',
      accent_color: requestData.accent_color || '#FF4081',
      theme_mode: requestData.theme_mode || 'system',
      target_platforms: requestData.target_platforms || ['android', 'ios'],
      min_sdk_version: requestData.min_sdk_version || 21,
      target_sdk_version: requestData.target_sdk_version || 34,
      version_name: requestData.version_name || '1.0.0',
      version_code: requestData.version_code || 1,
      tags: requestData.tags || [],
      metadata: requestData.metadata || {},
      status: 'draft' as const,
    };

    const { data: app, error } = await supabase.serviceClient
      .from('apps')
      .insert(appData)
      .select()
      .single();

    if (error) {
      logger.error('Error creating app:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create app',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Create default home page
    await supabase.serviceClient
      .from('app_pages')
      .insert({
        app_id: app.id,
        name: 'Home',
        title: 'Home',
        route_path: '/',
        page_type: 'home',
        is_home_page: true,
      });

    // Update file record with app_id if we uploaded an icon
    if (uploadedFileId) {
      try {
        await supabase.serviceClient
          .from('file_uploads')
          .update({ app_id: app.id })
          .eq('id', uploadedFileId);
        logger.info(`Updated file record ${uploadedFileId} with app_id ${app.id}`);
      } catch (fileUpdateError) {
        logger.warn('Failed to update file record with app_id:', fileUpdateError);
        // Don't fail the app creation for this
      }
    }

    // Log activity
    await supabase.serviceClient
      .from('app_activity_log')
      .insert({
        app_id: app.id,
        user_id: userId,
        action_type: 'app_created',
        action_description: `Created new app: ${app.name}`,
        after_state: app,
      });

    res.status(201).json({
      success: true,
      data: app,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * PUT /api/apps/:id
 * Update an app
 */
router.put('/:id',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id: appId } = req.params;
    const updateData: UpdateAppRequest = req.body;

    // Verify app ownership or collaboration
    const { data: app, error: fetchError } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', appId)
      .or(`user_id.eq.${userId},app_collaborators.user_id.eq.${userId}`)
      .single();

    if (fetchError || !app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { data: updatedApp, error } = await supabase.serviceClient
      .from('apps')
      .update({
        ...updateData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', appId)
      .select()
      .single();

    if (error) {
      logger.error('Error updating app:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update app',
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
        action_type: 'app_updated',
        action_description: `Updated app configuration`,
        before_state: app,
        after_state: updatedApp,
      });

    res.json({
      success: true,
      data: updatedApp,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/apps/:id/update-with-icon
 * Update an app with icon upload
 */
router.post('/:id/update-with-icon',
  rateLimits.api,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id: appId } = req.params;

    // Parse multipart form data
    const requestData = parseFormData(req.body);
    
    logger.info(`Update app with icon - App: ${appId}, User: ${userId}`);
    logger.info('Form data:', JSON.stringify(requestData, null, 2));
    
    // Verify app ownership
    const { data: app, error: fetchError } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', appId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Handle app icon upload if provided
    let appIconUrl = app.app_icon_url;
    let uploadedFileId: string | null = null;
    if (req.file) {
      try {
        const uploadedFile = await fileService.uploadFile(
          userId,
          {
            buffer: req.file.buffer,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
          },
          {
            file_type: 'icon',
            metadata: {
              description: `Updated app icon for ${requestData.name || app.name}`,
            },
          }
        );
        appIconUrl = uploadedFile.public_url;
        uploadedFileId = uploadedFile.id;
        logger.info(`App icon updated successfully: ${uploadedFile.public_url}`);
      } catch (uploadError) {
        logger.error('Error uploading app icon:', uploadError);
        res.status(500).json({
          success: false,
          error: `Failed to upload app icon`,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    // Prepare update data
    const updateData: any = {
      ...requestData,
      app_icon_url: appIconUrl,
      updated_at: new Date().toISOString(),
    };

    // Remove undefined values
    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined || updateData[key] === '') {
        delete updateData[key];
      }
    });

    // Update the app
    const { data: updatedApp, error } = await supabase.serviceClient
      .from('apps')
      .update(updateData)
      .eq('id', appId)
      .select()
      .single();

    if (error) {
      logger.error('Error updating app:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update app',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Update file record with app_id if we uploaded an icon
    if (uploadedFileId) {
      try {
        await supabase.serviceClient
          .from('file_uploads')
          .update({ app_id: appId })
          .eq('id', uploadedFileId);
        logger.info(`Updated file record ${uploadedFileId} with app_id ${appId}`);
      } catch (fileUpdateError) {
        logger.warn('Failed to update file record with app_id:', fileUpdateError);
        // Don't fail the app update for this
      }
    }

    // Log activity
    await supabase.serviceClient
      .from('app_activity_log')
      .insert({
        app_id: appId,
        user_id: userId,
        action: 'app_updated',
        description: `App "${updatedApp.name}" was updated`,
        metadata: { 
          updated_fields: Object.keys(requestData),
          icon_updated: !!req.file,
        },
      });

    res.json({
      success: true,
      data: updatedApp,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/apps/:id/clone
 * Clone an existing app
 */
router.post('/:id/clone',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id: sourceAppId } = req.params;
    const { name } = req.body;

    if (!name) {
      res.status(400).json({
        success: false,
        error: 'New app name is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get source app
    const { data: sourceApp, error: sourceError } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', sourceAppId)
      .single();

    if (sourceError || !sourceApp) {
      res.status(404).json({
        success: false,
        error: 'Source app not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Create cloned app
    const clonedAppData = {
      ...sourceApp,
      id: undefined, // Will be auto-generated
      user_id: userId,
      name: name,
      package_name: `com.makevia.${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      status: 'draft' as const,
      created_at: undefined,
      updated_at: undefined,
    };

    const { data: clonedApp, error: cloneError } = await supabase.serviceClient
      .from('apps')
      .insert(clonedAppData)
      .select()
      .single();

    if (cloneError) {
      logger.error('Error cloning app:', cloneError);
      res.status(500).json({
        success: false,
        error: 'Failed to clone app',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Clone pages and components (simplified version)
    const { data: sourcePages } = await supabase.serviceClient
      .from('app_pages')
      .select('*')
      .eq('app_id', sourceAppId);

    if (sourcePages && sourcePages.length > 0) {
      const clonedPages = sourcePages.map(page => ({
        ...page,
        id: undefined,
        app_id: clonedApp.id,
        created_at: undefined,
        updated_at: undefined,
      }));

      await supabase.serviceClient
        .from('app_pages')
        .insert(clonedPages);
    }

    res.status(201).json({
      success: true,
      data: clonedApp,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * DELETE /api/apps/:id
 * Delete an app
 */
router.delete('/:id',
  rateLimits.api,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { id: appId } = req.params;

    // Verify app ownership
    const { data: app, error: fetchError } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', appId)
      .eq('user_id', userId) // Only owner can delete
      .single();

    if (fetchError || !app) {
      res.status(404).json({
        success: false,
        error: 'App not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { error } = await supabase.serviceClient
      .from('apps')
      .delete()
      .eq('id', appId);

    if (error) {
      logger.error('Error deleting app:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete app',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      message: 'App deleted successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Handle multer errors
router.use((error: any, req: any, res: any, next: any) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'App icon file size exceeds 5MB limit',
        code: 'FILE_TOO_LARGE',
        timestamp: new Date().toISOString(),
      });
    }
    return res.status(400).json({
      success: false,
      error: `File upload error: ${error.message}`,
      code: error.code,
      timestamp: new Date().toISOString(),
    });
  }
  
  if (error.message === 'Only image files are allowed for app icons') {
    return res.status(400).json({
      success: false,
      error: error.message,
      code: 'INVALID_FILE_TYPE',
      timestamp: new Date().toISOString(),
    });
  }
  
  next(error);
});

export default router;