import dotenv from 'dotenv';

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
  };
  
  // Stripe
  stripe: {
    secretKey: string;
    webhookSecret: string;
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
      pro: string;
      power: string;
    };
  };
  
  // Rate Limiting
  rateLimit: {
    windowMs: number;
    maxRequests: number;
    maxAiRequests: number;
  };
  
  // URLs
  urls: {
    frontend: string;
    success: string;
    cancel: string;
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
    origins: (process.env.CORS_ORIGIN || 'http://localhost:3001').split(','),
  },
  
  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
  },
  
  // Stripe
  stripe: {
    secretKey: stripeKeys.secretKey,
    webhookSecret: stripeKeys.webhookSecret,
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
      pro: process.env.CLAUDE_MODEL_PRO || 'claude-3-sonnet-20240229',
      power: process.env.CLAUDE_MODEL_POWER || 'claude-3-opus-20240229',
    },
  },
  
  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
    maxAiRequests: parseInt(process.env.RATE_LIMIT_MAX_AI_REQUESTS || '10', 10),
  },
  
  // URLs
  urls: {
    frontend: process.env.FRONTEND_URL || 'http://localhost:3001',
    success: process.env.SUCCESS_URL || 'makevia://subscription/success',
    cancel: process.env.CANCEL_URL || 'makevia://subscription/canceled',
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