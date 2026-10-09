// Account + character HTTP API (JSON). Tokens are bearer session tokens.
//   POST   /api/guest                       -> { token, account }
//   POST   /api/register {username,password} (upgrades the current guest if a token is sent)
//   POST   /api/login    {username,password} -> { token, account }
//   POST   /api/logout
//   GET    /api/me                          -> { account, characters, maxSlots }
//   POST   /api/characters {name,element,faction}
//   DELETE /api/characters/:id
import type { IncomingMessage, ServerResponse } from 'node:http';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import accountData from '../data/accounts.json';
import { validateName, validatePassword, validateUsername } from '../shared/names';
import { FACTIONS, type FactionId } from '../shared/factions';
import type { ElementId } from '../shared/combat';
import { removeOwner } from './camps';
import { leaveCrew } from './crews';
import { StoreError, type Account, type Store } from './db/store';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const ELEMENTS: ElementId[] = ['fire', 'water', 'earth', 'air'];

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function checkPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), want.length);
  return timingSafeEqual(want, got);
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Small fixed-window limiter for login/register so passwords can't be brute forced quickly.
const attempts = new Map<string, { n: number; reset: number }>();
function limit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) {
    attempts.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  if (++a.n > max) throw new HttpError(429, 'Too many attempts, try again in a minute');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_000) throw new HttpError(413, 'Request too large');
  }
  if (!body) return {};
  try {
    const v = JSON.parse(body);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;

/**
 * Who is asking, for the rate limits. Behind a proxy (Fly) the socket is the
 * proxy, so CLIENT_IP_HEADER names the header that carries the real address;
 * it is only trusted when set, since anyone can send that header directly.
 */
function clientIp(req: IncomingMessage): string {
  const h = process.env.CLIENT_IP_HEADER;
  const v = h ? req.headers[h.toLowerCase()] : undefined;
  const fromProxy = (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
  return fromProxy || req.socket.remoteAddress || '?';
}

export function createApi(store: Store) {
  async function requireAccount(req: IncomingMessage): Promise<{ account: Account; token: string }> {
    const token = bearer(req);
    const account = token ? await store.accountForToken(token) : null;
    if (!account || !token) throw new HttpError(401, 'Please sign in again');
    return { account, token };
  }

  async function session(account: Account) {
    return { token: await store.createSession(account.id, accountData.sessionDays), account };
  }

  async function route(req: IncomingMessage, url: URL): Promise<unknown> {
    const ip = clientIp(req);
    const m = req.method;
    const p = url.pathname;
    if (m === 'POST' && p === '/api/guest') {
      limit(`guest:${ip}`, accountData.guestPerIpPerHour, 3600_000);
      const account = await store.createAccount(`guest_${randomBytes(5).toString('hex')}`, null, true);
      return session(account);
    }
    if (m === 'POST' && p === '/api/register') {
      limit(`auth:${ip}`, 20, 60_000);
      const b = await readJson(req);
      const username = String(b.username ?? '').trim();
      const password = String(b.password ?? '');
      const err = validateUsername(username) ?? validatePassword(password);
      if (err) throw new HttpError(400, err);
      const hash = await hashPassword(password);
      const token = bearer(req);
      const current = token ? await store.accountForToken(token) : null;
      if (current?.guest) return { token, account: await store.upgradeAccount(current.id, username, hash) };
      return session(await store.createAccount(username, hash, false));
    }
    if (m === 'POST' && p === '/api/login') {
      limit(`auth:${ip}`, 20, 60_000);
      const b = await readJson(req);
      const found = await store.findAccount(String(b.username ?? '').trim());
      if (!found || found.account.guest || !(await checkPassword(String(b.password ?? ''), found.passHash))) throw new HttpError(401, 'Wrong username or password');
      return session(found.account);
    }
    if (m === 'POST' && p === '/api/logout') {
      const t = bearer(req);
      if (t) await store.deleteSession(t);
      return { ok: true };
    }
    if (m === 'GET' && p === '/api/me') {
      const { account } = await requireAccount(req);
      return { account, characters: await store.listCharacters(account.id), maxSlots: accountData.characterSlots };
    }
    if (m === 'POST' && p === '/api/characters') {
      const { account } = await requireAccount(req);
      const b = await readJson(req);
      const name = String(b.name ?? '').trim();
      const nameErr = validateName(name);
      if (nameErr) throw new HttpError(400, nameErr);
      if (!ELEMENTS.includes(b.element as ElementId)) throw new HttpError(400, 'Pick an element');
      if (!FACTIONS.some((f) => f.id === b.faction)) throw new HttpError(400, 'Pick a faction');
      return { character: await store.createCharacter(account.id, { name, element: b.element as ElementId, faction: b.faction as FactionId }, accountData.characterSlots) };
    }
    const del = /^\/api\/characters\/([0-9a-f-]{36})$/.exec(p);
    if (m === 'DELETE' && del) {
      const { account } = await requireAccount(req);
      if (!(await store.deleteCharacter(account.id, del[1]))) throw new HttpError(404, 'No such character');
      removeOwner(del[1]);
      leaveCrew(del[1]);
      return { ok: true };
    }
    throw new HttpError(404, 'Not found');
  }

  /** Returns true if it handled the request. */
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return true;
    }
    res.setHeader('Content-Type', 'application/json');
    try {
      res.end(JSON.stringify(await route(req, url)));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof StoreError ? (e.code === 'not_found' ? 404 : 409) : 500;
      if (status === 500) console.error('[api]', e);
      res.statusCode = status;
      res.end(JSON.stringify({ error: status === 500 ? 'Server error' : (e as Error).message }));
    }
    return true;
  };
}
