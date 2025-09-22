/**
 * Enhanced Claude Service with Token Tracking
 * Integrates Claude API calls with comprehensive token usage tracking
 */

import { Anthropic } from '@anthropic-ai/sdk';
import { tokenTrackingService, TokenTrackingData } from './tokenTrackingService';
import { logger } from '@/utils/logger';
import { rateLimiter } from '@/middleware/rateLimiter';

export interface ClaudeRequest {
  prompt: string;
  model?: 'haiku' | 'sonnet' | 'opus';
  maxTokens?: number;
  temperature?: number;
  userId: string;
  generationId?: string;
  subscriptionTier?: string;
  ipAddress?: string;
}

export interface ClaudeResponse {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  requestId: string;
  model: string;
  stopReason?: string;
  cost: {
    inputCost: number;
    outputCost: number;
    totalCost: number;
  };
  duration: number;
}

class ClaudeService {
  private client: Anthropic;
  private readonly MODEL_MAPPING = {
    haiku: 'claude-3-haiku-20240307',
    sonnet: 'claude-3-5-sonnet-20241022', 
    opus: 'claude-3-opus-20240229'
  };

  private readonly CHARACTER_LIMITS = {
    free: 500,
    pro: 700,
    power: 1200
  };

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Validate prompt character limit based on subscription tier
   */
  private validatePromptLength(prompt: string, subscriptionTier: string = 'free'): boolean {
    const limit = this.CHARACTER_LIMITS[subscriptionTier as keyof typeof this.CHARACTER_LIMITS] || 500;
    return prompt.length <= limit;
  }

  /**
   * Get character limit for subscription tier
   */
  getCharacterLimit(subscriptionTier: string = 'free'): number {
    return this.CHARACTER_LIMITS[subscriptionTier as keyof typeof this.CHARACTER_LIMITS] || 500;
  }

  /**
   * Check if user can make AI requests (rate limiting + usage limits)
   */
  async canMakeRequest(userId: string, ipAddress?: string): Promise<{
    allowed: boolean;
    reason?: string;
    remainingRequests?: number;
    resetTime?: Date;
  }> {
    try {
      // Check usage limits first
      const usageLimits = await tokenTrackingService.checkUsageLimits(userId);
      if (!usageLimits.withinLimits) {
        return {
          allowed: false,
          reason: `Monthly limit exceeded. Used ${usageLimits.usage}/${usageLimits.limit} requests.`,
          remainingRequests: 0
        };
      }

      // Check rate limits
      const rateLimitKey = `claude_requests:${userId}`;
      const rateLimitResult = await rateLimiter.checkLimit(rateLimitKey, {
        windowMs: 60 * 1000, // 1 minute window
        maxRequests: 10, // Max 10 requests per minute per user
      });

      if (!rateLimitResult.allowed) {
        return {
          allowed: false,
          reason: 'Rate limit exceeded. Please wait before making another request.',
          resetTime: new Date(Date.now() + rateLimitResult.resetTime)
        };
      }

      return {
        allowed: true,
        remainingRequests: usageLimits.remaining
      };

    } catch (error) {
      logger.error('Error checking request permissions:', error);
      // If we can't check limits, err on the side of caution but allow the request
      return { allowed: true };
    }
  }

  /**
   * Generate content using Claude API with comprehensive tracking
   */
  async generateContent(request: ClaudeRequest): Promise<ClaudeResponse | null> {
    const startTime = Date.now();
    let claudeRequestId: string | undefined;
    
    try {
      // Validate subscription tier access to model
      if (!this.canUseModel(request.model || 'haiku', request.subscriptionTier || 'free')) {
        throw new Error(`Model ${request.model} not available for ${request.subscriptionTier} tier`);
      }

      // Validate prompt length
      if (!this.validatePromptLength(request.prompt, request.subscriptionTier)) {
        const limit = this.getCharacterLimit(request.subscriptionTier || 'free');
        throw new Error(`Prompt exceeds ${limit} character limit for ${request.subscriptionTier} tier`);
      }

      // Check if user can make request
      const canMakeRequest = await this.canMakeRequest(request.userId, request.ipAddress);
      if (!canMakeRequest.allowed) {
        throw new Error(canMakeRequest.reason || 'Request not allowed');
      }

      // Prepare Claude API request
      const modelName = this.MODEL_MAPPING[request.model || 'haiku'];
      const maxTokens = request.maxTokens || 4096;
      const temperature = request.temperature || 0.7;

      logger.info(`Making Claude API request for user ${request.userId} with model ${request.model}`);

      // Make Claude API request
      const response = await this.client.messages.create({
        model: modelName,
        max_tokens: maxTokens,
        temperature,
        messages: [{
          role: 'user',
          content: request.prompt
        }]
      });

      claudeRequestId = response.id;
      const duration = Date.now() - startTime;

      // Extract usage information
      const usage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens
      };

      // Calculate cost
      const cost = await tokenTrackingService.calculateCost(request.model || 'haiku', usage);
      if (!cost) {
        logger.error('Failed to calculate cost for request');
        throw new Error('Cost calculation failed');
      }

      // Extract response content
      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as any).text)
        .join('\n');

      // Log token usage
      const trackingData: TokenTrackingData = {
        userId: request.userId,
        generationId: request.generationId,
        promptText: request.prompt,
        modelUsed: request.model || 'haiku',
        usage,
        requestDurationMs: duration,
        claudeRequestId,
        subscriptionTier: request.subscriptionTier || 'free',
        ipAddress: request.ipAddress,
        status: 'completed',
        responseMetadata: {
          stop_reason: response.stop_reason,
          stop_sequence: response.stop_sequence,
          model: response.model
        }
      };

      await tokenTrackingService.logTokenUsage(trackingData);

      // Return formatted response
      return {
        content,
        usage,
        requestId: claudeRequestId,
        model: request.model || 'haiku',
        stopReason: response.stop_reason,
        cost,
        duration
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error('Claude API request failed:', {
        userId: request.userId,
        error: error.message,
        duration,
        model: request.model
      });

      // Log failed request
      const trackingData: TokenTrackingData = {
        userId: request.userId,
        generationId: request.generationId,
        promptText: request.prompt,
        modelUsed: request.model || 'haiku',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        requestDurationMs: duration,
        claudeRequestId,
        subscriptionTier: request.subscriptionTier || 'free',
        ipAddress: request.ipAddress,
        status: 'failed',
        errorMessage: error.message
      };

      await tokenTrackingService.logTokenUsage(trackingData);

      return null;
    }
  }

  /**
   * Check if user's subscription tier allows access to specific model
   */
  private canUseModel(model: string, subscriptionTier: string): boolean {
    const modelAccess = {
      free: ['haiku'],
      pro: ['haiku', 'sonnet'],
      power: ['haiku', 'sonnet', 'opus']
    };

    const allowedModels = modelAccess[subscriptionTier as keyof typeof modelAccess] || ['haiku'];
    return allowedModels.includes(model);
  }

  /**
   * Get available models for subscription tier
   */
  getAvailableModels(subscriptionTier: string = 'free'): string[] {
    const modelAccess = {
      free: ['haiku'],
      pro: ['haiku', 'sonnet'], 
      power: ['haiku', 'sonnet', 'opus']
    };

    return modelAccess[subscriptionTier as keyof typeof modelAccess] || ['haiku'];
  }

  /**
   * Get user's usage summary
   */
  async getUserUsage(userId: string) {
    return await tokenTrackingService.getUserMonthlyUsage(userId);
  }

  /**
   * Stream content generation (for real-time responses)
   */
  async streamContent(request: ClaudeRequest, onChunk: (chunk: string) => void): Promise<ClaudeResponse | null> {
    const startTime = Date.now();
    let claudeRequestId: string | undefined;
    let fullContent = '';
    
    try {
      // Same validation as generateContent
      if (!this.canUseModel(request.model || 'haiku', request.subscriptionTier || 'free')) {
        throw new Error(`Model ${request.model} not available for ${request.subscriptionTier} tier`);
      }

      if (!this.validatePromptLength(request.prompt, request.subscriptionTier)) {
        const limit = this.getCharacterLimit(request.subscriptionTier || 'free');
        throw new Error(`Prompt exceeds ${limit} character limit for ${request.subscriptionTier} tier`);
      }

      const canMakeRequest = await this.canMakeRequest(request.userId, request.ipAddress);
      if (!canMakeRequest.allowed) {
        throw new Error(canMakeRequest.reason || 'Request not allowed');
      }

      const modelName = this.MODEL_MAPPING[request.model || 'haiku'];

      logger.info(`Making streaming Claude API request for user ${request.userId}`);

      // Create streaming request
      const stream = await this.client.messages.create({
        model: modelName,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature || 0.7,
        messages: [{
          role: 'user',
          content: request.prompt
        }],
        stream: true
      });

      // Process stream
      let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      
      for await (const chunk of stream) {
        if (chunk.type === 'message_start') {
          claudeRequestId = chunk.message.id;
          usage.input_tokens = chunk.message.usage.input_tokens;
        } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          const text = chunk.delta.text;
          fullContent += text;
          onChunk(text);
        } else if (chunk.type === 'message_delta') {
          usage.output_tokens = chunk.usage.output_tokens;
          usage.total_tokens = usage.input_tokens + usage.output_tokens;
        }
      }

      const duration = Date.now() - startTime;

      // Calculate cost and log usage (same as generateContent)
      const cost = await tokenTrackingService.calculateCost(request.model || 'haiku', usage);
      if (!cost) {
        throw new Error('Cost calculation failed');
      }

      const trackingData: TokenTrackingData = {
        userId: request.userId,
        generationId: request.generationId,
        promptText: request.prompt,
        modelUsed: request.model || 'haiku',
        usage,
        requestDurationMs: duration,
        claudeRequestId,
        subscriptionTier: request.subscriptionTier || 'free',
        ipAddress: request.ipAddress,
        status: 'completed'
      };

      await tokenTrackingService.logTokenUsage(trackingData);

      return {
        content: fullContent,
        usage,
        requestId: claudeRequestId || '',
        model: request.model || 'haiku',
        cost,
        duration
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error('Streaming Claude API request failed:', {
        userId: request.userId,
        error: error.message,
        duration
      });

      // Log failed request
      await tokenTrackingService.logTokenUsage({
        userId: request.userId,
        generationId: request.generationId,
        promptText: request.prompt,
        modelUsed: request.model || 'haiku',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        requestDurationMs: duration,
        claudeRequestId,
        subscriptionTier: request.subscriptionTier || 'free',
        ipAddress: request.ipAddress,
        status: 'failed',
        errorMessage: error.message
      });

      return null;
    }
  }
}

export const claudeService = new ClaudeService();
export default claudeService;