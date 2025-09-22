import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import fs from 'fs/promises';
import path from 'path';

export interface StorageUploadResult {
  success: boolean;
  publicUrl?: string;
  signedUrl?: string;
  filePath?: string;
  fileSize?: number;
  error?: string;
}

export interface StorageDownloadOptions {
  expiresIn?: number; // seconds, default 3600 (1 hour)
}

export class SupabaseStorageService {
  private readonly bucketName = 'makevia-builds';

  /**
   * Initialize storage bucket if it doesn't exist
   */
  async initializeBucket(): Promise<void> {
    try {
      // Check if bucket exists
      const { data: buckets } = await supabase.storage.listBuckets();
      const bucketExists = buckets?.some(bucket => bucket.name === this.bucketName);

      if (!bucketExists) {
        logger.info('Creating storage bucket:', this.bucketName);
        
        const { error } = await supabase.storage.createBucket(this.bucketName, {
          public: false, // Private bucket for security
          allowedMimeTypes: [
            'application/vnd.android.package-archive', // APK
            'application/x-authorware-bin', // AAB 
            'application/zip', // Source code
            'application/octet-stream' // Generic binary & iOS IPA
          ],
          fileSizeLimit: 100 * 1024 * 1024, // 100MB limit
        });

        if (error) {
          logger.error('Failed to create storage bucket:', error);
          throw error;
        }

        logger.info('Storage bucket created successfully');
      }
    } catch (error) {
      logger.error('Error initializing storage bucket:', error);
      throw error;
    }
  }

  /**
   * Upload build artifact to Supabase Storage
   */
  async uploadBuildArtifact(
    buildId: string,
    filePath: string,
    buildType: string,
    appName: string
  ): Promise<StorageUploadResult> {
    try {
      // Read file
      const fileBuffer = await fs.readFile(filePath);
      const fileStats = await fs.stat(filePath);
      const fileName = path.basename(filePath);
      
      // Generate storage path: builds/{appName}/{buildId}/{fileName}
      const storagePath = `builds/${this.sanitizeFileName(appName)}/${buildId}/${fileName}`;

      logger.info('Uploading build artifact to Supabase Storage', {
        buildId,
        fileName,
        storagePath,
        fileSize: fileStats.size,
        buildType
      });

      // Upload file to Supabase Storage
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .upload(storagePath, fileBuffer, {
          contentType: this.getContentType(buildType),
          cacheControl: '3600', // Cache for 1 hour
          upsert: true // Allow overwriting
        });

      if (error) {
        logger.error('Failed to upload to Supabase Storage:', error);
        return {
          success: false,
          error: error.message
        };
      }

      // Generate signed URL for secure download
      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from(this.bucketName)
        .createSignedUrl(storagePath, 7 * 24 * 3600); // 7 days expiry

      if (signedUrlError) {
        logger.warn('Failed to generate signed URL:', signedUrlError);
      }

      logger.info('Build artifact uploaded successfully', {
        buildId,
        storagePath: data.path,
        fileSize: fileStats.size
      });

      return {
        success: true,
        filePath: data.path,
        signedUrl: signedUrlData?.signedUrl,
        fileSize: fileStats.size
      };

    } catch (error) {
      logger.error('Error uploading build artifact:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate signed download URL for build artifact
   */
  async getDownloadUrl(
    filePath: string,
    options: StorageDownloadOptions = {}
  ): Promise<string | null> {
    try {
      const expiresIn = options.expiresIn || 3600; // Default 1 hour

      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .createSignedUrl(filePath, expiresIn);

      if (error) {
        logger.error('Failed to generate download URL:', error);
        return null;
      }

      return data.signedUrl;
    } catch (error) {
      logger.error('Error generating download URL:', error);
      return null;
    }
  }

  /**
   * Delete build artifact from storage
   */
  async deleteBuildArtifact(filePath: string): Promise<boolean> {
    try {
      const { error } = await supabase.storage
        .from(this.bucketName)
        .remove([filePath]);

      if (error) {
        logger.error('Failed to delete build artifact:', error);
        return false;
      }

      logger.info('Build artifact deleted successfully:', filePath);
      return true;
    } catch (error) {
      logger.error('Error deleting build artifact:', error);
      return false;
    }
  }

  /**
   * List build artifacts for an app
   */
  async listBuildArtifacts(appName: string): Promise<any[]> {
    try {
      const folderPath = `builds/${this.sanitizeFileName(appName)}/`;

      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .list(folderPath, {
          limit: 100,
          sortBy: { column: 'created_at', order: 'desc' }
        });

      if (error) {
        logger.error('Failed to list build artifacts:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('Error listing build artifacts:', error);
      return [];
    }
  }

  /**
   * Clean up old build artifacts
   */
  async cleanupOldArtifacts(
    appName?: string,
    olderThanDays: number = 30,
    keepLastN: number = 5
  ): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      let foldersToCheck: string[] = [];
      
      if (appName) {
        foldersToCheck = [`builds/${this.sanitizeFileName(appName)}/`];
      } else {
        // List all app folders
        const { data: appFolders } = await supabase.storage
          .from(this.bucketName)
          .list('builds/', { limit: 1000 });
        
        foldersToCheck = (appFolders || [])
          .map(folder => `builds/${folder.name}/`);
      }

      let deletedCount = 0;

      for (const folderPath of foldersToCheck) {
        // List all builds in this app folder
        const { data: buildFolders } = await supabase.storage
          .from(this.bucketName)
          .list(folderPath, { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });

        if (!buildFolders?.length) continue;

        // Keep the most recent N builds, delete older ones
        const buildsToDelete = buildFolders.slice(keepLastN);
        const oldBuilds = buildsToDelete.filter(build => 
          new Date(build.created_at) < cutoffDate
        );

        for (const build of oldBuilds) {
          const buildPath = `${folderPath}${build.name}/`;
          
          // List files in this build folder
          const { data: files } = await supabase.storage
            .from(this.bucketName)
            .list(buildPath, { limit: 100 });

          if (files?.length) {
            // Delete all files in the build folder
            const filePaths = files.map(file => `${buildPath}${file.name}`);
            const { error } = await supabase.storage
              .from(this.bucketName)
              .remove(filePaths);

            if (!error) {
              deletedCount += files.length;
              logger.info(`Cleaned up ${files.length} files from build ${build.name}`);
            }
          }
        }
      }

      logger.info(`Cleanup completed: deleted ${deletedCount} old build artifacts`);
      return deletedCount;

    } catch (error) {
      logger.error('Error during build artifact cleanup:', error);
      return 0;
    }
  }

  /**
   * Get storage usage statistics
   */
  async getStorageStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    appBreakdown: Array<{ app: string; files: number; size: number }>;
  }> {
    try {
      const { data: appFolders } = await supabase.storage
        .from(this.bucketName)
        .list('builds/', { limit: 1000 });

      let totalFiles = 0;
      let totalSize = 0;
      const appBreakdown: Array<{ app: string; files: number; size: number }> = [];

      for (const appFolder of appFolders || []) {
        const appPath = `builds/${appFolder.name}/`;
        let appFiles = 0;
        let appSize = 0;

        // Get all build folders for this app
        const { data: buildFolders } = await supabase.storage
          .from(this.bucketName)
          .list(appPath, { limit: 1000 });

        for (const buildFolder of buildFolders || []) {
          const buildPath = `${appPath}${buildFolder.name}/`;
          
          const { data: files } = await supabase.storage
            .from(this.bucketName)
            .list(buildPath, { limit: 100 });

          for (const file of files || []) {
            appFiles++;
            appSize += file.metadata?.size || 0;
          }
        }

        totalFiles += appFiles;
        totalSize += appSize;
        
        appBreakdown.push({
          app: appFolder.name,
          files: appFiles,
          size: appSize
        });
      }

      return {
        totalFiles,
        totalSize,
        appBreakdown
      };

    } catch (error) {
      logger.error('Error getting storage stats:', error);
      return {
        totalFiles: 0,
        totalSize: 0,
        appBreakdown: []
      };
    }
  }

  /**
   * Get content type based on build type
   */
  private getContentType(buildType: string): string {
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

  /**
   * Sanitize file name for storage
   */
  private sanitizeFileName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

export const supabaseStorageService = new SupabaseStorageService();