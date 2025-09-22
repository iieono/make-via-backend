import { logger } from '@/utils/logger';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

export interface IOSBuildOptions {
  buildId: string;
  buildMode: 'debug' | 'release';
  appName: string;
  bundleId?: string;
  teamId?: string;
  provisioningProfile?: string;
  projectPath: string;
  outputPath: string;
  timeout?: number;
  useCloud?: boolean; // Use cloud build instead of local macOS
}

export interface IOSBuildProgress {
  buildId: string;
  status: 'starting' | 'building' | 'completed' | 'failed' | 'timeout';
  progress: number;
  message: string;
  outputPath?: string;
  fileSize?: number;
  error?: string;
}

export class IOSBuildManager {
  private activeBuids: Map<string, ChildProcess> = new Map();
  private readonly defaultTimeout = 20 * 60 * 1000; // 20 minutes for iOS builds
  private readonly isMacOS = os.platform() === 'darwin';

  /**
   * Start an iOS build process
   */
  async startBuild(options: IOSBuildOptions): Promise<void> {
    const {
      buildId,
      buildMode,
      appName,
      bundleId,
      teamId,
      provisioningProfile,
      projectPath,
      outputPath,
      timeout = this.defaultTimeout,
      useCloud = !this.isMacOS // Default to cloud if not on macOS
    } = options;

    try {
      // Ensure output directory exists
      await fs.mkdir(outputPath, { recursive: true });

      if (useCloud || !this.isMacOS) {
        // Use cloud-based iOS builds
        await this.startCloudBuild(options);
      } else {
        // Use local macOS Docker build
        await this.startLocalIOSBuild(options);
      }

    } catch (error) {
      logger.error(`Failed to start iOS build ${buildId}:`, error);
      throw error;
    }
  }

  /**
   * Start cloud-based iOS build using GitHub Actions
   */
  private async startCloudBuild(options: IOSBuildOptions): Promise<void> {
    const {
      buildId,
      buildMode,
      appName,
      projectPath,
      outputPath,
      timeout
    } = options;

    // Docker command for cloud build trigger
    const dockerArgs = [
      'run',
      '--rm',
      '--name', `makevia-ios-cloud-${buildId}`,
      '-v', `${projectPath}:/workspace:ro`,
      '-v', `${outputPath}:/output`,
      '-e', `BUILD_MODE=${buildMode}`,
      '-e', `APP_NAME=${appName}`,
      '-e', `BUILD_ID=${buildId}`,
      '-e', `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
      '-e', `GITHUB_REPO=${process.env.IOS_BUILD_REPO || 'makevia/ios-builds'}`,
      'makevia/ios-cloud-builder:latest'
    ];

    await this.executeDockerBuild(buildId, dockerArgs, timeout, 'cloud');
  }

  /**
   * Start local macOS iOS build
   */
  private async startLocalIOSBuild(options: IOSBuildOptions): Promise<void> {
    const {
      buildId,
      buildMode,
      appName,
      bundleId,
      teamId,
      provisioningProfile,
      projectPath,
      outputPath,
      timeout
    } = options;

    // Docker command for local iOS build
    const dockerArgs = [
      'run',
      '--rm',
      '--name', `makevia-ios-${buildId}`,
      '-v', `${projectPath}:/workspace:ro`,
      '-v', `${outputPath}:/output`,
      '-e', `BUILD_MODE=${buildMode}`,
      '-e', `APP_NAME=${appName}`,
      '-e', `BUILD_ID=${buildId}`,
      '--memory=4g', // iOS builds need more memory
      '--cpus=4', // iOS builds are CPU intensive
    ];

    // Add iOS-specific environment variables
    if (bundleId) dockerArgs.push('-e', `BUNDLE_ID=${bundleId}`);
    if (teamId) dockerArgs.push('-e', `TEAM_ID=${teamId}`);
    if (provisioningProfile) dockerArgs.push('-e', `PROVISIONING_PROFILE=${provisioningProfile}`);

    dockerArgs.push('makevia/ios-builder:latest');

    await this.executeDockerBuild(buildId, dockerArgs, timeout, 'local');
  }

  /**
   * Execute Docker build command
   */
  private async executeDockerBuild(
    buildId: string,
    dockerArgs: string[],
    timeout: number,
    buildType: 'local' | 'cloud'
  ): Promise<void> {
    logger.info(`Starting iOS ${buildType} build`, {
      buildId,
      command: `docker ${dockerArgs.join(' ')}`
    });

    // Start the Docker process
    const dockerProcess = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Store the process reference
    this.activeBuids.set(buildId, dockerProcess);

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      this.cancelBuild(buildId, 'timeout');
    }, timeout);

    // Handle process events
    let stdout = '';
    let stderr = '';

    dockerProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      logger.info(`iOS Build ${buildId} stdout:`, output);
      
      // Parse progress from Docker output
      this.parseProgressFromOutput(buildId, output);
    });

    dockerProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      logger.warn(`iOS Build ${buildId} stderr:`, output);
    });

    dockerProcess.on('close', async (code) => {
      clearTimeout(timeoutHandle);
      this.activeBuids.delete(buildId);

      if (code === 0) {
        // Build successful
        const outputFile = await this.findOutputFile(buildId, path.dirname(dockerArgs[dockerArgs.indexOf('-v') + 1].split(':')[1]));
        if (outputFile) {
          const stats = await fs.stat(outputFile.path);
          logger.info(`iOS build ${buildId} completed successfully`, {
            outputFile: outputFile.name,
            fileSize: stats.size
          });
          
          this.emitProgress(buildId, {
            buildId,
            status: 'completed',
            progress: 100,
            message: 'iOS build completed successfully',
            outputPath: outputFile.path,
            fileSize: stats.size
          });
        } else {
          logger.error(`iOS build ${buildId} completed but no output file found`);
          this.emitProgress(buildId, {
            buildId,
            status: 'failed',
            progress: 0,
            message: 'Build completed but no output file found',
            error: 'No output file found'
          });
        }
      } else {
        // Build failed
        logger.error(`iOS build ${buildId} failed with code ${code}`, {
          stdout: stdout.slice(-500),
          stderr: stderr.slice(-500)
        });
        
        this.emitProgress(buildId, {
          buildId,
          status: 'failed',
          progress: 0,
          message: `iOS build failed with exit code ${code}`,
          error: stderr || stdout
        });
      }
    });

    dockerProcess.on('error', (error) => {
      clearTimeout(timeoutHandle);
      this.activeBuids.delete(buildId);
      logger.error(`iOS build ${buildId} process error:`, error);
      
      this.emitProgress(buildId, {
        buildId,
        status: 'failed',
        progress: 0,
        message: 'Docker process error',
        error: error.message
      });
    });

    // Initial progress update
    this.emitProgress(buildId, {
      buildId,
      status: 'starting',
      progress: 5,
      message: `Starting iOS ${buildType} build...`
    });
  }

  /**
   * Cancel a running iOS build
   */
  async cancelBuild(buildId: string, reason: string = 'cancelled'): Promise<void> {
    const process = this.activeBuids.get(buildId);
    if (process) {
      logger.info(`Cancelling iOS build ${buildId}:`, reason);
      
      // Try to kill the Docker container gracefully first
      try {
        await this.killDockerContainer(`makevia-ios-${buildId}`);
        await this.killDockerContainer(`makevia-ios-cloud-${buildId}`);
      } catch (error) {
        logger.warn(`Failed to kill Docker container for iOS build ${buildId}:`, error);
      }

      // Kill the process if it's still running
      if (!process.killed) {
        process.kill('SIGTERM');
        
        setTimeout(() => {
          if (!process.killed) {
            process.kill('SIGKILL');
          }
        }, 5000);
      }

      this.activeBuids.delete(buildId);
      
      this.emitProgress(buildId, {
        buildId,
        status: 'failed',
        progress: 0,
        message: `iOS build ${reason}`,
        error: `Build was ${reason}`
      });
    }
  }

  /**
   * Get status of all active iOS builds
   */
  getActiveBuilds(): string[] {
    return Array.from(this.activeBuids.keys());
  }

  /**
   * Check if iOS build environment is available
   */
  async checkIOSBuildEnvironment(): Promise<{
    localMacOS: boolean;
    cloudAvailable: boolean;
    xcodePath?: string;
  }> {
    const result = {
      localMacOS: this.isMacOS,
      cloudAvailable: !!(process.env.GITHUB_TOKEN && process.env.IOS_BUILD_REPO),
      xcodePath: undefined as string | undefined
    };

    if (this.isMacOS) {
      try {
        const xcodePath = await new Promise<string>((resolve, reject) => {
          const process = spawn('xcode-select', ['-p']);
          let output = '';

          process.stdout?.on('data', (data) => {
            output += data.toString();
          });

          process.on('close', (code) => {
            if (code === 0) {
              resolve(output.trim());
            } else {
              reject(new Error('Xcode not found'));
            }
          });

          process.on('error', reject);
        });

        result.xcodePath = xcodePath;
      } catch (error) {
        logger.warn('Xcode not found on macOS system:', error);
      }
    }

    return result;
  }

  /**
   * Parse build progress from Docker output
   */
  private parseProgressFromOutput(buildId: string, output: string): void {
    const lines = output.split('\n');
    
    for (const line of lines) {
      let progress = 10;
      let message = 'Building iOS app...';

      if (line.includes('Getting Flutter dependencies')) {
        progress = 20;
        message = 'Getting dependencies...';
      } else if (line.includes('Installing iOS dependencies')) {
        progress = 30;
        message = 'Installing CocoaPods...';
      } else if (line.includes('Starting iOS build')) {
        progress = 40;
        message = 'Starting Xcode build...';
      } else if (line.includes('Building Xcode project')) {
        progress = 60;
        message = 'Compiling iOS code...';
      } else if (line.includes('Creating IPA')) {
        progress = 85;
        message = 'Creating iOS package...';
      } else if (line.includes('iOS Build completed')) {
        progress = 100;
        message = 'iOS build completed!';
      } else if (line.includes('☁️ Starting MakeVia iOS Cloud Build')) {
        progress = 15;
        message = 'Starting cloud build...';
      } else if (line.includes('🚀 Triggering iOS build')) {
        progress = 25;
        message = 'Triggering GitHub Actions...';
      } else if (line.includes('⏳ Monitoring build progress')) {
        progress = 35;
        message = 'Monitoring cloud build...';
      } else if (line.includes('📥 Downloading build artifact')) {
        progress = 90;
        message = 'Downloading build artifact...';
      }

      if (progress > 10) {
        this.emitProgress(buildId, {
          buildId,
          status: 'building',
          progress,
          message
        });
      }
    }
  }

  /**
   * Find the output file after build completion
   */
  private async findOutputFile(
    buildId: string,
    outputPath: string
  ): Promise<{ name: string; path: string } | null> {
    try {
      const files = await fs.readdir(outputPath);
      const outputFile = files.find(file => 
        (file.includes(buildId) && (file.endsWith('.ipa') || file.endsWith('.app.zip') || file.endsWith('.zip')))
      );

      if (outputFile) {
        return {
          name: outputFile,
          path: path.join(outputPath, outputFile)
        };
      }

      return null;
    } catch (error) {
      logger.error(`Error finding iOS output file for build ${buildId}:`, error);
      return null;
    }
  }

  /**
   * Kill Docker container by name
   */
  private async killDockerContainer(containerName: string): Promise<void> {
    return new Promise((resolve) => {
      const killProcess = spawn('docker', ['kill', containerName]);
      
      killProcess.on('close', () => {
        resolve();
      });

      killProcess.on('error', () => {
        resolve(); // Don't fail if container doesn't exist
      });
      
      setTimeout(resolve, 5000); // Timeout after 5 seconds
    });
  }

  /**
   * Emit progress updates
   */
  private emitProgress(buildId: string, progress: IOSBuildProgress): void {
    logger.info(`iOS Build ${buildId} progress:`, {
      status: progress.status,
      progress: progress.progress,
      message: progress.message,
      error: progress.error
    });

    // TODO: Integrate with WebSocket system or build status updates
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    const activeBuilds = Array.from(this.activeBuids.keys());
    
    for (const buildId of activeBuilds) {
      await this.cancelBuild(buildId, 'cleanup');
    }
  }
}

export const iosBuildManager = new IOSBuildManager();