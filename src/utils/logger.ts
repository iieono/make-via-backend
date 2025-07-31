import winston from 'winston';
import { config } from '@/config/config';

const { combine, timestamp, errors, json, printf, colorize } = winston.format;

// Custom format for development
const devFormat = printf(({ level, message, timestamp: ts, stack }) => {
  const formattedTimestamp = new Date(ts as string).toLocaleTimeString();
  if (stack) {
    return `${formattedTimestamp} [${level}]: ${message}\n${stack}`;
  }
  return `${formattedTimestamp} [${level}]: ${message}`;
});

// Create logger
export const logger = winston.createLogger({
  level: config.logging.level,
  format: combine(
    timestamp(),
    errors({ stack: true }),
    config.isDevelopment
      ? combine(colorize(), devFormat)
      : json()
  ),
  defaultMeta: { service: 'makevia-api' },
  transports: [
    // Console transport
    new winston.transports.Console({
      silent: process.env.NODE_ENV === 'test',
    }),
    
    // File transport (if configured)
    ...(config.logging.file
      ? [
          new winston.transports.File({
            filename: config.logging.file,
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 3,
          }),
          new winston.transports.File({
            filename: config.logging.file.replace('.log', '-combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5,
          }),
        ]
      : []),
  ],
});

// Handle uncaught exceptions and unhandled rejections
if (!config.isDevelopment) {
  logger.exceptions.handle(
    new winston.transports.File({ filename: 'logs/exceptions.log' })
  );
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
}