import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import AIContextService from './ai-context-service';
import type { 
  AppConfig, 
  AppPage, 
  PageComponent,
  AIContextType,
  ContextualPrompt
} from '@/types/app-development';

interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  context: AIContextType;
  metadata?: Record<string, any>;
}

interface CanvasAIResponse {
  message: string;
  actions?: AIAction[];
  generatedElements?: GeneratedElement[];
  metadata: {
    processingTime: number;
    contextUsed: string[];
    confidenceScore: number;
  };
}

interface AIAction {
  id: string;
  type: 'create_page' | 'connect_pages' | 'update_navigation' | 'open_editor';
  label: string;
  data: Record<string, any>;
}

interface GeneratedElement {
  type: 'page' | 'connection' | 'navigation';
  data: Record<string, any>;
}

/**
 * Canvas AI Agent - Global app-level AI assistant
 * Provides intelligent app structure creation and modification capabilities
 */
export class CanvasAIAgent extends AIContextService {
  private conversationHistory: Map<string, ConversationMessage[]> = new Map();
  private readonly MAX_CONVERSATION_LENGTH = 50;

  /**
   * Process canvas-level AI request with full app context
   */
  async processCanvasRequest(
    appId: string,
    userId: string,
    prompt: string,
    conversationId?: string
  ): Promise<CanvasAIResponse> {
    const startTime = Date.now();
    
    try {
      logger.info('Processing canvas AI request', { 
        appId, 
        userId, 
        promptLength: prompt.length,
        conversationId 
      });

      // Get comprehensive app context
      const appContext = await this.getEnhancedAppContext(appId);
      
      // Get conversation history
      const history = await this.getConversationHistory(appId, conversationId);
      
      // Build enhanced contextual prompt
      const contextualPrompt = await this.buildEnhancedCanvasPrompt(
        appContext,
        history,
        prompt
      );
      
      // Process with Claude AI
      const aiResponse = await this.callClaudeWithContext(contextualPrompt);
      
      // Parse AI response for actions and elements
      const parsedResponse = this.parseAIResponse(aiResponse, appContext);
      
      // Store conversation message
      await this.storeConversationMessage(appId, conversationId, {
        role: 'user',
        content: prompt,
        context: 'app_level',
        timestamp: new Date()
      });
      
      await this.storeConversationMessage(appId, conversationId, {
        role: 'assistant',
        content: parsedResponse.message,
        context: 'app_level',
        timestamp: new Date(),
        metadata: parsedResponse.metadata
      });
      
      // Log AI interaction
      await this.logAIInteraction(appId, userId, 'app_level', prompt, parsedResponse.message);
      
      const processingTime = Date.now() - startTime;
      
      return {
        ...parsedResponse,
        metadata: {
          ...parsedResponse.metadata,
          processingTime
        }
      };
      
    } catch (error) {
      logger.error('Canvas AI request failed', { error, appId, userId });
      throw error;
    }
  }

  /**
   * Get enhanced app context with conversation awareness
   */
  private async getEnhancedAppContext(appId: string): Promise<EnhancedAppContext> {
    const baseContext = await this.getAppContext(appId);
    
    // Get additional context for Canvas AI
    const [userFlow, designPatterns, recentChanges] = await Promise.all([
      this.analyzeUserFlow(appId),
      this.analyzeDesignPatterns(baseContext),
      this.getRecentAppChanges(appId, 10)
    ]);
    
    return {
      ...baseContext,
      userFlow,
      designPatterns,
      recentChanges,
      aiCapabilities: this.getAICapabilities(),
      contextGenerated: new Date()
    };
  }

  /**
   * Build enhanced contextual prompt for Canvas AI
   */
  private async buildEnhancedCanvasPrompt(
    context: EnhancedAppContext,
    history: ConversationMessage[],
    userPrompt: string
  ): Promise<ContextualPrompt> {
    const { app, all_pages, all_components } = context;
    
    const systemPrompt = `You are a Canvas AI Assistant for MakeVia, an AI-powered app builder. You have COMPLETE VISIBILITY into the entire app structure and can make app-level changes.

**CURRENT APP CONTEXT:**
- App: "${app.name}" (${app.app_type})
- Package: ${app.package_name}
- Status: ${app.status}
- Theme: ${app.primary_color} / ${app.accent_color}
- Platforms: ${app.target_platforms.join(', ')}

**APP STRUCTURE OVERVIEW:**
- Pages: ${all_pages.length} total
${all_pages.map(page => 
  `  • ${page.name} (${page.page_type}${page.page_subtype ? ` - ${page.page_subtype}` : ''})`
).join('\n')}

- Components: ${all_components.length} total across all pages
- Navigation: ${this.describeNavigationFlow(all_pages, context.userFlow)}

**RECENT USER ACTIVITY:**
${context.recentChanges.map(change => 
  `- ${change.action_type}: ${change.action_description} (${this.formatRelativeTime(change.created_at)})`
).join('\n')}

**CONVERSATION HISTORY:**
${history.slice(-10).map(msg => 
  `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
).join('\n')}

**YOUR CAPABILITIES:**
You can help users with:
1. **App Structure Creation**: "Create a social media app" → Generate complete page structure with login, feed, profile, settings
2. **Page Management**: Add/remove pages, set up page types, configure page relationships
3. **Navigation Design**: Connect pages with logical navigation flows, set up tab bars, drawers, bottom navigation
4. **App Architecture**: Suggest app structure improvements, design patterns, user experience flows
5. **Integration Planning**: Recommend features like authentication, payments, social features based on app type

**RESPONSE FORMAT:**
Always respond with:
1. Clear explanation of what you understand/will do
2. Specific actions you're taking (if any)
3. Suggestions for next steps

**AVAILABLE ACTIONS:**
- create_page: Create new pages with specified type and properties
- connect_pages: Establish navigation connections between pages
- update_navigation: Modify app navigation structure
- open_editor: Direct user to page editor for detailed component work

**CURRENT REQUEST CONTEXT:**
User is working in Canvas mode (app-level view) where they can see and modify the entire app structure.`;

    return {
      context_type: 'app_level',
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      context_data: {
        app_structure: {
          pages: all_pages.length,
          components: all_components.length,
          navigation_complexity: context.userFlow.complexity
        },
        conversation_length: history.length,
        recent_activity: context.recentChanges.length
      },
      app_id: appId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Parse AI response and extract actionable elements
   */
  private parseAIResponse(aiResponse: string, context: EnhancedAppContext): CanvasAIResponse {
    const actions: AIAction[] = [];
    const generatedElements: GeneratedElement[] = [];
    
    // Parse for page creation requests
    const pageCreationMatches = aiResponse.match(/create[_\s]page[:\s]*([^\.]+)/gi);
    if (pageCreationMatches) {
      pageCreationMatches.forEach((match, index) => {
        const pageDetails = this.extractPageDetails(match);
        actions.push({
          id: `create_page_${index}`,
          type: 'create_page',
          label: `Create ${pageDetails.name}`,
          data: pageDetails
        });
        
        generatedElements.push({
          type: 'page',
          data: pageDetails
        });
      });
    }
    
    // Parse for navigation connections
    const connectionMatches = aiResponse.match(/connect[_\s]([^\s]+)[_\s]to[_\s]([^\s]+)/gi);
    if (connectionMatches) {
      connectionMatches.forEach((match, index) => {
        const connectionDetails = this.extractConnectionDetails(match);
        actions.push({
          id: `connect_pages_${index}`,
          type: 'connect_pages',
          label: `Connect ${connectionDetails.from} to ${connectionDetails.to}`,
          data: connectionDetails
        });
      });
    }
    
    // Calculate confidence score based on context match
    const confidenceScore = this.calculateConfidenceScore(aiResponse, context);
    
    return {
      message: aiResponse,
      actions: actions.length > 0 ? actions : undefined,
      generatedElements: generatedElements.length > 0 ? generatedElements : undefined,
      metadata: {
        processingTime: 0, // Will be set by caller
        contextUsed: ['app_structure', 'conversation_history', 'recent_activity'],
        confidenceScore
      }
    };
  }

  /**
   * Get conversation history for app
   */
  private async getConversationHistory(
    appId: string, 
    conversationId?: string
  ): Promise<ConversationMessage[]> {
    const cacheKey = `conversation_${appId}_${conversationId || 'default'}`;
    
    if (this.conversationHistory.has(cacheKey)) {
      return this.conversationHistory.get(cacheKey)!;
    }
    
    // Load from database
    const { data: messages } = await supabase.serviceClient
      .from('ai_conversations')
      .select('*')
      .eq('app_id', appId)
      .eq('conversation_id', conversationId || 'default')
      .order('created_at', { ascending: true })
      .limit(this.MAX_CONVERSATION_LENGTH);
    
    const history: ConversationMessage[] = (messages || []).map(msg => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: new Date(msg.created_at),
      context: msg.context_type,
      metadata: msg.metadata
    }));
    
    this.conversationHistory.set(cacheKey, history);
    return history;
  }

  /**
   * Store conversation message
   */
  private async storeConversationMessage(
    appId: string,
    conversationId: string | undefined,
    message: Omit<ConversationMessage, 'id'>
  ): Promise<void> {
    const messageData = {
      app_id: appId,
      conversation_id: conversationId || 'default',
      role: message.role,
      content: message.content,
      context_type: message.context,
      metadata: message.metadata,
      created_at: message.timestamp.toISOString()
    };
    
    await supabase.serviceClient
      .from('ai_conversations')
      .insert(messageData);
    
    // Update cache
    const cacheKey = `conversation_${appId}_${conversationId || 'default'}`;
    const history = this.conversationHistory.get(cacheKey) || [];
    history.push({ ...message, id: Date.now().toString() });
    
    // Trim history if too long
    if (history.length > this.MAX_CONVERSATION_LENGTH) {
      history.splice(0, history.length - this.MAX_CONVERSATION_LENGTH);
    }
    
    this.conversationHistory.set(cacheKey, history);
  }

  /**
   * Analyze user flow patterns
   */
  private async analyzeUserFlow(appId: string): Promise<UserFlowAnalysis> {
    const { data: pages } = await supabase.serviceClient
      .from('app_pages')
      .select(`
        *,
        page_connections!inner(*)
      `)
      .eq('app_id', appId);
    
    if (!pages) {
      return { complexity: 'simple', patterns: [], entryPoints: [], exitPoints: [] };
    }
    
    // Analyze navigation patterns
    const connections = pages.flatMap(p => p.page_connections || []);
    const entryPoints = pages.filter(p => p.is_home_page || p.page_type === 'splash').map(p => p.name);
    const exitPoints = pages.filter(p => p.page_type === 'settings' || p.name.includes('logout')).map(p => p.name);
    
    const complexity = connections.length > pages.length ? 'complex' : 
                      connections.length > pages.length * 0.5 ? 'moderate' : 'simple';
    
    return {
      complexity,
      patterns: this.identifyNavigationPatterns(pages, connections),
      entryPoints,
      exitPoints
    };
  }

  /**
   * Analyze design patterns in app
   */
  private analyzeDesignPatterns(context: any): DesignPatternAnalysis {
    const { app, all_pages } = context;
    
    const patterns: string[] = [];
    
    // Detect common patterns
    if (all_pages.some((p: any) => p.page_type === 'auth')) patterns.push('authentication_flow');
    if (all_pages.some((p: any) => p.page_type === 'onboarding')) patterns.push('onboarding_sequence');
    if (all_pages.some((p: any) => p.page_type === 'settings')) patterns.push('settings_hierarchy');
    if (all_pages.some((p: any) => p.page_type === 'profile')) patterns.push('user_profile');
    
    // Detect app type patterns
    const appTypePatterns = this.getAppTypePatterns(app.app_type);
    patterns.push(...appTypePatterns);
    
    return {
      detectedPatterns: patterns,
      recommendations: this.getPatternRecommendations(patterns, all_pages.length),
      completeness: this.assessPatternCompleteness(patterns, app.app_type)
    };
  }

  /**
   * Get recent app changes
   */
  private async getRecentAppChanges(appId: string, limit: number): Promise<AppChange[]> {
    const { data: changes } = await supabase.serviceClient
      .from('app_activity_log')
      .select('*')
      .eq('app_id', appId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    return (changes || []).map(change => ({
      action_type: change.action_type,
      action_description: change.action_description,
      created_at: change.created_at,
      user_id: change.user_id
    }));
  }

  // Helper methods
  private describeNavigationFlow(pages: AppPage[], userFlow: UserFlowAnalysis): string {
    const homePages = pages.filter(p => p.is_home_page);
    const authPages = pages.filter(p => p.page_type === 'auth');
    
    if (homePages.length === 0) return 'No home page set';
    if (authPages.length === 0) return 'No authentication flow';
    
    return `${userFlow.complexity} navigation with ${userFlow.entryPoints.length} entry points`;
  }

  private formatRelativeTime(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffHours < 1) return 'just now';
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
  }

  private extractPageDetails(match: string): any {
    // Simple extraction - would be more sophisticated in production
    return {
      name: 'New Page',
      type: 'screen',
      displayName: 'New Page'
    };
  }

  private extractConnectionDetails(match: string): any {
    return {
      from: 'page1',
      to: 'page2'
    };
  }

  private calculateConfidenceScore(response: string, context: EnhancedAppContext): number {
    // Simple confidence calculation based on context relevance
    let score = 0.5;
    
    if (response.includes(context.app.name)) score += 0.1;
    if (response.includes('page')) score += 0.1;
    if (response.includes('navigation')) score += 0.1;
    if (response.length > 100) score += 0.1;
    
    return Math.min(score, 1.0);
  }

  private identifyNavigationPatterns(pages: any[], connections: any[]): string[] {
    const patterns = [];
    
    if (connections.some(c => c.connection_type === 'tab')) patterns.push('tabbed_navigation');
    if (connections.some(c => c.connection_type === 'drawer')) patterns.push('drawer_navigation');
    if (connections.some(c => c.connection_type === 'modal')) patterns.push('modal_dialogs');
    
    return patterns;
  }

  private getAppTypePatterns(appType: string): string[] {
    const patternMap: Record<string, string[]> = {
      'social': ['user_profiles', 'content_feeds', 'social_sharing'],
      'ecommerce': ['product_catalog', 'shopping_cart', 'checkout_flow'],
      'business': ['dashboard', 'reports', 'user_management'],
      'utility': ['quick_actions', 'settings', 'minimal_navigation']
    };
    
    return patternMap[appType] || [];
  }

  private getPatternRecommendations(patterns: string[], pageCount: number): string[] {
    const recommendations = [];
    
    if (!patterns.includes('authentication_flow') && pageCount > 3) {
      recommendations.push('Consider adding user authentication');
    }
    
    if (!patterns.includes('settings_hierarchy') && pageCount > 5) {
      recommendations.push('Add settings page for user preferences');
    }
    
    return recommendations;
  }

  private assessPatternCompleteness(patterns: string[], appType: string): number {
    const requiredPatterns = this.getAppTypePatterns(appType);
    const matchCount = patterns.filter(p => requiredPatterns.includes(p)).length;
    
    return requiredPatterns.length > 0 ? matchCount / requiredPatterns.length : 1.0;
  }

  private getAICapabilities(): string[] {
    return [
      'app_structure_creation',
      'page_management',
      'navigation_design',
      'pattern_recognition',
      'user_flow_analysis'
    ];
  }

  private async callClaudeWithContext(prompt: ContextualPrompt): Promise<string> {
    // This would integrate with the actual Claude API
    // For now, return a simulated response
    return `I understand you want to work on "${prompt.user_prompt}". Based on your app context, I can help you structure this effectively.`;
  }
}

// Type definitions
interface EnhancedAppContext {
  app: AppConfig;
  all_pages: AppPage[];
  all_components: PageComponent[];
  recent_activity: any[];
  dependencies: any[];
  template?: any;
  userFlow: UserFlowAnalysis;
  designPatterns: DesignPatternAnalysis;
  recentChanges: AppChange[];
  aiCapabilities: string[];
  contextGenerated: Date;
}

interface UserFlowAnalysis {
  complexity: 'simple' | 'moderate' | 'complex';
  patterns: string[];
  entryPoints: string[];
  exitPoints: string[];
}

interface DesignPatternAnalysis {
  detectedPatterns: string[];
  recommendations: string[];
  completeness: number;
}

interface AppChange {
  action_type: string;
  action_description: string;
  created_at: string;
  user_id: string;
}

export default CanvasAIAgent;