import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, PipelineItem } from '../lib/supabase';
import { generateYouTubeScript, isRateLimitError } from '../lib/gemini';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow GET and POST methods
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
  }

  // 1. Verify Authorization (if CRON_SECRET is configured)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
    const querySecret = (req.query.secret || req.query.key) as string;
    const customHeader = req.headers['x-cron-secret'] as string;

    const providedSecret = bearerToken || querySecret || customHeader;

    if (providedSecret !== cronSecret) {
      return res.status(401).json({
        error: 'Unauthorized. Invalid or missing cron secret authorization.',
      });
    }
  }

  try {
    const supabase = getSupabase();
    const cooldownHours = parseFloat(process.env.QUOTA_COOLDOWN_HOURS || '4');

    // 2. Check if there are any jobs currently in 'paused_quota'
    const { data: pausedJobs, error: pausedError } = await supabase
      .from('youtube_pipeline')
      .select('*')
      .eq('status', 'paused_quota')
      .order('quota_paused_at', { ascending: true })
      .limit(1);

    if (pausedError) {
      console.error('Error querying paused jobs:', pausedError);
      return res.status(500).json({ error: 'Database query failed', details: pausedError.message });
    }

    if (pausedJobs && pausedJobs.length > 0) {
      const pausedJob = pausedJobs[0] as PipelineItem;
      const pausedAt = pausedJob.quota_paused_at ? new Date(pausedJob.quota_paused_at).getTime() : 0;
      const now = Date.now();
      const elapsedHours = (now - pausedAt) / (1000 * 60 * 60);

      if (elapsedHours < cooldownHours) {
        const remainingMinutes = Math.ceil((cooldownHours - elapsedHours) * 60);
        console.log(`[Orchestrator] Quota cooldown active. ${remainingMinutes} minutes remaining. Aborting instantly.`);

        return res.status(200).json({
          success: true,
          action: 'paused_quota_active',
          message: `Quota cooldown active. Only ${elapsedHours.toFixed(1)}h elapsed of required ${cooldownHours}h. Execution halted immediately to consume 0 resources.`,
          paused_job_id: pausedJob.id,
          remaining_minutes: remainingMinutes,
        });
      }

      // 4 hours have passed! Release the paused job back to 'pending'
      console.log(`[Orchestrator] 4-hour quota cooldown expired for job ${pausedJob.id}. Resetting to pending.`);
      await supabase
        .from('youtube_pipeline')
        .update({
          status: 'pending',
          quota_paused_at: null,
          error_message: 'Cooldown expired. Re-queued for processing.',
        })
        .eq('id', pausedJob.id);
    }

    // 3. Find the next 'pending' job in queue
    const { data: pendingJobs, error: pendingError } = await supabase
      .from('youtube_pipeline')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (pendingError) {
      console.error('Error querying pending jobs:', pendingError);
      return res.status(500).json({ error: 'Database query failed', details: pendingError.message });
    }

    if (!pendingJobs || pendingJobs.length === 0) {
      return res.status(200).json({
        success: true,
        action: 'idle',
        message: 'No pending jobs in queue. Everything is up to date.',
      });
    }

    const currentJob = pendingJobs[0] as PipelineItem;

    // 4. Mark job as 'processing'
    await supabase
      .from('youtube_pipeline')
      .update({
        status: 'processing',
        updated_at: new Date().toISOString(),
      })
      .eq('id', currentJob.id);

    console.log(`[Orchestrator] Processing job ${currentJob.id} | Topic: "${currentJob.topic}"`);

    // 5. Generate scene-by-scene script using Gemini AI
    try {
      const script = await generateYouTubeScript(currentJob.topic);

      // 6. Update database with generated script and set status to 'ready_for_pc'
      const { error: updateError } = await supabase
        .from('youtube_pipeline')
        .update({
          status: 'ready_for_pc',
          title: script.title,
          script_data: script,
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', currentJob.id);

      if (updateError) {
        throw updateError;
      }

      console.log(`[Orchestrator] Job ${currentJob.id} ready_for_pc! Title: "${script.title}"`);

      return res.status(200).json({
        success: true,
        action: 'ready_for_pc',
        job_id: currentJob.id,
        topic: currentJob.topic,
        title: script.title,
        scenes_count: script.scenes.length,
        duration_seconds: script.total_estimated_duration_seconds,
        status: 'ready_for_pc',
      });
    } catch (genError: any) {
      console.error(`[Orchestrator] Error processing job ${currentJob.id}:`, genError);

      if (isRateLimitError(genError)) {
        // Handle Gemini 429 rate limit
        await supabase
          .from('youtube_pipeline')
          .update({
            status: 'paused_quota',
            quota_paused_at: new Date().toISOString(),
            error_message: `Google Gemini 429 Quota Exceeded: ${genError.message || 'Rate limit hit'}`,
          })
          .eq('id', currentJob.id);

        return res.status(200).json({
          success: false,
          action: 'paused_quota',
          message: 'Google Gemini 429 Rate limit hit. Pipeline state set to paused_quota for 4 hours.',
          job_id: currentJob.id,
        });
      }

      // Handle general execution errors
      const retryCount = (currentJob.retry_count || 0) + 1;
      const nextStatus = retryCount >= 3 ? 'error' : 'pending';

      await supabase
        .from('youtube_pipeline')
        .update({
          status: nextStatus,
          retry_count: retryCount,
          error_message: genError.message || 'Unknown generation error',
        })
        .eq('id', currentJob.id);

      return res.status(500).json({
        success: false,
        action: 'error',
        job_id: currentJob.id,
        next_status: nextStatus,
        error: genError.message || 'Generation failed',
      });
    }
  } catch (error: any) {
    console.error('[Orchestrator] Unexpected error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message || String(error),
    });
  }
}
