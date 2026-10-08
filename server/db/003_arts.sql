-- Phase 8: Special Arts (learned, equipped, quests in progress, bounty).
ALTER TABLE characters ADD COLUMN IF NOT EXISTS arts jsonb NOT NULL DEFAULT '{}'::jsonb;
