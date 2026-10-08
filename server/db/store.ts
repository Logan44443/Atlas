// Persistence. PostgreSQL in production (DATABASE_URL); in development the
// server tries a local database and falls back to memory so it always starts.
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { ElementId } from '../../shared/combat';
import type { FactionId } from '../../shared/factions';
import type { Structure } from '../../shared/building';

export interface Account {
  id: string;
  username: string;
  guest: boolean;
}

export interface CharacterRow {
  id: string;
  accountId: string;
  name: string;
  element: ElementId;
  faction: FactionId;
  level: number;
  xp: number;
  rank: number;
  /** last saved position, null until the character has played */
  pos: [number, number, number] | null;
  /** mastery node id -> rank */
  mastery: Record<string, number>;
  /** landmark ids already discovered */
  discovered: string[];
  /** Special Arts state (see shared/arts.ts ArtsState) */
  arts: unknown;
  /** materials carried and building milestones (Phase 9) */
  inv: Record<string, number>;
  milestones: string[];
  createdAt: string;
}

export interface CharacterSave {
  pos?: [number, number, number];
  level?: number;
  xp?: number;
  rank?: number;
  mastery?: Record<string, number>;
  discovered?: string[];
  arts?: unknown;
  inv?: Record<string, number>;
  milestones?: string[];
}

export class StoreError extends Error {
  constructor(public code: 'taken' | 'name_taken' | 'slots_full' | 'not_found', message: string) {
    super(message);
  }
}

export interface Store {
  readonly kind: 'postgres' | 'memory';
  createAccount(username: string, passHash: string | null, guest: boolean): Promise<Account>;
  /** Turn a guest account into a named one (keeps its characters). */
  upgradeAccount(id: string, username: string, passHash: string): Promise<Account>;
  findAccount(username: string): Promise<{ account: Account; passHash: string | null } | null>;
  createSession(accountId: string, days: number): Promise<string>;
  accountForToken(token: string): Promise<Account | null>;
  deleteSession(token: string): Promise<void>;
  listCharacters(accountId: string): Promise<CharacterRow[]>;
  createCharacter(accountId: string, c: { name: string; element: ElementId; faction: FactionId }, maxSlots: number): Promise<CharacterRow>;
  deleteCharacter(accountId: string, id: string): Promise<boolean>;
  getCharacter(id: string): Promise<CharacterRow | null>;
  renameCharacter(id: string, name: string): Promise<void>;
  saveCharacter(id: string, s: CharacterSave): Promise<void>;
  /** Camp structures (Phase 9). */
  loadStructures(): Promise<Structure[]>;
  saveStructures(list: Structure[]): Promise<void>;
  deleteStructures(ids: string[]): Promise<void>;
  close(): Promise<void>;
}

const newToken = () => randomBytes(24).toString('base64url');

// ---- PostgreSQL ---------------------------------------------------------------

type Row = Record<string, unknown>;
const toChar = (r: Row): CharacterRow => ({
  id: r.id as string,
  accountId: r.account_id as string,
  name: r.name as string,
  element: r.element as ElementId,
  faction: r.faction as FactionId,
  level: r.level as number,
  xp: r.xp as number,
  rank: r.faction_rank as number,
  pos: r.x === null ? null : [r.x as number, r.y as number, r.z as number],
  mastery: (r.mastery as Record<string, number>) ?? {},
  discovered: (r.discovered as string[]) ?? [],
  arts: r.arts ?? {},
  inv: (r.inv as Record<string, number>) ?? {},
  milestones: (r.milestones as string[]) ?? [],
  createdAt: new Date(r.created_at as string).toISOString(),
});
const toAccount = (r: Row): Account => ({ id: r.id as string, username: r.username as string, guest: r.guest as boolean });

export class PgStore implements Store {
  readonly kind = 'postgres';
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 3000 });
    const store = new PgStore(pool);
    await store.migrate();
    return store;
  }

  /** Runs server/db/*.sql once each, in name order. */
  private async migrate(): Promise<void> {
    await this.pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await this.pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const dir = import.meta.dirname;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log(`[db] applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  }

  async createAccount(username: string, passHash: string | null, guest: boolean): Promise<Account> {
    try {
      const r = await this.pool.query('INSERT INTO accounts (id, username, pass_hash, guest) VALUES ($1, $2, $3, $4) RETURNING *', [randomUUID(), username, passHash, guest]);
      return toAccount(r.rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new StoreError('taken', 'That username is taken');
      throw e;
    }
  }

  async upgradeAccount(id: string, username: string, passHash: string): Promise<Account> {
    try {
      const r = await this.pool.query('UPDATE accounts SET username = $2, pass_hash = $3, guest = false WHERE id = $1 RETURNING *', [id, username, passHash]);
      if (!r.rows[0]) throw new StoreError('not_found', 'Account not found');
      return toAccount(r.rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new StoreError('taken', 'That username is taken');
      throw e;
    }
  }

  async findAccount(username: string) {
    const r = await this.pool.query('SELECT * FROM accounts WHERE lower(username) = lower($1)', [username]);
    return r.rows[0] ? { account: toAccount(r.rows[0]), passHash: r.rows[0].pass_hash as string | null } : null;
  }

  async createSession(accountId: string, days: number): Promise<string> {
    const token = newToken();
    await this.pool.query(`INSERT INTO sessions (token, account_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`, [token, accountId, String(days)]);
    return token;
  }

  async accountForToken(token: string): Promise<Account | null> {
    const r = await this.pool.query('SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = $1 AND s.expires_at > now()', [token]);
    return r.rows[0] ? toAccount(r.rows[0]) : null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  }

  async listCharacters(accountId: string): Promise<CharacterRow[]> {
    const r = await this.pool.query('SELECT * FROM characters WHERE account_id = $1 ORDER BY created_at', [accountId]);
    return r.rows.map(toChar);
  }

  async createCharacter(accountId: string, c: { name: string; element: ElementId; faction: FactionId }, maxSlots: number): Promise<CharacterRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the account row so two tabs can't both take the last slot.
      await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      const n = (await client.query('SELECT count(*)::int AS n FROM characters WHERE account_id = $1', [accountId])).rows[0].n as number;
      if (n >= maxSlots) throw new StoreError('slots_full', `All ${maxSlots} character slots are used`);
      const r = await client.query('INSERT INTO characters (id, account_id, name, element, faction) VALUES ($1, $2, $3, $4, $5) RETURNING *', [randomUUID(), accountId, c.name, c.element, c.faction]);
      await client.query('COMMIT');
      return toChar(r.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      if ((e as { code?: string }).code === '23505') throw new StoreError('name_taken', 'That name is taken');
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteCharacter(accountId: string, id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM characters WHERE id = $1 AND account_id = $2', [id, accountId]);
    return (r.rowCount ?? 0) > 0;
  }

  async getCharacter(id: string): Promise<CharacterRow | null> {
    const r = await this.pool.query('SELECT * FROM characters WHERE id = $1', [id]);
    return r.rows[0] ? toChar(r.rows[0]) : null;
  }

  async renameCharacter(id: string, name: string): Promise<void> {
    try {
      await this.pool.query('UPDATE characters SET name = $2 WHERE id = $1', [id, name]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new StoreError('name_taken', 'That name is taken');
      throw e;
    }
  }

  async saveCharacter(id: string, s: CharacterSave): Promise<void> {
    await this.pool.query(
      `UPDATE characters SET
         x = COALESCE($2, x), y = COALESCE($3, y), z = COALESCE($4, z),
         level = COALESCE($5, level), xp = COALESCE($6, xp), faction_rank = COALESCE($7, faction_rank),
         mastery = COALESCE($8::jsonb, mastery), discovered = COALESCE($9::jsonb, discovered), arts = COALESCE($10::jsonb, arts),
         inv = COALESCE($11::jsonb, inv), milestones = COALESCE($12::jsonb, milestones),
         last_seen = now()
       WHERE id = $1`,
      [
        id, s.pos?.[0] ?? null, s.pos?.[1] ?? null, s.pos?.[2] ?? null, s.level ?? null, s.xp ?? null, s.rank ?? null,
        s.mastery ? JSON.stringify(s.mastery) : null, s.discovered ? JSON.stringify(s.discovered) : null, s.arts ? JSON.stringify(s.arts) : null,
        s.inv ? JSON.stringify(s.inv) : null, s.milestones ? JSON.stringify(s.milestones) : null,
      ],
    );
  }

  async loadStructures(): Promise<Structure[]> {
    const r = await this.pool.query('SELECT data FROM structures');
    return r.rows.map((x) => x.data as Structure);
  }

  async saveStructures(list: Structure[]): Promise<void> {
    if (!list.length) return;
    // One upsert per batch; the owner FK drops structures of deleted characters.
    await this.pool.query(
      `INSERT INTO structures (id, owner, data, updated_at)
       SELECT x.id, x.owner::uuid, x.data, now() FROM jsonb_to_recordset($1::jsonb) AS x(id text, owner text, data jsonb)
       WHERE EXISTS (SELECT 1 FROM characters c WHERE c.id = x.owner::uuid)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(list.map((s) => ({ id: s.id, owner: s.owner, data: s })))],
    );
  }

  async deleteStructures(ids: string[]): Promise<void> {
    if (ids.length) await this.pool.query('DELETE FROM structures WHERE id = ANY($1::text[])', [ids]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---- Memory (development fallback; lost on restart) ---------------------------

export class MemoryStore implements Store {
  readonly kind = 'memory';
  private accounts = new Map<string, { account: Account; passHash: string | null }>();
  private sessions = new Map<string, { accountId: string; expires: number }>();
  private chars = new Map<string, CharacterRow>();
  private structs = new Map<string, Structure>();

  private byName(username: string) {
    for (const a of this.accounts.values()) if (a.account.username.toLowerCase() === username.toLowerCase()) return a;
    return null;
  }

  async createAccount(username: string, passHash: string | null, guest: boolean): Promise<Account> {
    if (this.byName(username)) throw new StoreError('taken', 'That username is taken');
    const account = { id: randomUUID(), username, guest };
    this.accounts.set(account.id, { account, passHash });
    return account;
  }
  async upgradeAccount(id: string, username: string, passHash: string): Promise<Account> {
    const a = this.accounts.get(id);
    if (!a) throw new StoreError('not_found', 'Account not found');
    const other = this.byName(username);
    if (other && other !== a) throw new StoreError('taken', 'That username is taken');
    a.account = { ...a.account, username, guest: false };
    a.passHash = passHash;
    return a.account;
  }
  async findAccount(username: string) {
    return this.byName(username);
  }
  async createSession(accountId: string, days: number): Promise<string> {
    const token = newToken();
    this.sessions.set(token, { accountId, expires: Date.now() + days * 86400_000 });
    return token;
  }
  async accountForToken(token: string): Promise<Account | null> {
    const s = this.sessions.get(token);
    if (!s || s.expires < Date.now()) return null;
    return this.accounts.get(s.accountId)?.account ?? null;
  }
  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }
  async listCharacters(accountId: string): Promise<CharacterRow[]> {
    return [...this.chars.values()].filter((c) => c.accountId === accountId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async createCharacter(accountId: string, c: { name: string; element: ElementId; faction: FactionId }, maxSlots: number): Promise<CharacterRow> {
    if ((await this.listCharacters(accountId)).length >= maxSlots) throw new StoreError('slots_full', `All ${maxSlots} character slots are used`);
    for (const o of this.chars.values()) if (o.name.toLowerCase() === c.name.toLowerCase()) throw new StoreError('name_taken', 'That name is taken');
    const row: CharacterRow = { id: randomUUID(), accountId, ...c, level: 1, xp: 0, rank: 1, pos: null, mastery: {}, discovered: [], arts: {}, inv: {}, milestones: [], createdAt: new Date().toISOString() };
    this.chars.set(row.id, row);
    return row;
  }
  async deleteCharacter(accountId: string, id: string): Promise<boolean> {
    const c = this.chars.get(id);
    if (!c || c.accountId !== accountId) return false;
    for (const st of this.structs.values()) if (st.owner === id) this.structs.delete(st.id);
    return this.chars.delete(id);
  }
  async getCharacter(id: string): Promise<CharacterRow | null> {
    return this.chars.get(id) ?? null;
  }
  async renameCharacter(id: string, name: string): Promise<void> {
    for (const o of this.chars.values()) if (o.id !== id && o.name.toLowerCase() === name.toLowerCase()) throw new StoreError('name_taken', 'That name is taken');
    const c = this.chars.get(id);
    if (c) c.name = name;
  }
  async saveCharacter(id: string, s: CharacterSave): Promise<void> {
    const c = this.chars.get(id);
    if (!c) return;
    if (s.pos) c.pos = s.pos;
    if (s.mastery) c.mastery = { ...s.mastery };
    if (s.discovered) c.discovered = [...s.discovered];
    if (s.arts) c.arts = JSON.parse(JSON.stringify(s.arts));
    if (s.level !== undefined) c.level = s.level;
    if (s.xp !== undefined) c.xp = s.xp;
    if (s.rank !== undefined) c.rank = s.rank;
    if (s.inv) c.inv = { ...s.inv };
    if (s.milestones) c.milestones = [...s.milestones];
  }

  async loadStructures(): Promise<Structure[]> {
    return [...this.structs.values()].map((s) => JSON.parse(JSON.stringify(s)));
  }
  async saveStructures(list: Structure[]): Promise<void> {
    for (const s of list) if (this.chars.has(s.owner)) this.structs.set(s.id, JSON.parse(JSON.stringify(s)));
  }
  async deleteStructures(ids: string[]): Promise<void> {
    for (const id of ids) this.structs.delete(id);
  }
  async close(): Promise<void> {}
}

const DEV_URL = 'postgres://fourwinds:fourwinds@localhost:5432/fourwinds';

/** DATABASE_URL must work if set; otherwise try the local dev database, then memory. */
export async function openStore(): Promise<Store> {
  const url = process.env.DATABASE_URL;
  if (url) return PgStore.connect(url);
  try {
    const s = await PgStore.connect(DEV_URL);
    console.log('[db] using local PostgreSQL (fourwinds@localhost)');
    return s;
  } catch (e) {
    console.warn(`[db] no PostgreSQL (${(e as Error).message}); using in-memory storage, nothing will persist`);
    return new MemoryStore();
  }
}
