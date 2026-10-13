import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from './_supabase';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const supabase = getSupabase();

    // If POST, allow adding a new video topic to the queue
    if (req.method === 'POST') {
      const { topic } = req.body || {};
      if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
        return res.status(400).json({ error: 'A valid "topic" string is required.' });
      }

      const { data, error } = await supabase
        .from('youtube_pipeline')
        .insert([{ topic: topic.trim(), status: 'pending' }])
        .select()
        .single();

      if (error) {
        return res.status(500).json({ error: 'Failed to insert topic', details: error.message });
      }

      return res.status(201).json({
        success: true,
        message: 'Topic queued successfully.',
        item: data,
      });
    }

    // GET: Return summary stats and recent pipeline items
    const { data: items, error } = await supabase
      .from('youtube_pipeline')
      .select('id, topic, title, status, quota_paused_at, error_message, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      return res.status(500).json({ error: 'Database fetch failed', details: error.message });
    }

    const counts = {
      pending: 0,
      processing: 0,
      paused_quota: 0,
      ready_for_pc: 0,
      completed: 0,
      error: 0,
      total: items?.length || 0,
    };

    items?.forEach((item) => {
      const st = item.status as keyof typeof counts;
      if (counts[st] !== undefined) {
        counts[st]++;
      }
    });

    const cooldownHours = parseFloat(process.env.QUOTA_COOLDOWN_HOURS || '4');
    let activeQuotaPause: { paused_at: string; remaining_minutes: number } | null = null;

    const pausedItem = items?.find((i) => i.status === 'paused_quota');
    if (pausedItem && pausedItem.quota_paused_at) {
      const elapsedHours = (Date.now() - new Date(pausedItem.quota_paused_at).getTime()) / (1000 * 60 * 60);
      const remainingMinutes = Math.max(0, Math.ceil((cooldownHours - elapsedHours) * 60));
      activeQuotaPause = {
        paused_at: pausedItem.quota_paused_at,
        remaining_minutes: remainingMinutes,
      };
    }

    return res.status(200).json({
      success: true,
      counts,
      active_quota_pause: activeQuotaPause,
      recent_items: items || [],
    });
  } catch (error: any) {
    return res.status(500).json({
      error: 'Failed to retrieve pipeline status',
      details: error.message || String(error),
    });
  }
}
