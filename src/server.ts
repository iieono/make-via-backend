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
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';

// Routes
import authRoutes from '@/routes/auth';
import subscriptionRoutes from '@/routes/subscription';
import stripeRoutes from '@/routes/stripe';
import aiRoutes from '@/routes/ai';
import appsRoutes from '@/routes/apps';
import usageRoutes from '@/routes/usage';
import webhookRoutes from '@/routes/webhooks';

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
app.use('/api/auth', authRoutes);
app.use('/api/subscription', subscriptionRoutes); // Auth handled in individual routes
app.use('/api/stripe', stripeRoutes); // Auth handled in individual routes
app.use('/api/ai', aiRoutes); // Auth handled in individual routes
app.use('/api/apps', appsRoutes); // Auth handled in individual routes
app.use('/api/usage', usageRoutes); // Auth handled in individual routes
app.use('/webhooks', webhookRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  httpServer.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  httpServer.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

// Start server
const PORT = config.port;
httpServer.listen(PORT, () => {
  logger.info(`🚀 MakeVia API Server running on port ${PORT}`);
  logger.info(`📝 Environment: ${config.environment}`);
  logger.info(`🔗 Health check: http://localhost:${PORT}/health`);
  
  if (config.isDevelopment) {
    logger.info(`📚 API Documentation: http://localhost:${PORT}/api/docs`);
  }
});

export default app;