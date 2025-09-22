import { Router } from 'express';
import multer from 'multer';
import { fileService } from '@/services/files';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth, requireOwnership } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { AuthenticatedRequest, FileUploadRequest } from '@/types';
import {
  ValidationError,
  NotFoundError,
} from '@/middleware/errorHandler';

const router = Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1, // Only one file at a time
  },
  fileFilter: (req, file, cb) => {
    // Basic validation - more detailed validation in service
    const allowedMimes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'application/json', 'text/plain'
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  },
});

// Apply upload rate limiting to all routes
router.use(rateLimits.upload);

// Upload file
router.post('/upload',
  requireAuth,
  upload.single('file'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const file = req.file;

    if (!file) {
      throw ValidationError('No file provided');
    }

    // Parse request body
    const { app_id, file_type, metadata } = req.body;

    // Validate file_type
    const validFileTypes = ['image', 'icon', 'asset', 'other'];
    if (!file_type || !validFileTypes.includes(file_type)) {
      throw ValidationError('Valid file_type is required (image, icon, asset, other)');
    }

    // Validate app_id if provided
    if (app_id) {
      const { supabase } = await import('@/services/supabase');
      const app = await supabase.getAppById(app_id, user.id);
      if (!app) {
        throw NotFoundError('App not found or access denied');
      }
    }

    const uploadRequest: FileUploadRequest = {
      app_id: app_id || undefined,
      file_type,
      metadata: metadata ? JSON.parse(metadata) : undefined,
    };

    const uploadedFile = await fileService.uploadFile(
      user.id,
      {
        buffer: file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      },
      uploadRequest
    );

    logger.info(`File uploaded by user ${user.id}: ${uploadedFile.filename}`);

    res.status(201).json({
      success: true,
      data: uploadedFile,
      message: 'File uploaded successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Get user's files
router.get('/',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { app_id, file_type, page = 1, limit = 20 } = req.query;

    // Validate pagination parameters
    const parsedPage = Math.max(parseInt(page as string) || 1, 1);
    const parsedLimit = Math.min(Math.max(parseInt(limit as string) || 20, 1), 100);
    const offset = (parsedPage - 1) * parsedLimit;

    const files = await fileService.getUserFiles(
      user.id,
      app_id as string,
      file_type as string,
      parsedLimit,
      offset
    );

    res.json({
      success: true,
      data: files,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total: files.length, // Would need actual count from database
        pages: Math.ceil(files.length / parsedLimit),
      },
      timestamp: new Date().toISOString(),
    });
  })
);

// Get file by ID
router.get('/:id',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { id } = req.params;

    const { supabase } = await import('@/services/supabase');
    const file = await supabase.getFileById(id);

    if (!file || file.user_id !== user.id) {
      throw NotFoundError('File not found or access denied');
    }

    res.json({
      success: true,
      data: file,
      timestamp: new Date().toISOString(),
    });
  })
);

// Delete file
router.delete('/:id',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { id } = req.params;

    await fileService.deleteFile(user.id, id);

    logger.info(`File deleted by user ${user.id}: ${id}`);

    res.json({
      success: true,
      message: 'File deleted successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Get signed upload URL (for direct client uploads)
router.post('/signed-upload-url',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { filename, file_type } = req.body;

    if (!filename || !file_type) {
      throw ValidationError('filename and file_type are required');
    }

    const validFileTypes = ['image', 'icon', 'asset', 'other'];
    if (!validFileTypes.includes(file_type)) {
      throw ValidationError('Valid file_type is required (image, icon, asset, other)');
    }

    const { signedUrl, path } = await fileService.getSignedUploadUrl(
      user.id,
      filename,
      file_type
    );

    res.json({
      success: true,
      data: {
        signed_url: signedUrl,
        path: path,
        expires_in: 3600, // 1 hour
      },
      message: 'Signed upload URL created successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Get signed download URL
router.post('/:id/signed-download-url',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const { id } = req.params;

    const signedUrl = await fileService.getSignedDownloadUrl(user.id, id);

    res.json({
      success: true,
      data: {
        signed_url: signedUrl,
        expires_in: 3600, // 1 hour
      },
      message: 'Signed download URL created successfully',
      timestamp: new Date().toISOString(),
    });
  })
);

// Get file usage statistics
router.get('/stats/usage',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = req.user!;

    const stats = await fileService.getFileStats(user.id);

    res.json({
      success: true,
      data: {
        ...stats,
        storage_limit: 1024 * 1024 * 1024, // 1GB limit (could be tier-based)
        storage_used_percentage: Math.round((stats.total_size / (1024 * 1024 * 1024)) * 100 * 100) / 100,
      },
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
        error: 'File size exceeds 10MB limit',
        code: 'FILE_TOO_LARGE',
        timestamp: new Date().toISOString(),
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Only one file allowed per upload',
        code: 'TOO_MANY_FILES',
        timestamp: new Date().toISOString(),
      });
    }
  }
  
  if (error.message && error.message.includes('File type')) {
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