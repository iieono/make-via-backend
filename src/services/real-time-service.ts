import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { logger } from '@/utils/logger';
import jwt from 'jsonwebtoken';
import { config } from '@/config/config';

// Types for real-time events
export interface AIActionProgress {
  actionId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress?: number; // 0-100
  message?: string;
  timestamp: number;
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

export interface UserPresence {
  userId: string;
  appId: string;
  status: 'online' | 'away' | 'offline';
  currentPage?: string;
  lastSeen: Date;
}

export interface AppUpdate {
  appId: string;
  type: 'page_created' | 'page_updated' | 'page_deleted' | 'component_updated';
  data: any;
  userId: string;
  timestamp: number;
}

export class RealTimeService {
  private io: Server;
  private connectedUsers = new Map<string, { socketId: string; userId: string; appId?: string }>();

  constructor(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
        methods: ["GET", "POST"],
        credentials: true
      }
    });

    this.setupSocketEvents();
    logger.info('Real-time service initialized');
  }

  private setupSocketEvents() {
    this.io.use(this.authenticateSocket.bind(this));

    this.io.on('connection', (socket) => {
      const userId = (socket as any).userId;
      logger.info('User connected to WebSocket', { userId, socketId: socket.id });

      // Store connection
      this.connectedUsers.set(socket.id, { socketId: socket.id, userId });

      // Handle user joining app workspace
      socket.on('join_app', async (appId: string) => {
        try {
          // Update connection info
          const connection = this.connectedUsers.get(socket.id);
          if (connection) {
            connection.appId = appId;
            this.connectedUsers.set(socket.id, connection);
          }

          // Join app room
          await socket.join(`app:${appId}`);
          
          // Notify other users in the app
          socket.to(`app:${appId}`).emit('user_joined', {
            userId,
            timestamp: Date.now()
          });

          logger.info('User joined app workspace', { userId, appId, socketId: socket.id });
        } catch (error) {
          logger.error('Error joining app workspace', { userId, appId, error });
        }
      });

      // Handle user leaving app workspace
      socket.on('leave_app', async (appId: string) => {
        try {
          await socket.leave(`app:${appId}`);
          
          // Update connection info
          const connection = this.connectedUsers.get(socket.id);
          if (connection) {
            connection.appId = undefined;
            this.connectedUsers.set(socket.id, connection);
          }

          // Notify other users
          socket.to(`app:${appId}`).emit('user_left', {
            userId,
            timestamp: Date.now()
          });

          logger.info('User left app workspace', { userId, appId });
        } catch (error) {
          logger.error('Error leaving app workspace', { userId, appId, error });
        }
      });

      // Handle preview session joining
      socket.on('join_preview', async (sessionId: string) => {
        try {
          await socket.join(`preview:${sessionId}`);
          logger.info('User joined preview session', { userId, sessionId });
        } catch (error) {
          logger.error('Error joining preview session', { userId, sessionId, error });
        }
      });

      // Handle user cursor/presence updates
      socket.on('cursor_update', (data: { appId: string; x: number; y: number; pageId?: string }) => {
        socket.to(`app:${data.appId}`).emit('user_cursor', {
          userId,
          x: data.x,
          y: data.y,
          pageId: data.pageId,
          timestamp: Date.now()
        });
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        const connection = this.connectedUsers.get(socket.id);
        if (connection) {
          logger.info('User disconnected from WebSocket', { 
            userId: connection.userId, 
            socketId: socket.id,
            appId: connection.appId
          });

          // Notify app workspace if user was in one
          if (connection.appId) {
            socket.to(`app:${connection.appId}`).emit('user_left', {
              userId: connection.userId,
              timestamp: Date.now()
            });
          }

          this.connectedUsers.delete(socket.id);
        }
      });

      // Handle errors
      socket.on('error', (error) => {
        logger.error('Socket error', { userId, socketId: socket.id, error });
      });
    });
  }

  private async authenticateSocket(socket: any, next: (err?: Error) => void) {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
      
      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const decoded = jwt.verify(token, config.jwtSecret) as any;
      socket.userId = decoded.userId || decoded.sub;

      next();
    } catch (error) {
      logger.error('Socket authentication failed', { error });
      next(new Error('Authentication failed'));
    }
  }

  /**
   * Emit AI action progress to user
   */
  emitActionProgress(userId: string, actionProgress: AIActionProgress) {
    try {
      this.io.to(`user:${userId}`).emit('ai_action_progress', actionProgress);
      logger.debug('AI action progress emitted', { userId, actionId: actionProgress.actionId });
    } catch (error) {
      logger.error('Error emitting AI action progress', { userId, error });
    }
  }

  /**
   * Emit console log to preview session
   */
  emitConsoleLog(sessionId: string, log: ConsoleLog) {
    try {
      this.io.to(`preview:${sessionId}`).emit('console_log', {
        id: log.id,
        level: log.level,
        type: log.type,
        message: log.message,
        componentId: log.componentId,
        pageId: log.pageId,
        interactionData: log.interactionData,
        stackTrace: log.stackTrace,
        timestamp: log.timestamp.toISOString()
      });
      logger.debug('Console log emitted', { sessionId, logLevel: log.level });
    } catch (error) {
      logger.error('Error emitting console log', { sessionId, error });
    }
  }

  /**
   * Emit user presence update to app workspace
   */
  emitUserPresence(appId: string, presence: UserPresence) {
    try {
      this.io.to(`app:${appId}`).emit('user_presence', {
        userId: presence.userId,
        status: presence.status,
        currentPage: presence.currentPage,
        lastSeen: presence.lastSeen.toISOString()
      });
      logger.debug('User presence emitted', { appId, userId: presence.userId });
    } catch (error) {
      logger.error('Error emitting user presence', { appId, error });
    }
  }

  /**
   * Emit app update to all users in app workspace
   */
  emitAppUpdate(appId: string, update: AppUpdate) {
    try {
      this.io.to(`app:${appId}`).emit('app_update', {
        type: update.type,
        data: update.data,
        userId: update.userId,
        timestamp: update.timestamp
      });
      logger.debug('App update emitted', { appId, updateType: update.type });
    } catch (error) {
      logger.error('Error emitting app update', { appId, error });
    }
  }

  /**
   * Send notification to specific user
   */
  sendNotificationToUser(userId: string, notification: {
    id: string;
    type: string;
    title: string;
    message: string;
    data?: any;
    timestamp: number;
  }) {
    try {
      // Find user's socket(s)
      const userSockets = Array.from(this.connectedUsers.values())
        .filter(conn => conn.userId === userId);

      userSockets.forEach(conn => {
        this.io.to(conn.socketId).emit('notification', notification);
      });

      logger.debug('Notification sent to user', { userId, notificationType: notification.type });
    } catch (error) {
      logger.error('Error sending notification to user', { userId, error });
    }
  }

  /**
   * Send broadcast message to all users in app
   */
  broadcastToApp(appId: string, event: string, data: any) {
    try {
      this.io.to(`app:${appId}`).emit(event, data);
      logger.debug('Broadcast sent to app', { appId, event });
    } catch (error) {
      logger.error('Error broadcasting to app', { appId, event, error });
    }
  }

  /**
   * Get connected users count for an app
   */
  getAppConnectedUsers(appId: string): number {
    try {
      const room = this.io.sockets.adapter.rooms.get(`app:${appId}`);
      return room ? room.size : 0;
    } catch (error) {
      logger.error('Error getting app connected users', { appId, error });
      return 0;
    }
  }

  /**
   * Get all connected users
   */
  getConnectedUsersCount(): number {
    return this.connectedUsers.size;
  }

  /**
   * Check if user is online
   */
  isUserOnline(userId: string): boolean {
    return Array.from(this.connectedUsers.values()).some(conn => conn.userId === userId);
  }

  /**
   * Get user's connected apps
   */
  getUserConnectedApps(userId: string): string[] {
    return Array.from(this.connectedUsers.values())
      .filter(conn => conn.userId === userId && conn.appId)
      .map(conn => conn.appId!);
  }

  /**
   * Force disconnect user (for admin purposes)
   */
  disconnectUser(userId: string, reason?: string) {
    try {
      const userSockets = Array.from(this.connectedUsers.values())
        .filter(conn => conn.userId === userId);

      userSockets.forEach(conn => {
        const socket = this.io.sockets.sockets.get(conn.socketId);
        if (socket) {
          socket.emit('force_disconnect', { reason: reason || 'Administrative action' });
          socket.disconnect(true);
        }
      });

      logger.info('User forcefully disconnected', { userId, reason });
    } catch (error) {
      logger.error('Error disconnecting user', { userId, error });
    }
  }

  /**
   * Get Socket.IO instance for custom usage
   */
  getIO(): Server {
    return this.io;
  }
}

// Singleton instance - will be initialized in server.ts
export let realTimeService: RealTimeService;