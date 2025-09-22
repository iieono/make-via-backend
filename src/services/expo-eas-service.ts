import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import { supabaseStorageService } from '@/services/supabase-storage-service';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

// Expo EAS types
interface EASBuildRequest {
  appId: string;
  platform: 'ios' | 'android' | 'all';
  profile: 'development' | 'preview' | 'production';
  environment?: Record<string, string>;
  buildConfiguration?: EASBuildConfiguration;
}

interface EASBuildConfiguration {
  distribution?: 'store' | 'internal' | 'simulator';
  ios?: {
    enterpriseProvisioning?: string;
    simulators?: boolean;
  };
  android?: {
    applicationId?: string;
    versionCode?: number;
  };
  cache?: {
    disabled?: boolean;
    key?: string;
  };
}

interface EASBuildResponse {
  buildId: string;
  platform: 'ios' | 'android';
  status: 'new' | 'in-progress' | 'finished' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  artifacts?: {
    url?: string;
    bundleUrl?: string;
    manifestUrl?: string;
  };
  logsUrl?: string;
  error?: {
    message: string;
    code: string;
  };
}

interface ExpoConfig {
  expo: {
    name: string;
    slug: string;
    version: string;
    orientation: 'portrait' | 'landscape' | 'default';
    icon: string;
    userInterfaceStyle: 'automatic' | 'light' | 'dark';
    splash: {
      image: string;
      resizeMode: 'contain' | 'cover' | 'stretch';
      backgroundColor: string;
    };
    assetBundlePatterns: string[];
    ios?: {
      supportsTablet?: boolean;
      bundleIdentifier?: string;
      simulator?: boolean;
    };
    android?: {
      adaptiveIcon?: {
        foregroundImage: string;
        backgroundColor: string;
      };
      package?: string;
    };
    plugins?: string[];
    extra?: Record<string, any>;
  };
}

export class ExpoEASService {
  private readonly expoApiToken: string;
  private readonly projectId: string;
  private readonly buildDir: string;

  constructor() {
    this.expoApiToken = process.env.EXPO_API_TOKEN || '';
    this.projectId = process.env.EXPO_PROJECT_ID || '';
    this.buildDir = process.env.EXPO_BUILD_DIRECTORY || '/tmp/expo-builds';
  }

  /**
   * Start a new EAS build for React Native app
   */
  async startEASBuild(buildRequest: EASBuildRequest, userId: string): Promise<string> {
    try {
      // Get React Native app data
      const appData = await this.getRNAppData(buildRequest.appId);
      
      // Generate Expo project
      const projectPath = await this.generateExpoProject(buildRequest.appId, appData);
      
      // Create build record
      const buildId = `eas_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const { data: build, error } = await supabase
        .from('rn_builds')
        .insert({
          app_id: buildRequest.appId,
          user_id: userId,
          build_platform: buildRequest.platform === 'all' ? 'ios' : buildRequest.platform,
          build_mode: buildRequest.profile,
          status: 'pending',
          build_config: buildRequest,
          build_logs: '',
          started_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;

      // Start EAS build
      this.executeEASBuild(buildId, buildRequest, projectPath, userId).catch(error => {
        logger.error(`EAS build ${buildId} failed:`, error);
        this.updateBuildStatus(buildId, 'failed', error.message);
      });

      return buildId;
    } catch (error) {
      logger.error('Error starting EAS build:', error);
      throw error;
    }
  }

  /**
   * Execute EAS build process
   */
  private async executeEASBuild(
    buildId: string,
    buildRequest: EASBuildRequest,
    projectPath: string,
    userId: string
  ): Promise<void> {
    try {
      // Update status to building
      await this.updateBuildStatus(buildId, 'building');

      // Check if Expo CLI is installed
      const expoInstalled = await this.checkExpoCLI();
      if (!expoInstalled) {
        throw new Error('Expo CLI is not installed');
      }

      // Update app.json with proper configuration
      await this.updateExpoConfig(projectPath, buildRequest.appId);

      // Initialize Expo project if needed
      await this.initializeExpoProject(projectPath);

      // Install dependencies
      await this.installDependencies(projectPath);

      // Start EAS build
      const buildCommand = this.buildEASCommand(buildRequest);
      const buildResult = await this.runBuildCommand(buildCommand, projectPath);

      // Handle build result
      if (buildResult.success) {
        await this.handleBuildSuccess(buildId, buildResult.artifacts);
      } else {
        await this.updateBuildStatus(buildId, 'failed', buildResult.error);
      }

    } catch (error) {
      logger.error(`EAS build ${buildId} failed:`, error);
      await this.updateBuildStatus(buildId, 'failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Generate Expo project structure from React Native app data
   */
  private async generateExpoProject(appId: string, appData: any): Promise<string> {
    const projectPath = path.join(this.buildDir, `${appId}_${Date.now()}`);
    
    try {
      // Create project directory
      await fs.mkdir(projectPath, { recursive: true });

      // Generate package.json
      const packageJson = this.generatePackageJson(appData);
      await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));

      // Generate app.json (Expo configuration)
      const appJson = this.generateAppJson(appData);
      await fs.writeFile(path.join(projectPath, 'app.json'), JSON.stringify(appJson, null, 2));

      // Generate eas.json (EAS configuration)
      const easJson = this.generateEasJson(appData);
      await fs.writeFile(path.join(projectPath, 'eas.json'), JSON.stringify(easJson, null, 2));

      // Generate React Native screens
      await this.generateRNScreens(projectPath, appData);

      // Generate navigation structure
      await this.generateNavigation(projectPath, appData);

      // Generate components
      await this.generateComponents(projectPath, appData);

      // Generate state management
      await this.generateStateManagement(projectPath, appData);

      // Generate API integrations
      await this.generateAPIIntegrations(projectPath, appData);

      logger.info(`Generated Expo project at ${projectPath}`);
      return projectPath;

    } catch (error) {
      logger.error('Failed to generate Expo project:', error);
      throw error;
    }
  }

  /**
   * Generate package.json for React Native app
   */
  private generatePackageJson(appData: any): any {
    const dependencies = {
      'expo': '~50.0.0',
      'expo-status-bar': '~1.11.1',
      'react': '18.2.0',
      'react-native': '0.73.0',
      'react-native-screens': '~3.29.0',
      'react-native-safe-area-context': '4.8.2',
      '@react-navigation/native': '^6.1.9',
      '@react-navigation/native-stack': '^6.9.17',
      '@react-navigation/bottom-tabs': '^6.5.11',
      '@react-navigation/drawer': '^6.6.6',
      '@reduxjs/toolkit': '^2.0.1',
      'react-redux': '^9.0.4',
      'react-query': '^3.39.3',
      'axios': '^1.6.2',
      'react-native-gesture-handler': '~2.14.0',
      'react-native-reanimated': '~3.6.2',
      'react-native-vector-icons': '^10.0.3'
    };

    // Add app-specific packages
    if (appData.packages) {
      appData.packages.forEach((pkg: any) => {
        if (pkg.packageType === 'dependency') {
          dependencies[pkg.packageName] = pkg.version;
        }
      });
    }

    return {
      name: appData.name || 'ReactNativeApp',
      version: appData.version || '1.0.0',
      main: 'node_modules/expo/AppEntry.js',
      scripts: {
        start: 'expo start',
        android: 'expo start --android',
        ios: 'expo start --ios',
        web: 'expo start --web'
      },
      dependencies,
      devDependencies: {
        '@babel/core': '^7.20.0',
        '@types/react': '~18.2.45',
        '@types/react-native': '~0.73.0',
        'typescript': '^5.1.3'
      },
      private: true
    };
  }

  /**
   * Generate app.json (Expo configuration)
   */
  private generateAppJson(appData: any): ExpoConfig {
    const expoConfig: ExpoConfig = {
      expo: {
        name: appData.name || 'React Native App',
        slug: appData.slug || 'react-native-app',
        version: appData.version || '1.0.0',
        orientation: 'portrait',
        icon: './assets/icon.png',
        userInterfaceStyle: 'automatic',
        splash: {
          image: './assets/splash.png',
          resizeMode: 'contain',
          backgroundColor: '#ffffff'
        },
        assetBundlePatterns: ['**/*'],
        ios: {
          supportsTablet: true,
          bundleIdentifier: appData.bundle_id || 'com.example.rnapp'
        },
        android: {
          adaptiveIcon: {
            foregroundImage: './assets/adaptive-icon.png',
            backgroundColor: '#FFFFFF'
          },
          package: appData.package_name || 'com.example.rnapp'
        }
      }
    };

    // Add plugins from app data
    if (appData.packages) {
      const plugins = appData.packages
        .filter((pkg: any) => pkg.isExpoCompatible && pkg.configPlugins.length > 0)
        .flatMap((pkg: any) => pkg.configPlugins);
      
      if (plugins.length > 0) {
        expoConfig.expo.plugins = plugins;
      }
    }

    // Add native modules
    if (appData.nativeModules) {
      appData.nativeModules.forEach((module: any) => {
        if (module.isExpoPlugin && module.moduleName) {
          if (!expoConfig.expo.plugins) expoConfig.expo.plugins = [];
          expoConfig.expo.plugins.push(module.moduleName);
        }
      });
    }

    return expoConfig;
  }

  /**
   * Generate eas.json (EAS configuration)
   */
  private generateEasJson(appData: any): any {
    return {
      cli: {
        version: '>= 3.1.1'
      },
      build: {
        development: {
          developmentClient: true,
          distribution: 'internal',
          env: {
            EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL
          }
        },
        preview: {
          distribution: 'internal',
          env: {
            EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL
          }
        },
        production: {
          distribution: 'store',
          env: {
            EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL
          }
        }
      },
      submit: {
        production: {
          ios: {
            appleId: process.env.APPLE_ID,
            ascAppId: process.env.ASC_APP_ID,
            appleTeamId: process.env.APPLE_TEAM_ID
          },
          android: {
            serviceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH
          }
        }
      }
    };
  }

  /**
   * Generate React Native screens
   */
  private async generateRNScreens(projectPath: string, appData: any): Promise<void> {
    const screensDir = path.join(projectPath, 'screens');
    await fs.mkdir(screensDir, { recursive: true });

    for (const screen of appData.screens || []) {
      const screenContent = this.generateScreenCode(screen);
      const screenPath = path.join(screensDir, `${screen.routeName}.tsx`);
      await fs.writeFile(screenPath, screenContent);
    }
  }

  /**
   * Generate screen component code
   */
  private generateScreenCode(screen: any): string {
    return `import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';

const ${screen.routeName.charAt(0).toUpperCase() + screen.routeName.slice(1)}: React.FC = ({ navigation, route }) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    // Initialize screen
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContainer}>
        <Text style={styles.title}>${screen.name}</Text>
        {/* Screen content will be generated here */}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollContainer: {
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 16,
    color: '#333',
  },
});

export default ${screen.routeName.charAt(0).toUpperCase() + screen.routeName.slice(1)};`;
  }

  /**
   * Generate navigation structure
   */
  private async generateNavigation(projectPath: string, appData: any): Promise<void> {
    const navigationDir = path.join(projectPath, 'navigation');
    await fs.mkdir(navigationDir, { recursive: true });

    // Generate AppNavigator
    const appNavigator = this.generateAppNavigator(appData);
    await fs.writeFile(path.join(navigationDir, 'AppNavigator.tsx'), appNavigator);

    // Generate navigation config files for each navigation type
    for (const nav of appData.navigation || []) {
      const navConfig = this.generateNavigationConfig(nav);
      const navPath = path.join(navigationDir, `${nav.name}Navigator.tsx`);
      await fs.writeFile(navPath, navConfig);
    }
  }

  /**
   * Generate main App Navigator
   */
  private generateAppNavigator(appData: any): string {
    return `import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createDrawerNavigator } from '@react-navigation/drawer';

// Import screens
${appData.screens.map((screen: any) => 
  `import ${screen.routeName} from '../screens/${screen.routeName}';`
).join('\n')}

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
const Drawer = createDrawerNavigator();

const AppNavigator = () => {
  return (
    <NavigationContainer>
      ${this.generateNavigatorStructure(appData.navigation || [])}
    </NavigationContainer>
  );
};

export default AppNavigator;`;
  }

  /**
   * Generate navigator structure based on navigation config
   */
  private generateNavigatorStructure(navigation: any[]): string {
    if (navigation.length === 0) {
      return `<Stack.Navigator>
        <Stack.Screen name="Home" component={Home} options={{ title: 'Home' }} />
      </Stack.Navigator>`;
    }

    const mainNav = navigation.find(nav => nav.is_main_navigation);
    if (!mainNav) {
      return `<Stack.Navigator>
        <Stack.Screen name="Home" component={Home} options={{ title: 'Home' }} />
      </Stack.Navigator>`;
    }

    switch (mainNav.navigationType) {
      case 'stack':
        return this.generateStackNavigator(mainNav);
      case 'tab':
        return this.generateTabNavigator(mainNav);
      case 'drawer':
        return this.generateDrawerNavigator(mainNav);
      default:
        return `<Stack.Navigator>
          <Stack.Screen name="Home" component={Home} options={{ title: 'Home' }} />
        </Stack.Navigator>`;
    }
  }

  /**
   * Generate Stack Navigator
   */
  private generateStackNavigator(nav: any): string {
    return `<Stack.Navigator>
      ${nav.routes.map((route: any) => 
        `<Stack.Screen 
          name="${route.name}" 
          component={${route.component}} 
          options={${JSON.stringify(route.options || {})}}
        />`
      ).join('\n      ')}
    </Stack.Navigator>`;
  }

  /**
   * Generate Tab Navigator
   */
  private generateTabNavigator(nav: any): string {
    return `<Tab.Navigator>
      ${nav.routes.map((route: any) => 
        `<Tab.Screen 
          name="${route.name}" 
          component={${route.component}} 
          options={${JSON.stringify(route.options || {})}}
        />`
      ).join('\n      ')}
    </Tab.Navigator>`;
  }

  /**
   * Generate Drawer Navigator
   */
  private generateDrawerNavigator(nav: any): string {
    return `<Drawer.Navigator>
      ${nav.routes.map((route: any) => 
        `<Drawer.Screen 
          name="${route.name}" 
          component={${route.component}} 
          options={${JSON.stringify(route.options || {})}}
        />`
      ).join('\n      ')}
    </Drawer.Navigator>`;
  }

  /**
   * Generate navigation configuration
   */
  private generateNavigationConfig(nav: any): string {
    return `import React from 'react';
import { ${nav.navigationType === 'stack' ? 'createNativeStackNavigator' : 
               nav.navigationType === 'tab' ? 'createBottomTabNavigator' : 
               'createDrawerNavigator'} } from '@react-navigation/${nav.navigationType}';

${nav.routes.map((route: any) => 
  `import ${route.component} from '../screens/${route.component}';`
).join('\n')}

const ${nav.navigationType.charAt(0).toUpperCase() + nav.navigationType.slice(1)} = create${nav.navigationType.charAt(0).toUpperCase() + nav.navigationType.slice(1)}();

const ${nav.name}Navigator = () => {
  return (
    <${nav.navigationType}.Navigator>
      ${nav.routes.map((route: any) => 
        `<${nav.navigationType}.Screen 
          name="${route.name}" 
          component={${route.component}} 
          options={${JSON.stringify(route.options || {})}}
        />`
      ).join('\n      ')}
    </${nav.navigationType}.Navigator>
  );
};

export default ${nav.name}Navigator;`;
  }

  /**
   * Generate components
   */
  private async generateComponents(projectPath: string, appData: any): Promise<void> {
    const componentsDir = path.join(projectPath, 'components');
    await fs.mkdir(componentsDir, { recursive: true });

    for (const component of appData.components || []) {
      if (component.is_reusable) {
        const componentContent = this.generateComponentCode(component);
        const componentPath = path.join(componentsDir, `${component.name}.tsx`);
        await fs.writeFile(componentPath, componentContent);
      }
    }
  }

  /**
   * Generate component code
   */
  private generateComponentCode(component: any): string {
    return `import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface ${component.name}Props {
  ${component.props ? component.props.map((prop: any) => 
    `${prop.name}${prop.required ? '' : '?'}: ${prop.type};`
  ).join('\n  ') : ''}
}

const ${component.name}: React.FC<${component.name}Props> = ({ ${component.props ? component.props.map((p: any) => p.name).join(', ') : ''} }) => {
  return (
    <View style={styles.container}>
      <Text>${component.name}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    // Component styles
  },
});

export default ${component.name};`;
  }

  /**
   * Generate state management setup
   */
  private async generateStateManagement(projectPath: string, appData: any): Promise<void> {
    const stateDir = path.join(projectPath, 'state');
    await fs.mkdir(stateDir, { recursive: true });

    for (const stateConfig of appData.stateManagement || []) {
      switch (stateConfig.stateType) {
        case 'redux':
          await this.generateReduxSetup(stateDir, stateConfig);
          break;
        case 'zustand':
          await this.generateZustandSetup(stateDir, stateConfig);
          break;
        case 'context':
          await this.generateContextSetup(stateDir, stateConfig);
          break;
      }
    }
  }

  /**
   * Generate Redux setup
   */
  private async generateReduxSetup(stateDir: string, stateConfig: any): Promise<void> {
    // Generate store configuration
    const storeContent = `import { configureStore } from '@reduxjs/toolkit';
${stateConfig.slices.map((slice: any) => 
  `import ${slice.name}Slice from './${slice.name}Slice';`
).join('\n')}

export const store = configureStore({
  reducer: {
    ${stateConfig.slices.map((slice: any) => `${slice.name}: ${slice.name}Slice`).join(',\n    ')}
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;`;

    await fs.writeFile(path.join(stateDir, 'store.ts'), storeContent);

    // Generate slices
    for (const slice of stateConfig.slices) {
      const sliceContent = `import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface ${slice.name}State {
  ${Object.entries(slice.initialState).map(([key, value]) => 
    `${key}: ${typeof value};`
  ).join('\n  ')}
}

const initialState: ${slice.name}State = ${JSON.stringify(slice.initialState, null, 2)};

const ${slice.name}Slice = createSlice({
  name: '${slice.name}',
  initialState,
  reducers: {
    ${slice.reducers.map((reducer: any) => 
      `${reducer.name}: (state, action: PayloadAction<${reducer.action}>) => {
        // Reducer logic for ${reducer.name}
      }`
    ).join(',\n    ')}
  },
});

export const { ${slice.reducers.map((r: any) => r.name).join(', ')} } = ${slice.name}Slice.actions;
export default ${slice.name}Slice.reducer;`;

      await fs.writeFile(path.join(stateDir, `${slice.name}Slice.ts`), sliceContent);
    }

    // Generate hooks
    const hooksContent = `import { useDispatch, useSelector } from 'react-redux';
import type { RootState, AppDispatch } from './store';

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: <T>(selector: (state: RootState) => T) => T = useSelector;`;

    await fs.writeFile(path.join(stateDir, 'hooks.ts'), hooksContent);
  }

  /**
   * Generate Zustand setup
   */
  private async generateZustandSetup(stateDir: string, stateConfig: any): Promise<void> {
    const storeContent = `import { create } from 'zustand';

interface ${stateConfig.name}Store {
  ${Object.entries(stateConfig.storeConfig).map(([key, value]) => 
    `${key}: ${typeof value};`
  ).join('\n  ')}
  ${stateConfig.hooks.map((hook: any) => `${hook.name}: ${hook.type};`).join('\n  ')}
}

export const use${stateConfig.name}Store = create<${stateConfig.name}Store>((set, get) => ({
  ...${JSON.stringify(stateConfig.storeConfig, null, 2)},
  ${stateConfig.hooks.map((hook: any) => 
    `${hook.name}: ${hook.implementation}`
  ).join(',\n  ')}
}));`;

    await fs.writeFile(path.join(stateDir, `${stateConfig.name}Store.ts`), storeContent);
  }

  /**
   * Generate Context setup
   */
  private async generateContextSetup(stateDir: string, stateConfig: any): Promise<void> {
    const contextContent = `import React, { createContext, useContext, useReducer, ReactNode } from 'react';

interface ${stateConfig.name}State {
  ${Object.entries(stateConfig.storeConfig).map(([key, value]) => 
    `${key}: ${typeof value};`
  ).join('\n  ')}
}

type ${stateConfig.name}Action = {
  type: string;
  payload?: any;
};

const initialState: ${stateConfig.name}State = ${JSON.stringify(stateConfig.storeConfig, null, 2)};

const ${stateConfig.name}Context = createContext<{
  state: ${stateConfig.name}State;
  dispatch: React.Dispatch<${stateConfig.name}Action>;
} | null>(null);

export const ${stateConfig.name}Provider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer((state: ${stateConfig.name}State, action: ${stateConfig.name}Action) => {
    // Reducer logic
    return state;
  }, initialState);

  return (
    <${stateConfig.name}Context.Provider value={{ state, dispatch }}>
      {children}
    </${stateConfig.name}Context.Provider>
  );
};

export const use${stateConfig.name} = () => {
  const context = useContext(${stateConfig.name}Context);
  if (!context) {
    throw new Error(\`use${stateConfig.name} must be used within a ${stateConfig.name}Provider\`);
  }
  return context;
};`;

    await fs.writeFile(path.join(stateDir, `${stateConfig.name}Context.tsx`), contextContent);
  }

  /**
   * Generate API integrations
   */
  private async generateAPIIntegrations(projectPath: string, appData: any): Promise<void> {
    const apiDir = path.join(projectPath, 'api');
    await fs.mkdir(apiDir, { recursive: true });

    for (const api of appData.apis || []) {
      const apiContent = this.generateAPICode(api);
      const apiPath = path.join(apiDir, `${api.name}.ts`);
      await fs.writeFile(apiPath, apiContent);
    }

    // Generate API configuration
    const apiConfigContent = `import axios from 'axios';

const api = axios.create({
  baseURL: process.env.EXPO_PUBLIC_API_URL || 'https://api.example.com',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor
api.interceptors.request.use(
  (config) => {
    // Add auth token if available
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Handle errors
    return Promise.reject(error);
  }
);

export default api;`;

    await fs.writeFile(path.join(apiDir, 'config.ts'), apiConfigContent);
  }

  /**
   * Generate API code
   */
  private generateAPICode(api: any): string {
    return `import api from './config';

interface ${api.name}Response {
  // Response interface
}

interface ${api.name}Request {
  // Request interface
}

export const ${api.name}Service = {
  ${api.method.toLowerCase()}: async (data?: ${api.name}Request): Promise<${api.name}Response> => {
    try {
      const response = await api.${api.method.toLowerCase()}('${api.endpoint}', data);
      return response.data;
    } catch (error) {
      console.error('Error in ${api.name}:', error);
      throw error;
    }
  },
};`;
  }

  /**
   * Update Expo configuration with app-specific settings
   */
  private async updateExpoConfig(projectPath: string, appId: string): Promise<void> {
    const appConfigPath = path.join(projectPath, 'app.json');
    const appConfigContent = await fs.readFile(appConfigPath, 'utf-8');
    const appConfig = JSON.parse(appConfigContent);

    // Update with latest app data from database
    const appData = await this.getRNAppData(appId);
    
    appConfig.expo.name = appData.name;
    appConfig.expo.slug = appData.slug;
    appConfig.expo.version = appData.version;

    await fs.writeFile(appConfigPath, JSON.stringify(appConfig, null, 2));
  }

  /**
   * Initialize Expo project
   */
  private async initializeExpoProject(projectPath: string): Promise<void> {
    // Create basic assets
    const assetsDir = path.join(projectPath, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });

    // Create placeholder assets
    const placeholderAssets = [
      { name: 'icon.png', content: 'placeholder' },
      { name: 'splash.png', content: 'placeholder' },
      { name: 'adaptive-icon.png', content: 'placeholder' },
      { name: 'favicon.png', content: 'placeholder' },
    ];

    for (const asset of placeholderAssets) {
      const assetPath = path.join(assetsDir, asset.name);
      if (!(await fs.exists(assetPath))) {
        await fs.writeFile(assetPath, asset.content);
      }
    }
  }

  /**
   * Install dependencies
   */
  private async installDependencies(projectPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const installProcess = spawn('npm', ['install'], {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      installProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      installProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      installProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm install failed with code ${code}\nstderr: ${stderr}`));
        }
      });

      installProcess.on('error', (error) => {
        reject(new Error(`Failed to start npm install: ${error.message}`));
      });

      // Set timeout
      setTimeout(() => {
        installProcess.kill();
        reject(new Error('npm install timeout after 5 minutes'));
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Build EAS command
   */
  private buildEASCommand(buildRequest: EASBuildRequest): string {
    const platform = buildRequest.platform === 'all' ? 'all' : buildRequest.platform;
    return `eas build --platform ${platform} --profile ${buildRequest.profile}`;
  }

  /**
   * Run build command
   */
  private async runBuildCommand(command: string, projectPath: string): Promise<{
    success: boolean;
    artifacts?: any;
    error?: string;
  }> {
    return new Promise((resolve, reject) => {
      const buildProcess = spawn('npx', command.split(' '), {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          EXPO_TOKEN: this.expoApiToken,
        },
      });

      let stdout = '';
      let stderr = '';

      buildProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        logger.info(`EAS build stdout: ${data}`);
      });

      buildProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        logger.warn(`EAS build stderr: ${data}`);
      });

      buildProcess.on('close', (code) => {
        if (code === 0) {
          // Parse artifacts from output
          const artifacts = this.parseBuildArtifacts(stdout);
          resolve({ success: true, artifacts });
        } else {
          resolve({ 
            success: false, 
            error: `EAS build failed with code ${code}\nstderr: ${stderr}` 
          });
        }
      });

      buildProcess.on('error', (error) => {
        resolve({ 
          success: false, 
          error: `Failed to start EAS build: ${error.message}` 
        });
      });

      // Set timeout for long builds (EAS builds can take a while)
      setTimeout(() => {
        buildProcess.kill();
        resolve({ 
          success: false, 
          error: 'EAS build timeout after 60 minutes' 
        });
      }, 60 * 60 * 1000);
    });
  }

  /**
   * Parse build artifacts from EAS output
   */
  private parseBuildArtifacts(stdout: string): any {
    // Parse EAS build output for artifact URLs
    const urlMatch = stdout.match(/Build URL: (https:\/\/[^\s]+)/);
    const artifactMatch = stdout.match(/Artifact URL: (https:\/\/[^\s]+)/);

    return {
      buildUrl: urlMatch ? urlMatch[1] : null,
      artifactUrl: artifactMatch ? artifactMatch[1] : null,
      logsUrl: stdout.match(/Logs URL: (https:\/\/[^\s]+)/)?.[1],
    };
  }

  /**
   * Handle successful build
   */
  private async handleBuildSuccess(buildId: string, artifacts: any): Promise<void> {
    try {
      let downloadUrl = artifacts.artifactUrl;
      
      // If no direct artifact URL, try to download from build URL
      if (!downloadUrl && artifacts.buildUrl) {
        downloadUrl = await this.downloadBuildArtifact(artifacts.buildUrl);
      }

      if (downloadUrl) {
        await this.updateBuildStatus(buildId, 'completed', null, downloadUrl, artifacts);
      } else {
        await this.updateBuildStatus(buildId, 'completed', null, artifacts.buildUrl, artifacts);
      }
    } catch (error) {
      logger.error('Failed to handle build success:', error);
      await this.updateBuildStatus(buildId, 'completed', null, artifacts.buildUrl, artifacts);
    }
  }

  /**
   * Download build artifact from EAS
   */
  private async downloadBuildArtifact(buildUrl: string): Promise<string> {
    try {
      // This would involve calling EAS API to get build details and download artifacts
      // For now, return the build URL as the download URL
      return buildUrl;
    } catch (error) {
      logger.error('Failed to download build artifact:', error);
      throw error;
    }
  }

  /**
   * Check if Expo CLI is installed
   */
  private async checkExpoCLI(): Promise<boolean> {
    return new Promise((resolve) => {
      const checkProcess = spawn('which', ['expo']);
      
      checkProcess.on('close', (code) => {
        resolve(code === 0);
      });

      checkProcess.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Update build status in database
   */
  private async updateBuildStatus(
    buildId: string,
    status: 'pending' | 'building' | 'completed' | 'failed',
    errorMessage?: string,
    downloadUrl?: string,
    artifacts?: any
  ): Promise<void> {
    const updates: any = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (status === 'completed') {
      updates.completed_at = new Date().toISOString();
      updates.download_url = downloadUrl;
      updates.output_url = downloadUrl;
      if (artifacts) {
        updates.artifacts = artifacts;
      }
    }

    if (status === 'failed') {
      updates.error_message = errorMessage;
      updates.completed_at = new Date().toISOString();
    }

    await supabase
      .from('rn_builds')
      .update(updates)
      .eq('id', buildId);
  }

  /**
   * Get React Native app data from database
   */
  private async getRNAppData(appId: string): Promise<any> {
    const [
      { data: app },
      { data: screens },
      { data: components },
      { data: navigation },
      { data: stateManagement },
      { data: packages },
      { data: nativeModules },
      { data: apis }
    ] = await Promise.all([
      supabase.from('rn_apps').select('*').eq('id', appId).single(),
      supabase.from('rn_screens').select('*').eq('app_id', appId),
      supabase.from('rn_components').select('*').eq('app_id', appId),
      supabase.from('rn_navigation').select('*').eq('app_id', appId),
      supabase.from('rn_state_management').select('*').eq('app_id', appId),
      supabase.from('rn_packages').select('*').eq('app_id', appId),
      supabase.from('rn_native_modules').select('*').eq('app_id', appId),
      supabase.from('rn_apis').select('*').eq('app_id', appId)
    ]);

    return {
      app: app,
      screens: screens || [],
      components: components || [],
      navigation: navigation || [],
      stateManagement: stateManagement || [],
      packages: packages || [],
      nativeModules: nativeModules || [],
      apis: apis || []
    };
  }

  /**
   * Get build status
   */
  async getBuildStatus(buildId: string): Promise<any> {
    const { data: build } = await supabase
      .from('rn_builds')
      .select('*')
      .eq('id', buildId)
      .single();

    return build;
  }

  /**
   * Cancel a build
   */
  async cancelBuild(buildId: string): Promise<void> {
    await this.updateBuildStatus(buildId, 'failed', 'Build cancelled by user');
  }

  /**
   * Get builds for an app
   */
  async getAppBuilds(appId: string, limit = 20): Promise<any[]> {
    const { data: builds } = await supabase
      .from('rn_builds')
      .select('*')
      .eq('app_id', appId)
      .order('created_at', { ascending: false })
      .limit(limit);

    return builds || [];
  }
}

export const expoEASService = new ExpoEASService();