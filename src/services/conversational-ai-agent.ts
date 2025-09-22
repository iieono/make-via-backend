import { supabase } from '@/services/supabase';
import { claudeService } from '@/services/claude';
import { creditService } from '@/services/credit-service';
import { logger } from '@/utils/logger';
import type { Database } from '@/types/database';
import { v4 as uuidv4 } from 'uuid';

// Types for the conversational AI system
interface ConversationContext {
  conversationId: string;
  appId: string;
  userId: string;
  appData: {
    pages: any[];
    components: any[];
    navigation: any[];
    metadata: any;
  };
  conversationHistory: AIMessage[];
}

interface AIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
  actionsPerformed: AIAction[];
  creditsConsumed: number;
  status: 'processing' | 'completed' | 'failed';
  createdAt: Date;
}

interface AIAction {
  id: string;
  type: AIActionType;
  targetId?: string;
  details: Record<string, any>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  creditsCost: number;
  errorMessage?: string;
}

enum AIActionType {
  // Page operations (free/low cost)
  DELETE_PAGE = 'delete_page',
  RENAME_PAGE = 'rename_page',
  NAVIGATE_TO_PAGE = 'navigate_to_page',
  
  // Simple edits (low cost)
  EDIT_TEXT = 'edit_text',
  CHANGE_STYLE = 'change_style',
  ADD_SIMPLE_WIDGET = 'add_simple_widget',
  
  // Complex operations (medium cost)
  CREATE_PAGE = 'create_page',
  CREATE_COMPLEX_COMPONENT = 'create_complex_component',
  SETUP_NAVIGATION = 'setup_navigation',
  INTEGRATE_API = 'integrate_api',
  
  // Advanced operations (high cost)
  ANALYZE_APP = 'analyze_app',
  OPTIMIZE_PERFORMANCE = 'optimize_performance',
  DEBUG_COMPLEX_ISSUE = 'debug_complex_issue',
  REFACTOR_MULTIPLE_PAGES = 'refactor_multiple_pages',
}

interface AIResponse {
  success: boolean;
  message: string;
  actionsPerformed: AIAction[];
  totalCreditsUsed: number;
  conversationId: string;
  messageId: string;
  partialCompletion?: boolean;
  remainingActions?: number;
}

export class ConversationalAIAgent {
  private db = supabase;

  /**
   * Main entry point for handling user messages
   */
  async handleMessage(
    conversationId: string | null,
    userMessage: string,
    imageUrl?: string,
    appId?: string,
    userId?: string
  ): Promise<AIResponse> {
    try {
      logger.info('Processing AI message', { 
        conversationId, 
        messageLength: userMessage.length,
        hasImage: !!imageUrl 
      });

      // Get or create conversation
      const conversation = await this.getOrCreateConversation(
        conversationId, 
        appId!, 
        userId!
      );

      // Get full project context
      const context = await this.getFullProjectContext(conversation.id);

      // Analyze user message for intended actions
      const plannedActions = await this.analyzeUserMessage(
        userMessage, 
        context, 
        imageUrl
      );

      // Calculate total credits needed (including planning cost)
      const totalCredits = this.calculateCredits(plannedActions, context, userMessage, !!imageUrl);

      // Check if user has ANY credits (allow partial execution)
      const userCredits = await creditService.getUserAvailableCredits(context.userId);
      if (userCredits <= 0) {
        throw new Error(`No credits available. Please upgrade your plan or purchase more credits.`);
      }

      // Store user message
      const userMessageRecord = await this.storeUserMessage(
        conversation.id,
        userMessage,
        imageUrl,
        totalCredits
      );

      // Execute actions sequentially with credit checks before each action
      const executedActions = [];
      let totalCreditsUsed = 0;
      let creditsExhausted = false;
      
      // First, consume planning credits
      const planningCost = creditService.calculatePlanningCosts(
        plannedActions.length, 
        this.requiresAnalysis(userMessage, plannedActions), 
        !!imageUrl ? 1 : 0
      );
      
      const planningSuccess = await creditService.consumeCredits(
        context.userId, 
        planningCost, 
        `Planning for: ${userMessage.substring(0, 100)}...`
      );
      
      if (!planningSuccess) {
        throw new Error(`Insufficient credits for planning. Need ${planningCost} credits.`);
      }
      
      totalCreditsUsed += planningCost;
      
      for (const action of plannedActions) {
        try {
          // Check credits before each action
          const actionCost = creditService.calculateSmartCreditCost(
            action.type,
            {
              appSize: this.getAppSize(context),
              componentComplexity: this.getComponentComplexity(action),
              integrationCount: context.appData.components.length,
              userTier: 'free', // TODO: Get from context
            }
          );
          
          const hasCreditsForAction = await creditService.checkCredits(context.userId, actionCost);
          
          if (!hasCreditsForAction) {
            // Credits exhausted - stop execution gracefully
            creditsExhausted = true;
            logger.info('Credits exhausted during action execution', {
              userId: context.userId,
              completedActions: executedActions.length,
              remainingActions: plannedActions.length - executedActions.length,
              actionThatFailed: action.type
            });
            break;
          }
          
          // Execute the action
          const result = await this.executeAction(action, context);
          
          // Consume credits for successful action
          const consumeSuccess = await creditService.consumeCredits(
            context.userId, 
            actionCost, 
            `Action: ${action.type}`, 
            result.id
          );
          
          if (consumeSuccess) {
            totalCreditsUsed += actionCost;
            result.creditsCost = actionCost;
          }
          
          executedActions.push(result);

          // Real-time status update would go here
          // this.emitActionProgress(context.userId, action.id, result.status);
        } catch (error) {
          logger.error('Action execution failed', { actionId: action.id, error });
          executedActions.push({
            ...action,
            status: 'failed' as const,
            errorMessage: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // Generate AI response based on results and credit status
      const aiResponseText = await this.generateResponse(executedActions, context, creditsExhausted, plannedActions.length);

      // Store AI message
      const aiMessageRecord = await this.storeAIMessage(
        conversation.id,
        aiResponseText,
        executedActions,
        totalCreditsUsed
      );

      // Note: Credits are already consumed per-action above

      return {
        success: true,
        message: aiResponseText,
        actionsPerformed: executedActions,
        totalCreditsUsed: totalCreditsUsed,
        conversationId: conversation.id,
        messageId: aiMessageRecord.id,
        partialCompletion: creditsExhausted,
        remainingActions: creditsExhausted ? plannedActions.length - executedActions.length : 0
      };

    } catch (error) {
      logger.error('AI message handling failed', { error, conversationId, userId });
      throw error;
    }
  }

  /**
   * Get or create conversation thread
   */
  private async getOrCreateConversation(
    conversationId: string | null,
    appId: string,
    userId: string
  ) {
    if (conversationId) {
      const { data: existing } = await this.db
        .from('ai_conversations')
        .select('*')
        .eq('id', conversationId)
        .single();
      
      if (existing) {
        return existing;
      }
    }

    // Create new conversation
    const { data: newConversation, error } = await this.db
      .from('ai_conversations')
      .insert({
        app_id: appId,
        user_id: userId,
        total_credits_used: 0
      })
      .select()
      .single();

    if (error) throw error;
    return newConversation;
  }

  /**
   * Get complete project context for AI understanding
   */
  private async getFullProjectContext(conversationId: string): Promise<ConversationContext> {
    // Get conversation details
    const { data: conversation } = await this.db
      .from('ai_conversations')
      .select('app_id, user_id')
      .eq('id', conversationId)
      .single();

    if (!conversation) throw new Error('Conversation not found');

    // Get app data
    const [
      { data: pages },
      { data: components },
      { data: app },
      { data: messages }
    ] = await Promise.all([
      this.db.from('app_pages').select('*').eq('app_id', conversation.app_id),
      this.db.from('page_components').select('*').eq('app_id', conversation.app_id),
      this.db.from('apps').select('*').eq('id', conversation.app_id).single(),
      this.db
        .from('ai_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(20) // Last 20 messages for context
    ]);

    return {
      conversationId,
      appId: conversation.app_id,
      userId: conversation.user_id,
      appData: {
        pages: pages || [],
        components: components || [],
        navigation: [], // TODO: Get navigation data
        metadata: app
      },
      conversationHistory: messages || []
    };
  }

  /**
   * Analyze user message to determine intended actions
   */
  private async analyzeUserMessage(
    message: string,
    context: ConversationContext,
    imageUrl?: string
  ): Promise<AIAction[]> {
    // Build context for Claude
    const claudeContext = {
      message,
      imageUrl,
      appStructure: {
        totalPages: context.appData.pages.length,
        pageNames: context.appData.pages.map(p => p.name),
        totalComponents: context.appData.components.length,
        recentConversation: context.conversationHistory.slice(-5)
      }
    };

    const prompt = `
You are an AI agent for a mobile app builder. Analyze this user message and determine what actions need to be performed.

Current app structure:
- Pages: ${claudeContext.appStructure.pageNames.join(', ')}
- Total components: ${claudeContext.appStructure.totalComponents}

User message: "${message}"

Based on this message, determine what actions are needed. Respond with a JSON array of actions.

Available action types:
- delete_page, rename_page, navigate_to_page (0 credits)
- edit_text, change_style, add_simple_widget (1-2 credits)
- create_page, create_complex_component, setup_navigation (3-5 credits)
- analyze_app, optimize_performance, debug_complex_issue (8-15 credits)

Example response:
[
  {
    "type": "create_page",
    "details": {
      "name": "Login Page",
      "description": "Create a login page with email and password fields"
    }
  }
]
    `;

    try {
      const response = await claudeService.generateText(prompt, 'haiku');
      const actions = JSON.parse(response);
      
      // Convert to internal action format
      return actions.map((action: any) => ({
        id: uuidv4(),
        type: action.type,
        details: action.details || {},
        status: 'pending' as const,
        creditsCost: this.getBaseCreditCost(action.type)
      }));
    } catch (error) {
      logger.error('Failed to analyze user message', { error, message });
      
      // Fallback: create a generic action
      return [{
        id: uuidv4(),
        type: AIActionType.EDIT_TEXT,
        details: { operation: 'generic_edit', message },
        status: 'pending',
        creditsCost: 1
      }];
    }
  }

  /**
   * Calculate total credits needed for actions including planning cost
   */
  private calculateCredits(
    actions: AIAction[], 
    context: ConversationContext, 
    userMessage: string, 
    hasImage: boolean
  ): number {
    // Calculate planning cost based on complexity
    const stepCount = actions.length;
    const hasAnalysis = this.requiresAnalysis(userMessage, actions);
    const imageCount = hasImage ? 1 : 0;
    
    const planningCost = creditService.calculatePlanningCosts(stepCount, hasAnalysis, imageCount);
    
    // Calculate action execution costs using credit service pricing
    const executionCost = actions.reduce((total, action) => {
      // Get user's subscription tier for smart pricing
      const userTier = 'free'; // TODO: Get from context
      const smartCost = creditService.calculateSmartCreditCost(
        action.type,
        {
          appSize: this.getAppSize(context),
          componentComplexity: this.getComponentComplexity(action),
          integrationCount: context.appData.components.length,
          userTier: userTier as 'free' | 'creator' | 'power',
        }
      );
      return total + smartCost;
    }, 0);
    
    const totalCost = planningCost + executionCost;
    
    logger.info('Credit calculation breakdown', {
      planningCost,
      executionCost,
      totalCost,
      stepCount,
      hasAnalysis,
      imageCount,
      actionTypes: actions.map(a => a.type)
    });
    
    return totalCost;
  }

  /**
   * Get base credit cost for action type
   */
  private getBaseCreditCost(actionType: string): number {
    const costs = {
      // Free operations
      delete_page: 0,
      rename_page: 0,
      navigate_to_page: 0,
      
      // Low cost operations (1-2 credits)
      edit_text: 1,
      change_style: 1,
      add_simple_widget: 2,
      
      // Medium cost operations (3-5 credits)
      create_page: 3,
      create_complex_component: 4,
      setup_navigation: 3,
      integrate_api: 5,
      
      // High cost operations (8-15 credits)
      analyze_app: 8,
      optimize_performance: 12,
      debug_complex_issue: 10,
      refactor_multiple_pages: 15,
    };
    
    return costs[actionType as keyof typeof costs] || 1;
  }

  /**
   * Analyze complexity for dynamic pricing
   */
  private analyzeComplexity(action: AIAction, context: ConversationContext): number {
    let multiplier = 1.0;
    
    // App size factor
    if (context.appData.pages.length > 10) multiplier *= 1.2;
    if (context.appData.components.length > 50) multiplier *= 1.1;
    
    // Action complexity factor
    if (action.details?.complexity === 'high') multiplier *= 1.5;
    if (action.details?.multiStep === true) multiplier *= 1.3;
    
    return Math.max(0.5, Math.min(3.0, multiplier));
  }

  /**
   * Determine if the request requires analysis
   */
  private requiresAnalysis(userMessage: string, actions: AIAction[]): boolean {
    const analysisKeywords = [
      'analyze', 'review', 'check', 'audit', 'examine', 'assess',
      'evaluate', 'optimize', 'improve', 'suggest', 'recommend'
    ];
    
    const hasAnalysisKeywords = analysisKeywords.some(keyword => 
      userMessage.toLowerCase().includes(keyword)
    );
    
    const hasAnalysisActions = actions.some(action => 
      action.type.includes('analyze') || action.type.includes('optimize') || action.type.includes('debug')
    );
    
    return hasAnalysisKeywords || hasAnalysisActions;
  }

  /**
   * Determine app size category for smart pricing
   */
  private getAppSize(context: ConversationContext): 'small' | 'medium' | 'large' {
    const pageCount = context.appData.pages.length;
    const componentCount = context.appData.components.length;
    
    if (pageCount <= 3 && componentCount <= 10) return 'small';
    if (pageCount <= 8 && componentCount <= 30) return 'medium';
    return 'large';
  }

  /**
   * Determine component complexity for smart pricing
   */
  private getComponentComplexity(action: AIAction): 'simple' | 'moderate' | 'complex' {
    const complexActionTypes = [
      'create_complex_component', 'integrate_api', 'setup_navigation',
      'optimize_performance', 'debug_complex_issue', 'refactor_multiple_pages'
    ];
    
    const moderateActionTypes = [
      'create_page', 'add_complex_widget', 'setup_form'
    ];
    
    if (complexActionTypes.some(type => action.type.includes(type))) return 'complex';
    if (moderateActionTypes.some(type => action.type.includes(type))) return 'moderate';
    return 'simple';
  }

  /**
   * Check if user has enough credits
   */
  private async checkUserCredits(userId: string, requiredCredits: number): Promise<boolean> {
    return await creditService.checkCredits(userId, requiredCredits);
  }

  /**
   * Execute a specific action with real-time progress updates
   */
  private async executeAction(action: AIAction, context: ConversationContext): Promise<AIAction> {
    // Get real-time service if available
    const realTimeService = (global as any).realTimeService;
    
    // Store action in database first
    const { data: actionRecord } = await this.db
      .from('ai_actions')
      .insert({
        message_id: null, // Will be updated when we store the message
        app_id: context.appId,
        action_type: action.type,
        target_id: action.targetId,
        details: action.details,
        status: 'in_progress',
        credits_cost: action.creditsCost
      })
      .select()
      .single();

    // Emit real-time progress update
    if (realTimeService) {
      realTimeService.emitActionProgress(context.userId, {
        actionId: actionRecord!.id,
        status: 'in_progress',
        progress: 0,
        message: `Starting ${action.type}...`,
        timestamp: Date.now()
      });
    }

    try {
      let result: any;
      
      // Emit progress update
      if (realTimeService) {
        realTimeService.emitActionProgress(context.userId, {
          actionId: actionRecord!.id,
          status: 'in_progress',
          progress: 25,
          message: `Executing ${action.type}...`,
          timestamp: Date.now()
        });
      }
      
      switch (action.type) {
        case AIActionType.CREATE_PAGE:
          result = await this.executeCreatePage(action.details, context);
          break;
          
        case AIActionType.EDIT_TEXT:
          result = await this.executeEditText(action.details, context);
          break;
          
        case AIActionType.DELETE_PAGE:
          result = await this.executeDeletePage(action.details, context);
          break;
          
        // Add more action handlers...
        default:
          result = { success: false, message: `Action ${action.type} not implemented yet` };
      }

      // Update action status
      await this.db
        .from('ai_actions')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', actionRecord!.id);

      // Emit completion update
      if (realTimeService) {
        realTimeService.emitActionProgress(context.userId, {
          actionId: actionRecord!.id,
          status: 'completed',
          progress: 100,
          message: `Completed ${action.type}`,
          timestamp: Date.now()
        });
      }

      return {
        ...action,
        id: actionRecord!.id,
        status: 'completed'
      };
      
    } catch (error) {
      // Update action with error
      await this.db
        .from('ai_actions')
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error'
        })
        .eq('id', actionRecord!.id);

      // Emit failure update
      if (realTimeService) {
        realTimeService.emitActionProgress(context.userId, {
          actionId: actionRecord!.id,
          status: 'failed',
          progress: 0,
          message: `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: Date.now()
        });
      }

      throw error;
    }
  }

  /**
   * Execute page creation
   */
  private async executeCreatePage(details: any, context: ConversationContext) {
    const { data: newPage, error } = await this.db
      .from('app_pages')
      .insert({
        app_id: context.appId,
        name: details.name || 'New Page',
        slug: (details.name || 'new-page').toLowerCase().replace(/\s+/g, '-'),
        page_type: 'screen',
        content: details.content || { components: [] },
        position_x: Math.random() * 400,
        position_y: Math.random() * 300
      })
      .select()
      .single();

    if (error) throw error;
    return { success: true, pageId: newPage.id, message: `Created page "${details.name}"` };
  }

  /**
   * Execute text editing
   */
  private async executeEditText(details: any, context: ConversationContext) {
    // Implementation for text editing
    return { success: true, message: `Text edited: ${details.operation}` };
  }

  /**
   * Execute page deletion
   */
  private async executeDeletePage(details: any, context: ConversationContext) {
    if (!details.pageId) {
      throw new Error('Page ID required for deletion');
    }

    const { error } = await this.db
      .from('app_pages')
      .delete()
      .eq('id', details.pageId)
      .eq('app_id', context.appId);

    if (error) throw error;
    return { success: true, message: `Page deleted successfully` };
  }

  /**
   * Generate AI response based on executed actions and credit status
   */
  private async generateResponse(
    actions: AIAction[], 
    context: ConversationContext,
    creditsExhausted: boolean = false,
    totalPlannedActions: number = 0
  ): Promise<string> {
    const completedActions = actions.filter(a => a.status === 'completed');
    const failedActions = actions.filter(a => a.status === 'failed');
    
    if (completedActions.length === 0 && failedActions.length > 0) {
      return `I encountered some issues: ${failedActions.map(a => a.errorMessage).join(', ')}`;
    }
    
    const successSummary = completedActions.map(action => {
      switch (action.type) {
        case AIActionType.CREATE_PAGE:
          return `Created page "${action.details.name}"`;
        case AIActionType.EDIT_TEXT:
          return `Updated text content`;
        case AIActionType.DELETE_PAGE:
          return `Deleted page`;
        default:
          return `Completed ${action.type}`;
      }
    }).join(', ');
    
    let response = '';
    
    if (creditsExhausted) {
      // Partial completion due to credits exhaustion (like Claude Code)
      const remainingActions = totalPlannedActions - actions.length;
      response = `I've completed ${completedActions.length} action(s): ${successSummary}. `;
      response += `However, you've run out of credits and I couldn't complete ${remainingActions} remaining action(s). `;
      response += `Please upgrade your plan or purchase more credits to continue with the remaining tasks.`;
    } else if (completedActions.length > 0) {
      response = `Done! ${successSummary}.`;
    }
    
    if (failedActions.length > 0) {
      response += ` Note: ${failedActions.length} action(s) had issues.`;
    }
    
    return response;
  }

  /**
   * Store user message
   */
  private async storeUserMessage(
    conversationId: string,
    content: string,
    imageUrl?: string,
    creditsConsumed: number = 0
  ) {
    const { data, error } = await this.db
      .from('ai_messages')
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

  /**
   * Store AI response message
   */
  private async storeAIMessage(
    conversationId: string,
    content: string,
    actions: AIAction[],
    creditsConsumed: number
  ) {
    const { data, error } = await this.db
      .from('ai_messages')
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

  /**
   * Consume credits from user account
   */
  private async consumeUserCredits(
    userId: string,
    amount: number,
    actions: AIAction[]
  ) {
    if (amount <= 0) return;

    const description = `AI actions: ${actions.map(a => a.type).join(', ')}`;
    const success = await creditService.consumeCredits(userId, amount, description);

    if (!success) {
      throw new Error('Failed to consume credits - insufficient balance');
    }
  }

  /**
   * Get conversation history
   */
  async getConversationHistory(conversationId: string): Promise<AIMessage[]> {
    const { data, error } = await this.db
      .from('ai_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Get user's available credits
   */
  async getUserCredits(userId: string): Promise<number> {
    return await creditService.getUserAvailableCredits(userId);
  }
}

export const conversationalAIAgent = new ConversationalAIAgent();