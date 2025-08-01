import { Request, Response } from 'express';
import { logger } from '@/utils/logger';

export const notFoundHandler = (req: Request, res: Response): void => {
  logger.warn('Route not found:', {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });

  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found`,
    code: 'NOT_FOUND',
    timestamp: new Date().toISOString(),
  });
};