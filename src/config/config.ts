import dotenv from 'dotenv';
import { BACKEND_DESIGN_SYSTEM } from './design-system';

dotenv.config();

interface Config {
  // Server
  port: number;
  environment: string;
  isDevelopment: boolean;
  isProduction: boolean;
  
  // CORS
  cors: {
    origins: string[];
  };
  
  // Supabase
  supabase: {
    url: string;
    serviceRoleKey: string;
    anonKey: string;
    storageUrl: string;
  };
  
  // Stripe
  stripe: {
    secretKey: string;
    webhookSecret: string;
    publishableKey: string;
    productIds: {
      creatorMonthly: string;
      creatorYearly: string;
      powerMonthly: string;
      powerYearly: string;
      freeBoost: string;
      creatorBoost: string;
      powerBoost: string;
      exportCredit: string;
    };
    priceIds: {
      pro: string;
      power: string;
    };
  };
  
  // Claude AI
  claude: {
    apiKey: string;
    models: {
      free: string;
      creator: string;
      power: string;
    };
    extraAiPriceIds: {
      ai100Free: string;
      ai100Creator: string;
      ai400Power: string;
    };
    appBuildPriceIds: {
      freeAppBuild: string;
    };
    characterLimits: {
      free: number;
      creator: number;
      power: number;
    };
  };
  
  // Rate Limiting
  rateLimit: {
    windowMs: number;
    maxRequests: number;
    maxAiRequests: number;
  };
  
  // Redis (optional, for rate limiting and caching)
  redis?: {
    url: string;
  };
  
  // URLs
  urls: {
    mobileScheme: string;
    success: string;
    cancel: string;
    deepLinkBase: string;
    frontend: string;
  };
  
  // Security
  security: {
    jwtSecret: string;
    encryptionKey: string;
  };
  
  // Logging
  logging: {
    level: string;
    file?: string;
  };
  
  // Design System
  designSystem: typeof BACKEND_DESIGN_SYSTEM;
}

const getStripeKeys = () => {
  const isDev = process.env.NODE_ENV !== 'production';
  return {
    secretKey: isDev 
      ? process.env.STRIPE_SECRET_KEY_TEST! 
      : process.env.STRIPE_SECRET_KEY_LIVE!,
    webhookSecret: isDev 
      ? process.env.STRIPE_WEBHOOK_SECRET_TEST! 
      : process.env.STRIPE_WEBHOOK_SECRET_LIVE!,
    publishableKey: isDev 
      ? process.env.STRIPE_PUBLISHABLE_KEY_TEST! 
      : process.env.STRIPE_PUBLISHABLE_KEY_LIVE!,
  };
};

const stripeKeys = getStripeKeys();

export const config: Config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  environment: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV !== 'production',
  isProduction: process.env.NODE_ENV === 'production',
  
  // CORS
  cors: {
    origins: [
      'http://localhost:3001',
      'http://localhost:8081', // Expo Metro bundler
      'exp://localhost:19000',  // Expo Go
      'http://127.0.0.1:8081',  // Alternative Expo Metro
      'http://localhost:19000', // Expo web
      'http://localhost:19006', // Expo web alternative
      ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : []),
    ],
  },
  
  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    storageUrl: process.env.SUPABASE_STORAGE_URL || `${process.env.SUPABASE_URL}/storage/v1`,
  },
  
  // Stripe
  stripe: {
    secretKey: stripeKeys.secretKey,
    webhookSecret: stripeKeys.webhookSecret,
    publishableKey: stripeKeys.publishableKey,
    productIds: {
      creatorMonthly: process.env.STRIPE_CREATOR_MONTHLY_PRODUCT_ID || 'prod_SmassYokwK64RI',
      creatorYearly: process.env.STRIPE_CREATOR_YEARLY_PRODUCT_ID || 'prod_Sp6yPQcdg9Ie7k',
      powerMonthly: process.env.STRIPE_POWER_MONTHLY_PRODUCT_ID || 'prod_SmatR83xmmXJfe',
      powerYearly: process.env.STRIPE_POWER_YEARLY_PRODUCT_ID || 'prod_Sp71R8v8gja5vH',
      freeBoost: process.env.STRIPE_FREE_BOOST_PRODUCT_ID || 'prod_SnJ8mB72N7Ds0Y',
      creatorBoost: process.env.STRIPE_CREATOR_BOOST_PRODUCT_ID || 'prod_SnJ9tpME1wzLZy',
      powerBoost: process.env.STRIPE_POWER_BOOST_PRODUCT_ID || 'prod_SnJ9PmCLspnm5g',
      exportCredit: process.env.STRIPE_EXPORT_CREDIT_PRODUCT_ID || 'prod_SnJF0mIG3OKeBs',
    },
    priceIds: {
      pro: process.env.STRIPE_PRO_PRICE_ID || 'price_makevia_pro_monthly',
      power: process.env.STRIPE_POWER_PRICE_ID || 'price_makevia_power_monthly',
    },
  },
  
  // Claude AI
  claude: {
    apiKey: process.env.CLAUDE_API_KEY!,
    models: {
      free: process.env.CLAUDE_MODEL_FREE || 'claude-3-haiku-20240307',
      creator: process.env.CLAUDE_MODEL_CREATOR || 'claude-3-sonnet-20240229', 
      power: process.env.CLAUDE_MODEL_POWER || 'claude-3-sonnet-20240229',
    },
    extraAiPriceIds: {
      ai100Free: process.env.STRIPE_EXTRA_AI_100_FREE_PRICE_ID || 'price_extra_ai_100_free',
      ai100Creator: process.env.STRIPE_EXTRA_AI_100_CREATOR_PRICE_ID || 'price_extra_ai_100_creator', 
      ai400Power: process.env.STRIPE_EXTRA_AI_500_POWER_PRICE_ID || 'price_extra_ai_400_power',
    },
    appBuildPriceIds: {
      freeAppBuild: process.env.STRIPE_FREE_APP_BUILD_PRICE_ID || 'price_free_app_build',
    },
    characterLimits: {
      free: 2000,   // ~500 tokens = $0.0015 cost with Haiku, profitable with 100 credits
      creator: 8000,  // ~2000 tokens = $0.006 cost with Sonnet, profitable with 1500 credits  
      power: 15000,   // ~3750 tokens = $0.011 cost with Sonnet, profitable with 5000 credits
    },
  },
  
  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
    maxAiRequests: parseInt(process.env.RATE_LIMIT_MAX_AI_REQUESTS || '10', 10),
  },
  
  // Redis (optional, for rate limiting and caching)
  redis: process.env.REDIS_URL ? {
    url: process.env.REDIS_URL,
  } : undefined,
  
  // URLs
  urls: {
    mobileScheme: process.env.MOBILE_APP_SCHEME || 'makevia://',
    success: process.env.SUCCESS_URL || 'makevia://subscription/success',
    cancel: process.env.CANCEL_URL || 'makevia://subscription/canceled',
    deepLinkBase: process.env.APP_DEEP_LINK_BASE || 'makevia://',
    frontend: process.env.FRONTEND_URL || 'http://localhost:3001',
  },
  
  // Security
  security: {
    jwtSecret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
    encryptionKey: process.env.ENCRYPTION_KEY || 'your-32-character-encryption-key!!',
  },
  
  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE,
  },
  
  // Design System
  designSystem: BACKEND_DESIGN_SYSTEM,
};

// Validate required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CLAUDE_API_KEY',
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingEnvVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('Please check your .env file and ensure all required variables are set.');
  process.exit(1);
}