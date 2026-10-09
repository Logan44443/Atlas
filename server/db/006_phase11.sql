-- Phase 11: faction standing, crews, crew bases and territory.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS standing jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS crews (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  tag         text NOT NULL,
  faction     text NOT NULL,
  -- xp, bank, coins, raid window, message of the day
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crews_name ON crews (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS crews_tag ON crews (upper(tag));

CREATE TABLE IF NOT EXISTS crew_members (
  character_id  uuid PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  crew_id       uuid NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member',
  joined_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crew_members_crew ON crew_members (crew_id);

-- Crew base pieces belong to the crew (owner stays in data so the builder can take theirs down).
ALTER TABLE structures ALTER COLUMN owner DROP NOT NULL;
ALTER TABLE structures ADD COLUMN IF NOT EXISTS crew uuid REFERENCES crews(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS territory (
  id          text PRIMARY KEY,
  owner       text NOT NULL DEFAULT '',
  crew        text NOT NULL DEFAULT '',
  held_since  bigint NOT NULL DEFAULT 0
);
