import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';

import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import { errorHandler } from '@/middleware/errorHandler';
import { notFoundHandler } from '@/middleware/notFoundHandler';
import rateLimits from '@/middleware/rateLimit';
import { backgroundJobService } from '@/services/background-jobs';
import { RealTimeService, realTimeService as realTimeServiceInstance } from '@/services/real-time-service';

// Routes
import authRoutes from '@/routes/auth';
import authEndpointsRoutes from '@/routes/auth-endpoints';
import subscriptionRoutes from '@/routes/subscription';
import stripeRoutes from '@/routes/stripe';
import aiRoutes from '@/routes/ai';
import appsRoutes from '@/routes/apps';
import pagesRoutes from '@/routes/pages';
import componentsRoutes from '@/routes/components';
import githubRoutes from '@/routes/github';
import buildsRoutes from '@/routes/builds';
import canvasRoutes from '@/routes/canvas';
import usageRoutes from '@/routes/usage';
import webhookRoutes from '@/routes/webhooks';
import filesRoutes from '@/routes/files';
import previewRoutes from '@/routes/preview';
import notificationsRoutes from '@/routes/notifications';
import monitoringRoutes from '@/routes/monitoring';
import collaborationRoutes from '@/routes/collaboration';
import userCollaborationRoutes from '@/routes/user-collaboration';
import appArchivingRoutes from '@/routes/app-archiving';
import pageConnectionsRoutes from '@/routes/page-connections';
import enhancedAIGenerationRoutes from '@/routes/enhanced-ai-generation';
import analyticsRoutes from '@/routes/analytics';
import reactNativeRoutes from '@/routes/react-native';

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
app.use(cors({
  origin: config.cors.origins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Compression
app.use(compression());

// Logging
app.use(morgan(config.isDevelopment ? 'dev' : 'combined', {
  stream: {
    write: (message: string) => logger.info(message.trim()),
  },
}));

// Body parsing middleware
app.use('/webhooks', express.raw({ type: 'application/json' })); // Raw body for webhooks
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
app.use(rateLimits.general);

// Root route - API info
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'MakeVia API',
    description: 'AI-powered mobile app builder backend',
    version: process.env.npm_package_version || '1.0.0',
    environment: config.environment,
    status: 'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      auth: '/api/auth/*',
      apps: '/api/apps/*',
      pages: '/api/apps/:appId/pages/*',
      components: '/api/apps/:appId/pages/:pageId/components/*',
      github: '/api/apps/:appId/github/*',
      builds: '/api/apps/:appId/builds/*',
      canvas: '/api/apps/:appId/canvas/*',
      ai: '/api/ai/*',
      subscription: '/api/subscription/*',
      files: '/api/files/*',
      notifications: '/api/notifications/*',
      monitoring: '/api/monitoring/*',
      collaboration: '/api/apps/:appId/collaborators/*',
      userCollaboration: '/api/collaboration/*',
      appArchiving: '/api/apps/:appId/archive, /api/apps/archived*',
      pageConnections: '/api/apps/:appId/page-connections/*',
      enhancedAI: '/api/ai/*',
      webhooks: '/webhooks/*'
    },
    documentation: config.isDevelopment ? `http://localhost:${config.port}/api/docs` : null,
    features: [
      'Claude AI Integration',
      'Stripe Payments',
      'Supabase Database',
      'File Upload System',
      'Push Notifications',
      'Team Collaboration',
      'Usage Analytics',
      'Abuse Prevention',
      'Token Monitoring',
      'Visual App Builder',
      'Flutter Code Generation',
      'GitHub Integration',
      'APK/AAB Build System',
      'Visual Canvas Editor'
    ]
  });
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: config.environment,
    version: process.env.npm_package_version || '1.0.0',
  });
});

// API Routes
app.use('/api/auth', authRoutes); // User profile management
app.use('/api/auth', authEndpointsRoutes); // Authentication endpoints (login, register, etc.)
app.use('/api/subscription', subscriptionRoutes); // Auth handled in individual routes
app.use('/api/stripe', stripeRoutes); // Auth handled in individual routes
app.use('/api/ai', aiRoutes); // Auth handled in individual routes
app.use('/api/apps', appsRoutes); // Auth handled in individual routes
app.use('/api/apps/:appId/pages', pagesRoutes); // App pages management
app.use('/api/apps/:appId/pages/:pageId/components', componentsRoutes); // Component management
app.use('/api/apps/:appId/github', githubRoutes); // GitHub integration
app.use('/api/apps/:appId/builds', buildsRoutes); // Build system
app.use('/api/builds', buildsRoutes); // Global build endpoints
app.use('/api/apps/:appId/canvas', canvasRoutes); // Canvas and visual editor
app.use('/api/usage', usageRoutes); // Auth handled in individual routes
app.use('/api/files', filesRoutes); // File upload and management
app.use('/api/preview', previewRoutes); // App preview system
app.use('/api/notifications', notificationsRoutes); // Push notifications
app.use('/api/monitoring', monitoringRoutes); // Usage monitoring and abuse prevention
app.use('/api/apps/:appId/collaborators', collaborationRoutes); // App collaboration management
app.use('/api/collaboration', userCollaborationRoutes); // User collaboration endpoints
app.use('/api/apps', appArchivingRoutes); // App archiving and restoration
app.use('/api/apps', pageConnectionsRoutes); // Page connections and navigation
app.use('/api/ai', enhancedAIGenerationRoutes); // Enhanced AI generation tracking
app.use('/api/analytics', analyticsRoutes); // Analytics and activity tracking
app.use('/api/react-native', reactNativeRoutes); // React Native app development
app.use('/webhooks', webhookRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  backgroundJobService.stop();
  httpServer.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  backgroundJobService.stop();
  httpServer.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

// Initialize WebSocket service
const realTimeService = new RealTimeService(httpServer);
// Make it available globally
(global as any).realTimeService = realTimeService;

// Start server
const PORT = config.port;
httpServer.listen(PORT, () => {
  logger.info(`🚀 MakeVia API Server running on port ${PORT}`);
  logger.info(`📝 Environment: ${config.environment}`);
  logger.info(`🔗 Health check: http://localhost:${PORT}/health`);
  logger.info(`🔌 WebSocket server initialized`);
  
  // Start background jobs
  backgroundJobService.start();
  
  // Start preview service cleanup job
  const { previewService } = require('@/services/preview-service');
  previewService.startCleanupJob();
  
  // Template initialization disabled - templates will be managed manually
  // const templateService = new TemplateService();
  // templateService.initializeStarterTemplates().catch(error => {
  //   logger.error('Failed to initialize starter templates:', error);
  // });
  
  if (config.isDevelopment) {
    logger.info(`📚 API Documentation: http://localhost:${PORT}/api/docs`);
  }
});

export default app;