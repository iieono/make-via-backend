export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

// User types
export interface User {
  id: string;
  email: string;
  full_name?: string;
  avatar_url?: string;
  subscription_tier: 'free' | 'pro' | 'power';
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  tier: 'free' | 'pro' | 'power';
  status: string;
  claude_usage_count: number;
  claude_usage_limit: number;
  screens_limit: number;
  apps_limit: number;
  current_period_start: string;
  current_period_end: string;
  stripe_subscription_id?: string;
}

// App types
export interface App {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  package_name?: string;
  version: string;
  status: 'draft' | 'preview' | 'published' | 'archived';
  icon_url?: string;
  primary_color: string;
  theme_mode: 'light' | 'dark' | 'system';
  config: Record<string, any>;
  metadata: Record<string, any>;
  preview_count: number;
  build_count: number;
  last_previewed_at?: string;
  last_built_at?: string;
  is_public: boolean;
  sharing_enabled: boolean;
  organization_id?: string;
  visibility: 'private' | 'organization' | 'public';
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface Screen {
  id: string;
  app_id: string;
  name: string;
  description?: string;
  screen_type: 'page' | 'modal' | 'bottom_sheet' | 'dialog';
  ai_prompt?: string;
  ai_model_used?: string;
  generation_timestamp?: string;
  ui_structure: Record<string, any>;
  styling: Record<string, any>;
  logic: Record<string, any>;
  canvas_x: number;
  canvas_y: number;
  canvas_width: number;
  canvas_height: number;
  is_start_screen: boolean;
  requires_auth: boolean;
  config: Record<string, any>;
  version: number;
  parent_screen_id?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

// Stripe types
export interface StripeSubscription {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  status: string;
  tier: 'free' | 'pro' | 'power';
  price_id: string;
  product_id: string;
  currency: string;
  amount: number;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  canceled_at?: string;
  cancellation_reason?: string;
  trial_start?: string;
  trial_end?: string;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

// AI Generation types
export interface AIGenerationRequest {
  prompt: string;
  screen_type?: 'page' | 'modal' | 'bottom_sheet' | 'dialog';
  context?: {
    app_name?: string;
    app_type?: string;
    existing_screens?: string[];
    brand_colors?: string[];
    design_style?: string;
  };
}

export interface AIGenerationResponse {
  ui_structure: Record<string, any>;
  styling: Record<string, any>;
  logic: Record<string, any>;
  metadata: {
    model_used: string;
    tokens_used: number;
    processing_time_ms: number;
    suggestions?: string[];
  };
}

export interface AIGenerationLog {
  id: string;
  user_id: string;
  app_id?: string;
  screen_id?: string;
  prompt_text: string;
  model_used: string;
  response_text?: string;
  tokens_used: number;
  processing_time_ms?: number;
  status: 'pending' | 'success' | 'failed' | 'timeout';
  error_message?: string;
  cost_usd: number;
  created_at: string;
}

// Usage tracking types
export interface UsageStats {
  claude_generations_used: number;
  claude_generations_limit: number;
  apps_created: number;
  apps_limit: number;
  screens_created: number;
  screens_limit: number;
  period_start: string;
  period_end: string;
}

// Request/Response types
export interface CreateCheckoutSessionRequest {
  priceId: string;
  userId: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CreateCheckoutSessionResponse {
  url: string;
  sessionId: string;
}

export interface GenerateUIRequest extends AIGenerationRequest {
  app_id?: string;
  screen_id?: string;
}

export interface GenerateUIResponse extends AIGenerationResponse {
  generation_id: string;
  cost_usd: number;
  remaining_generations: number;
}

// Error types
export interface ApiError extends Error {
  statusCode: number;
  code?: string;
  details?: any;
}

// Middleware types
export interface AuthenticatedRequest extends Express.Request {
  user?: User;
  subscription?: UserSubscription;
}

// Webhook types
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: any;
  };
  created: number;
}