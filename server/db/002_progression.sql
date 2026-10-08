-- Phase 7: mastery allocation and discovered landmarks per character.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS mastery jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS discovered jsonb NOT NULL DEFAULT '[]'::jsonb;
