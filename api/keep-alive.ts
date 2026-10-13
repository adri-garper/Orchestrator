import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from './lib/supabase';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startTime = Date.now();

  try {
    const supabase = getSupabase();

    // 1. Perform a lightweight query to Supabase to reset the 7-day inactivity timer
    const { data, error } = await supabase
      .from('youtube_pipeline')
      .select('id, status')
      .limit(1);

    if (error) {
      console.error('[Keep-Alive] Supabase ping warning:', error.message);
      return res.status(500).json({
        status: 'error',
        platform: 'vercel',
        supabase_status: 'disconnected',
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }

    const durationMs = Date.now() - startTime;

    return res.status(200).json({
      status: 'alive',
      message: 'Both Vercel serverless runtime and Supabase database are awake and active.',
      timestamp: new Date().toISOString(),
      latency_ms: durationMs,
      supabase_status: 'healthy',
      items_in_pipeline: data ? data.length : 0,
    });
  } catch (err: any) {
    console.error('[Keep-Alive] Unexpected failure:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to complete keep-alive check',
      details: err.message || String(err),
      timestamp: new Date().toISOString(),
    });
  }
}
