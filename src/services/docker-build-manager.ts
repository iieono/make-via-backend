import { logger } from '@/utils/logger';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

export interface DockerBuildOptions {
  buildId: string;
  buildType: 'apk' | 'aab' | 'source_code' | 'ipa';
  buildMode: 'debug' | 'release';
  appName: string;
  projectPath: string;
  outputPath: string;
  timeout?: number; // milliseconds
}

export interface BuildProgress {
  buildId: string;
  status: 'starting' | 'building' | 'completed' | 'failed' | 'timeout';
  progress: number; // 0-100
  message: string;
  outputPath?: string;
  fileSize?: number;
  error?: string;
}

export class DockerBuildManager {
  private activeBuids: Map<string, ChildProcess> = new Map();
  private readonly dockerImage = 'makevia/flutter-builder:latest';
  private readonly defaultTimeout = 10 * 60 * 1000; // 10 minutes

  /**
   * Start a Docker build process
   */
  async startBuild(options: DockerBuildOptions): Promise<void> {
    const {
      buildId,
      buildType,
      buildMode,
      appName,
      projectPath,
      outputPath,
      timeout = this.defaultTimeout
    } = options;

    try {
      // Ensure output directory exists
      await fs.mkdir(outputPath, { recursive: true });

      // Build Docker run command
      const dockerArgs = [
        'run',
        '--rm',
        '--name', `makevia-build-${buildId}`,
        '-v', `${projectPath}:/workspace:ro`, // Read-only source
        '-v', `${outputPath}:/output`, // Output directory
        '-e', `BUILD_TYPE=${buildType}`,
        '-e', `BUILD_MODE=${buildMode}`,
        '-e', `APP_NAME=${appName}`,
        '-e', `BUILD_ID=${buildId}`,
        '--memory=2g', // Limit memory to 2GB
        '--cpus=2', // Limit to 2 CPU cores
        this.dockerImage
      ];

      logger.info('Starting Docker build', {
        buildId,
        buildType,
        buildMode,
        appName,
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
        logger.info(`Build ${buildId} stdout:`, output);
        
        // Parse progress from Docker output
        this.parseProgressFromOutput(buildId, output);
      });

      dockerProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        logger.warn(`Build ${buildId} stderr:`, output);
      });

      dockerProcess.on('close', async (code) => {
        clearTimeout(timeoutHandle);
        this.activeBuids.delete(buildId);

        if (code === 0) {
          // Build successful
          const outputFile = await this.findOutputFile(buildId, outputPath, buildType);
          if (outputFile) {
            const stats = await fs.stat(outputFile.path);
            logger.info(`Build ${buildId} completed successfully`, {
              outputFile: outputFile.name,
              fileSize: stats.size
            });
            
            this.emitProgress(buildId, {
              buildId,
              status: 'completed',
              progress: 100,
              message: 'Build completed successfully',
              outputPath: outputFile.path,
              fileSize: stats.size
            });
          } else {
            logger.error(`Build ${buildId} completed but no output file found`);
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
          logger.error(`Build ${buildId} failed with code ${code}`, {
            stdout: stdout.slice(-500), // Last 500 chars
            stderr: stderr.slice(-500)
          });
          
          this.emitProgress(buildId, {
            buildId,
            status: 'failed',
            progress: 0,
            message: `Build failed with exit code ${code}`,
            error: stderr || stdout
          });
        }
      });

      dockerProcess.on('error', (error) => {
        clearTimeout(timeoutHandle);
        this.activeBuids.delete(buildId);
        logger.error(`Build ${buildId} process error:`, error);
        
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
        message: 'Starting Docker container...'
      });

    } catch (error) {
      logger.error(`Failed to start build ${buildId}:`, error);
      throw error;
    }
  }

  /**
   * Cancel a running build
   */
  async cancelBuild(buildId: string, reason: string = 'cancelled'): Promise<void> {
    const process = this.activeBuids.get(buildId);
    if (process) {
      logger.info(`Cancelling build ${buildId}:`, reason);
      
      // Try to kill the Docker container gracefully first
      try {
        await this.killDockerContainer(`makevia-build-${buildId}`);
      } catch (error) {
        logger.warn(`Failed to kill Docker container for build ${buildId}:`, error);
      }

      // Kill the process if it's still running
      if (!process.killed) {
        process.kill('SIGTERM');
        
        // Force kill after 5 seconds
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
        message: `Build ${reason}`,
        error: `Build was ${reason}`
      });
    }
  }

  /**
   * Get status of all active builds
   */
  getActiveBuilds(): string[] {
    return Array.from(this.activeBuids.keys());
  }

  /**
   * Check if Docker image is available
   */
  async checkDockerImage(): Promise<boolean> {
    try {
      const result = await new Promise<boolean>((resolve) => {
        const process = spawn('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']);
        let found = false;

        process.stdout?.on('data', (data) => {
          const images = data.toString().split('\n');
          found = images.some(image => image.includes(this.dockerImage));
        });

        process.on('close', () => {
          resolve(found);
        });

        process.on('error', () => {
          resolve(false);
        });
      });

      return result;
    } catch (error) {
      logger.error('Error checking Docker image:', error);
      return false;
    }
  }

  /**
   * Build the Docker image if it doesn't exist
   */
  async buildDockerImage(): Promise<void> {
    logger.info('Building Docker image:', this.dockerImage);

    const dockerfilePath = path.join(process.cwd(), 'docker');
    const buildArgs = [
      'build',
      '-t', this.dockerImage,
      '-f', path.join(dockerfilePath, 'Dockerfile.flutter'),
      dockerfilePath
    ];

    return new Promise((resolve, reject) => {
      const buildProcess = spawn('docker', buildArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      buildProcess.stdout?.on('data', (data) => {
        logger.info('Docker build:', data.toString());
      });

      buildProcess.stderr?.on('data', (data) => {
        logger.warn('Docker build stderr:', data.toString());
      });

      buildProcess.on('close', (code) => {
        if (code === 0) {
          logger.info('Docker image built successfully');
          resolve();
        } else {
          reject(new Error(`Docker build failed with code ${code}`));
        }
      });

      buildProcess.on('error', reject);
    });
  }

  /**
   * Parse build progress from Docker output
   */
  private parseProgressFromOutput(buildId: string, output: string): void {
    const lines = output.split('\n');
    
    for (const line of lines) {
      let progress = 10; // Default progress
      let message = 'Building...';

      // Parse different build stages
      if (line.includes('Getting Flutter dependencies')) {
        progress = 20;
        message = 'Getting dependencies...';
      } else if (line.includes('Starting Flutter build')) {
        progress = 30;
        message = 'Starting build process...';
      } else if (line.includes('Running Gradle task')) {
        progress = 50;
        message = 'Compiling Android code...';
      } else if (line.includes('Built build/app/outputs')) {
        progress = 90;
        message = 'Finalizing build...';
      } else if (line.includes('Build completed successfully')) {
        progress = 100;
        message = 'Build completed!';
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
    outputPath: string,
    buildType: string
  ): Promise<{ name: string; path: string } | null> {
    try {
      const files = await fs.readdir(outputPath);
      const extension = buildType === 'aab' ? '.aab' : buildType === 'source_code' ? '.zip' : '.apk';
      
      const outputFile = files.find(file => 
        file.includes(buildId) && file.endsWith(extension)
      );

      if (outputFile) {
        return {
          name: outputFile,
          path: path.join(outputPath, outputFile)
        };
      }

      return null;
    } catch (error) {
      logger.error(`Error finding output file for build ${buildId}:`, error);
      return null;
    }
  }

  /**
   * Kill Docker container by name
   */
  private async killDockerContainer(containerName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const killProcess = spawn('docker', ['kill', containerName]);
      
      killProcess.on('close', (code) => {
        resolve(); // Don't reject on non-zero exit, container might already be gone
      });

      killProcess.on('error', reject);
      
      // Timeout after 5 seconds
      setTimeout(() => {
        resolve();
      }, 5000);
    });
  }

  /**
   * Emit progress updates (to be extended with WebSocket or event system)
   */
  private emitProgress(buildId: string, progress: BuildProgress): void {
    // For now, just log the progress
    // In a real implementation, you'd emit this to WebSocket clients or store in database
    logger.info(`Build ${buildId} progress:`, {
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

export const dockerBuildManager = new DockerBuildManager();