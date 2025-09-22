import { Request } from 'express';

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
  display_email?: string;
  full_name?: string;
  avatar_url?: string;
  subscription_tier: 'free' | 'pro' | 'power';
  onboarding_completed: boolean;
  email_notifications?: boolean;
  push_notifications?: boolean;
  marketing_emails?: boolean;
  email_confirmed?: boolean;
  email_confirmed_at?: string;
  last_login_at?: string;
  last_activity?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  tier: 'free' | 'creator' | 'power';
  status: string;
  
  // Credit-based system
  available_credits: number;
  credits_used_this_period: number;
  credits_reset_date: string;
  
  // Legacy fields (deprecated but kept for compatibility)
  claude_usage_count: number;
  claude_usage_limit: number;
  
  // Resource limits
  screens_limit: number;
  apps_limit: number;
  
  // Subscription period
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
  app_icon_url?: string;
  splash_screen_url?: string;
  primary_color: string;
  accent_color: string;
  theme_mode: 'light' | 'dark' | 'system';
  target_platforms: string[];
  min_sdk_version: number;
  target_sdk_version: number;
  version_name: string;
  version_code: number;
  status: 'draft' | 'published' | 'archived' | 'building' | 'error';
  is_template: boolean;
  template_category?: string;
  tags: string[];
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
  published_at?: string;
  deleted_at?: string;
  // Legacy/compatibility fields
  version?: string;
  icon_url?: string;
  config?: Record<string, any>;
  preview_count?: number;
  build_count?: number;
  last_previewed_at?: string;
  last_built_at?: string;
  is_public?: boolean;
  sharing_enabled?: boolean;
  organization_id?: string;
  visibility?: 'private' | 'organization' | 'public';
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

// Usage tracking types - Credit-based system
export interface UsageStats {
  // Credit-based AI usage
  credits_available: number;
  credits_used: number;
  credits_limit: number;
  credits_reset_date: string;
  
  // Resource usage
  apps_created: number;
  apps_limit: number;
  screens_created: number;
  screens_limit: number;
  
  // Period information
  period_start: string;
  period_end: string;
  
  // Legacy fields (deprecated but kept for compatibility)
  claude_generations_used?: number;
  claude_generations_limit?: number;
}

// Credit transaction types
export interface CreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  transaction_type: 'subscription_renewal' | 'bonus_credits' | 'action_usage' | 'refund' | 'admin_adjustment';
  description: string;
  created_at: string;
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
export interface AuthenticatedRequest extends Request {
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

// File management types
export interface FileUpload {
  id: string;
  user_id: string;
  app_id?: string;
  original_name: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  file_hash?: string;
  storage_bucket: string;
  is_public: boolean;
  metadata: Record<string, any>;
  created_at: string;
  expires_at?: string;
  public_url?: string; // Added for compatibility, populated from metadata
}

export interface FileUploadRequest {
  app_id?: string;
  file_type: 'image' | 'icon' | 'asset' | 'other';
  metadata?: Record<string, any>;
}

// Preview system types
export interface AppPreview {
  id: string;
  app_id: string;
  user_id: string;
  preview_data: Record<string, any>;
  share_token?: string;
  share_enabled: boolean;
  expires_at?: string;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface PreviewConfiguration {
  theme: 'light' | 'dark' | 'system';
  device_type: 'mobile' | 'tablet';
  orientation: 'portrait' | 'landscape';
  show_navigation: boolean;
  show_status_bar: boolean;
}

// Push notifications types
export interface PushNotification {
  id: string;
  user_id: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  type: 'info' | 'success' | 'warning' | 'error';
  category: 'ai_generation' | 'subscription' | 'usage' | 'system' | 'marketing';
  scheduled_at?: string;
  sent_at?: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  created_at: string;
}

export interface PushToken {
  id: string;
  user_id: string;
  token: string;
  platform: 'ios' | 'android';
  device_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Build system types
export interface AppBuild {
  id: string;
  app_id: string;
  user_id: string;
  build_type: 'apk' | 'aab' | 'ios';
  status: 'pending' | 'building' | 'success' | 'failed';
  build_log?: string;
  download_url?: string;
  file_size?: number;
  expires_at?: string;
  metadata: Record<string, any>;
  started_at?: string;
  completed_at?: string;
  created_at: string;
}


// Analytics types
export interface AnalyticsEvent {
  id: string;
  user_id: string;
  app_id?: string;
  event_type: string;
  event_data: Record<string, any>;
  session_id?: string;
  device_info?: Record<string, any>;
  created_at: string;
}

export interface AppAnalytics {
  app_id: string;
  total_screens: number;
  total_previews: number;
  total_builds: number;
  ai_generations_used: number;
  last_activity: string;
  popular_screens: string[];
  user_engagement: Record<string, any>;
}

// Feedback types
export interface Feedback {
  id: string;
  user_id: string;
  app_id?: string;
  screen_id?: string;
  type: 'bug' | 'feature' | 'improvement' | 'general';
  title: string;
  description: string;
  rating?: number;
  metadata: Record<string, any>;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  created_at: string;
  updated_at: string;
}

// Deep link types
export interface DeepLink {
  id: string;
  app_id: string;
  user_id: string;
  link_type: 'app_share' | 'screen_share' | 'preview_share';
  target_id: string;
  token: string;
  expires_at?: string;
  click_count: number;
  metadata: Record<string, any>;
  created_at: string;
}