import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import jwt from 'jsonwebtoken';
import { config } from '@/config/config';

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  isAuthenticated?: boolean;
}

interface SubscriptionUpdate {
  type: 'subscription_updated' | 'usage_updated' | 'plan_changed';
  userId: string;
  data: any;
}

export class RealtimeSubscriptionService {
  private wss: WebSocketServer;
  private clients: Map<string, Set<AuthenticatedWebSocket>> = new Map();

  constructor(port: number = 8081) {
    this.wss = new WebSocketServer({ port });
    this.setupWebSocketServer();
    this.setupSupabaseRealtimeSubscriptions();
    
    logger.info(`Realtime subscription service started on port ${port}`);
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: AuthenticatedWebSocket, request) => {
      logger.info('New WebSocket connection attempt');

      // Extract JWT token from query params or headers
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const token = url.searchParams.get('token') || request.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        logger.warn('WebSocket connection rejected: No token provided');
        ws.close(1008, 'Token required');
        return;
      }

      try {
        // Verify JWT token
        const decoded = jwt.verify(token, config.jwt.secret) as any;
        const userId = decoded.sub || decoded.userId;

        if (!userId) {
          logger.warn('WebSocket connection rejected: Invalid token');
          ws.close(1008, 'Invalid token');
          return;
        }

        // Authenticate the connection
        ws.userId = userId;
        ws.isAuthenticated = true;

        // Add to clients map
        if (!this.clients.has(userId)) {
          this.clients.set(userId, new Set());
        }
        this.clients.get(userId)!.add(ws);

        logger.info(`WebSocket authenticated for user: ${userId}`);

        // Send initial subscription status
        this.sendInitialSubscriptionStatus(ws, userId);

        // Handle messages
        ws.on('message', (message) => {
          try {
            const data = JSON.parse(message.toString());
            this.handleClientMessage(ws, data);
          } catch (error) {
            logger.error('Error parsing WebSocket message:', error);
          }
        });

        // Handle disconnect
        ws.on('close', () => {
          if (ws.userId) {
            const userClients = this.clients.get(ws.userId);
            if (userClients) {
              userClients.delete(ws);
              if (userClients.size === 0) {
                this.clients.delete(ws.userId);
              }
            }
            logger.info(`WebSocket disconnected for user: ${ws.userId}`);
          }
        });

        // Handle errors
        ws.on('error', (error) => {
          logger.error('WebSocket error:', error);
        });

      } catch (error) {
        logger.error('WebSocket authentication failed:', error);
        ws.close(1008, 'Authentication failed');
      }
    });
  }

  private async sendInitialSubscriptionStatus(ws: AuthenticatedWebSocket, userId: string): Promise<void> {
    try {
      // Get current subscription status
      const { data: subscription } = await supabase.rpc('get_user_subscription', {
        user_uuid: userId,
      });

      const { data: usage } = await supabase.rpc('get_available_generations', {
        user_uuid: userId,
      });

      ws.send(JSON.stringify({
        type: 'initial_status',
        data: {
          subscription: subscription[0] || null,
          usage: usage[0] || null,
          timestamp: new Date().toISOString(),
        },
      }));
    } catch (error) {
      logger.error('Error sending initial subscription status:', error);
    }
  }

  private handleClientMessage(ws: AuthenticatedWebSocket, message: any): void {
    switch (message.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        break;
        
      case 'request_status':
        if (ws.userId) {
          this.sendInitialSubscriptionStatus(ws, ws.userId);
        }
        break;
        
      default:
        logger.warn(`Unknown message type: ${message.type}`);
    }
  }

  private setupSupabaseRealtimeSubscriptions(): void {
    // Subscribe to subscription changes
    supabase
      .channel('subscription_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_subscriptions',
        },
        (payload) => {
          this.handleSubscriptionChange(payload);
        }
      )
      .subscribe();

    // Subscribe to usage changes
    supabase
      .channel('usage_changes')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_subscriptions',
          filter: 'claude_usage_count=neq.null',
        },
        (payload) => {
          this.handleUsageChange(payload);
        }
      )
      .subscribe();

    // Subscribe to subscription events
    supabase
      .channel('subscription_events')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'subscription_events',
        },
        (payload) => {
          this.handleSubscriptionEvent(payload);
        }
      )
      .subscribe();

    logger.info('Supabase realtime subscriptions established');
  }

  private async handleSubscriptionChange(payload: any): Promise<void> {
    try {
      const userId = payload.new?.user_id || payload.old?.user_id;
      if (!userId) return;

      // Get updated subscription data
      const { data: subscription } = await supabase.rpc('get_user_subscription', {
        user_uuid: userId,
      });

      const update: SubscriptionUpdate = {
        type: 'subscription_updated',
        userId,
        data: {
          subscription: subscription[0] || null,
          changeType: payload.eventType,
          timestamp: new Date().toISOString(),
        },
      };

      this.broadcastToUser(userId, update);
      logger.info(`Subscription update sent to user: ${userId}`);
    } catch (error) {
      logger.error('Error handling subscription change:', error);
    }
  }

  private async handleUsageChange(payload: any): Promise<void> {
    try {
      const userId = payload.new?.user_id;
      if (!userId) return;

      // Get updated usage data
      const { data: usage } = await supabase.rpc('get_available_generations', {
        user_uuid: userId,
      });

      const update: SubscriptionUpdate = {
        type: 'usage_updated',
        userId,
        data: {
          usage: usage[0] || null,
          previousUsage: payload.old?.claude_usage_count,
          currentUsage: payload.new?.claude_usage_count,
          timestamp: new Date().toISOString(),
        },
      };

      this.broadcastToUser(userId, update);
      logger.info(`Usage update sent to user: ${userId}`);
    } catch (error) {
      logger.error('Error handling usage change:', error);
    }
  }

  private async handleSubscriptionEvent(payload: any): Promise<void> {
    try {
      const userId = payload.new?.user_id;
      if (!userId) return;

      const update: SubscriptionUpdate = {
        type: 'plan_changed',
        userId,
        data: {
          event: payload.new,
          timestamp: new Date().toISOString(),
        },
      };

      this.broadcastToUser(userId, update);
      logger.info(`Plan change event sent to user: ${userId}`);
    } catch (error) {
      logger.error('Error handling subscription event:', error);
    }
  }

  private broadcastToUser(userId: string, update: SubscriptionUpdate): void {
    const userClients = this.clients.get(userId);
    if (!userClients || userClients.size === 0) {
      logger.debug(`No connected clients for user: ${userId}`);
      return;
    }

    const message = JSON.stringify(update);
    
    userClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          logger.error('Error sending message to client:', error);
          // Remove dead connection
          userClients.delete(client);
        }
      } else {
        // Clean up dead connections
        userClients.delete(client);
      }
    });
  }

  // Public method to trigger updates (for manual notifications)
  public async notifySubscriptionUpdate(userId: string, type: SubscriptionUpdate['type'], data: any): Promise<void> {
    const update: SubscriptionUpdate = {
      type,
      userId,
      data: {
        ...data,
        timestamp: new Date().toISOString(),
      },
    };

    this.broadcastToUser(userId, update);
  }

  // Health check
  public getConnectionStats(): { totalConnections: number; connectedUsers: number } {
    let totalConnections = 0;
    this.clients.forEach((clients) => {
      totalConnections += clients.size;
    });

    return {
      totalConnections,
      connectedUsers: this.clients.size,
    };
  }

  public close(): void {
    this.wss.close();
    logger.info('Realtime subscription service closed');
  }
}

// Export singleton instance
export const realtimeSubscriptionService = new RealtimeSubscriptionService();