-- Phase 10: pets (owned, active, rare quests, Bond Trial luck).
ALTER TABLE characters ADD COLUMN IF NOT EXISTS pets jsonb NOT NULL DEFAULT '{}'::jsonb;
