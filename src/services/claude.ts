import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import type { 
  AIGenerationRequest, 
  AIGenerationResponse, 
  GenerateUIRequest,
  GenerateUIResponse,
  UserSubscription 
} from '@/types';

class ClaudeService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: config.claude.apiKey,
    });
  }

  async generateUI(
    userId: string,
    request: GenerateUIRequest & { preferred_model?: string }
  ): Promise<GenerateUIResponse> {
    const startTime = Date.now();
    let generationId: string | undefined;

    try {
      // Check user subscription and usage limits
      const subscription = await supabase.getUserSubscription(userId);
      if (!subscription) {
        throw new Error('User subscription not found');
      }

      // Check if user can make AI generations
      const canGenerate = await supabase.incrementClaudeUsage(userId);
      if (!canGenerate) {
        throw new Error('AI generation limit exceeded for current billing period');
      }

      // Get the appropriate model for user's tier and preference
      const model = this.getModelForTier(subscription.tier, request.preferred_model);

      // Create the prompt for UI generation
      const prompt = this.createUIPrompt(request);

      // Log the generation attempt
      await supabase.logAIGeneration({
        user_id: userId,
        app_id: request.app_id,
        screen_id: request.screen_id,
        prompt_text: request.prompt,
        model_used: model,
        status: 'pending',
        tokens_used: 0,
        cost_usd: 0,
      });

      // Call Claude API
      const response = await this.anthropic.messages.create({
        model: model,
        max_tokens: 4000,
        temperature: 0.3,
        system: this.getSystemPrompt(),
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const processingTime = Date.now() - startTime;
      const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
      const cost = this.calculateCost(model, tokensUsed);

      // Parse the response
      const generatedContent = response.content[0];
      if (generatedContent.type !== 'text') {
        throw new Error('Unexpected response format from Claude');
      }

      const aiResponse = this.parseClaudeResponse(generatedContent.text);

      // Update the log with success
      await supabase.logAIGeneration({
        user_id: userId,
        app_id: request.app_id,
        screen_id: request.screen_id,
        prompt_text: request.prompt,
        model_used: model,
        response_text: generatedContent.text,
        tokens_used: tokensUsed,
        processing_time_ms: processingTime,
        status: 'success',
        cost_usd: cost,
      });

      // Get updated subscription to return remaining generations
      const updatedSubscription = await supabase.getUserSubscription(userId);
      const remainingGenerations = updatedSubscription 
        ? (updatedSubscription.claude_usage_limit - updatedSubscription.claude_usage_count)
        : 0;

      logger.info(`Generated UI for user ${userId}, tokens: ${tokensUsed}, cost: $${cost}`);

      return {
        ...aiResponse,
        generation_id: generationId || 'unknown',
        cost_usd: cost,
        remaining_generations: remainingGenerations,
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      // Log the failed generation
      await supabase.logAIGeneration({
        user_id: userId,
        app_id: request.app_id,
        screen_id: request.screen_id,
        prompt_text: request.prompt,
        model_used: this.getModelForTier('free'), // Default model for error case
        tokens_used: 0,
        processing_time_ms: processingTime,
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
        cost_usd: 0,
      });

      logger.error('Error generating UI:', error);
      throw error;
    }
  }

  private getModelForTier(tier: string, preferredModel?: string): string {
    const availableModels = this.getAvailableModelsForTier(tier);
    
    // If user specified a preferred model and it's available for their tier, use it
    if (preferredModel && availableModels.includes(preferredModel)) {
      return preferredModel;
    }
    
    // Otherwise, use the default model for their tier
    switch (tier) {
      case 'power':
        return config.claude.models.power; // Opus by default, but can use any
      case 'pro':
        return config.claude.models.pro; // Sonnet by default, but can use Haiku too
      case 'free':
      default:
        return config.claude.models.free; // Haiku only
    }
  }

  private getAvailableModelsForTier(tier: string): string[] {
    switch (tier) {
      case 'power':
        // Power users can use all models
        return [
          config.claude.models.free,    // Haiku
          config.claude.models.pro,     // Sonnet
          config.claude.models.power,   // Opus
        ];
      case 'pro':
        // Pro users can use Haiku and Sonnet
        return [
          config.claude.models.free,    // Haiku
          config.claude.models.pro,     // Sonnet
        ];
      case 'free':
      default:
        // Free users can only use Haiku
        return [config.claude.models.free];
    }
  }

  private getSystemPrompt(): string {
    return `You are an expert Flutter UI designer and developer. Your job is to generate Flutter widget code and styling based on user descriptions.

IMPORTANT RULES:
1. Generate ONLY valid Flutter/Dart code
2. Use Material Design 3 components and patterns
3. Follow Flutter best practices and conventions
4. Include proper responsive design considerations
5. Generate complete, working widget structures
6. Include appropriate styling and theming
7. Use meaningful variable names and proper formatting
8. Consider accessibility and user experience

RESPONSE FORMAT:
Respond with a JSON object containing exactly these fields:
- "ui_structure": Flutter widget tree as a JSON structure
- "styling": Styling information (colors, fonts, spacing, etc.)
- "logic": State management and interaction logic
- "metadata": Additional information about the generated UI

Make sure your response is valid JSON that can be parsed programmatically.`;
  }

  private createUIPrompt(request: GenerateUIRequest): string {
    let prompt = `Generate a Flutter UI for: "${request.prompt}"`;

    if (request.screen_type) {
      prompt += `\nScreen type: ${request.screen_type}`;
    }

    if (request.context) {
      const { app_name, app_type, existing_screens, brand_colors, design_style } = request.context;
      
      if (app_name) prompt += `\nApp name: ${app_name}`;
      if (app_type) prompt += `\nApp type: ${app_type}`;
      if (design_style) prompt += `\nDesign style: ${design_style}`;
      if (brand_colors?.length) prompt += `\nBrand colors: ${brand_colors.join(', ')}`;
      if (existing_screens?.length) {
        prompt += `\nExisting screens: ${existing_screens.join(', ')}`;
      }
    }

    prompt += `\n\nGenerate a complete, functional Flutter UI that matches the description. Include proper widget structure, styling, and basic interaction logic.`;

    return prompt;
  }

  private parseClaudeResponse(responseText: string): AIGenerationResponse {
    try {
      // Try to extract JSON from the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in Claude response');
      }

      const parsedResponse = JSON.parse(jsonMatch[0]);
      
      // Validate required fields
      if (!parsedResponse.ui_structure || !parsedResponse.styling || !parsedResponse.logic) {
        throw new Error('Missing required fields in Claude response');
      }

      return {
        ui_structure: parsedResponse.ui_structure,
        styling: parsedResponse.styling,
        logic: parsedResponse.logic,
        metadata: {
          model_used: parsedResponse.metadata?.model_used || 'claude-3-haiku',
          tokens_used: parsedResponse.metadata?.tokens_used || 0,
          processing_time_ms: parsedResponse.metadata?.processing_time_ms || 0,
          suggestions: parsedResponse.metadata?.suggestions || [],
        },
      };
    } catch (error) {
      logger.error('Error parsing Claude response:', error);
      
      // Return a fallback response structure
      return {
        ui_structure: {
          type: 'Container',
          child: {
            type: 'Text',
            data: 'Error generating UI. Please try again.',
          },
        },
        styling: {
          backgroundColor: '#f5f5f5',
          textColor: '#333333',
        },
        logic: {
          state: {},
          actions: {},
        },
        metadata: {
          model_used: 'claude-3-haiku',
          tokens_used: 0,
          processing_time_ms: 0,
          suggestions: ['Try a more specific prompt', 'Check your internet connection'],
        },
      };
    }
  }

  private calculateCost(model: string, tokens: number): number {
    // Claude API pricing (approximate, update with actual rates)
    const pricing = {
      'claude-3-haiku-20240307': {
        input: 0.25 / 1000000,  // $0.25 per million input tokens
        output: 1.25 / 1000000, // $1.25 per million output tokens
      },
      'claude-3-sonnet-20240229': {
        input: 3.0 / 1000000,   // $3.00 per million input tokens
        output: 15.0 / 1000000, // $15.00 per million output tokens
      },
      'claude-3-opus-20240229': {
        input: 15.0 / 1000000,  // $15.00 per million input tokens
        output: 75.0 / 1000000, // $75.00 per million output tokens
      },
    };

    const modelPricing = pricing[model as keyof typeof pricing];
    if (!modelPricing) {
      return 0; // Unknown model, return 0 cost
    }

    // Approximate 80% input, 20% output tokens
    const inputTokens = Math.floor(tokens * 0.8);
    const outputTokens = Math.floor(tokens * 0.2);

    return (inputTokens * modelPricing.input) + (outputTokens * modelPricing.output);
  }

  // Utility method to check if a user can make AI generations
  async canUserGenerate(userId: string): Promise<{ canGenerate: boolean; remainingGenerations: number }> {
    try {
      const subscription = await supabase.getUserSubscription(userId);
      if (!subscription) {
        return { canGenerate: false, remainingGenerations: 0 };
      }

      const remainingGenerations = subscription.claude_usage_limit - subscription.claude_usage_count;
      return {
        canGenerate: remainingGenerations > 0,
        remainingGenerations: Math.max(0, remainingGenerations),
      };
    } catch (error) {
      logger.error('Error checking user generation ability:', error);
      return { canGenerate: false, remainingGenerations: 0 };
    }
  }

  // Method to get user's AI generation history
  async getUserGenerationHistory(userId: string, limit = 50): Promise<any[]> {
    try {
      // This would typically query the ai_generation_logs table
      // Implementation depends on your Supabase service methods
      return [];
    } catch (error) {
      logger.error('Error fetching user generation history:', error);
      throw error;
    }
  }

  // Get available models for user's subscription tier
  async getAvailableModelsForUser(userId: string): Promise<{
    available_models: Array<{
      id: string;
      name: string;
      description: string;
      speed: 'fast' | 'medium' | 'slow';
      quality: 'good' | 'better' | 'best';
      cost_multiplier: number;
    }>;
    default_model: string;
  }> {
    try {
      const subscription = await supabase.getUserSubscription(userId);
      const tier = subscription?.tier || 'free';
      const availableModelIds = this.getAvailableModelsForTier(tier);
      
      const modelInfo = {
        [config.claude.models.free]: {
          id: config.claude.models.free,
          name: 'Haiku',
          description: 'Fast and efficient model, great for simple UI components',
          speed: 'fast' as const,
          quality: 'good' as const,
          cost_multiplier: 1,
        },
        [config.claude.models.pro]: {
          id: config.claude.models.pro,
          name: 'Sonnet',
          description: 'Balanced model with good quality and reasonable speed',
          speed: 'medium' as const,
          quality: 'better' as const,
          cost_multiplier: 15, // 15x more expensive than Haiku
        },
        [config.claude.models.power]: {
          id: config.claude.models.power,
          name: 'Opus',
          description: 'Highest quality model for complex and sophisticated UIs',
          speed: 'slow' as const,
          quality: 'best' as const,
          cost_multiplier: 75, // 75x more expensive than Haiku
        },
      };

      const availableModels = availableModelIds.map(modelId => modelInfo[modelId]);
      const defaultModel = this.getModelForTier(tier);

      return {
        available_models: availableModels,
        default_model: defaultModel,
      };
    } catch (error) {
      logger.error('Error getting available models for user:', error);
      throw error;
    }
  }
}

export const claudeService = new ClaudeService();