import { Router } from 'express';
import { stripeService } from '@/services/stripe';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import rateLimits from '@/middleware/rateLimit';
import type { StripeWebhookEvent } from '@/types';

const router = Router();

// Stripe webhook endpoint (no auth required, Stripe signature verification instead)
router.post('/stripe', 
  rateLimits.webhook,
  // Important: Use raw body for Stripe webhooks
  asyncHandler(async (req, res) => {
    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      logger.warn('Missing Stripe signature header');
      res.status(400).json({
        success: false,
        error: 'Missing Stripe signature',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // Verify and handle the webhook event
      const event = await stripeService.handleWebhookEvent(
        req.body, // Raw body needed for signature verification
        signature
      );

      logger.info(`Successfully processed Stripe webhook: ${event.type}`, {
        eventId: event.id,
        eventType: event.type,
      });

      res.json({
        success: true,
        message: 'Webhook processed successfully',
        eventId: event.id,
        eventType: event.type,
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      logger.error('Stripe webhook processing failed:', {
        error: error.message,
        signature: signature.substring(0, 20) + '...',
      });

      // Return 400 for invalid signatures, 500 for other errors
      const statusCode = error.message?.includes('signature') ? 400 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: 'Webhook processing failed',
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// Test webhook endpoint (development only)
if (process.env.NODE_ENV === 'development') {
  router.post('/test-stripe', asyncHandler(async (req, res) => {
    const { eventType, data } = req.body;

    if (!eventType || !data) {
      res.status(400).json({
        success: false,
        error: 'eventType and data are required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Create a mock Stripe event for testing
    const mockEvent: StripeWebhookEvent = {
      id: `evt_test_${Date.now()}`,
      type: eventType,
      data: {
        object: data,
      },
      created: Math.floor(Date.now() / 1000),
    };

    logger.info(`Processing test webhook: ${eventType}`);

    try {
      // Process the mock event (but skip signature verification)
      switch (eventType) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          // Handle subscription change logic here if needed for testing
          break;
        case 'customer.subscription.deleted':
          // Handle subscription deletion logic here if needed for testing
          break;
        case 'invoice.payment_succeeded':
          // Handle successful payment logic here if needed for testing
          break;
        case 'invoice.payment_failed':
          // Handle failed payment logic here if needed for testing
          break;
        default:
          logger.info(`Unhandled test webhook event type: ${eventType}`);
      }

      res.json({
        success: true,
        message: 'Test webhook processed successfully',
        eventId: mockEvent.id,
        eventType: mockEvent.type,
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      logger.error('Test webhook processing failed:', error);
      
      res.status(500).json({
        success: false,
        error: 'Test webhook processing failed',
        details: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }));
}

// Webhook status endpoint (for monitoring)
router.get('/status', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      stripe_endpoint: '/webhooks/stripe',
      status: 'active',
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  });
}));

export default router;