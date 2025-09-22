/**
 * TypeScript types for the comprehensive app development platform
 */

// App Development Enums
export type AppStatus = 'draft' | 'development' | 'testing' | 'building' | 'published' | 'archived';
export type PageType = 'screen' | 'splash' | 'loading' | 'auth' | 'onboarding' | 'error' | 'settings' | 'profile' | 'home' | 'detail' | 'list' | 'form' | 'modal' | 'drawer';
export type PageSubtype = 'login' | 'register' | 'forgot_password' | 'profile_edit' | 'user_settings' | 'privacy_settings' | 'notification_settings' | 'about' | 'help' | 'terms' | 'privacy_policy';
export type ComponentCategory = 'layout' | 'input' | 'display' | 'navigation' | 'media' | 'data' | 'action' | 'feedback';
export type BuildType = 'apk' | 'aab' | 'source_code' | 'ipa';
export type BuildStatus = 'queued' | 'building' | 'completed' | 'failed' | 'cancelled';
export type BuildMode = 'debug' | 'release';
export type TargetPlatform = 'android-arm' | 'android-arm64' | 'android-x64';
export type DependencyType = 'production' | 'dev' | 'test';
export type SyncStatus = 'pending' | 'syncing' | 'completed' | 'failed';
export type CollaboratorRole = 'viewer' | 'editor' | 'admin' | 'owner';
export type DifficultyLevel = 'beginner' | 'intermediate' | 'advanced';

// NEW: Enhanced collaboration types
export type PresenceStatus = 'viewing' | 'editing' | 'idle' | 'away';
export type PageConnectionType = 'navigation' | 'tab_group' | 'modal_parent' | 'flow_sequence' | 'shared_component';
export type AIModel = 'claude-3-haiku' | 'claude-3-sonnet' | 'claude-3-opus' | 'claude-3-5-haiku' | 'claude-3-5-sonnet' | 'claude-3-5-opus' | 'claude-4';
export type GenerationStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'canceled' | 'queued' | 'timeout';

// Enhanced App Configuration
export interface AppConfig {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  package_name?: string;
  app_icon_url?: string;
  splash_screen_url?: string;
  primary_color: string;
  accent_color: string;
  theme_mode: string;
  target_platforms: string[];
  min_sdk_version: number;
  target_sdk_version: number;
  version_name: string;
  version_code: number;
  status: AppStatus;
  tags: string[];
  metadata: Record<string, any>;
  
  // Enhanced configuration
  flutter_version: string;
  dart_version: string;
  environment_variables: Record<string, string>;
  build_config: BuildConfiguration;
  capabilities: AppCapabilities;
  permissions: AppPermissions;
  assets: AppAssets;
  app_store_config: AppStoreConfig;
  github_integration: GitHubIntegration;
  export_settings: ExportSettings;
  
  created_at: string;
  updated_at: string;
  published_at?: string;
}

export interface BuildConfiguration {
  android: {
    compileSdkVersion: number;
    targetSdkVersion: number;
    minSdkVersion: number;
    obfuscate: boolean;
    shrinkResources: boolean;
  };
  ios: {
    deploymentTarget: string;
    enableBitcode: boolean;
  };
}

export interface AppCapabilities {
  camera: boolean;
  location: boolean;
  push_notifications: boolean;
  biometric_auth: boolean;
  file_access: boolean;
  network_access: boolean;
  phone_calls: boolean;
  contacts: boolean;
  calendar: boolean;
  photos: boolean;
}

export interface AppPermissions {
  android: string[];
  ios: string[];
}

export interface AppAssets {
  fonts: string[];
  images: string[];
  icons: string[];
  sounds: string[];
  videos: string[];
}

export interface AppStoreConfig {
  category: string;
  keywords: string[];
  short_description: string;
  full_description: string;
  age_rating: string;
  privacy_policy_url: string;
  support_url: string;
  marketing_url: string;
}

export interface GitHubIntegration {
  enabled: boolean;
  auto_sync: boolean;
  branch: string;
}

export interface ExportSettings {
  apk: {
    enabled: boolean;
    optimize: boolean;
    obfuscate: boolean;
  };
  aab: {
    enabled: boolean;
    optimize: boolean;
  };
  signing: {
    auto_sign: boolean;
  };
}

// Enhanced Page Configuration
export interface AppPage {
  id: string;
  app_id: string;
  name: string;
  title: string;
  description?: string;
  route_path: string;
  page_type: PageType;
  page_subtype?: PageSubtype;
  is_home_page: boolean;
  is_auth_required: boolean;
  background_color?: string;
  background_image_url?: string;
  app_bar_config: AppBarConfig;
  navigation_config: NavigationConfig;
  permissions_required: string[];
  metadata: Record<string, any>;
  
  // Enhanced page features
  duration_ms?: number;
  animations: PageAnimations;
  lifecycle_hooks: LifecycleHooks;
  conditional_logic: ConditionalLogic;
  data_sources: DataSources;
  state_management: StateManagement;
  seo_config: SEOConfig;
  accessibility_config: AccessibilityConfig;
  
  created_at: string;
  updated_at: string;
}

export interface AppBarConfig {
  show: boolean;
  title: string;
  backgroundColor: string;
  elevation: number;
  actions: any[];
}

export interface NavigationConfig {
  showBottomNav: boolean;
  showDrawer: boolean;
  transition: string;
}

export interface PageAnimations {
  entrance: {
    type: string;
    duration: number;
  };
  exit: {
    type: string;
    duration: number;
  };
}

export interface LifecycleHooks {
  onInit: any[];
  onResume: any[];
  onPause: any[];
  onDestroy: any[];
}

export interface ConditionalLogic {
  showConditions: any[];
  hideConditions: any[];
}

export interface DataSources {
  apis: any[];
  local_data: any[];
  state_variables: any[];
}

export interface StateManagement {
  variables: any[];
  computed_properties: any[];
  watchers: any[];
}

export interface SEOConfig {
  title: string;
  description: string;
  keywords: string[];
  og_image: string;
}

export interface AccessibilityConfig {
  screen_reader_enabled: boolean;
  semantic_labels: any[];
  focus_order: any[];
}

// Component System
export interface PageComponent {
  id: string;
  page_id: string;
  component_library_id?: string;
  component_type: string;
  component_name: string;
  flutter_widget_name: string;
  properties: Record<string, any>;
  styling: Record<string, any>;
  constraints: Record<string, any>;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  z_index: number;
  is_visible: boolean;
  is_locked: boolean;
  parent_id?: string;
  sort_order: number;
  
  // Enhanced component features
  data_binding: DataBinding;
  event_handlers: EventHandlers;
  validation_rules: ValidationRules;
  responsive_config: ResponsiveConfig;
  accessibility_config: ComponentAccessibilityConfig;
  animation_config: AnimationConfig;
  conditional_rendering: ConditionalRendering;
  
  created_at: string;
  updated_at: string;
}

export interface DataBinding {
  state_variables: any[];
  api_bindings: any[];
  computed_values: any[];
}

export interface EventHandlers {
  onTap: any[];
  onChange: any[];
  onSubmit: any[];
  onFocus: any[];
  onBlur: any[];
}

export interface ValidationRules {
  required: boolean;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  custom_validators: any[];
}

export interface ResponsiveConfig {
  breakpoints: {
    mobile: { width: string; visible: boolean };
    tablet: { width: string; visible: boolean };
    desktop: { width: string; visible: boolean };
  };
  adaptive_sizing: boolean;
}

export interface ComponentAccessibilityConfig {
  semantic_label: string;
  hint: string;
  is_focusable: boolean;
  focus_order?: number;
  screen_reader_text: string;
}

export interface AnimationConfig {
  entrance?: any;
  exit?: any;
  hover?: any;
  click?: any;
  micro_interactions: any[];
}

export interface ConditionalRendering {
  show_when: any[];
  hide_when: any[];
  dynamic_properties: any[];
}

// Component Library
export interface ComponentLibrary {
  id: string;
  name: string;
  category: ComponentCategory;
  flutter_widget_name: string;
  description?: string;
  properties_schema: Record<string, any>;
  default_properties: Record<string, any>;
  preview_image_url?: string;
  documentation_url?: string;
  is_premium: boolean;
  is_active: boolean;
  version: string;
  created_at: string;
  updated_at: string;
}


// App Dependencies
export interface AppDependency {
  id: string;
  app_id: string;
  package_name: string;
  version: string;
  dependency_type: DependencyType;
  auto_update: boolean;
  compatibility_notes?: string;
  is_active: boolean;
  added_at: string;
  updated_at: string;
}

// GitHub Integration
export interface GitHubRepository {
  id: string;
  app_id: string;
  repo_name: string;
  repo_url: string;
  owner_username: string;
  branch: string;
  access_token_encrypted?: string;
  auto_sync: boolean;
  last_sync_at?: string;
  sync_status: SyncStatus;
  sync_error_message?: string;
  created_at: string;
  updated_at: string;
}

// Build System
export interface AppBuild {
  id: string;
  app_id: string;
  user_id: string;
  build_type: BuildType;
  build_status: BuildStatus;
  build_logs?: string;
  download_url?: string;
  file_size?: number;
  file_hash?: string;
  build_config: Record<string, any>;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  expires_at?: string;
}

// ENHANCED: Collaboration
export interface AppCollaborator {
  id: string;
  app_id: string;
  user_id: string;
  email?: string;
  role: CollaboratorRole;
  permissions: Record<string, any>;
  invited_by_user_id?: string;
  invited_at: string;
  joined_at?: string;
  accepted_at?: string;
  last_activity_at?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// NEW: App Presence Tracking
export interface AppPresence {
  id: string;
  app_id: string;
  user_id: string;
  status: PresenceStatus;
  current_page_id?: string;
  session_id?: string;
  last_activity_at: string;
  started_at: string;
  metadata: Record<string, any>;
}

// NEW: Enhanced Collaborator with Presence
export interface CollaboratorWithPresence {
  collaborator_id: string;
  user_id: string;
  email: string;
  full_name?: string;
  role: CollaboratorRole;
  is_online: boolean;
  current_status?: PresenceStatus;
  current_page_id?: string;
  last_activity_at?: string;
}

// NEW: Page Connections
export interface PageConnection {
  id: string;
  app_id: string;
  from_page_id: string;
  to_page_id: string;
  connection_type: PageConnectionType;
  connection_data: Record<string, any>;
  is_auto_detected: boolean;
  detected_at?: string;
  created_by_user_id?: string;
  created_at: string;
  updated_at: string;
}

// NEW: Archived App Access
export interface ArchivedAppAccess {
  id: string;
  app_id: string;
  user_id: string;
  access_type: 'view' | 'export';
  granted_by_user_id?: string;
  granted_at: string;
  expires_at?: string;
  payment_required: boolean;
  payment_amount?: number;
  payment_status?: 'pending' | 'completed' | 'failed';
  stripe_payment_intent_id?: string;
  used_at?: string;
  metadata: Record<string, any>;
}

// ENHANCED: Activity Log
export interface AppActivityLog {
  id: string;
  app_id: string;
  user_id: string;
  action_type: string;
  action_description: string;
  affected_entity_type?: string; // 'page', 'component', 'app', 'collaborator'
  affected_entity_id?: string;
  before_state?: Record<string, any>;
  after_state?: Record<string, any>;
  change_summary?: string;
  ip_address?: string;
  user_agent?: string;
  session_id?: string;
  metadata: Record<string, any>;
  created_at: string;
}

// API Request/Response Types
export interface CreateAppRequest {
  name: string;
  description?: string;
  package_name?: string;
  primary_color?: string;
  accent_color?: string;
}

export interface UpdateAppRequest {
  name?: string;
  description?: string;
  package_name?: string;
  primary_color?: string;
  accent_color?: string;
  build_config?: Partial<BuildConfiguration>;
  capabilities?: Partial<AppCapabilities>;
  permissions?: Partial<AppPermissions>;
  app_store_config?: Partial<AppStoreConfig>;
  export_settings?: Partial<ExportSettings>;
}

export interface CreatePageRequest {
  name: string;
  title: string;
  description?: string;
  route_path: string;
  page_type: PageType;
  page_subtype?: PageSubtype;
  is_home_page?: boolean;
  is_auth_required?: boolean;
}

export interface CreateComponentRequest {
  page_id: string;
  component_library_id?: string;
  component_type: string;
  component_name: string;
  flutter_widget_name: string;
  position_x: number;
  position_y: number;
  width?: number;
  height?: number;
  properties?: Record<string, any>;
  styling?: Record<string, any>;
}

export interface BuildRequest {
  app_id: string;
  build_type: BuildType;
  build_mode: BuildMode;
  target_platform?: TargetPlatform;
  build_config?: BuildConfiguration;
}

export interface BuildResult {
  build_id: string;
  status: BuildStatus;
  download_url?: string;
  error_message?: string;
  created_at: string;
  completed_at?: string;
}

export interface BuildConfiguration {
  signing?: {
    keystore_path: string;
    key_alias: string;
    store_password: string;
    key_password: string;
  };
  obfuscation?: boolean;
  minify?: boolean;
  shrink_resources?: boolean;
  target_platforms?: TargetPlatform[];
  custom_gradle_args?: string[];
}

// AI Context Types
export type AIContextType = 
  | 'app_level' 
  | 'page_focus' 
  | 'component_focus' 
  | 'design_assistance' 
  | 'code_generation'
  | 'generic';

export interface ContextualPrompt {
  context_type: AIContextType;
  system_prompt: string;
  user_prompt: string;
  context_data: Record<string, any>;
  app_id: string;
  focused_entity_id?: string;
  timestamp: string;
}

// Canvas Types
export interface CanvasNode {
  id: string;
  app_id: string;
  page_id?: string;
  title: string;
  description?: string;
  node_type: 'page' | 'modal' | 'flow' | 'component';
  position_x: number;
  position_y: number;
  width?: number;
  height?: number;
  styling?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface CanvasConnection {
  id: string;
  app_id: string;
  from_node_id: string;
  to_node_id: string;
  connection_type: 'navigation' | 'action' | 'condition';
  trigger_config: Record<string, any>;
  animation_config?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface CanvasState {
  app_id: string;
  app_name: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  pages: AppPage[];
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
  selection: {
    type: 'none' | 'node' | 'connection' | 'multiple';
    selected_items: string[];
  };
}

export interface ComponentUpdate {
  component_id: string;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  z_index: number;
}

// NEW: Enhanced API Request/Response Types
export interface UpdatePresenceRequest {
  status: PresenceStatus;
  current_page_id?: string;
  session_id?: string;
}

export interface PresenceResponse {
  app_id: string;
  collaborators: CollaboratorWithPresence[];
  total_online: number;
}

export interface InviteCollaboratorRequest {
  email: string;
  role: CollaboratorRole;
  message?: string;
}

export interface ArchiveAppRequest {
  reason?: string;
}

export interface ArchivedAppAccessRequest {
  access_type: 'view' | 'export';
  payment_amount?: number;
}

export interface PageConnectionsResponse {
  connections: PageConnection[];
  navigation_graph: {
    nodes: { id: string; label: string; type: string }[];
    edges: { from: string; to: string; type: PageConnectionType; label?: string }[];
  };
}

export interface EnhancedGenerationRequest {
  prompt: string;
  model: AIModel;
  app_id?: string;
  page_id?: string;
  context?: Record<string, any>;
}

export interface EnhancedGenerationResponse {
  generation_id: string;
  status: GenerationStatus;
  estimated_time_ms?: number;
  queue_position?: number;
  model_used: AIModel;
}

export interface CollaborationInvite {
  id: string;
  app_id: string;
  invited_by_user_id: string;
  email: string;
  role: CollaboratorRole;
  message?: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  expires_at: string;
  accepted_at?: string;
  accepted_by_user_id?: string;
  created_at: string;
  apps?: {
    name: string;
    description?: string;
  };
  user_profiles?: {
    full_name: string;
  };
}

export interface CollaborationActivity {
  id: string;
  app_id: string;
  user_id: string;
  action_type: string;
  action_description: string;
  affected_entity?: string;
  before_state?: Record<string, any>;
  after_state?: Record<string, any>;
  created_at: string;
  user_profiles: {
    full_name: string;
    avatar_url?: string;
  };
}

// Context for AI prompting
export interface AppContext {
  app: AppConfig;
  current_page?: AppPage;
  selected_component?: PageComponent;
  all_pages: AppPage[];
  all_components: PageComponent[];
  recent_activity: AppActivityLog[];
  dependencies: AppDependency[];
}