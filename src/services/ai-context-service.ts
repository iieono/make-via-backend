import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import type { 
  AppConfig, 
  AppPage, 
  PageComponent, 
  AppContext,
  ContextualPrompt,
  AIContextType
} from '@/types/app-development';

export class AIContextService {

  /**
   * Generate contextual prompt for AI based on current focus
   */
  async generateContextualPrompt(
    appId: string,
    contextType: AIContextType,
    focusEntityId?: string,
    userPrompt?: string
  ): Promise<ContextualPrompt> {
    try {
      // Get full app context
      const appContext = await this.getAppContext(appId);
      
      // Generate context-specific prompt based on focus
      const contextualPrompt = await this.buildContextualPrompt(
        appContext,
        contextType,
        focusEntityId,
        userPrompt
      );

      return contextualPrompt;
    } catch (error) {
      logger.error('Error generating contextual prompt:', error);
      throw error;
    }
  }

  /**
   * Get comprehensive app context
   */
  private async getAppContext(appId: string): Promise<AppContext> {
    // Get app data
    const { data: app } = await supabase.serviceClient
      .from('apps')
      .select('*')
      .eq('id', appId)
      .single();

    if (!app) {
      throw new Error('App not found');
    }

    // Get all pages
    const { data: pages } = await supabase.serviceClient
      .from('app_pages')
      .select('*')
      .eq('app_id', appId)
      .order('created_at');

    // Get all components with page information
    const { data: components } = await supabase.serviceClient
      .from('page_components')
      .select(`
        *,
        app_pages!inner(id, name, title, page_type)
      `)
      .eq('app_pages.app_id', appId);

    // Get recent activity
    const { data: activity } = await supabase.serviceClient
      .from('app_activity_log')
      .select('*')
      .eq('app_id', appId)
      .order('created_at', { ascending: false })
      .limit(10);

    // Get dependencies
    const { data: dependencies } = await supabase.serviceClient
      .from('app_dependencies')
      .select('*')
      .eq('app_id', appId)
      .eq('is_active', true);

    return {
      app: app as AppConfig,
      all_pages: pages || [],
      all_components: components || [],
      recent_activity: activity || [],
      dependencies: dependencies || [],
    };
  }

  /**
   * Build contextual prompt based on focus type
   */
  private async buildContextualPrompt(
    appContext: AppContext,
    contextType: AIContextType,
    focusEntityId?: string,
    userPrompt?: string
  ): Promise<ContextualPrompt> {
    let systemPrompt = '';
    let contextData: any = {};

    switch (contextType) {
      case 'app_level':
        ({ systemPrompt, contextData } = this.buildAppLevelContext(appContext, userPrompt));
        break;
      
      case 'page_focus':
        ({ systemPrompt, contextData } = await this.buildPageFocusContext(appContext, focusEntityId, userPrompt));
        break;
      
      case 'component_focus':
        ({ systemPrompt, contextData } = await this.buildComponentFocusContext(appContext, focusEntityId, userPrompt));
        break;
      
      case 'design_assistance':
        ({ systemPrompt, contextData } = this.buildDesignAssistanceContext(appContext, userPrompt));
        break;
      
      case 'code_generation':
        ({ systemPrompt, contextData } = this.buildCodeGenerationContext(appContext, focusEntityId, userPrompt));
        break;
      
      default:
        ({ systemPrompt, contextData } = this.buildGenericContext(appContext, userPrompt));
    }

    return {
      context_type: contextType,
      system_prompt: systemPrompt,
      user_prompt: userPrompt || '',
      context_data: contextData,
      app_id: appContext.app.id,
      focused_entity_id: focusEntityId,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Build app-level context prompt
   */
  private buildAppLevelContext(appContext: AppContext, userPrompt?: string): { systemPrompt: string; contextData: any } {
    const { app, all_pages, all_components } = appContext;
    
    const systemPrompt = `You are an AI assistant helping with app development in MakeVia, a visual Flutter app builder.

**Current App Context:**
- App Name: ${app.name}
- Description: ${app.description || 'No description'}
- Package: ${app.package_name}
- Type: ${app.app_type}
- Status: ${app.status}
- Theme: Primary color ${app.primary_color}, Accent color ${app.accent_color}
- Target Platforms: ${app.target_platforms.join(', ')}
- Pages: ${all_pages.length} total (${all_pages.map(p => p.name).join(', ')})
- Components: ${all_components.length} total across all pages

**App Configuration:**
- Flutter Version: ${app.flutter_version}
- Dart Version: ${app.dart_version}
- Min SDK: ${app.min_sdk_version}, Target SDK: ${app.target_sdk_version}
- Capabilities: ${Object.entries(app.capabilities).filter(([,enabled]) => enabled).map(([cap]) => cap).join(', ')}

**Recent Activity:**
${appContext.recent_activity.slice(0, 5).map(activity => 
  `- ${activity.action_type}: ${activity.action_description}`
).join('\n')}

You should provide contextual advice about:
- App architecture and structure
- Design patterns and best practices
- Feature recommendations based on app type
- Technical considerations for the target platforms
- User experience improvements

Keep responses focused, actionable, and specific to Flutter/mobile development.`;

    const contextData = {
      app_summary: {
        name: app.name,
        type: app.app_type,
        pages_count: all_pages.length,
        components_count: all_components.length,
        status: app.status,
      },
      recent_changes: appContext.recent_activity.slice(0, 5),
    };

    return { systemPrompt, contextData };
  }

  /**
   * Build page-focused context prompt
   */
  private async buildPageFocusContext(appContext: AppContext, pageId?: string, userPrompt?: string): Promise<{ systemPrompt: string; contextData: any }> {
    const { app, all_pages, all_components } = appContext;
    
    const focusedPage = pageId ? all_pages.find(p => p.id === pageId) : null;
    const pageComponents = focusedPage ? all_components.filter(c => c.app_pages.id === focusedPage.id) : [];
    
    const currentPageInfo = focusedPage ? `
**Currently Focused Page: ${focusedPage.name}**
- Title: ${focusedPage.title}
- Type: ${focusedPage.page_type}${focusedPage.page_subtype ? ` (${focusedPage.page_subtype})` : ''}
- Route: ${focusedPage.route_path}
- Auth Required: ${focusedPage.is_auth_required ? 'Yes' : 'No'}
- Components: ${pageComponents.length} total
- Description: ${focusedPage.description || 'No description'}

**Page Components:**
${pageComponents.map(c => 
  `- ${c.component_name} (${c.component_type}) at (${c.position_x}, ${c.position_y})`
).join('\n')}` : 'No specific page focused';

    const systemPrompt = `You are an AI assistant helping with page design in MakeVia, a visual Flutter app builder.

**App Context:**
- App: ${app.name} (${app.app_type})
- Total Pages: ${all_pages.map(p => `${p.name} (${p.page_type})`).join(', ')}

${currentPageInfo}

**Other Pages for Reference:**
${all_pages.filter(p => p.id !== pageId).map(p => 
  `- ${p.name} (${p.page_type}) - ${all_components.filter(c => c.app_pages.id === p.id).length} components`
).join('\n')}

You should provide contextual advice about:
- Page layout and component positioning
- UI/UX best practices for the page type
- Navigation flow between pages
- Component suggestions for the current page
- Accessibility considerations
- Mobile-specific design patterns

Focus on the currently selected page when providing specific recommendations.`;

    const contextData = {
      focused_page: focusedPage,
      page_components: pageComponents,
      related_pages: all_pages.filter(p => p.id !== pageId),
    };

    return { systemPrompt, contextData };
  }

  /**
   * Build component-focused context prompt
   */
  private async buildComponentFocusContext(appContext: AppContext, componentId?: string, userPrompt?: string): Promise<{ systemPrompt: string; contextData: any }> {
    const { app, all_pages, all_components } = appContext;
    
    const focusedComponent = componentId ? all_components.find(c => c.id === componentId) : null;
    const componentPage = focusedComponent ? all_pages.find(p => p.id === focusedComponent.app_pages.id) : null;
    const siblingComponents = componentPage ? all_components.filter(c => 
      c.app_pages.id === componentPage.id && c.id !== componentId
    ) : [];

    const currentComponentInfo = focusedComponent ? `
**Currently Focused Component: ${focusedComponent.component_name}**
- Type: ${focusedComponent.component_type}
- Flutter Widget: ${focusedComponent.flutter_widget_name}
- Position: (${focusedComponent.position_x}, ${focusedComponent.position_y})
- Size: ${focusedComponent.width}x${focusedComponent.height}
- Z-Index: ${focusedComponent.z_index}
- Page: ${componentPage?.name} (${componentPage?.page_type})

**Component Properties:**
${Object.entries(focusedComponent.properties || {}).map(([key, value]) => 
  `- ${key}: ${JSON.stringify(value)}`
).join('\n')}

**Sibling Components on Same Page:**
${siblingComponents.map(c => 
  `- ${c.component_name} (${c.component_type}) at (${c.position_x}, ${c.position_y})`
).join('\n')}` : 'No specific component focused';

    const systemPrompt = `You are an AI assistant helping with component design in MakeVia, a visual Flutter app builder.

**App Context:**
- App: ${app.name} (${app.app_type})
- Current Page: ${componentPage?.name || 'Unknown'} (${componentPage?.page_type || 'Unknown'})

${currentComponentInfo}

**Available Widget Types:**
- Text: For displaying text content
- ElevatedButton: For primary actions
- TextField: For user input
- Container: For layout and styling
- Image: For displaying images
- ListView: For scrollable lists
- Column/Row: For layout arrangement

You should provide contextual advice about:
- Component-specific properties and styling
- Positioning and sizing recommendations
- Interactions with sibling components
- Accessibility features for the component type
- Flutter widget best practices
- Animation and state management

Focus on the currently selected component when providing specific recommendations.`;

    const contextData = {
      focused_component: focusedComponent,
      component_page: componentPage,
      sibling_components: siblingComponents,
    };

    return { systemPrompt, contextData };
  }

  /**
   * Build design assistance context prompt
   */
  private buildDesignAssistanceContext(appContext: AppContext, userPrompt?: string): { systemPrompt: string; contextData: any } {
    const { app, all_pages, all_components } = appContext;
    
    const systemPrompt = `You are a UI/UX design expert helping with visual app design in MakeVia.

**App Design Context:**
- App: ${app.name} (${app.app_type})
- Design System: Primary ${app.primary_color}, Accent ${app.accent_color}
- Theme Mode: ${app.theme_mode}
- Target: ${app.target_platforms.join(', ')} platforms

**Current App Structure:**
- Pages: ${all_pages.length} (${all_pages.map(p => `${p.name}(${p.page_type})`).join(', ')})
- Total Components: ${all_components.length}
- Home Page: ${all_pages.find(p => p.is_home_page)?.name || 'None set'}

**Design Patterns for Mobile Apps:**
${this.getDesignPatternsForAppType('custom')}

You should provide advice about:
- Visual hierarchy and layout principles
- Color scheme and typography recommendations
- Component composition and spacing
- Mobile design patterns and conventions
- Accessibility and usability guidelines
- Brand consistency across pages

Provide specific, actionable design recommendations.`;

    const contextData = {
      design_system: {
        primary_color: app.primary_color,
        accent_color: app.accent_color,
        theme_mode: app.theme_mode,
      },
      app_structure: {
        pages: all_pages.map(p => ({ name: p.name, type: p.page_type })),
        component_distribution: this.getComponentDistribution(all_pages, all_components),
      },
    };

    return { systemPrompt, contextData };
  }

  /**
   * Build code generation context prompt
   */
  private buildCodeGenerationContext(appContext: AppContext, focusEntityId?: string, userPrompt?: string): { systemPrompt: string; contextData: any } {
    const { app, all_pages, all_components } = appContext;
    
    const systemPrompt = `You are a Flutter development expert helping with code generation in MakeVia.

**App Technical Context:**
- App: ${app.name}
- Package: ${app.package_name}
- Flutter: ${app.flutter_version}, Dart: ${app.dart_version}
- SDK: Min ${app.min_sdk_version}, Target ${app.target_sdk_version}
- Dependencies: ${appContext.dependencies.length} active

**Code Generation Scope:**
- Pages: ${all_pages.length} total
- Components: ${all_components.length} total
- Capabilities: ${Object.entries(app.capabilities).filter(([,enabled]) => enabled).map(([cap]) => cap).join(', ')}

**Architecture Patterns:**
- Using BLoC pattern for state management
- Material Design 3 components
- Responsive design for multiple screen sizes
- Clean architecture with separation of concerns

You should help with:
- Flutter widget code generation
- State management implementation
- Navigation setup between pages
- API integration patterns
- Error handling and validation
- Performance optimization

Generate clean, production-ready Flutter code following best practices.`;

    const contextData = {
      technical_config: {
        package_name: app.package_name,
        flutter_version: app.flutter_version,
        dart_version: app.dart_version,
        capabilities: app.capabilities,
      },
      structure: {
        pages: all_pages,
        components: all_components,
        dependencies: appContext.dependencies,
      },
    };

    return { systemPrompt, contextData };
  }

  /**
   * Build generic context prompt
   */
  private buildGenericContext(appContext: AppContext, userPrompt?: string): { systemPrompt: string; contextData: any } {
    const { app } = appContext;
    
    const systemPrompt = `You are an AI assistant helping with app development in MakeVia, a visual Flutter app builder.

**Current App:** ${app.name} (${app.app_type})

You can help with:
- App design and user experience
- Flutter development questions
- Mobile app best practices
- Feature implementation guidance
- Technical architecture advice

Please ask me to focus on a specific page or component for more targeted assistance.`;

    const contextData = {
      app_basic_info: {
        name: app.name,
        type: app.app_type,
        status: app.status,
      },
    };

    return { systemPrompt, contextData };
  }

  /**
   * Get design patterns for app type
   */
  private getDesignPatternsForAppType(appType: string): string {
    const patterns: Record<string, string> = {
      'social': `
- Feed/timeline layouts with cards
- Profile pages with user information
- Navigation tabs for main sections
- Floating action button for posts
- Pull-to-refresh interactions`,
      
      'ecommerce': `
- Product grid/list layouts
- Shopping cart with item management
- Checkout flow with progress indicators
- Search and filter functionality
- Product detail pages with images`,
      
      'business': `
- Dashboard with key metrics
- Data visualization components
- Form layouts for data entry
- Navigation drawer for menu
- Professional color schemes`,
      
      'utility': `
- Clean, functional interfaces
- Quick action buttons
- Settings and configuration pages
- Minimal navigation structure
- Focus on core functionality`,
      
      'default': `
- Standard Material Design patterns
- Consistent navigation structure
- Proper use of color and typography
- Mobile-first responsive design
- Accessible component layouts`
    };

    return patterns[appType] || patterns['default'];
  }

  /**
   * Get component distribution across pages
   */
  private getComponentDistribution(pages: AppPage[], components: PageComponent[]): Record<string, number> {
    return pages.reduce((acc, page) => {
      const pageComponents = components.filter(c => c.app_pages.id === page.id);
      acc[page.name] = pageComponents.length;
      return acc;
    }, {} as Record<string, number>);
  }

  /**
   * Log AI interaction for analytics
   */
  async logAIInteraction(
    appId: string,
    userId: string,
    contextType: AIContextType,
    userPrompt: string,
    response: string,
    focusEntityId?: string
  ): Promise<void> {
    try {
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'ai_interaction',
          action_description: `AI assistance: ${contextType} - ${userPrompt.substring(0, 100)}...`,
          affected_entity: focusEntityId,
          after_state: {
            context_type: contextType,
            prompt_length: userPrompt.length,
            response_length: response.length,
          },
        });
    } catch (error) {
      logger.error('Error logging AI interaction:', error);
    }
  }
}

export default AIContextService;