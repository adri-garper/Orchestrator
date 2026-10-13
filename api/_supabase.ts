import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

export interface PipelineItem {
  id: string;
  topic: string;
  title?: string | null;
  status: 'pending' | 'processing' | 'paused_quota' | 'ready_for_pc' | 'completed' | 'error';
  quota_paused_at?: string | null;
  script_data?: ScriptData | null;
  audio_urls?: string[];
  image_urls?: string[];
  video_url?: string | null;
  error_message?: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface ScriptScene {
  scene_number: number;
  duration_seconds: number;
  narration: string;
  visual_description: string;
  image_prompt: string;
  text_overlay?: string;
}

export interface ScriptData {
  title: string;
  target_audience: string;
  total_estimated_duration_seconds: number;
  tags: string[];
  scenes: ScriptScene[];
}

let supabaseInstance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (supabaseInstance) {
    return supabaseInstance;
  }

  const supabaseUrl = (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ''
  ).replace(/^["']|["']$/g, '').trim();

  const supabaseKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  ).replace(/^["']|["']$/g, '').trim();

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.');
  }

  supabaseInstance = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseInstance;
}
