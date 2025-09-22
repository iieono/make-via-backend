import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import type { FileUpload, FileUploadRequest } from '@/types';

class FileService {
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  private readonly ALLOWED_TYPES = {
    image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    icon: ['image/png', 'image/svg+xml', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'application/octet-stream'],
    asset: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/json'],
    other: ['application/json', 'text/plain']
  };

  async uploadFile(
    userId: string,
    file: {
      buffer: Buffer;
      originalName: string;
      mimeType: string;
      size: number;
    },
    request: FileUploadRequest
  ): Promise<FileUpload> {
    try {
      // Validate file size
      if (file.size > this.MAX_FILE_SIZE) {
        throw new Error('File size exceeds 10MB limit');
      }

      // Validate file type with fallback for generic MIME types
      const allowedTypes = this.ALLOWED_TYPES[request.file_type] || [];
      let mimeType = file.mimeType;
      
      // If MIME type is generic (application/octet-stream), try to detect from extension
      if (mimeType === 'application/octet-stream' && request.file_type === 'icon') {
        const extension = this.getFileExtension(file.originalName).toLowerCase();
        const mimeTypeMap: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml'
        };
        mimeType = mimeTypeMap[extension] || mimeType;
      }
      
      if (!allowedTypes.includes(mimeType)) {
        throw new Error(`File type ${mimeType} not allowed for ${request.file_type}`);
      }

      // Generate unique filename
      const timestamp = Date.now();
      const extension = this.getFileExtension(file.originalName);
      const filename = `${userId}/${request.file_type}/${timestamp}-${this.sanitizeFilename(file.originalName)}${extension}`;

      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('app-icons')
        .upload(filename, file.buffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`);
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('app-icons')
        .getPublicUrl(filename);

      // Save file record to database
      const fileRecord = {
        user_id: userId,
        app_id: request.app_id,
        original_name: file.originalName,
        file_name: filename,
        file_path: uploadData.path,
        file_size: file.size,
        mime_type: mimeType,
        file_hash: null,
        storage_bucket: 'app-icons',
        is_public: true,
        metadata: {
          mime_type: mimeType,
          original_mime_type: file.mimeType,
          file_type: request.file_type,
          public_url: urlData.publicUrl,
          ...request.metadata,
        },
        expires_at: null,
      };

      const savedFile = await supabase.createFile(fileRecord);
      
      // Add public_url to the returned object for compatibility
      const fileWithUrl = {
        ...savedFile,
        public_url: urlData.publicUrl
      };
      
      logger.info(`File uploaded successfully for user ${userId}: ${filename}`);
      return fileWithUrl;

    } catch (error) {
      logger.error('Error uploading file:', error);
      throw error;
    }
  }

  async deleteFile(userId: string, fileId: string): Promise<void> {
    try {
      // Get file record
      const file = await supabase.getFileById(fileId);
      if (!file || file.user_id !== userId) {
        throw new Error('File not found or access denied');
      }

      // Delete from Supabase Storage
      const { error: deleteError } = await supabase.storage
        .from('app-icons')
        .remove([file.file_path]);

      if (deleteError) {
        logger.warn(`Failed to delete file from storage: ${deleteError.message}`);
      }

      // Delete from database
      await supabase.deleteFile(fileId);

      logger.info(`File deleted for user ${userId}: ${file.file_name}`);

    } catch (error) {
      logger.error('Error deleting file:', error);
      throw error;
    }
  }

  async getUserFiles(
    userId: string,
    appId?: string,
    fileType?: string,
    limit = 50,
    offset = 0
  ): Promise<FileUpload[]> {
    try {
      // Note: fileType filtering now needs to be done on metadata.file_type
      return await supabase.getUserFiles(userId, appId, fileType, limit, offset);
    } catch (error) {
      logger.error('Error fetching user files:', error);
      throw error;
    }
  }

  async getSignedUploadUrl(
    userId: string,
    filename: string,
    fileType: string
  ): Promise<{ signedUrl: string; path: string }> {
    try {
      const timestamp = Date.now();
      const extension = this.getFileExtension(filename);
      const path = `${userId}/${fileType}/${timestamp}-${this.sanitizeFilename(filename)}${extension}`;

      const { data, error } = await supabase.storage
        .from('app-icons')
        .createSignedUploadUrl(path);

      if (error) {
        throw new Error(`Failed to create signed URL: ${error.message}`);
      }

      return {
        signedUrl: data.signedUrl,
        path: path,
      };

    } catch (error) {
      logger.error('Error creating signed upload URL:', error);
      throw error;
    }
  }

  async getSignedDownloadUrl(userId: string, fileId: string): Promise<string> {
    try {
      const file = await supabase.getFileById(fileId);
      if (!file || file.user_id !== userId) {
        throw new Error('File not found or access denied');
      }

      const { data, error } = await supabase.storage
        .from('app-icons')
        .createSignedUrl(file.file_path, 3600); // 1 hour expiry

      if (error) {
        throw new Error(`Failed to create signed URL: ${error.message}`);
      }

      return data.signedUrl;

    } catch (error) {
      logger.error('Error creating signed download URL:', error);
      throw error;
    }
  }

  private getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    return lastDot === -1 ? '' : filename.substring(lastDot);
  }

  private sanitizeFilename(filename: string): string {
    // Remove extension for sanitization
    const lastDot = filename.lastIndexOf('.');
    const nameWithoutExt = lastDot === -1 ? filename : filename.substring(0, lastDot);
    
    // Replace special characters with underscores
    return nameWithoutExt
      .replace(/[^a-zA-Z0-9-_]/g, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  }

  // Get file usage statistics
  async getFileStats(userId: string): Promise<{
    total_files: number;
    total_size: number;
    by_type: Record<string, { count: number; size: number }>;
  }> {
    try {
      const files = await this.getUserFiles(userId, undefined, undefined, 1000);
      
      const stats = {
        total_files: files.length,
        total_size: files.reduce((sum, file) => sum + file.file_size, 0),
        by_type: {} as Record<string, { count: number; size: number }>,
      };

      // Group by file type (stored in metadata)
      files.forEach(file => {
        const fileType = file.metadata?.file_type || 'other';
        if (!stats.by_type[fileType]) {
          stats.by_type[fileType] = { count: 0, size: 0 };
        }
        stats.by_type[fileType].count++;
        stats.by_type[fileType].size += file.file_size;
      });

      return stats;

    } catch (error) {
      logger.error('Error getting file stats:', error);
      throw error;
    }
  }
}

export const fileService = new FileService();