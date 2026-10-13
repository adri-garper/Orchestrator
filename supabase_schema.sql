-- ==============================================================================
-- SUPABASE SCHEMA FOR YOUTUBE ORCHESTRATOR
-- Execute this script in your Supabase Project -> SQL Editor
-- ==============================================================================

-- 1. Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Create the youtube_pipeline table
CREATE TABLE IF NOT EXISTS youtube_pipeline (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'paused_quota', 'ready_for_pc', 'completed', 'error')
    ),
    quota_paused_at TIMESTAMPTZ,
    script_data JSONB,
    audio_urls JSONB DEFAULT '[]'::jsonb,
    image_urls JSONB DEFAULT '[]'::jsonb,
    video_url TEXT,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Indexes for fast status lookups and queue sorting
CREATE INDEX IF NOT EXISTS idx_youtube_pipeline_status ON youtube_pipeline(status);
CREATE INDEX IF NOT EXISTS idx_youtube_pipeline_created ON youtube_pipeline(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_youtube_pipeline_quota ON youtube_pipeline(quota_paused_at);

-- 4. Automatically update the updated_at column on row modification
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_youtube_pipeline_updated_at ON youtube_pipeline;
CREATE TRIGGER trigger_youtube_pipeline_updated_at
    BEFORE UPDATE ON youtube_pipeline
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 5. Create storage bucket for generated audio & images
INSERT INTO storage.buckets (id, name, public)
VALUES ('youtube-assets', 'youtube-assets', true)
ON CONFLICT (id) DO NOTHING;

-- 6. Storage bucket policy: allow public read of assets
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'objects' AND policyname = 'Public Access youtube-assets'
    ) THEN
        CREATE POLICY "Public Access youtube-assets"
        ON storage.objects FOR SELECT
        USING (bucket_id = 'youtube-assets');
    END IF;
END $$;

-- 7. Insert an initial sample video job to test immediately
INSERT INTO youtube_pipeline (topic, status)
VALUES ('Curiosidades fascinantes sobre el espacio profundo que no te enseñaron en la escuela', 'pending')
ON CONFLICT DO NOTHING;
