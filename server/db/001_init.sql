-- Accounts, login sessions and characters (DESIGN sections 1 and 3).
CREATE TABLE IF NOT EXISTS accounts (
  id          uuid PRIMARY KEY,
  username    text NOT NULL,
  pass_hash   text,
  guest       boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower ON accounts (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);

CREATE TABLE IF NOT EXISTS characters (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  element     text NOT NULL CHECK (element IN ('fire', 'water', 'earth', 'air')),
  faction     text NOT NULL,
  level       integer NOT NULL DEFAULT 1,
  xp          integer NOT NULL DEFAULT 0,
  faction_rank integer NOT NULL DEFAULT 1,
  x           real,
  y           real,
  z           real,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS characters_name_lower ON characters (lower(name));
CREATE INDEX IF NOT EXISTS characters_account ON characters (account_id);
