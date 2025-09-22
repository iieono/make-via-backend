import { Router } from 'express';
import { claudeService } from '@/services/claude';
import { supabase } from '@/services/supabase';
import { logger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import rateLimits from '@/middleware/rateLimit';
import type { AuthenticatedRequest } from '@/types';
import {
  ValidationError,
  NotFoundError,
} from '@/middleware/errorHandler';

const router = Router();

// Apply rate limiting to all monitoring routes
router.use(rateLimits.monitoring);

// Get user's current usage limits and consumption
router.get('/limits', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;

  try {
    const limits = await claudeService.getUserUsageLimits(user.id);

    res.json({
      success: true,
      data: limits,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error fetching user limits:', error);
    throw error;
  }
}));

// Get user's token consumption history
router.get('/consumption', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const days = parseInt(req.query.days as string) || 30;

  if (days < 1 || days > 365) {
    throw ValidationError('Days parameter must be between 1 and 365');
  }

  try {
    const consumption = await claudeService.getUserTokenConsumption(user.id, days);

    res.json({
      success: true,
      data: consumption,
      period: {
        days: days,
        start_date: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        end_date: new Date().toISOString().split('T')[0],
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error fetching user consumption:', error);
    throw error;
  }
}));

// Abuse status endpoint removed - using monthly limits only

// Get user's generation history with abuse incidents
router.get('/generation-history', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    // Get generation logs
    const { data: generations, error: genError } = await supabase
      .from('ai_generation_logs')
      .select(`
        id,
        created_at,
        prompt_text,
        model_used,
        tokens_used,
        cost_usd,
        status,
        processing_time_ms
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (genError) {
      logger.error('Error fetching generation history:', genError);
      throw genError;
    }

    // Abuse incidents removed - using monthly limits only

    res.json({
      success: true,
      data: {
        generations: generations || [],
        pagination: {
          limit,
          offset,
          has_more: (generations?.length || 0) === limit,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error fetching generation history:', error);
    throw error;
  }
}));

// Get system-wide monitoring stats (admin only - would need admin middleware)
router.get('/system-stats', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  // For now, just return user's own stats
  // In production, add admin role check
  const user = req.user!;

  try {
    // Get today's system-wide stats (simplified for demo)
    const today = new Date().toISOString().split('T')[0];

    const { data: dailyStats, error: statsError } = await supabase
      .from('user_token_consumption')
      .select(`
        total_tokens,
        total_cost_usd,
        total_generations
      `)
      .eq('date', today);

    if (statsError) {
      logger.error('Error fetching system stats:', statsError);
      throw statsError;
    }

    // Aggregate stats
    const stats = (dailyStats || []).reduce(
      (acc, day) => ({
        total_tokens: acc.total_tokens + (day.total_tokens || 0),
        total_cost: acc.total_cost + Number(day.total_cost_usd || 0),
        total_generations: acc.total_generations + (day.total_generations || 0),
      }),
      { total_tokens: 0, total_cost: 0, total_generations: 0 }
    );

    // Get abuse incidents today
    const { data: abuseIncidents, error: abuseError } = await supabase
      .from('abuse_incidents')
      .select('incident_type, severity')
      .gte('created_at', `${today}T00:00:00.000Z`)
      .lte('created_at', `${today}T23:59:59.999Z`);

    if (abuseError) {
      logger.error('Error fetching abuse incidents:', abuseError);
    }

    res.json({
      success: true,
      data: {
        daily_stats: {
          date: today,
          ...stats,
          active_users: dailyStats?.length || 0,
        },
        abuse_summary: {
          total_incidents: abuseIncidents?.length || 0,
          incidents_by_type: (abuseIncidents || []).reduce((acc, inc) => {
            acc[inc.incident_type] = (acc[inc.incident_type] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error fetching system stats:', error);
    throw error;
  }
}));

// Check if generation is allowed (pre-generation check)
router.post('/check-generation', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    throw ValidationError('Prompt is required');
  }

  try {
    const subscription = await supabase.getUserSubscription(user.id);
    if (!subscription) {
      throw NotFoundError('User subscription not found');
    }

    // Get character limit
    const { data: charLimitData, error: charError } = await supabase
      .from('generation_limits')
      .select('limit_value')
      .eq('limit_type', 'character_limit')
      .eq('tier', subscription.tier)
      .single();

    const characterLimit = charLimitData?.limit_value || 2000;

    // Check character limit
    if (prompt.length > characterLimit) {
      res.json({
        success: false,
        allowed: false,
        reason: 'character_limit_exceeded',
        message: `Prompt exceeds character limit of ${characterLimit} characters`,
        details: {
          prompt_length: prompt.length,
          character_limit: characterLimit,
          tier: subscription.tier,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Daily/hourly limits removed - using monthly limits only

    // Check available generations
    const { data: availableGens } = await supabase.rpc('get_available_generations', {
      user_uuid: user.id,
    });

    const available = availableGens?.[0]?.total_available || 0;

    if (available <= 0) {
      res.json({
        success: false,
        allowed: false,
        reason: 'generation_limit_exceeded',
        message: 'AI generation limit exceeded for current billing period',
        details: {
          subscription_remaining: availableGens?.[0]?.subscription_remaining || 0,
          extra_remaining: availableGens?.[0]?.extra_remaining || 0,
          tier: subscription.tier,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // All checks passed
    res.json({
      success: true,
      allowed: true,
      message: 'Generation allowed',
      details: {
        prompt_length: prompt.length,
        character_limit: characterLimit,
        available_generations: available,
        tier: subscription.tier,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('Error checking generation allowance:', error);
    throw error;
  }
}));

export default router;