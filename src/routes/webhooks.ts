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

// Webhook monitoring dashboard (for ops team)
router.get('/metrics', asyncHandler(async (req, res) => {
  try {
    const { webhookProcessor } = await import('@/services/webhook-processor');
    const metrics = await webhookProcessor.getWebhookMetrics();
    
    res.json({
      success: true,
      data: metrics,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch webhook metrics',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}));

// Webhook replay endpoint (for failed events)
router.post('/replay/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { force } = req.body;

  if (!eventId) {
    res.status(400).json({
      success: false,
      error: 'Event ID is required',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const { supabase } = await import('@/services/supabase');
    
    // Get the webhook event
    const { data: webhookEvent, error } = await supabase.serviceClient
      .from('webhook_events')
      .select('*')
      .eq('stripe_event_id', eventId)
      .single();

    if (error || !webhookEvent) {
      res.status(404).json({
        success: false,
        error: 'Webhook event not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check if event was already processed successfully
    if (webhookEvent.processed && !force) {
      res.status(400).json({
        success: false,
        error: 'Event already processed. Use force=true to replay anyway.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Replay the event
    const { webhookProcessor } = await import('@/services/webhook-processor');
    await webhookProcessor.processWebhookEvent(webhookEvent.event_data);

    res.json({
      success: true,
      message: `Webhook event ${eventId} replayed successfully`,
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Failed to replay webhook event',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}));

// Process pending retries endpoint (for background job)
router.post('/process-retries', asyncHandler(async (req, res) => {
  try {
    const { webhookProcessor } = await import('@/services/webhook-processor');
    await webhookProcessor.processPendingRetries();

    res.json({
      success: true,
      message: 'Pending webhook retries processed',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Failed to process pending retries',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}));

// Get failed webhook events for debugging
router.get('/failed', asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    const { supabase } = await import('@/services/supabase');
    
    const { data: failedEvents, error } = await supabase.serviceClient
      .from('webhook_events')
      .select('stripe_event_id, event_type, error_message, processing_attempts, created_at')
      .eq('processed', false)
      .not('error_message', 'is', null)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: failedEvents || [],
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        total: failedEvents?.length || 0,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch failed webhook events',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}));

// Webhook status endpoint (for monitoring)
router.get('/status', asyncHandler(async (req, res) => {
  try {
    const { webhookProcessor } = await import('@/services/webhook-processor');
    const metrics = await webhookProcessor.getWebhookMetrics();
    
    res.json({
      success: true,
      data: {
        stripe_endpoint: '/webhooks/stripe',
        status: metrics.success_rate > 95 ? 'healthy' : 'degraded',
        environment: process.env.NODE_ENV,
        metrics: {
          success_rate: `${metrics.success_rate.toFixed(2)}%`,
          total_events_24h: metrics.total_events,
          pending_retries: metrics.pending_retries,
        },
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      data: {
        stripe_endpoint: '/webhooks/stripe',
        status: 'error',
        environment: process.env.NODE_ENV,
        error: error.message,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });
  }
}));

export default router;