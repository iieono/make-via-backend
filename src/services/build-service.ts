import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import GitHubIntegrationService from '@/services/github-integration';
import type { AppConfig, AppPage, PageComponent, BuildRequest, BuildResult } from '@/types/app-development';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import archiver from 'archiver';
import crypto from 'crypto';
import { dockerBuildManager } from '@/services/docker-build-manager';
import { iosBuildManager } from '@/services/ios-build-manager';
import { supabaseStorageService } from '@/services/supabase-storage-service';

export class BuildService {
  private readonly buildDir: string;
  private readonly outputDir: string;

  constructor() {
    this.buildDir = process.env.BUILD_DIRECTORY || '/tmp/makevia-builds';
    this.outputDir = process.env.OUTPUT_DIRECTORY || '/tmp/makevia-outputs';
  }

  /**
   * Start a build process for an app
   */
  async startBuild(buildRequest: BuildRequest, userId: string): Promise<string> {
    try {
      // Check for cached build first
      const cachedBuildId = await this.checkBuildCache(buildRequest);
      if (cachedBuildId) {
        logger.info(`Using cached build ${cachedBuildId} for app ${buildRequest.app_id}`);
        
        // Clone the cached build record for this user
        const clonedBuildId = await this.cloneCachedBuild(cachedBuildId, buildRequest, userId);
        return clonedBuildId;
      }

      const buildId = `build_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      // Create build record
      const { data: build, error } = await supabase.serviceClient
        .from('app_builds')
        .insert({
          app_id: buildRequest.app_id,
          user_id: userId,
          build_type: buildRequest.build_type,
          build_mode: buildRequest.build_mode,
          target_platform: buildRequest.target_platform,
          status: 'queued',
          build_id: buildId,
          build_config: buildRequest.build_config || {},
          build_hash: await this.calculateBuildHash(buildRequest),
        })
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to create build record: ${error.message}`);
      }

      // Start build process in background
      this.executeBuild(buildId, buildRequest, userId).catch(error => {
        logger.error(`Build ${buildId} failed:`, error);
        this.updateBuildStatus(buildId, 'failed', error.message);
      });

      return buildId;
    } catch (error) {
      logger.error('Error starting build:', error);
      throw error;
    }
  }

  /**
   * Execute the actual build process using Docker
   */
  private async executeBuild(buildId: string, buildRequest: BuildRequest, userId: string): Promise<void> {
    const buildPath = path.join(this.buildDir, buildId);
    const outputPath = path.join(this.outputDir, buildId);
    
    try {
      // Update status to building
      await this.updateBuildStatus(buildId, 'building');

      // Ensure directories exist
      await fs.mkdir(buildPath, { recursive: true });
      await fs.mkdir(outputPath, { recursive: true });

      // Get app data
      const appData = await this.getAppBuildData(buildRequest.app_id);
      
      // Generate Flutter project
      await this.generateFlutterProject(buildPath, appData, buildRequest);
      
      // Execute Docker build
      await this.executeDockerBuild(buildId, buildPath, outputPath, buildRequest, appData.app);
      
    } catch (error) {
      logger.error(`Build ${buildId} failed:`, error);
      await this.updateBuildStatus(buildId, 'failed', error instanceof Error ? error.message : 'Unknown error');
      
      // Clean up on failure
      try {
        await fs.rm(buildPath, { recursive: true, force: true });
        await fs.rm(outputPath, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.error('Error cleaning up build directories:', cleanupError);
      }
    }
  }

  /**
   * Execute build using Docker container
   */
  private async executeDockerBuild(
    buildId: string,
    projectPath: string,
    outputPath: string,
    buildRequest: BuildRequest,
    appConfig: AppConfig
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const buildCompleteHandler = async (buildId: string, success: boolean, outputFile?: string, error?: string) => {
        try {
          if (success && outputFile) {
            // Upload to Supabase Storage
            const uploadResult = await supabaseStorageService.uploadBuildArtifact(
              buildId,
              outputFile,
              buildRequest.build_type,
              appConfig.name
            );

            if (uploadResult.success) {
              // Generate download URL
              const downloadUrl = await supabaseStorageService.getDownloadUrl(
                uploadResult.filePath!,
                { expiresIn: 7 * 24 * 3600 } // 7 days
              );

              // Update build record with success
              await this.updateBuildStatus(buildId, 'completed', null, downloadUrl);

              // Clean up local files after successful upload
              await this.cleanupBuildFiles(projectPath, outputPath);

              logger.info(`Build ${buildId} completed and uploaded successfully`);
              resolve();
            } else {
              throw new Error(`Failed to upload build artifact: ${uploadResult.error}`);
            }
          } else {
            throw new Error(error || 'Build failed');
          }
        } catch (err) {
          logger.error(`Post-build processing failed for ${buildId}:`, err);
          reject(err);
        }
      };

      // Handle iOS builds differently
      if (buildRequest.build_type === 'ipa' || buildRequest.build_type === 'ios') {
        this.startIOSBuild(buildId, projectPath, outputPath, buildRequest, appConfig, buildCompleteHandler)
          .catch(reject);
      } else {
        this.startDockerBuildWithCallback(buildId, projectPath, outputPath, buildRequest, appConfig, buildCompleteHandler)
          .catch(reject);
      }
    });
  }

  /**
   * Start iOS build with completion callback
   */
  private async startIOSBuild(
    buildId: string,
    projectPath: string,
    outputPath: string,
    buildRequest: BuildRequest,
    appConfig: AppConfig,
    onComplete: (buildId: string, success: boolean, outputFile?: string, error?: string) => void
  ): Promise<void> {
    try {
      // Start iOS build
      await iosBuildManager.startBuild({
        buildId,
        buildMode: buildRequest.build_mode as 'debug' | 'release',
        appName: this.sanitizeAppName(appConfig.name),
        bundleId: appConfig.package_name,
        projectPath,
        outputPath,
        timeout: 25 * 60 * 1000 // 25 minutes for iOS builds
      });

      // Monitor iOS build completion
      this.monitorIOSBuild(buildId, outputPath, onComplete);

    } catch (error) {
      logger.error(`Failed to start iOS build ${buildId}:`, error);
      onComplete(buildId, false, undefined, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Monitor iOS build progress and completion
   */
  private monitorIOSBuild(
    buildId: string,
    outputPath: string,
    onComplete: (buildId: string, success: boolean, outputFile?: string, error?: string) => void
  ): void {
    // Poll for completion every 10 seconds (iOS builds take longer)
    const pollInterval = setInterval(async () => {
      try {
        const activeBuilds = iosBuildManager.getActiveBuilds();
        
        if (!activeBuilds.includes(buildId)) {
          // Build is no longer active, check for output
          clearInterval(pollInterval);
          
          const outputFile = await this.findBuildOutput(outputPath, buildId, 'ipa');
          if (outputFile) {
            onComplete(buildId, true, outputFile);
          } else {
            onComplete(buildId, false, undefined, 'iOS build completed but no output file found');
          }
        }
      } catch (error) {
        clearInterval(pollInterval);
        onComplete(buildId, false, undefined, error instanceof Error ? error.message : 'iOS monitoring error');
      }
    }, 10000);

    // Set maximum monitoring time (30 minutes for iOS)
    setTimeout(() => {
      clearInterval(pollInterval);
      iosBuildManager.cancelBuild(buildId, 'timeout');
      onComplete(buildId, false, undefined, 'iOS build timeout after 30 minutes');
    }, 30 * 60 * 1000);
  }

  /**
   * Start Docker build with completion callback
   */
  private async startDockerBuildWithCallback(
    buildId: string,
    projectPath: string,
    outputPath: string,
    buildRequest: BuildRequest,
    appConfig: AppConfig,
    onComplete: (buildId: string, success: boolean, outputFile?: string, error?: string) => void
  ): Promise<void> {
    try {
      // Ensure Docker image is available
      const imageExists = await dockerBuildManager.checkDockerImage();
      if (!imageExists) {
        logger.info('Docker image not found, building it now...');
        await dockerBuildManager.buildDockerImage();
      }

      // Start Docker build
      await dockerBuildManager.startBuild({
        buildId,
        buildType: buildRequest.build_type as 'apk' | 'aab' | 'source_code',
        buildMode: buildRequest.build_mode as 'debug' | 'release',
        appName: this.sanitizeAppName(appConfig.name),
        projectPath,
        outputPath,
        timeout: 15 * 60 * 1000 // 15 minutes
      });

      // Monitor build completion
      this.monitorDockerBuild(buildId, outputPath, buildRequest.build_type, onComplete);

    } catch (error) {
      logger.error(`Failed to start Docker build ${buildId}:`, error);
      onComplete(buildId, false, undefined, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Monitor Docker build progress and completion
   */
  private monitorDockerBuild(
    buildId: string,
    outputPath: string,
    buildType: string,
    onComplete: (buildId: string, success: boolean, outputFile?: string, error?: string) => void
  ): void {
    // Poll for completion every 5 seconds
    const pollInterval = setInterval(async () => {
      try {
        const activeBuilds = dockerBuildManager.getActiveBuilds();
        
        if (!activeBuilds.includes(buildId)) {
          // Build is no longer active, check for output
          clearInterval(pollInterval);
          
          const outputFile = await this.findBuildOutput(outputPath, buildId, buildType);
          if (outputFile) {
            onComplete(buildId, true, outputFile);
          } else {
            onComplete(buildId, false, undefined, 'Build completed but no output file found');
          }
        }
      } catch (error) {
        clearInterval(pollInterval);
        onComplete(buildId, false, undefined, error instanceof Error ? error.message : 'Monitoring error');
      }
    }, 5000);

    // Set maximum monitoring time (20 minutes)
    setTimeout(() => {
      clearInterval(pollInterval);
      dockerBuildManager.cancelBuild(buildId, 'timeout');
      onComplete(buildId, false, undefined, 'Build timeout after 20 minutes');
    }, 20 * 60 * 1000);
  }

  /**
   * Find build output file
   */
  private async findBuildOutput(outputPath: string, buildId: string, buildType: string): Promise<string | null> {
    try {
      const files = await fs.readdir(outputPath);
      const extension = buildType === 'aab' ? '.aab' : buildType === 'source_code' ? '.zip' : '.apk';
      
      const outputFile = files.find(file => 
        file.includes(buildId) && file.endsWith(extension)
      );

      return outputFile ? path.join(outputPath, outputFile) : null;
    } catch (error) {
      logger.error(`Error finding build output for ${buildId}:`, error);
      return null;
    }
  }

  /**
   * Clean up build files after successful upload
   */
  private async cleanupBuildFiles(projectPath: string, outputPath: string): Promise<void> {
    try {
      // Keep project source for caching, but remove build outputs
      await fs.rm(path.join(projectPath, 'build'), { recursive: true, force: true });
      await fs.rm(path.join(projectPath, '.dart_tool'), { recursive: true, force: true });
      
      // Remove output directory completely
      await fs.rm(outputPath, { recursive: true, force: true });
      
      logger.info('Build files cleaned up successfully');
    } catch (error) {
      logger.warn('Failed to cleanup build files:', error);
    }
  }

  /**
   * Sanitize app name for file system use
   */
  private sanitizeAppName(appName: string): string {
    return appName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'makevia-app';
  }

  /**
   * Get app data needed for building
   */
  private async getAppBuildData(appId: string): Promise<{
    app: AppConfig;
    pages: AppPage[];
    components: PageComponent[];
  }> {
    // Get app
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', appId)
      .single();

    if (!app) {
      throw new Error('App not found');
    }

    // Get pages
    const { data: pages } = await supabase.serviceClient
      .from('app_pages')
      .select('*')
      .eq('app_id', appId)
      .order('created_at');

    // Get components
    const { data: components } = await supabase.serviceClient
      .from('page_components')
      .select(`
        *,
        app_pages!inner(app_id)
      `)
      .eq('app_pages.app_id', appId);

    return {
      app: app as AppConfig,
      pages: pages || [],
      components: components || [],
    };
  }

  /**
   * Generate Flutter project for building
   */
  private async generateFlutterProject(
    buildPath: string,
    appData: { app: AppConfig; pages: AppPage[]; components: PageComponent[] },
    buildRequest: BuildRequest
  ): Promise<void> {
    // Use GitHubIntegrationService to generate Flutter files
    const githubService = new GitHubIntegrationService('dummy-token'); // Token not needed for file generation
    const files = await githubService.generateFlutterProject(
      appData.app,
      appData.pages,
      appData.components
    );

    // Create platform-specific files
    if (buildRequest.build_type === 'ios' || buildRequest.build_type === 'ipa') {
      const iosFiles = this.generateIOSFiles(appData.app, buildRequest);
      Object.assign(files, iosFiles);
    } else {
      const androidFiles = this.generateAndroidFiles(appData.app, buildRequest);
      Object.assign(files, androidFiles);
    }

    // Write all files to build directory
    await Promise.all(
      Object.entries(files).map(async ([filePath, content]) => {
        const fullPath = path.join(buildPath, filePath);
        const dir = path.dirname(fullPath);
        
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, content);
      })
    );

    logger.info(`Generated Flutter project with ${Object.keys(files).length} files`);
  }

  /**
   * Generate Android-specific configuration files
   */
  private generateAndroidFiles(app: AppConfig, buildRequest: BuildRequest): Record<string, string> {
    const files: Record<string, string> = {};

    // android/app/build.gradle
    files['android/app/build.gradle'] = this.generateAppBuildGradle(app, buildRequest);

    // android/app/src/main/AndroidManifest.xml
    files['android/app/src/main/AndroidManifest.xml'] = this.generateAndroidManifest(app);

    // android/build.gradle
    files['android/build.gradle'] = this.generateProjectBuildGradle();

    // android/gradle.properties
    files['android/gradle.properties'] = this.generateGradleProperties();

    // android/settings.gradle
    files['android/settings.gradle'] = this.generateSettingsGradle();

    // android/app/src/main/kotlin/MainActivity.kt
    files[`android/app/src/main/kotlin/${app.package_name?.replace(/\./g, '/')}/MainActivity.kt`] = 
      this.generateMainActivity(app);

    return files;
  }

  private generateAppBuildGradle(app: AppConfig, buildRequest: BuildRequest): string {
    const signingConfig = buildRequest.build_mode === 'release' && buildRequest.build_config?.signing
      ? `
    signingConfigs {
        release {
            keyAlias '${buildRequest.build_config.signing.key_alias}'
            keyPassword '${buildRequest.build_config.signing.key_password}'
            storeFile file('${buildRequest.build_config.signing.keystore_path}')
            storePassword '${buildRequest.build_config.signing.store_password}'
        }
    }`
      : '';

    return `def localProperties = new Properties()
def localPropertiesFile = rootProject.file('local.properties')
if (localPropertiesFile.exists()) {
    localPropertiesFile.withReader('UTF-8') { reader ->
        localProperties.load(reader)
    }
}

def flutterRoot = localProperties.getProperty('flutter.sdk')
if (flutterRoot == null) {
    throw new GradleException("Flutter SDK not found. Define location with flutter.sdk in the local.properties file.")
}

def flutterVersionCode = localProperties.getProperty('flutter.versionCode')
if (flutterVersionCode == null) {
    flutterVersionCode = '${app.version_code || 1}'
}

def flutterVersionName = localProperties.getProperty('flutter.versionName')
if (flutterVersionName == null) {
    flutterVersionName = '${app.version_name || '1.0.0'}'
}

apply plugin: 'com.android.application'
apply plugin: 'kotlin-android'
apply from: "$flutterRoot/packages/flutter_tools/gradle/flutter.gradle"

android {
    compileSdkVersion ${app.target_sdk_version || 34}
    ndkVersion flutter.ndkVersion

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = '1.8'
    }

    sourceSets {
        main.java.srcDirs += 'src/main/kotlin'
    }

    defaultConfig {
        applicationId "${app.package_name}"
        minSdkVersion ${app.min_sdk_version || 21}
        targetSdkVersion ${app.target_sdk_version || 34}
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }
    ${signingConfig}

    buildTypes {
        release {
            ${buildRequest.build_mode === 'release' && buildRequest.build_config?.signing ? 'signingConfig signingConfigs.release' : ''}
            minifyEnabled true
            useProguard true
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}

flutter {
    source '../..'
}

dependencies {
    implementation "org.jetbrains.kotlin:kotlin-stdlib-jdk7:$kotlin_version"
}
`;
  }

  private generateAndroidManifest(app: AppConfig): string {
    const permissions = app.capabilities 
      ? Object.entries(app.capabilities)
          .filter(([, enabled]) => enabled)
          .map(([capability]) => this.getPermissionForCapability(capability))
          .filter(Boolean)
          .map(permission => `    <uses-permission android:name="${permission}" />`)
          .join('\n')
      : '';

    return `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
${permissions}

    <application
        android:label="${app.name}"
        android:name="\${applicationName}"
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/LaunchTheme"
        android:exported="true">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:theme="@style/LaunchTheme"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"
            android:hardwareAccelerated="true"
            android:windowSoftInputMode="adjustResize">
            <meta-data
              android:name="io.flutter.embedding.android.NormalTheme"
              android:resource="@style/NormalTheme"
              />
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <meta-data
            android:name="flutterEmbedding"
            android:value="2" />
    </application>
</manifest>
`;
  }

  private getPermissionForCapability(capability: string): string | null {
    const permissionMap: Record<string, string> = {
      'camera': 'android.permission.CAMERA',
      'location': 'android.permission.ACCESS_FINE_LOCATION',
      'storage': 'android.permission.WRITE_EXTERNAL_STORAGE',
      'internet': 'android.permission.INTERNET',
      'bluetooth': 'android.permission.BLUETOOTH',
      'microphone': 'android.permission.RECORD_AUDIO',
      'push_notifications': 'android.permission.RECEIVE_BOOT_COMPLETED',
    };
    return permissionMap[capability] || null;
  }

  private generateProjectBuildGradle(): string {
    return `buildscript {
    ext.kotlin_version = '1.7.10'
    repositories {
        google()
        mavenCentral()
    }

    dependencies {
        classpath 'com.android.tools.build:gradle:7.3.0'
        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version"
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.buildDir = '../build'
subprojects {
    project.buildDir = "\${rootProject.buildDir}/\${project.name}"
}
subprojects {
    project.evaluationDependsOn(':app')
}

tasks.register("clean", Delete) {
    delete rootProject.buildDir
}
`;
  }

  private generateGradleProperties(): string {
    return `org.gradle.jvmargs=-Xmx1536M
android.useAndroidX=true
android.enableJetifier=true
`;
  }

  private generateSettingsGradle(): string {
    return `include ':app'

def localPropertiesFile = new File(rootProject.projectDir, "local.properties")
def properties = new Properties()

assert localPropertiesFile.exists()
localPropertiesFile.withReader("UTF-8") { reader -> properties.load(reader) }

def flutterSdkPath = properties.getProperty("flutter.sdk")
assert flutterSdkPath != null, "flutter.sdk not set in local.properties"
apply from: "$flutterSdkPath/packages/flutter_tools/gradle/app_plugin_loader.gradle"
`;
  }

  private generateMainActivity(app: AppConfig): string {
    const packagePath = app.package_name?.split('.').join('.') || 'com.makevia.app';
    
    return `package ${packagePath}

import io.flutter.embedding.android.FlutterActivity

class MainActivity: FlutterActivity() {
}
`;
  }

  /**
   * Generate iOS-specific configuration files
   */
  private generateIOSFiles(app: AppConfig, buildRequest: BuildRequest): Record<string, string> {
    const files: Record<string, string> = {};

    // ios/Runner/Info.plist
    files['ios/Runner/Info.plist'] = this.generateInfoPlist(app);

    // ios/Runner.xcodeproj/project.pbxproj (simplified version)
    files['ios/Runner.xcodeproj/project.pbxproj'] = this.generateXcodeProjFile(app, buildRequest);

    // ios/Runner/AppDelegate.swift
    files['ios/Runner/AppDelegate.swift'] = this.generateAppDelegate(app);

    // ios/Podfile
    files['ios/Podfile'] = this.generatePodfile();

    // ios/Runner/Runner-Bridging-Header.h
    files['ios/Runner/Runner-Bridging-Header.h'] = this.generateBridgingHeader();

    return files;
  }

  private generateInfoPlist(app: AppConfig): string {
    const bundleId = app.package_name || 'com.makevia.app';
    const permissions = this.getIOSPermissions(app);

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>$(DEVELOPMENT_LANGUAGE)</string>
	<key>CFBundleDisplayName</key>
	<string>${app.name}</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${app.name}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${app.version_name || '1.0.0'}</string>
	<key>CFBundleSignature</key>
	<string>????</string>
	<key>CFBundleVersion</key>
	<string>${app.version_code || 1}</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UILaunchStoryboardName</key>
	<string>LaunchScreen</string>
	<key>UIMainStoryboardFile</key>
	<string>Main</string>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>UISupportedInterfaceOrientations~ipad</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationPortraitUpsideDown</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>CADisableMinimumFrameDurationOnPhone</key>
	<true/>
	<key>UIApplicationSupportsIndirectInputEvents</key>
	<true/>
${permissions}
</dict>
</plist>
`;
  }

  private getIOSPermissions(app: AppConfig): string {
    if (!app.capabilities) return '';

    const permissions: string[] = [];

    if (app.capabilities.camera) {
      permissions.push(`	<key>NSCameraUsageDescription</key>
	<string>This app needs camera access to take photos.</string>`);
    }

    if (app.capabilities.location) {
      permissions.push(`	<key>NSLocationWhenInUseUsageDescription</key>
	<string>This app needs location access to provide location-based features.</string>`);
    }

    if (app.capabilities.microphone) {
      permissions.push(`	<key>NSMicrophoneUsageDescription</key>
	<string>This app needs microphone access to record audio.</string>`);
    }

    if (app.capabilities.file_access) {
      permissions.push(`	<key>NSDocumentsFolderUsageDescription</key>
	<string>This app needs access to documents to save and load files.</string>`);
    }

    return permissions.join('\n');
  }

  private generateXcodeProjFile(app: AppConfig, buildRequest: BuildRequest): string {
    const bundleId = app.package_name || 'com.makevia.app';
    
    // This is a simplified version - in production, you'd use a proper Xcode project template
    return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 54;
	objects = {

/* Begin PBXBuildFile section */
		1498D2341E8E89220040F4C2 /* GeneratedPluginRegistrant.m in Sources */ = {isa = PBXBuildFile; fileRef = 1498D2331E8E89220040F4C2 /* GeneratedPluginRegistrant.m */; };
		3B3967161E833CAA004F5970 /* AppFrameworkInfo.plist in Resources */ = {isa = PBXBuildFile; fileRef = 3B3967151E833CAA004F5970 /* AppFrameworkInfo.plist */; };
		74858FAF1ED2DC5600515810 /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = 74858FAE1ED2DC5600515810 /* AppDelegate.swift */; };
		97C146FC1CF9000F007C117D /* Main.storyboard in Resources */ = {isa = PBXBuildFile; fileRef = 97C146FA1CF9000F007C117D /* Main.storyboard */; };
		97C146FE1CF9000F007C117D /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = 97C146FD1CF9000F007C117D /* Assets.xcassets */; };
		97C147011CF9000F007C117D /* LaunchScreen.storyboard in Resources */ = {isa = PBXBuildFile; fileRef = 97C146FF1CF9000F007C117D /* LaunchScreen.storyboard */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		1498D2321E8E86230040F4C2 /* GeneratedPluginRegistrant.h */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.h; path = GeneratedPluginRegistrant.h; sourceTree = "<group>"; };
		1498D2331E8E89220040F4C2 /* GeneratedPluginRegistrant.m */ = {isa = PBXFileReference; fileEncoding = 4; lastKnownFileType = sourcecode.c.objc; path = GeneratedPluginRegistrant.m; sourceTree = "<group>"; };
		3B3967151E833CAA004F5970 /* AppFrameworkInfo.plist */ = {isa = PBXFileReference; fileEncoding = 4; lastKnownFileType = text.plist.xml; name = AppFrameworkInfo.plist; path = Flutter/AppFrameworkInfo.plist; sourceTree = "<group>"; };
		74858FAD1ED2DC5600515810 /* Runner-Bridging-Header.h */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.h; path = "Runner-Bridging-Header.h"; sourceTree = "<group>"; };
		74858FAE1ED2DC5600515810 /* AppDelegate.swift */ = {isa = PBXFileReference; fileEncoding = 4; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = "<group>"; };
		7AFA3C8E1D35360C0083082E /* Release.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; name = Release.xcconfig; path = Flutter/Release.xcconfig; sourceTree = "<group>"; };
		9740EEB21CF90195004384FC /* Debug.xcconfig */ = {isa = PBXFileReference; fileEncoding = 4; lastKnownFileType = text.xcconfig; name = Debug.xcconfig; path = Flutter/Debug.xcconfig; sourceTree = "<group>"; };
		9740EEB31CF90195004384FC /* Generated.xcconfig */ = {isa = PBXFileReference; fileEncoding = 4; lastKnownFileType = text.xcconfig; name = Generated.xcconfig; path = Flutter/Generated.xcconfig; sourceTree = "<group>"; };
		97C146EE1CF9000F007C117D /* Runner.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Runner.app; sourceTree = BUILT_PRODUCTS_DIR; };
		97C146FB1CF9000F007C117D /* Base */ = {isa = PBXFileReference; lastKnownFileType = file.storyboard; name = Base; path = Base.lproj/Main.storyboard; sourceTree = "<group>"; };
		97C146FD1CF9000F007C117D /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };
		97C147001CF9000F007C117D /* Base */ = {isa = PBXFileReference; lastKnownFileType = file.storyboard; name = Base; path = Base.lproj/LaunchScreen.storyboard; sourceTree = "<group>"; };
		97C147021CF9000F007C117D /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXBuildConfiguration section */
		97C147061CF9000F007C117D /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				DEVELOPMENT_TEAM = "";
				PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};
				PRODUCT_NAME = "${app.name}";
				VERSIONING_SYSTEM = "apple-generic";
				MARKETING_VERSION = "${app.version_name || '1.0.0'}";
				CURRENT_PROJECT_VERSION = "${app.version_code || 1}";
			};
			name = Debug;
		};
		97C147071CF9000F007C117D /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				DEVELOPMENT_TEAM = "";
				PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};
				PRODUCT_NAME = "${app.name}";
				VERSIONING_SYSTEM = "apple-generic";
				MARKETING_VERSION = "${app.version_name || '1.0.0'}";
				CURRENT_PROJECT_VERSION = "${app.version_code || 1}";
			};
			name = Release;
		};
/* End XCBuildConfiguration section */

	};
	rootObject = 97C146E61CF9000F007C117D /* Project object */;
}
`;
  }

  private generateAppDelegate(app: AppConfig): string {
    return `import UIKit
import Flutter

@UIApplicationMain
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;
  }

  private generatePodfile(): string {
    return `# Uncomment this line to define a global platform for your project
platform :ios, '12.0'

# CocoaPods analytics sends network stats synchronously affecting flutter build latency.
ENV['COCOAPODS_DISABLE_STATS'] = 'true'

project 'Runner', {
  'Debug' => :debug,
  'Profile' => :release,
  'Release' => :release,
}

def flutter_root
  generated_xcode_build_settings_path = File.expand_path(File.join('..', 'Flutter', 'Generated.xcconfig'), __FILE__)
  unless File.exist?(generated_xcode_build_settings_path)
    raise "#{generated_xcode_build_settings_path} must exist. If you're running pod install manually, make sure flutter pub get is executed first"
  end

  File.foreach(generated_xcode_build_settings_path) do |line|
    matches = line.match(/FLUTTER_ROOT\\=(.*)/)
    return matches[1].strip if matches
  end
  raise "FLUTTER_ROOT not found in #{generated_xcode_build_settings_path}. Try deleting Generated.xcconfig, then run flutter pub get"
end

require File.expand_path(File.join('packages', 'flutter_tools', 'bin', 'podhelper'), flutter_root)

flutter_ios_podfile_setup

target 'Runner' do
  use_frameworks!
  use_modular_headers!

  flutter_install_all_ios_pods File.dirname(File.realpath(__FILE__))
  target 'RunnerTests' do
    inherit! :search_paths
  end
end

post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
  end
end
`;
  }

  private generateBridgingHeader(): string {
    return `#import "GeneratedPluginRegistrant.h"
`;
  }

  /**
   * Execute Flutter build command
   */
  private async executeFlutterBuild(buildPath: string, buildRequest: BuildRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const buildType = buildRequest.build_type === 'aab' ? 'appbundle' : 'apk';
      const buildMode = buildRequest.build_mode || 'release';
      
      const command = 'flutter';
      const args = ['build', buildType, `--${buildMode}`];
      
      if (buildRequest.target_platform && buildRequest.target_platform !== 'android') {
        args.push('--target-platform', buildRequest.target_platform);
      }

      logger.info(`Executing: ${command} ${args.join(' ')} in ${buildPath}`);

      const buildProcess = spawn(command, args, {
        cwd: buildPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${process.env.FLUTTER_ROOT}/bin:${process.env.PATH}`,
        },
      });

      let stdout = '';
      let stderr = '';

      buildProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        logger.info(`Build stdout: ${data}`);
      });

      buildProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        logger.warn(`Build stderr: ${data}`);
      });

      buildProcess.on('close', (code) => {
        if (code === 0) {
          const outputPath = buildType === 'appbundle'
            ? path.join(buildPath, 'build/app/outputs/bundle/release/app-release.aab')
            : path.join(buildPath, 'build/app/outputs/flutter-apk/app-release.apk');
          
          resolve(outputPath);
        } else {
          reject(new Error(`Build failed with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
        }
      });

      buildProcess.on('error', (error) => {
        reject(new Error(`Failed to start build process: ${error.message}`));
      });

      // Set timeout for long-running builds
      setTimeout(() => {
        buildProcess.kill();
        reject(new Error('Build timeout after 10 minutes'));
      }, 10 * 60 * 1000);
    });
  }

  /**
   * Store build artifact and return download URL
   */
  private async storeBuildArtifact(buildId: string, outputPath: string, buildRequest: BuildRequest): Promise<string> {
    const fileName = `${buildId}.${buildRequest.build_type}`;
    const storagePath = path.join(this.outputDir, fileName);
    
    // Copy the build artifact to storage
    await fs.copyFile(outputPath, storagePath);
    
    // In a real implementation, you would upload to cloud storage (S3, etc.)
    // For now, we'll return a local file path
    const downloadUrl = `/api/builds/${buildId}/download`;
    
    logger.info(`Stored build artifact: ${storagePath}`);
    return downloadUrl;
  }

  /**
   * Update build status in database
   */
  private async updateBuildStatus(
    buildId: string,
    status: 'queued' | 'building' | 'completed' | 'failed',
    errorMessage?: string | null,
    downloadUrl?: string | null
  ): Promise<void> {
    const updates: any = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (status === 'completed') {
      updates.completed_at = new Date().toISOString();
      updates.download_url = downloadUrl;
    }

    if (status === 'failed') {
      updates.error_message = errorMessage;
      updates.completed_at = new Date().toISOString();
    }

    await supabase.serviceClient
      .from('app_builds')
      .update(updates)
      .eq('build_id', buildId);
  }

  /**
   * Get build status
   */
  async getBuildStatus(buildId: string): Promise<any> {
    const { data: build } = await supabase.serviceClient
      .from('app_builds')
      .select('*')
      .eq('build_id', buildId)
      .single();

    return build;
  }

  /**
   * Get builds for an app
   */
  async getAppBuilds(appId: string, limit = 20): Promise<any[]> {
    const { data: builds } = await supabase.serviceClient
      .from('app_builds')
      .select('*')
      .eq('app_id', appId)
      .order('created_at', { ascending: false })
      .limit(limit);

    return builds || [];
  }

  /**
   * Cancel a build
   */
  async cancelBuild(buildId: string): Promise<void> {
    await this.updateBuildStatus(buildId, 'failed', 'Build cancelled by user');
    
    // Clean up build directory if it exists
    const buildPath = path.join(this.buildDir, buildId);
    try {
      await fs.rm(buildPath, { recursive: true, force: true });
    } catch (error) {
      logger.warn(`Failed to clean up build directory for ${buildId}:`, error);
    }
  }

  /**
   * Calculate build hash for caching
   */
  private async calculateBuildHash(buildRequest: BuildRequest): Promise<string> {
    // Get app content for hashing
    const appData = await this.getAppBuildData(buildRequest.app_id);
    
    const hashInput = {
      app: {
        id: appData.app.id,
        name: appData.app.name,
        package_name: appData.app.package_name,
        version_name: appData.app.version_name,
        version_code: appData.app.version_code,
        capabilities: appData.app.capabilities,
        updated_at: appData.app.updated_at,
      },
      pages: appData.pages.map(p => ({
        id: p.id,
        name: p.name,
        route_path: p.route_path,
        page_config: p.page_config,
        updated_at: p.updated_at,
      })),
      components: appData.components.map(c => ({
        id: c.id,
        component_type: c.component_type,
        component_data: c.component_data,
        properties: c.properties,
        updated_at: c.updated_at,
      })),
      build_config: {
        build_type: buildRequest.build_type,
        build_mode: buildRequest.build_mode,
        target_platform: buildRequest.target_platform,
        build_config: buildRequest.build_config,
      },
    };

    const hashString = JSON.stringify(hashInput, Object.keys(hashInput).sort());
    return crypto.createHash('sha256').update(hashString).digest('hex');
  }

  /**
   * Check if a cached build exists for this configuration
   */
  private async checkBuildCache(buildRequest: BuildRequest): Promise<string | null> {
    const buildHash = await this.calculateBuildHash(buildRequest);
    
    // Look for completed builds with same hash (within last 30 days for freshness)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const { data: cachedBuild } = await supabase.serviceClient
      .from('app_builds')
      .select('build_id, download_url, created_at')
      .eq('app_id', buildRequest.app_id)
      .eq('build_hash', buildHash)
      .eq('status', 'completed')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .not('download_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (cachedBuild) {
      // Verify the cached build file still exists
      const fileName = `${cachedBuild.build_id}.${buildRequest.build_type}`;
      const cachedFilePath = path.join(this.outputDir, fileName);
      
      try {
        await fs.access(cachedFilePath);
        return cachedBuild.build_id;
      } catch (error) {
        logger.warn(`Cached build file not found: ${cachedFilePath}`);
        // File doesn't exist, remove from cache
        await supabase.serviceClient
          .from('app_builds')
          .update({ download_url: null, status: 'failed', error_message: 'Cached file missing' })
          .eq('build_id', cachedBuild.build_id);
      }
    }

    return null;
  }

  /**
   * Clone a cached build for the current user
   */
  private async cloneCachedBuild(cachedBuildId: string, buildRequest: BuildRequest, userId: string): Promise<string> {
    const newBuildId = `build_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    // Get original build details
    const { data: originalBuild } = await supabase.serviceClient
      .from('app_builds')
      .select('*')
      .eq('build_id', cachedBuildId)
      .single();

    if (!originalBuild) {
      throw new Error('Original build not found');
    }

    // Copy the cached build file to new build ID
    const originalFileName = `${cachedBuildId}.${buildRequest.build_type}`;
    const newFileName = `${newBuildId}.${buildRequest.build_type}`;
    const originalPath = path.join(this.outputDir, originalFileName);
    const newPath = path.join(this.outputDir, newFileName);

    try {
      await fs.copyFile(originalPath, newPath);
    } catch (error) {
      throw new Error(`Failed to copy cached build: ${error}`);
    }

    // Create new build record referencing the cached build
    const { error } = await supabase.serviceClient
      .from('app_builds')
      .insert({
        app_id: buildRequest.app_id,
        user_id: userId,
        build_type: buildRequest.build_type,
        build_mode: buildRequest.build_mode,
        target_platform: buildRequest.target_platform,
        status: 'completed',
        build_id: newBuildId,
        build_config: buildRequest.build_config || {},
        build_hash: originalBuild.build_hash,
        download_url: `/api/builds/${newBuildId}/download`,
        completed_at: new Date().toISOString(),
        cached_from_build_id: cachedBuildId,
      });

    if (error) {
      throw new Error(`Failed to create cached build record: ${error.message}`);
    }

    logger.info(`Cloned cached build ${cachedBuildId} to ${newBuildId}`);
    return newBuildId;
  }

  /**
   * Clean up build source files but keep artifacts for caching
   */
  private async cleanupBuildSources(buildPath: string): Promise<void> {
    try {
      // Keep only the build outputs, remove source files
      const itemsToKeep = ['build'];
      const dirContents = await fs.readdir(buildPath);
      
      for (const item of dirContents) {
        if (!itemsToKeep.includes(item)) {
          const itemPath = path.join(buildPath, item);
          await fs.rm(itemPath, { recursive: true, force: true });
        }
      }
      
      logger.info(`Cleaned up build sources for ${path.basename(buildPath)}`);
    } catch (error) {
      logger.warn(`Failed to cleanup build sources: ${error}`);
    }
  }

  /**
   * Clean up old cached builds (keep last 5 per app, or builds from last 30 days)
   */
  async cleanupOldBuilds(appId?: string): Promise<void> {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      let query = supabase.serviceClient
        .from('app_builds')
        .select('build_id, app_id, created_at, download_url')
        .eq('status', 'completed')
        .lt('created_at', thirtyDaysAgo.toISOString())
        .not('download_url', 'is', null);

      if (appId) {
        query = query.eq('app_id', appId);
      }

      const { data: oldBuilds } = await query.order('created_at', { ascending: false });

      if (!oldBuilds?.length) {
        return;
      }

      // Group by app and keep only the 5 most recent per app
      const buildsByApp = new Map<string, any[]>();
      for (const build of oldBuilds) {
        if (!buildsByApp.has(build.app_id)) {
          buildsByApp.set(build.app_id, []);
        }
        buildsByApp.get(build.app_id)!.push(build);
      }

      const buildsToDelete: string[] = [];
      for (const [, builds] of buildsByApp) {
        // Keep the 5 most recent, mark the rest for deletion
        builds.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        const buildsToRemove = builds.slice(5);
        buildsToDelete.push(...buildsToRemove.map(b => b.build_id));
      }

      if (buildsToDelete.length > 0) {
        // Delete files
        await Promise.all(buildsToDelete.map(async (buildId) => {
          const filePath = path.join(this.outputDir, `${buildId}.apk`);
          const aabPath = path.join(this.outputDir, `${buildId}.aab`);
          
          try {
            await fs.rm(filePath, { force: true });
            await fs.rm(aabPath, { force: true });
          } catch (error) {
            logger.warn(`Failed to delete build file for ${buildId}: ${error}`);
          }
        }));

        // Update database records
        await supabase.serviceClient
          .from('app_builds')
          .update({ download_url: null, status: 'expired' })
          .in('build_id', buildsToDelete);

        logger.info(`Cleaned up ${buildsToDelete.length} old builds`);
      }
    } catch (error) {
      logger.error('Error cleaning up old builds:', error);
    }
  }
}

export default BuildService;