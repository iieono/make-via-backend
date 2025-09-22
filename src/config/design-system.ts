/**
 * Backend Design System Configuration
 * 
 * This file ensures consistency between backend API responses and frontend design.
 * All styling constants and color definitions should match the frontend design system.
 */

// Color palette - Must match frontend Colors.ts
export const BACKEND_COLORS = {
  // Primary palette
  primary: '#F4F1ED',        // Warm accent (primary color)
  primaryHover: '#EFEAE5',   // Hover state
  primaryPressed: '#E9E4DF', // Pressed state
  primarySubtle: '#F9F6F3',  // Subtle backgrounds
  
  // Coral accent color
  coral: '#E27D60',          // Coral for highlights and CTAs
  coralHover: '#DC7256',     // Coral hover
  coralPressed: '#D6684C',   // Coral pressed
  
  // Core grayscale palette
  darkGray: '#1A1A1A',       // Main background (Scaffold)
  veryDarkGray: '#0F0F0F',   // Deeper dark for elevation
  softDark: '#2A2A2A',       // Lighter dark for elevated surfaces
  mediumGray: '#B0B0B0',     // Borders, secondary text, icons
  lightGray: '#E5E5E5',      // Cards, surfaces, input fields
  veryLightGray: '#F0F0F0',  // Lighter than main light gray
  darkMediumGray: '#808080', // Darker medium for disabled states
  lightMediumGray: '#C0C0C0',// Lighter medium for subtle borders
  
  // Surface colors
  background: '#1A1A1A',     // Main background
  surface: '#E5E5E5',        // Cards and surfaces
  surfaceVariant: '#F0F0F0', // Alternative surface
  surfaceDark: '#2A2A2A',    // Dark surfaces/elevated on dark bg
  
  // Text colors
  textPrimary: '#E5E5E5',    // Primary text on dark background
  textSecondary: '#B0B0B0',  // Secondary text
  textTertiary: '#808080',   // Tertiary/hint text
  textOnCard: '#1A1A1A',     // Text on light cards
  textOnCardSecondary: '#808080', // Secondary text on light cards
  
  // Interactive elements
  border: '#C0C0C0',         // Borders and outlines
  borderSubtle: '#D0D0D0',   // Very subtle borders
  divider: '#C0C0C0',        // Dividers
  disabled: '#808080',       // Disabled elements
  outline: '#B0B0B0',        // Outline color
  
  // Status colors
  success: '#4CAF50',       // Standard green
  error: '#E53E3E',         // Standard red
  warning: '#FF9800',       // Standard orange
  info: '#B0B0B0',          // Use medium gray for info
  
  // Light theme colors
  light: {
    background: '#FFFFFF',
    surface: '#F5F5F5',
    surfaceVariant: '#E0E0E0',
    text: '#000000',
    secondaryText: '#666666',
    card: '#FFFFFF',
    border: '#E0E0E0',
    divider: '#E0E0E0',
  },
  
  // Dark theme colors
  dark: {
    background: '#1A1A1A',
    surface: '#2A2A2A',
    surfaceVariant: '#3A3A3A',
    text: '#FFFFFF',
    secondaryText: '#B0B0B0',
    card: '#2A2A2A',
    border: '#3A3A3A',
    divider: '#3A3A3A',
  },
};

// Spacing system - Must match frontend DesignSystem.ts
export const BACKEND_SPACING = {
  // Base unit - 8pt
  unit: 8,
  
  // Spacing values (multiples of 8)
  xs: 4,    // 0.5 unit
  sm: 8,    // 1 unit  
  md: 16,   // 2 units
  lg: 24,   // 3 units
  xl: 32,   // 4 units
  xxl: 40,  // 5 units
  xxxl: 48, // 6 units
  
  // Border radius values (Apple-style smooth rounded corners)
  radiusXs: 4,   // 0.5 unit - tiny elements
  radiusSm: 8,   // 1 unit - small elements  
  radiusMd: 12,  // 1.5 units - medium elements
  radiusLg: 16,  // 2 units - cards, buttons
  radiusXl: 20,  // 2.5 units - large surfaces
  radiusXxl: 24, // 3 units - modal dialogs
};

// Typography scale - Must match frontend DesignSystem.ts
export const BACKEND_TYPOGRAPHY = {
  fontFamily: 'Manrope',
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    xxl: 24,
    xxxl: 32,
  },
  fontWeight: {
    light: '300',
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.75,
  },
};

// Animation durations
export const BACKEND_ANIMATION = {
  fast: 150,
  normal: 300,
  slow: 500,
};

// Z-index layers for frontend reference
export const BACKEND_Z_INDEX = {
  modal: 1000,
  drawer: 900,
  popover: 800,
  tooltip: 700,
  header: 600,
  footer: 500,
  content: 100,
  background: 0,
};

// API response styling utilities
export const createStylizedResponse = (
  data: any,
  status: 'success' | 'error' | 'warning' | 'info' = 'success',
  theme: 'light' | 'dark' = 'dark'
) => {
  const colors = theme === 'light' ? BACKEND_COLORS.light : BACKEND_COLORS.dark;
  const statusColors = {
    success: BACKEND_COLORS.success,
    error: BACKEND_COLORS.error,
    warning: BACKEND_COLORS.warning,
    info: BACKEND_COLORS.info,
  };

  return {
    success: status === 'success',
    status,
    data,
    styling: {
      colors: {
        ...colors,
        status: statusColors[status],
      },
      spacing: BACKEND_SPACING,
      typography: BACKEND_TYPOGRAPHY,
    },
    timestamp: new Date().toISOString(),
  };
};

// UI component styling for API responses
export const UI_COMPONENT_STYLES = {
  // Button styles
  button: {
    primary: {
      backgroundColor: BACKEND_COLORS.coral,
      color: BACKEND_COLORS.darkGray,
      borderRadius: BACKEND_SPACING.radiusLg,
      padding: `${BACKEND_SPACING.md}px ${BACKEND_SPACING.lg}px`,
    },
    secondary: {
      backgroundColor: BACKEND_COLORS.surfaceDark,
      color: BACKEND_COLORS.textPrimary,
      borderRadius: BACKEND_SPACING.radiusLg,
      padding: `${BACKEND_SPACING.md}px ${BACKEND_SPACING.lg}px`,
    },
  },
  
  // Card styles
  card: {
    backgroundColor: BACKEND_COLORS.surfaceDark,
    borderRadius: BACKEND_SPACING.radiusLg,
    padding: BACKEND_SPACING.lg,
    shadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
  },
  
  // Input styles
  input: {
    backgroundColor: BACKEND_COLORS.surface,
    borderRadius: BACKEND_SPACING.radiusMd,
    padding: BACKEND_SPACING.md,
    borderColor: BACKEND_COLORS.border,
    borderWidth: 1,
  },
  
  // Text styles
  text: {
    heading: {
      fontSize: BACKEND_TYPOGRAPHY.fontSize.xxl,
      fontWeight: BACKEND_TYPOGRAPHY.fontWeight.semibold,
      color: BACKEND_COLORS.textPrimary,
    },
    body: {
      fontSize: BACKEND_TYPOGRAPHY.fontSize.base,
      fontWeight: BACKEND_TYPOGRAPHY.fontWeight.regular,
      color: BACKEND_COLORS.textSecondary,
    },
    caption: {
      fontSize: BACKEND_TYPOGRAPHY.fontSize.sm,
      fontWeight: BACKEND_TYPOGRAPHY.fontWeight.regular,
      color: BACKEND_COLORS.textTertiary,
    },
  },
};

// Validation helpers
export const validateColor = (color: string): boolean => {
  return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
};

export const validateSpacing = (spacing: number): boolean => {
  return [4, 8, 16, 24, 32, 40, 48].includes(spacing);
};

// Export all constants for easy import
export const BACKEND_DESIGN_SYSTEM = {
  colors: BACKEND_COLORS,
  spacing: BACKEND_SPACING,
  typography: BACKEND_TYPOGRAPHY,
  animation: BACKEND_ANIMATION,
  zIndex: BACKEND_Z_INDEX,
  uiComponents: UI_COMPONENT_STYLES,
  utils: {
    createStylizedResponse,
    validateColor,
    validateSpacing,
  },
};