import { logger } from '@/utils/logger';
import { supabaseStorageService } from '@/services/supabase-storage-service';
import { dockerBuildManager } from '@/services/docker-build-manager';

/**
 * Initialize build system components
 */
export async function initializeBuildSystem(): Promise<void> {
  try {
    logger.info('Initializing MakeVia build system...');

    // Initialize Supabase storage bucket
    await supabaseStorageService.initializeBucket();
    logger.info('✅ Supabase Storage initialized');

    // Check Docker availability
    const imageExists = await dockerBuildManager.checkDockerImage();
    if (!imageExists) {
      logger.warn('⚠️ Docker image not found - will be built on first use');
    } else {
      logger.info('✅ Docker image available');
    }

    // Setup cleanup scheduler (run daily at midnight)
    setInterval(async () => {
      try {
        logger.info('Running scheduled build cleanup...');
        
        // Clean up old Supabase storage artifacts
        const deletedCount = await supabaseStorageService.cleanupOldArtifacts();
        logger.info(`🧹 Cleaned up ${deletedCount} old build artifacts`);
        
        // Get storage stats
        const stats = await supabaseStorageService.getStorageStats();
        logger.info('📊 Storage stats:', {
          totalFiles: stats.totalFiles,
          totalSize: `${(stats.totalSize / 1024 / 1024).toFixed(2)}MB`,
          apps: stats.appBreakdown.length
        });
      } catch (error) {
        logger.error('Error during scheduled cleanup:', error);
      }
    }, 24 * 60 * 60 * 1000); // 24 hours

    logger.info('🚀 Build system initialized successfully');

  } catch (error) {
    logger.error('❌ Failed to initialize build system:', error);
    throw error;
  }
}

/**
 * Cleanup function to call on server shutdown
 */
export async function cleanupBuildSystem(): Promise<void> {
  try {
    logger.info('Cleaning up build system...');
    
    // Cancel all active builds
    await dockerBuildManager.cleanup();
    
    logger.info('Build system cleanup completed');
  } catch (error) {
    logger.error('Error during build system cleanup:', error);
  }
}