import { Request, Response, NextFunction } from 'express';
import { logger } from '@/utils/logger';
import type { ApiError } from '@/types';

export class AppError extends Error implements ApiError {
  public statusCode: number;
  public code?: string;
  public details?: any;
  public isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code?: string,
    details?: any,
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const createError = (
  message: string,
  statusCode: number = 500,
  code?: string,
  details?: any
): AppError => {
  return new AppError(message, statusCode, code, details);
};

// Common error creators
export const ValidationError = (message: string, details?: any) =>
  new AppError(message, 400, 'VALIDATION_ERROR', details);

export const AuthenticationError = (message: string = 'Authentication required') =>
  new AppError(message, 401, 'AUTHENTICATION_ERROR');

export const AuthorizationError = (message: string = 'Access denied') =>
  new AppError(message, 403, 'AUTHORIZATION_ERROR');

export const NotFoundError = (resource: string = 'Resource') =>
  new AppError(`${resource} not found`, 404, 'NOT_FOUND');

export const ConflictError = (message: string, details?: any) =>
  new AppError(message, 409, 'CONFLICT_ERROR', details);

export const RateLimitError = (message: string = 'Rate limit exceeded') =>
  new AppError(message, 429, 'RATE_LIMIT_ERROR');

export const InternalServerError = (message: string = 'Internal server error') =>
  new AppError(message, 500, 'INTERNAL_SERVER_ERROR');

export const ServiceUnavailableError = (message: string = 'Service unavailable') =>
  new AppError(message, 503, 'SERVICE_UNAVAILABLE');

// Handle different types of errors
const handleSupabaseError = (error: any): AppError => {
  if (error.code === 'PGRST116') {
    return NotFoundError('Resource');
  }
  
  if (error.code === '23505') {
    return ConflictError('Resource already exists', { constraint: error.constraint });
  }
  
  if (error.code === '23503') {
    return ValidationError('Referenced resource does not exist', { constraint: error.constraint });
  }
  
  if (error.code === '23514') {
    return ValidationError('Data validation failed', { constraint: error.constraint });
  }

  return InternalServerError(`Database error: ${error.message}`);
};

const handleStripeError = (error: any): AppError => {
  switch (error.type) {
    case 'StripeCardError':
      return ValidationError('Card was declined', { decline_code: error.decline_code });
    case 'StripeRateLimitError':
      return RateLimitError('Too many requests to Stripe API');
    case 'StripeInvalidRequestError':
      return ValidationError(`Invalid request: ${error.message}`);
    case 'StripeAPIError':
      return ServiceUnavailableError('Payment service temporarily unavailable');
    case 'StripeConnectionError':
      return ServiceUnavailableError('Unable to connect to payment service');
    case 'StripeAuthenticationError':
      return InternalServerError('Payment configuration error');
    default:
      return InternalServerError(`Payment error: ${error.message}`);
  }
};

const handleClaudeError = (error: any): AppError => {
  if (error.status === 400) {
    return ValidationError(`AI service error: ${error.message}`);
  }
  
  if (error.status === 401) {
    return InternalServerError('AI service authentication error');
  }
  
  if (error.status === 429) {
    return RateLimitError('AI service rate limit exceeded');
  }
  
  if (error.status >= 500) {
    return ServiceUnavailableError('AI service temporarily unavailable');
  }

  return InternalServerError(`AI service error: ${error.message}`);
};

const handleJWTError = (error: any): AppError => {
  if (error.name === 'JsonWebTokenError') {
    return AuthenticationError('Invalid token');
  }
  
  if (error.name === 'TokenExpiredError') {
    return AuthenticationError('Token expired');
  }
  
  if (error.name === 'NotBeforeError') {
    return AuthenticationError('Token not active');
  }

  return AuthenticationError('Token validation failed');
};

const handleValidationError = (error: any): AppError => {
  if (error.details) {
    const validationErrors = error.details.map((detail: any) => ({
      field: detail.path?.join('.'),
      message: detail.message,
    }));
    
    return ValidationError('Validation failed', { errors: validationErrors });
  }
  
  return ValidationError(error.message);
};

// Main error handler middleware
export const errorHandler = (
  error: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  let appError: AppError;

  // If it's already an AppError, use it directly
  if (error instanceof AppError) {
    appError = error;
  } else {
    // Convert different error types to AppError
    if (error.message?.includes('supabase') || error.message?.includes('postgres')) {
      appError = handleSupabaseError(error);
    } else if (error.message?.includes('stripe') || error.constructor.name?.includes('Stripe')) {
      appError = handleStripeError(error);
    } else if (error.message?.includes('claude') || error.message?.includes('anthropic')) {
      appError = handleClaudeError(error);
    } else if (error.name?.includes('JsonWebToken') || error.name?.includes('Token')) {
      appError = handleJWTError(error);
    } else if (error.name === 'ValidationError') {
      appError = handleValidationError(error);
    } else {
      // Generic error
      appError = InternalServerError(
        process.env.NODE_ENV === 'production' 
          ? 'Something went wrong' 
          : error.message
      );
    }
  }

  // Log the error
  const logLevel = appError.statusCode >= 500 ? 'error' : 'warn';
  logger[logLevel]('API Error:', {
    error: error.message,
    stack: error.stack,
    statusCode: appError.statusCode,
    code: appError.code,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.body,
    params: req.params,
    query: req.query,
  });

  // Send error response
  const response = {
    success: false,
    error: appError.message,
    code: appError.code,
    ...(appError.details && { details: appError.details }),
    timestamp: new Date().toISOString(),
    ...(process.env.NODE_ENV !== 'production' && {
      stack: appError.stack,
    }),
  };

  res.status(appError.statusCode).json(response);
};

// 404 handler for unmatched routes
export const notFoundHandler = (req: Request, res: Response): void => {
  const error = NotFoundError(`Route ${req.method} ${req.path}`);
  
  logger.warn('Route not found:', {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });

  res.status(error.statusCode).json({
    success: false,
    error: error.message,
    code: error.code,
    timestamp: new Date().toISOString(),
  });
};

// Async wrapper to catch errors in async route handlers
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Global unhandled rejection and exception handlers
export const setupGlobalErrorHandlers = (): void => {
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit the process in production, just log the error
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  });

  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught Exception:', error);
    // Exit the process for uncaught exceptions
    process.exit(1);
  });
};