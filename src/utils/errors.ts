/**
 * Custom error classes for the application
 */

export class ValidationError extends Error {
  public statusCode: number = 400;
  
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Error.captureStackTrace(this, ValidationError);
  }
}

export class AuthenticationError extends Error {
  public statusCode: number = 401;
  
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
    Error.captureStackTrace(this, AuthenticationError);
  }
}

export class ForbiddenError extends Error {
  public statusCode: number = 403;
  
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
    Error.captureStackTrace(this, ForbiddenError);
  }
}

export class NotFoundError extends Error {
  public statusCode: number = 404;
  
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
    Error.captureStackTrace(this, NotFoundError);
  }
}

export class ConflictError extends Error {
  public statusCode: number = 409;
  
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
    Error.captureStackTrace(this, ConflictError);
  }
}

export class InternalServerError extends Error {
  public statusCode: number = 500;
  
  constructor(message: string) {
    super(message);
    this.name = 'InternalServerError';
    Error.captureStackTrace(this, InternalServerError);
  }
}