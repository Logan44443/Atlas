-- Phase 9: materials carried, building milestones, and camp structures.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS inv jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS milestones jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS structures (
  id          text PRIMARY KEY,
  owner       uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS structures_owner ON structures (owner);
