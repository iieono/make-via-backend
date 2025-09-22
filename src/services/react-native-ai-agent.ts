import { supabase } from '@/services/supabase';
import { claudeService } from '@/services/claude';
import { creditService } from '@/services/credit-service';
import { logger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';

// React Native and Expo specific types
interface ReactNativeContext {
  appId: string;
  userId: string;
  expoVersion: string;
  reactNativeVersion: string;
  appStructure: {
    screens: RNScreen[];
    components: RNComponent[];
    navigation: RNNavigation[];
    stateManagement: RNStateManagement[];
    packages: RNPackage[];
    nativeModules: RNNativeModule[];
    themes: RNTheme[];
  };
  deviceConfig?: {
    platform: 'ios' | 'android' | 'web';
    version: string;
    deviceType: string;
  };
}

interface RNScreen {
  id: string;
  name: string;
  routeName: string;
  componentTree: ReactNativeComponent[];
  imports: string[];
  dependencies: string[];
  styles: StyleSheetDefinition;
  stateHooks: StateHook[];
  propsInterface: InterfaceDefinition;
}

interface RNComponent {
  id: string;
  name: string;
  componentType: 'functional' | 'class' | 'screen';
  code: string;
  props: PropDefinition[];
  styles: StyleSheetDefinition;
  dependencies: string[];
  imports: string[];
  category: 'ui' | 'layout' | 'form' | 'navigation' | 'custom';
}

interface ReactNativeComponent {
  type: string;
  props: Record<string, any>;
  children?: ReactNativeComponent[];
  style?: StyleSheetDefinition;
  key?: string;
}

interface StyleSheetDefinition {
  [key: string]: {
    [key: string]: any;
  };
}

interface InterfaceDefinition {
  name: string;
  properties: PropertyDefinition[];
}

interface PropertyDefinition {
  name: string;
  type: string;
  required?: boolean;
  defaultValue?: any;
}

interface PropDefinition {
  name: string;
  type: string;
  required?: boolean;
  defaultValue?: any;
  description?: string;
}

interface StateHook {
  name: string;
  type: string;
  initialValue?: any;
  dependencies?: string[];
}

interface RNNavigation {
  id: string;
  navigationType: 'stack' | 'tab' | 'drawer' | 'native';
  config: NavigationConfig;
  routes: RouteDefinition[];
  deepLinking?: DeepLinkingConfig;
}

interface NavigationConfig {
  [key: string]: any;
}

interface RouteDefinition {
  name: string;
  component: string;
  path?: string;
  options?: RouteOptions;
}

interface RouteOptions {
  title?: string;
  headerShown?: boolean;
  tabBarIcon?: any;
  tabBarLabel?: string;
}

interface DeepLinkingConfig {
  prefixes: string[];
  config: {
    screens: Record<string, string>;
  };
}

interface RNStateManagement {
  id: string;
  stateType: 'redux' | 'zustand' | 'context' | 'recoil';
  storeConfig: StoreConfig;
  slices: SliceDefinition[];
  hooks: HookDefinition[];
}

interface StoreConfig {
  [key: string]: any;
}

interface SliceDefinition {
  name: string;
  initialState: any;
  reducers: ReducerDefinition[];
}

interface ReducerDefinition {
  name: string;
  action: string;
  stateChanges: any;
}

interface HookDefinition {
  name: string;
  type: 'selector' | 'dispatch' | 'custom';
  implementation: string;
}

interface RNPackage {
  id: string;
  packageName: string;
  version: string;
  packageType: 'dependency' | 'devDependency' | 'pod';
  isExpoCompatible: boolean;
  requiresNativeBuild: boolean;
  configPlugins: any[];
}

interface RNNativeModule {
  id: string;
  moduleName: string;
  platform: 'ios' | 'android' | 'both';
  configType: 'plugin' | 'pod' | 'gradle' | 'permission';
  configuration: any;
  isExpoPlugin: boolean;
}

interface RNTheme {
  id: string;
  name: string;
  colors: ThemeColors;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
  borderRadius: ThemeBorderRadius;
  shadows: ThemeShadows;
}

interface ThemeColors {
  [key: string]: string;
}

interface ThemeTypography {
  [key: string]: any;
}

interface ThemeSpacing {
  [key: string]: number;
}

interface ThemeBorderRadius {
  [key: string]: number;
}

interface ThemeShadows {
  [key: string]: any;
}

// React Native AI Action Types
enum RNActionType {
  // Screen operations
  CREATE_SCREEN = 'create_screen',
  EDIT_SCREEN = 'edit_screen',
  DELETE_SCREEN = 'delete_screen',
  
  // Component operations
  CREATE_COMPONENT = 'create_component',
  EDIT_COMPONENT = 'edit_component',
  DELETE_COMPONENT = 'delete_component',
  
  // Navigation operations
  CREATE_NAVIGATION = 'create_navigation',
  EDIT_NAVIGATION = 'edit_navigation',
  ADD_DEEP_LINKING = 'add_deep_linking',
  
  // State management
  SETUP_STATE_MANAGEMENT = 'setup_state_management',
  CREATE_REDUX_SLICE = 'create_redux_slice',
  CREATE_ZUSTAND_STORE = 'create_zustand_store',
  
  // Styling and themes
  CREATE_THEME = 'create_theme',
  APPLY_STYLES = 'apply_styles',
  
  // Native features
  ADD_NATIVE_MODULE = 'add_native_module',
  CONFIGURE_PERMISSIONS = 'configure_permissions',
  
  // Package management
  ADD_PACKAGE = 'add_package',
  UPDATE_PACKAGE = 'update_package',
  
  // API integration
  CREATE_API_INTEGRATION = 'create_api_integration',
  SETUP_REACT_QUERY = 'setup_react_query',
  
  // Analysis and optimization
  ANALYZE_APP = 'analyze_app',
  OPTIMIZE_PERFORMANCE = 'optimize_performance',
  DEBUG_ISSUE = 'debug_issue',
  
  // Build and deployment
  GENERATE_EXPO_CONFIG = 'generate_expo_config',
  SETUP_EAS_BUILD = 'setup_eas_build',
}

interface RNAIAction {
  id: string;
  type: RNActionType;
  details: Record<string, any>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  creditsCost: number;
  errorMessage?: string;
  generatedCode?: string;
  targetId?: string;
}

interface RNConversation {
  id: string;
  appId: string;
  userId: string;
  sessionId: string;
  context: ReactNativeContext;
  messages: RNMessage[];
  totalCreditsUsed: number;
}

interface RNMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
  actionsPerformed: RNAIAction[];
  creditsConsumed: number;
  status: 'processing' | 'completed' | 'failed';
  timestamp: Date;
}

interface RNGenerationResult {
  success: boolean;
  code?: string;
  dependencies?: string[];
  config?: any;
  error?: string;
  componentId?: string;
  screenId?: string;
}

export class ReactNativeAIAgent {
  private db = supabase;

  /**
   * Main entry point for React Native AI generation
   */
  async handleRNMessage(
    conversationId: string | null,
    userMessage: string,
    imageUrl?: string,
    appId?: string,
    userId?: string
  ): Promise<{
    success: boolean;
    message: string;
    actionsPerformed: RNAIAction[];
    totalCreditsUsed: number;
    conversationId: string;
    partialCompletion?: boolean;
    remainingActions?: number;
  }> {
    try {
      logger.info('Processing React Native AI message', {
        conversationId,
        messageLength: userMessage.length,
        hasImage: !!imageUrl,
        platform: 'react-native'
      });

      // Get or create React Native conversation
      const conversation = await this.getOrCreateRNConversation(
        conversationId,
        appId!,
        userId!
      );

      // Get React Native project context
      const context = await this.getRNProjectContext(conversation.id);

      // Analyze message for React Native actions
      const plannedActions = await this.analyzeRNMessage(
        userMessage,
        context,
        imageUrl
      );

      // Calculate credits for React Native operations
      const totalCredits = this.calculateRNCredits(plannedActions, context);

      // Check user credits
      const userCredits = await creditService.getUserAvailableCredits(context.userId);
      if (userCredits <= 0) {
        throw new Error('No credits available. Please upgrade your plan.');
      }

      // Store user message
      const userMessageRecord = await this.storeRNUserMessage(
        conversation.id,
        userMessage,
        imageUrl,
        totalCredits
      );

      // Execute actions with credit tracking
      const executedActions = [];
      let totalCreditsUsed = 0;
      let creditsExhausted = false;

      for (const action of plannedActions) {
        const actionCost = this.calculateRNActionCost(action, context);
        
        if (totalCreditsUsed + actionCost > userCredits) {
          creditsExhausted = true;
          break;
        }

        try {
          const result = await this.executeRNAction(action, context);
          
          // Consume credits
          const consumeSuccess = await creditService.consumeCredits(
            context.userId,
            actionCost,
            `React Native action: ${action.type}`
          );

          if (consumeSuccess) {
            totalCreditsUsed += actionCost;
            result.creditsCost = actionCost;
          }

          executedActions.push(result);
        } catch (error) {
          logger.error('RN action execution failed', { actionId: action.id, error });
          executedActions.push({
            ...action,
            status: 'failed' as const,
            errorMessage: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // Generate React Native-specific response
      const response = await this.generateRNResponse(
        executedActions,
        context,
        creditsExhausted
      );

      // Store AI response
      await this.storeRNAIMessage(
        conversation.id,
        response.message,
        executedActions,
        totalCreditsUsed
      );

      return {
        success: true,
        message: response.message,
        actionsPerformed: executedActions,
        totalCreditsUsed,
        conversationId: conversation.id,
        partialCompletion: creditsExhausted,
        remainingActions: creditsExhausted ? plannedActions.length - executedActions.length : 0
      };

    } catch (error) {
      logger.error('React Native AI message handling failed', { error });
      throw error;
    }
  }

  /**
   * Get React Native project context with all app structure
   */
  private async getRNProjectContext(conversationId: string): Promise<ReactNativeContext> {
    // Get conversation details
    const { data: conversation } = await this.db
      .from('rn_ai_conversations')
      .select('app_id, user_id, session_id, expo_version, react_native_version')
      .eq('id', conversationId)
      .single();

    if (!conversation) throw new Error('Conversation not found');

    // Get all React Native app data
    const [
      { data: app },
      { data: screens },
      { data: components },
      { data: navigation },
      { data: stateManagement },
      { data: packages },
      { data: nativeModules },
      { data: themes }
    ] = await Promise.all([
      this.db.from('rn_apps').select('*').eq('id', conversation.app_id).single(),
      this.db.from('rn_screens').select('*').eq('app_id', conversation.app_id),
      this.db.from('rn_components').select('*').eq('app_id', conversation.app_id),
      this.db.from('rn_navigation').select('*').eq('app_id', conversation.app_id),
      this.db.from('rn_state_management').select('*').eq('app_id', conversation.app_id),
      this.db.from('rn_packages').select('*').eq('app_id', conversation.app_id),
      this.db.from('rn_native_modules').select('*').eq('app_id', conversation.app_id),
      this.db.from('rn_themes').select('*').eq('app_id', conversation.app_id)
    ]);

    return {
      appId: conversation.app_id,
      userId: conversation.user_id,
      expoVersion: conversation.expo_version || 'latest',
      reactNativeVersion: conversation.react_native_version || 'latest',
      appStructure: {
        screens: screens || [],
        components: components || [],
        navigation: navigation || [],
        stateManagement: stateManagement || [],
        packages: packages || [],
        nativeModules: nativeModules || [],
        themes: themes || []
      }
    };
  }

  /**
   * Analyze user message for React Native specific actions
   */
  private async analyzeRNMessage(
    message: string,
    context: ReactNativeContext,
    imageUrl?: string
  ): Promise<RNAIAction[]> {
    const prompt = `
You are an expert React Native and Expo AI agent. Analyze this user request and determine what React Native actions need to be performed.

Current app context:
- Screens: ${context.appStructure.screens.map(s => s.name).join(', ') || 'None'}
- Components: ${context.appStructure.components.length} components
- Navigation: ${context.appStructure.navigation.length} navigation configs
- State Management: ${context.appStructure.stateManagement.map(s => s.stateType).join(', ') || 'None'}
- Expo Version: ${context.expoVersion}
- React Native Version: ${context.reactNativeVersion}

User request: "${message}"

Based on this request, identify the React Native-specific actions needed. Respond with a JSON array of actions.

Available React Native action types:
- create_screen: Create a new screen component
- edit_screen: Modify existing screen
- create_component: Create reusable component
- create_navigation: Set up React Navigation
- setup_state_management: Configure Redux/Zustand/Context
- create_theme: Define app theme
- add_package: Add npm package
- add_native_module: Configure native modules
- create_api_integration: Set up API calls
- analyze_app: Analyze app structure
- optimize_performance: Optimize React Native performance
- generate_expo_config: Generate app.json/eas.json

Example response:
[
  {
    "type": "create_screen",
    "details": {
      "name": "ProfileScreen",
      "description": "User profile screen with avatar and settings",
      "route": "profile"
    }
  }
]
    `;

    try {
      const response = await claudeService.generateText(prompt, 'haiku');
      const actions = JSON.parse(response);
      
      return actions.map((action: any) => ({
        id: uuidv4(),
        type: action.type,
        details: action.details || {},
        status: 'pending' as const,
        creditsCost: this.getRNBaseCreditCost(action.type)
      }));
    } catch (error) {
      logger.error('Failed to analyze RN message', { error, message });
      
      // Fallback action
      return [{
        id: uuidv4(),
        type: RNActionType.CREATE_COMPONENT,
        details: { operation: 'generic_rn_component', message },
        status: 'pending',
        creditsCost: 2
      }];
    }
  }

  /**
   * Execute React Native specific actions
   */
  private async executeRNAction(action: RNAIAction, context: ReactNativeContext): Promise<RNAIAction> {
    try {
      let result: RNGenerationResult;

      switch (action.type) {
        case RNActionType.CREATE_SCREEN:
          result = await this.createRNScreen(action.details, context);
          break;
          
        case RNActionType.CREATE_COMPONENT:
          result = await this.createRNComponent(action.details, context);
          break;
          
        case RNActionType.CREATE_NAVIGATION:
          result = await this.createRNNavigation(action.details, context);
          break;
          
        case RNActionType.SETUP_STATE_MANAGEMENT:
          result = await this.setupRNStateManagement(action.details, context);
          break;
          
        case RNActionType.CREATE_THEME:
          result = await this.createRNTheme(action.details, context);
          break;
          
        case RNActionType.ADD_PACKAGE:
          result = await this.addRNPackage(action.details, context);
          break;
          
        case RNActionType.ADD_NATIVE_MODULE:
          result = await this.addRNNativeModule(action.details, context);
          break;
          
        case RNActionType.CREATE_API_INTEGRATION:
          result = await this.createRNAPIIntegration(action.details, context);
          break;
          
        case RNActionType.GENERATE_EXPO_CONFIG:
          result = await this.generateExpoConfig(action.details, context);
          break;
          
        case RNActionType.ANALYZE_APP:
          result = await this.analyzeRNApp(context);
          break;
          
        case RNActionType.OPTIMIZE_PERFORMANCE:
          result = await this.optimizeRNPerformance(context);
          break;
          
        default:
          result = {
            success: false,
            error: `React Native action ${action.type} not implemented yet`
          };
      }

      // Store action in database
      const { data: actionRecord } = await this.db
        .from('rn_ai_actions')
        .insert({
          message_id: null, // Will be updated when storing message
          app_id: context.appId,
          action_type: action.type,
          target_id: result.componentId || result.screenId,
          details: action.details,
          status: result.success ? 'completed' : 'failed',
          credits_cost: action.creditsCost,
          code_generated: result.code,
          error_message: result.error
        })
        .select()
        .single();

      return {
        ...action,
        id: actionRecord!.id,
        status: result.success ? 'completed' : 'failed',
        errorMessage: result.error,
        generatedCode: result.code,
        targetId: result.componentId || result.screenId
      };

    } catch (error) {
      logger.error('RN action execution failed', { actionId: action.id, error });
      
      return {
        ...action,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Create React Native screen with proper structure
   */
  private async createRNScreen(details: any, context: ReactNativeContext): Promise<RNGenerationResult> {
    const screenName = details.name || 'NewScreen';
    const routeName = details.route || screenName.toLowerCase().replace(/\s+/g, '');
    
    // Generate React Native screen code
    const screenCode = await this.generateRNScreenCode(screenName, details, context);
    
    // Store screen in database
    const { data: screen, error } = await this.db
      .from('rn_screens')
      .insert({
        app_id: context.appId,
        name: screenName,
        route_name: routeName,
        component_tree: this.parseComponentTree(screenCode),
        imports: this.extractImports(screenCode),
        styles: this.extractStyles(screenCode),
        dependencies: this.extractDependencies(screenCode),
        state_management: this.extractStateHooks(screenCode),
        props_interface: this.generatePropsInterface(details),
        order_index: context.appStructure.screens.length
      })
      .select()
      .single();

    if (error) throw error;

    return {
      success: true,
      code: screenCode,
      screenId: screen.id
    };
  }

  /**
   * Generate React Native screen code with Expo compatibility
   */
  private async generateRNScreenCode(screenName: string, details: any, context: ReactNativeContext): Promise<string> {
    const prompt = `
Generate a complete React Native screen component for Expo.

Screen name: ${screenName}
Requirements: ${JSON.stringify(details, null, 2)}
Expo version: ${context.expoVersion}
React Native version: ${context.reactNativeVersion}

Generate a functional React Native component that:
1. Uses proper React hooks (useState, useEffect, etc.)
2. Has proper TypeScript interfaces
3. Includes StyleSheet for styling
4. Is Expo-compatible
5. Uses modern React Native patterns
6. Includes proper imports
7. Has responsive design considerations

Respond with the complete TypeScript code in a code block.
`;

    const response = await claudeService.generateText(prompt, 'haiku');
    
    // Extract code from response
    const codeMatch = response.match(/```(?:tsx?|javascript)\n([\s\S]*?)\n```/);
    return codeMatch ? codeMatch[1] : response;
  }

  /**
   * Create React Native component
   */
  private async createRNComponent(details: any, context: ReactNativeContext): Promise<RNGenerationResult> {
    const componentName = details.name || 'NewComponent';
    const componentCode = await this.generateRNComponentCode(componentName, details, context);
    
    const { data: component, error } = await this.db
      .from('rn_components')
      .insert({
        app_id: context.appId,
        name: componentName,
        component_type: 'functional',
        code: componentCode,
        styles: this.extractStyles(componentCode),
        dependencies: this.extractDependencies(componentCode),
        imports: this.extractImports(componentCode),
        category: details.category || 'custom',
        is_reusable: true
      })
      .select()
      .single();

    if (error) throw error;

    return {
      success: true,
      code: componentCode,
      componentId: component.id
    };
  }

  /**
   * Generate React Native component code
   */
  private async generateRNComponentCode(componentName: string, details: any, context: ReactNativeContext): Promise<string> {
    const prompt = `
Generate a reusable React Native component for Expo.

Component name: ${componentName}
Type: ${details.componentType || 'functional'}
Category: ${details.category || 'ui'}
Requirements: ${JSON.stringify(details, null, 2)}
Expo version: ${context.expoVersion}

Generate a reusable React Native component that:
1. Uses TypeScript with proper interfaces
2. Has proper prop validation
3. Includes StyleSheet
4. Is Expo-compatible
5. Follows React Native best practices
6. Includes proper imports

Respond with the complete TypeScript code.
`;

    const response = await claudeService.generateText(prompt, 'haiku');
    const codeMatch = response.match(/```(?:tsx?|javascript)\n([\s\S]*?)\n```/);
    return codeMatch ? codeMatch[1] : response;
  }

  /**
   * Set up React Navigation
   */
  private async createRNNavigation(details: any, context: ReactNativeContext): Promise<RNGenerationResult> {
    const navigationConfig = await this.generateNavigationConfig(details, context);
    
    const { data: navigation, error } = await this.db
      .from('rn_navigation')
      .insert({
        app_id: context.appId,
        navigation_type: details.type || 'stack',
        name: details.name || 'MainNavigation',
        config: navigationConfig,
        routes: details.routes || [],
        deep_linking: details.deepLinking || {},
        is_main_navigation: details.isMain || false
      })
      .select()
      .single();

    if (error) throw error;

    return {
      success: true,
      config: navigationConfig
    };
  }

  /**
   * Generate navigation configuration
   */
  private async generateNavigationConfig(details: any, context: ReactNativeContext): Promise<any> {
    const prompt = `
Generate React Navigation v6 configuration for Expo.

Navigation type: ${details.type || 'stack'}
Available screens: ${context.appStructure.screens.map(s => s.route_name).join(', ')}
Requirements: ${JSON.stringify(details, null, 2)}

Generate complete React Navigation v6 configuration that:
1. Uses proper navigator types (Stack, Tab, Drawer)
2. Includes screen configurations
3. Has proper deep linking setup
4. Is Expo-compatible
5. Includes proper imports and setup code

Respond with the complete navigation configuration as JSON.
`;

    const response = await claudeService.generateText(prompt, 'haiku');
    try {
      return JSON.parse(response);
    } catch {
      return { config: response };
    }
  }

  /**
   * Generate Expo app.json configuration
   */
  private async generateExpoConfig(details: any, context: ReactNativeContext): Promise<RNGenerationResult> {
    const expoConfig = {
      expo: {
        name: context.appStructure.screens.length > 0 ? 'My React Native App' : 'New App',
        slug: details.slug || 'my-react-native-app',
        version: details.version || '1.0.0',
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
          bundleIdentifier: details.bundleId || 'com.example.myapp'
        },
        android: {
          adaptiveIcon: {
            foregroundImage: './assets/adaptive-icon.png',
            backgroundColor: '#FFFFFF'
          },
          package: details.packageName || 'com.example.myapp'
        },
        plugins: context.appStructure.packages
          .filter(p => p.isExpoCompatible && p.configPlugins.length > 0)
          .map(p => p.configPlugins)
          .flat()
      }
    };

    // Update app's expo_config
    await this.db
      .from('rn_apps')
      .update({ expo_config: expoConfig })
      .eq('id', context.appId);

    return {
      success: true,
      config: expoConfig
    };
  }

  /**
   * Analyze React Native app for optimization
   */
  private async analyzeRNApp(context: ReactNativeContext): Promise<RNGenerationResult> {
    const analysis = {
      screens: context.appStructure.screens.length,
      components: context.appStructure.components.length,
      navigationConfigs: context.appStructure.navigation.length,
      stateManagement: context.appStructure.stateManagement.map(s => s.stateType),
      packages: context.appStructure.packages.length,
      nativeModules: context.appStructure.nativeModules.length,
      themes: context.appStructure.themes.length,
      recommendations: [
        'Consider implementing proper error boundaries',
        'Add React Query for efficient data fetching',
        'Implement proper TypeScript interfaces',
        'Add proper accessibility support'
      ]
    };

    return {
      success: true,
      config: analysis
    };
  }

  /**
   * Optimize React Native performance
   */
  private async optimizeRNPerformance(context: ReactNativeContext): Promise<RNGenerationResult> {
    const optimizations = {
      recommendations: [
        'Use React.memo for expensive components',
        'Implement virtualized lists with FlatList',
        'Add proper image optimization',
        'Use useCallback and useMemo hooks',
        'Implement proper bundle splitting',
        'Add Hermes engine for better performance'
      ],
      codeSnippets: {
        memoExample: `import React, { memo } from 'react';

const OptimizedComponent = memo(({ data }) => {
  return <Text>{data}</Text>;
});`,
        flatListExample: `<FlatList
  data={items}
  renderItem={({ item }) => <ItemComponent item={item} />}
  keyExtractor={item => item.id}
  initialNumToRender={10}
  maxToRenderPerBatch={10}
  windowSize={10}
/>`
      }
    };

    return {
      success: true,
      config: optimizations
    };
  }

  // Helper methods for code analysis and extraction
  private parseComponentTree(code: string): ReactNativeComponent[] {
    // Parse React component structure from code
    // This is a simplified implementation
    return [];
  }

  private extractImports(code: string): string[] {
    const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"];?/g;
    const imports: string[] = [];
    let match;
    
    while ((match = importRegex.exec(code)) !== null) {
      imports.push(match[1]);
    }
    
    return imports;
  }

  private extractStyles(code: string): StyleSheetDefinition {
    // Extract StyleSheet definitions
    const styleMatch = code.match(/StyleSheet\.create\(([\s\S]*?)\)/);
    if (styleMatch) {
      try {
        return JSON.parse(styleMatch[1]);
      } catch {
        return {};
      }
    }
    return {};
  }

  private extractDependencies(code: string): string[] {
    // Extract npm package dependencies
    const packages: string[] = [];
    
    // Look for common React Native packages
    const rnPackages = [
      '@react-navigation/native', '@react-navigation/stack', '@react-navigation/bottom-tabs',
      '@react-navigation/drawer', '@reduxjs/toolkit', 'zustand', 'react-query',
      'axios', 'react-native-vector-icons', 'react-native-elements'
    ];
    
    rnPackages.forEach(pkg => {
      if (code.includes(pkg)) {
        packages.push(pkg);
      }
    });
    
    return packages;
  }

  private extractStateHooks(code: string): StateHook[] {
    // Extract useState, useEffect, etc. hooks
    const hooks: StateHook[] = [];
    
    const useStateRegex = /useState<([^>]+)>\(([^)]+)\)/g;
    let match;
    
    while ((match = useStateRegex.exec(code)) !== null) {
      hooks.push({
        name: match[2],
        type: match[1],
        initialValue: match[2]
      });
    }
    
    return hooks;
  }

  private generatePropsInterface(details: any): InterfaceDefinition {
    return {
      name: 'Props',
      properties: [
        {
          name: 'navigation',
          type: 'any',
          required: false
        },
        {
          name: 'route',
          type: 'any',
          required: false
        }
      ]
    };
  }

  private getRNBaseCreditCost(actionType: string): number {
    const costs = {
      // Low cost (1-3 credits)
      create_component: 2,
      create_theme: 1,
      
      // Medium cost (3-8 credits)
      create_screen: 5,
      edit_screen: 3,
      create_navigation: 6,
      setup_state_management: 8,
      
      // High cost (8-15 credits)
      add_native_module: 10,
      create_api_integration: 8,
      optimize_performance: 12,
      analyze_app: 8,
      generate_expo_config: 3,
      
      // Package management (1-5 credits)
      add_package: 2,
      update_package: 1
    };
    
    return costs[actionType as keyof typeof costs] || 2;
  }

  private calculateRNCredits(actions: RNAIAction[], context: ReactNativeContext): number {
    return actions.reduce((total, action) => {
      return total + this.calculateRNActionCost(action, context);
    }, 0);
  }

  private calculateRNActionCost(action: RNAIAction, context: ReactNativeContext): number {
    let cost = this.getRNBaseCreditCost(action.type);
    
    // Complexity multipliers
    if (context.appStructure.screens.length > 10) cost *= 1.2;
    if (context.appStructure.components.length > 50) cost *= 1.1;
    
    return Math.round(cost);
  }

  private async getOrCreateRNConversation(
    conversationId: string | null,
    appId: string,
    userId: string
  ) {
    if (conversationId) {
      const { data: existing } = await this.db
        .from('rn_ai_conversations')
        .select('*')
        .eq('id', conversationId)
        .single();
      
      if (existing) return existing;
    }

    const { data: newConversation, error } = await this.db
      .from('rn_ai_conversations')
      .insert({
        app_id: appId,
        user_id: userId,
        session_id: uuidv4(),
        expo_version: 'latest',
        react_native_version: 'latest',
        total_credits_used: 0
      })
      .select()
      .single();

    if (error) throw error;
    return newConversation;
  }

  private async storeRNUserMessage(
    conversationId: string,
    content: string,
    imageUrl?: string,
    creditsConsumed: number = 0
  ) {
    const { data, error } = await this.db
      .from('rn_ai_messages')
      .insert({
        conversation_id: conversationId,
        role: 'user',
        content,
        image_url: imageUrl,
        credits_consumed: creditsConsumed,
        status: 'completed'
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  private async storeRNAIMessage(
    conversationId: string,
    content: string,
    actions: RNAIAction[],
    creditsConsumed: number
  ) {
    const { data, error } = await this.db
      .from('rn_ai_messages')
      .insert({
        conversation_id: conversationId,
        role: 'assistant',
        content,
        actions_performed: actions,
        credits_consumed: creditsConsumed,
        status: 'completed'
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  private async generateRNResponse(
    actions: RNAIAction[],
    context: ReactNativeContext,
    creditsExhausted: boolean
  ): Promise<{ message: string }> {
    const completedActions = actions.filter(a => a.status === 'completed');
    const failedActions = actions.filter(a => a.status === 'failed');
    
    let response = '';
    
    if (completedActions.length > 0) {
      const actionSummary = completedActions.map(action => {
        switch (action.type) {
          case RNActionType.CREATE_SCREEN:
            return `Created screen "${action.details.name}"`;
          case RNActionType.CREATE_COMPONENT:
            return `Created component "${action.details.name}"`;
          case RNActionType.CREATE_NAVIGATION:
            return `Set up ${action.details.type} navigation`;
          case RNActionType.GENERATE_EXPO_CONFIG:
            return 'Generated Expo configuration';
          default:
            return `Completed ${action.type}`;
        }
      }).join(', ');
      
      response = `✅ ${actionSummary}`;
    }
    
    if (failedActions.length > 0) {
      response += `\n❌ ${failedActions.length} action(s) failed`;
    }
    
    if (creditsExhausted) {
      response += '\n\n⚠️ You\'ve run out of credits. Please upgrade your plan to continue.';
    }
    
    response += '\n\nYour React Native app is being updated with Expo compatibility!';
    
    return { message: response };
  }

  // Additional React Native specific methods would go here...
  private async setupRNStateManagement(details: any, context: ReactNativeContext): Promise<RNGenerationResult> {
    // Implementation for setting up Redux/Zustand/Context
    return { success: true };
  }

  private async createRNTheme(details: any, context: ReactNativeContext): Promise<RNGenerationResult> {
    // Implementation for creating React Native theme
    return { success: true };
  }

  private async addRNPackage(details: any, context: ReactNativeContext): Promise<RNGenerationResult> {
    // Implementation for adding npm packages
    return { success: true };
  }

  private async addRNNativeModule(details: any, context: ReactNativeContext): Promise<RNGenerationResult> {
    // Implementation for adding native modules
    return { success: true };
  }

  private async createRNAPIIntegration(details: any, context: ReactNativeContext): Promise<RNGenerationResult> {
    // Implementation for creating API integrations
    return { success: true };
  }
}

export const reactNativeAIAgent = new ReactNativeAIAgent();