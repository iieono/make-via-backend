import { config } from '@/config/config';

/**
 * Design System Utilities for API Responses
 * 
 * This module provides utilities to ensure consistent styling information
 * is sent to the frontend, maintaining design consistency across the application.
 */

// Export design system constants
export const designSystem = config.designSystem;

// Helper to create stylized API responses
export const createApiResponse = (
  data: any,
  options: {
    status?: 'success' | 'error' | 'warning' | 'info';
    theme?: 'light' | 'dark';
    message?: string;
    styling?: boolean;
  } = {}
) => {
  const {
    status = 'success',
    theme = 'dark',
    message,
    styling = true,
  } = options;

  const baseResponse = {
    success: status === 'success',
    status,
    data,
    timestamp: new Date().toISOString(),
  };

  if (message) {
    (baseResponse as any).message = message;
  }

  if (styling) {
    (baseResponse as any).styling = {
      colors: {
        ...designSystem.colors[theme],
        status: designSystem.colors[status === 'error' ? 'error' : status === 'warning' ? 'warning' : status === 'info' ? 'info' : 'success'],
      },
      spacing: designSystem.spacing,
      typography: designSystem.typography,
      uiComponents: designSystem.uiComponents,
    };
  }

  return baseResponse;
};

// Create success response with styling
export const successResponse = (data: any, message?: string, theme: 'light' | 'dark' = 'dark') => {
  return createApiResponse(data, { status: 'success', message, theme });
};

// Create error response with styling
export const errorResponse = (error: string | Error, data?: any, theme: 'light' | 'dark' = 'dark') => {
  const errorMessage = error instanceof Error ? error.message : error;
  return createApiResponse(
    { error: errorMessage, ...data },
    { status: 'error', message: errorMessage, theme }
  );
};

// Create warning response with styling
export const warningResponse = (data: any, message: string, theme: 'light' | 'dark' = 'dark') => {
  return createApiResponse(data, { status: 'warning', message, theme });
};

// Create info response with styling
export const infoResponse = (data: any, message: string, theme: 'light' | 'dark' = 'dark') => {
  return createApiResponse(data, { status: 'info', message, theme });
};

// UI component styling helpers for frontend
export const getComponentStyles = (component: 'button' | 'card' | 'input' | 'text', variant?: string, theme: 'light' | 'dark' = 'dark') => {
  const colors = designSystem.colors[theme];
  
  switch (component) {
    case 'button':
      if (variant === 'secondary') {
        return {
          backgroundColor: designSystem.uiComponents.button.secondary.backgroundColor,
          color: designSystem.uiComponents.button.secondary.color,
          borderRadius: designSystem.uiComponents.button.secondary.borderRadius,
          padding: designSystem.uiComponents.button.secondary.padding,
        };
      }
      return {
        backgroundColor: designSystem.uiComponents.button.primary.backgroundColor,
        color: designSystem.uiComponents.button.primary.color,
        borderRadius: designSystem.uiComponents.button.primary.borderRadius,
        padding: designSystem.uiComponents.button.primary.padding,
      };
      
    case 'card':
      return {
        backgroundColor: designSystem.uiComponents.card.backgroundColor,
        borderRadius: designSystem.uiComponents.card.borderRadius,
        padding: designSystem.uiComponents.card.padding,
        shadow: designSystem.uiComponents.card.shadow,
      };
      
    case 'input':
      return {
        backgroundColor: designSystem.uiComponents.input.backgroundColor,
        borderRadius: designSystem.uiComponents.input.borderRadius,
        padding: designSystem.uiComponents.input.padding,
        borderColor: designSystem.uiComponents.input.borderColor,
        borderWidth: designSystem.uiComponents.input.borderWidth,
      };
      
    case 'text':
      if (variant === 'body') {
        return designSystem.uiComponents.text.body;
      }
      if (variant === 'caption') {
        return designSystem.uiComponents.text.caption;
      }
      return designSystem.uiComponents.text.heading;
      
    default:
      return {};
  }
};

// Theme detection utilities
export const detectTheme = (userAgent?: string): 'light' | 'dark' => {
  // Simple theme detection based on various factors
  // In a real app, this would be more sophisticated and user-configurable
  return 'dark'; // Default to dark theme for MakeVia
};

// Color validation utilities
export const isValidColor = (color: string): boolean => {
  return designSystem.utils.validateColor(color);
};

export const getColorWithFallback = (color: string, fallback: string = designSystem.colors.primary): string => {
  return isValidColor(color) ? color : fallback;
};

// Spacing utilities
export const getSpacing = (size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'xxxl'): number => {
  return designSystem.spacing[size];
};

export const getBorderRadius = (size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl'): number => {
  return designSystem.spacing[`radius${size.charAt(0).toUpperCase() + size.slice(1)}`];
};

// Export all utilities
export const designUtils = {
  createApiResponse,
  successResponse,
  errorResponse,
  warningResponse,
  infoResponse,
  getComponentStyles,
  detectTheme,
  isValidColor,
  getColorWithFallback,
  getSpacing,
  getBorderRadius,
};