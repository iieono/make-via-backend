import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';

// Types for preview system
export interface PreviewSession {
  id: string;
  appId: string;
  userId: string;
  deviceType: 'android' | 'ios' | 'web';
  sessionData: {
    currentPage: string;
    navigationStack: string[];
    appState: Record<string, any>;
  };
  status: 'active' | 'expired';
  expiresAt: Date;
  createdAt: Date;
}

export interface ConsoleLog {
  id: string;
  sessionId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  type: 'interaction' | 'navigation' | 'form_input' | 'api_call' | 'performance' | 'error' | 'warning' | 'debug';
  message: string;
  componentId?: string;
  pageId?: string;
  interactionData?: any;
  stackTrace?: string;
  timestamp: Date;
}

export interface AppRenderData {
  appId: string;
  metadata: {
    name: string;
    description: string;
    theme: any;
  };
  pages: Array<{
    id: string;
    name: string;
    slug: string;
    content: any;
    isHomePage: boolean;
  }>;
  navigation: Array<{
    from: string;
    to: string;
    type: string;
    conditions?: any;
  }>;
  globalState: Record<string, any>;
}

export class PreviewService {
  private db = supabase;
  private readonly SESSION_DURATION_HOURS = 2;
  private activeSessions = new Map<string, PreviewSession>();

  /**
   * Create a new preview session
   */
  async createPreviewSession(
    appId: string,
    userId: string,
    deviceType: 'android' | 'ios' | 'web' = 'android'
  ): Promise<PreviewSession> {
    try {
      logger.info('Creating preview session', { appId, userId, deviceType });

      // Check if app exists and user has access
      const { data: app, error: appError } = await this.db
        .from('apps')
        .select('id, name, user_id')
        .eq('id', appId)
        .single();

      if (appError || !app) {
        throw new Error('App not found or access denied');
      }

      // Create session
      const sessionId = uuidv4();
      const expiresAt = new Date(Date.now() + this.SESSION_DURATION_HOURS * 60 * 60 * 1000);

      const { data: sessionRecord, error } = await this.db
        .from('app_preview_sessions')
        .insert({
          id: sessionId,
          app_id: appId,
          user_id: userId,
          device_type: deviceType,
          session_data: {
            currentPage: 'home',
            navigationStack: [],
            appState: {}
          },
          status: 'active',
          expires_at: expiresAt.toISOString()
        })
        .select()
        .single();

      if (error) {
        logger.error('Failed to create preview session', { error, appId, userId });
        throw error;
      }

      const session: PreviewSession = {
        id: sessionRecord.id,
        appId: sessionRecord.app_id,
        userId: sessionRecord.user_id,
        deviceType: sessionRecord.device_type as 'android' | 'ios' | 'web',
        sessionData: sessionRecord.session_data,
        status: sessionRecord.status as 'active' | 'expired',
        expiresAt: new Date(sessionRecord.expires_at),
        createdAt: new Date(sessionRecord.created_at)
      };

      // Cache session
      this.activeSessions.set(sessionId, session);

      logger.info('Preview session created successfully', { sessionId, appId, userId });
      return session;

    } catch (error) {
      logger.error('Preview session creation failed', { error, appId, userId });
      throw error;
    }
  }

  /**
   * Get app render data for preview
   */
  async getAppRenderData(appId: string): Promise<AppRenderData> {
    try {
      // Get app metadata
      const { data: app, error: appError } = await this.db
        .from('apps')
        .select('id, name, description, theme_config')
        .eq('id', appId)
        .single();

      if (appError || !app) {
        throw new Error('App not found');
      }

      // Get pages with their content
      const { data: pages, error: pagesError } = await this.db
        .from('app_pages')
        .select(`
          id,
          name,
          slug,
          content,
          is_home_page,
          page_components (
            id,
            component_type,
            props,
            position_x,
            position_y,
            width,
            height
          )
        `)
        .eq('app_id', appId)
        .order('created_at', { ascending: true });

      if (pagesError) {
        logger.error('Failed to fetch app pages', { error: pagesError, appId });
        throw pagesError;
      }

      // Get navigation connections
      const { data: navigation, error: navError } = await this.db
        .from('page_connections')
        .select('from_page_id, to_page_id, connection_type, conditions')
        .eq('app_id', appId);

      if (navError) {
        logger.error('Failed to fetch navigation data', { error: navError, appId });
      }

      // Transform data for frontend rendering
      const renderData: AppRenderData = {
        appId: app.id,
        metadata: {
          name: app.name,
          description: app.description || '',
          theme: app.theme_config || this.getDefaultTheme()
        },
        pages: (pages || []).map(page => ({
          id: page.id,
          name: page.name,
          slug: page.slug,
          content: {
            ...page.content,
            components: page.page_components || []
          },
          isHomePage: page.is_home_page || false
        })),
        navigation: (navigation || []).map(nav => ({
          from: nav.from_page_id,
          to: nav.to_page_id,
          type: nav.connection_type,
          conditions: nav.conditions
        })),
        globalState: {}
      };

      logger.info('App render data prepared', { appId, pagesCount: renderData.pages.length });
      return renderData;

    } catch (error) {
      logger.error('Failed to get app render data', { error, appId });
      throw error;
    }
  }

  /**
   * Log preview console message
   */
  async logConsoleMessage(
    sessionId: string,
    level: ConsoleLog['level'],
    type: ConsoleLog['type'],
    message: string,
    metadata?: {
      componentId?: string;
      pageId?: string;
      interactionData?: any;
      stackTrace?: string;
    }
  ): Promise<void> {
    try {
      const logId = uuidv4();
      
      const { error } = await this.db
        .from('preview_console_logs')
        .insert({
          id: logId,
          session_id: sessionId,
          level,
          type,
          message,
          component_id: metadata?.componentId,
          page_id: metadata?.pageId,
          interaction_data: metadata?.interactionData,
          stack_trace: metadata?.stackTrace
        });

      if (error) {
        logger.error('Failed to log console message', { error, sessionId });
      }

      // Emit to real-time service for live console
      const realTimeService = (global as any).realTimeService;
      if (realTimeService) {
        realTimeService.emitConsoleLog(sessionId, {
          id: logId,
          sessionId,
          level,
          type,
          message,
          componentId: metadata?.componentId,
          pageId: metadata?.pageId,
          interactionData: metadata?.interactionData,
          stackTrace: metadata?.stackTrace,
          timestamp: new Date()
        });
      }

      logger.debug('Console message logged', { sessionId, level, type });

    } catch (error) {
      logger.error('Console logging failed', { error, sessionId, level, message });
    }
  }

  /**
   * Update preview session state
   */
  async updateSessionState(
    sessionId: string,
    updates: {
      currentPage?: string;
      navigationStack?: string[];
      appState?: Record<string, any>;
    }
  ): Promise<void> {
    try {
      // Get current session data
      const { data: currentSession } = await this.db
        .from('app_preview_sessions')
        .select('session_data')
        .eq('id', sessionId)
        .single();

      if (!currentSession) {
        throw new Error('Session not found');
      }

      // Merge updates with existing data
      const updatedData = {
        ...currentSession.session_data,
        currentPage: updates.currentPage || currentSession.session_data.currentPage,
        navigationStack: updates.navigationStack || currentSession.session_data.navigationStack,
        appState: {
          ...currentSession.session_data.appState,
          ...updates.appState
        }
      };

      // Update database
      const { error } = await this.db
        .from('app_preview_sessions')
        .update({
          session_data: updatedData,
          updated_at: new Date().toISOString()
        })
        .eq('id', sessionId);

      if (error) {
        logger.error('Failed to update session state', { error, sessionId });
        throw error;
      }

      // Update cache
      const cachedSession = this.activeSessions.get(sessionId);
      if (cachedSession) {
        cachedSession.sessionData = updatedData;
        this.activeSessions.set(sessionId, cachedSession);
      }

      logger.debug('Session state updated', { sessionId, updates });

    } catch (error) {
      logger.error('Session state update failed', { error, sessionId });
      throw error;
    }
  }

  /**
   * Get preview session
   */
  async getPreviewSession(sessionId: string): Promise<PreviewSession | null> {
    try {
      // Check cache first
      const cached = this.activeSessions.get(sessionId);
      if (cached && cached.expiresAt > new Date()) {
        return cached;
      }

      // Fetch from database
      const { data: sessionRecord, error } = await this.db
        .from('app_preview_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

      if (error || !sessionRecord) {
        return null;
      }

      const session: PreviewSession = {
        id: sessionRecord.id,
        appId: sessionRecord.app_id,
        userId: sessionRecord.user_id,
        deviceType: sessionRecord.device_type,
        sessionData: sessionRecord.session_data,
        status: sessionRecord.status,
        expiresAt: new Date(sessionRecord.expires_at),
        createdAt: new Date(sessionRecord.created_at)
      };

      // Check if expired
      if (session.expiresAt <= new Date()) {
        await this.expireSession(sessionId);
        return null;
      }

      // Update cache
      this.activeSessions.set(sessionId, session);
      return session;

    } catch (error) {
      logger.error('Failed to get preview session', { error, sessionId });
      return null;
    }
  }

  /**
   * Expire a preview session
   */
  async expireSession(sessionId: string): Promise<void> {
    try {
      const { error } = await this.db
        .from('app_preview_sessions')
        .update({ status: 'expired' })
        .eq('id', sessionId);

      if (error) {
        logger.error('Failed to expire session', { error, sessionId });
      }

      // Remove from cache
      this.activeSessions.delete(sessionId);

      logger.info('Preview session expired', { sessionId });

    } catch (error) {
      logger.error('Session expiration failed', { error, sessionId });
    }
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<void> {
    try {
      const cutoffTime = new Date();
      
      const { error } = await this.db
        .from('app_preview_sessions')
        .update({ status: 'expired' })
        .lt('expires_at', cutoffTime.toISOString())
        .eq('status', 'active');

      if (error) {
        logger.error('Failed to cleanup expired sessions', { error });
      }

      // Clean up cache
      const expiredSessions = Array.from(this.activeSessions.entries())
        .filter(([_, session]) => session.expiresAt <= cutoffTime)
        .map(([sessionId, _]) => sessionId);

      expiredSessions.forEach(sessionId => {
        this.activeSessions.delete(sessionId);
      });

      logger.info('Expired sessions cleaned up');

    } catch (error) {
      logger.error('Session cleanup failed', { error });
    }
  }

  /**
   * Get console logs for session
   */
  async getConsoleLogs(
    sessionId: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<ConsoleLog[]> {
    try {
      const { data, error } = await this.db
        .from('preview_console_logs')
        .select('*')
        .eq('session_id', sessionId)
        .order('timestamp', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        logger.error('Failed to get console logs', { error, sessionId });
        throw error;
      }

      return (data || []).map(log => ({
        id: log.id,
        sessionId: log.session_id,
        level: log.level,
        type: log.type,
        message: log.message,
        componentId: log.component_id,
        pageId: log.page_id,
        interactionData: log.interaction_data,
        stackTrace: log.stack_trace,
        timestamp: new Date(log.timestamp)
      }));

    } catch (error) {
      logger.error('Failed to fetch console logs', { error, sessionId });
      throw error;
    }
  }

  /**
   * Get default theme configuration
   */
  private getDefaultTheme() {
    return {
      primaryColor: '#007AFF',
      secondaryColor: '#5856D6',
      backgroundColor: '#FFFFFF',
      textColor: '#000000',
      spacing: 8,
      borderRadius: 8,
      fontFamily: 'System'
    };
  }

  /**
   * Start background cleanup job
   */
  startCleanupJob(): void {
    // Clean up expired sessions every hour
    setInterval(() => {
      this.cleanupExpiredSessions().catch(error => {
        logger.error('Background session cleanup failed', { error });
      });
    }, 60 * 60 * 1000); // 1 hour
  }
}

export const previewService = new PreviewService();