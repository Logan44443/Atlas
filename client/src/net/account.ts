// Talks to the account API (server/api.ts). Without a server, characters live
// in localStorage and play offline.
import type { ElementId } from '@shared/combat';
import type { FactionId } from '@shared/factions';
import { defaultServerUrl } from './netCombat';

export interface Character {
  id: string;
  name: string;
  element: ElementId;
  faction: FactionId;
  level: number;
  pos: [number, number, number] | null;
}

export interface AccountInfo {
  id: string;
  username: string;
  guest: boolean;
}

const TOKEN_KEY = 'fw.token';
const LOCAL_KEY = 'fw.localCharacters';

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null): void {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export function apiBase(): string {
  return defaultServerUrl().replace(/^ws/, 'http');
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Online when the account API answers; otherwise an offline roster in localStorage. */
export class AccountClient {
  online = false;
  account: AccountInfo | null = null;
  characters: Character[] = [];
  maxSlots = 4;

  get token(): string | null {
    return store.get(TOKEN_KEY);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const t = this.token;
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(apiBase() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(4000) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data;
  }

  /** Signs in with the saved token, or as a fresh guest. Falls back to offline if there's no server. */
  async start(forceOffline = false): Promise<void> {
    if (!forceOffline) {
      try {
        if (this.token) {
          try {
            await this.refresh();
            this.online = true;
            return;
          } catch (e) {
            if (!(e instanceof ApiError) || e.status !== 401) throw e;
            store.set(TOKEN_KEY, null);
          }
        }
        const g = await this.call<{ token: string }>('POST', '/api/guest');
        store.set(TOKEN_KEY, g.token);
        await this.refresh();
        this.online = true;
        return;
      } catch (e) {
        console.info(`[account] offline: ${(e as Error).message}`);
      }
    }
    this.online = false;
    this.account = null;
    this.characters = this.localCharacters();
  }

  async refresh(): Promise<void> {
    const me = await this.call<{ account: AccountInfo; characters: Character[]; maxSlots: number }>('GET', '/api/me');
    this.account = me.account;
    this.characters = me.characters;
    this.maxSlots = me.maxSlots;
  }

  async register(username: string, password: string): Promise<void> {
    const r = await this.call<{ token: string }>('POST', '/api/register', { username, password });
    store.set(TOKEN_KEY, r.token);
    await this.refresh();
  }

  async login(username: string, password: string): Promise<void> {
    const r = await this.call<{ token: string }>('POST', '/api/login', { username, password });
    store.set(TOKEN_KEY, r.token);
    await this.refresh();
  }

  async logout(): Promise<void> {
    await this.call('POST', '/api/logout').catch(() => {});
    store.set(TOKEN_KEY, null);
    await this.start();
  }

  async create(name: string, element: ElementId, faction: FactionId): Promise<Character> {
    if (!this.online) {
      const list = this.localCharacters();
      if (list.length >= this.maxSlots) throw new ApiError(409, `All ${this.maxSlots} character slots are used`);
      if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, 'That name is taken');
      const c: Character = { id: `local-${Date.now().toString(36)}`, name, element, faction, level: 1, pos: null };
      this.saveLocal([...list, c]);
      this.characters = this.localCharacters();
      return c;
    }
    const r = await this.call<{ character: Character }>('POST', '/api/characters', { name, element, faction });
    await this.refresh();
    return r.character;
  }

  async remove(id: string): Promise<void> {
    if (!this.online) {
      this.saveLocal(this.localCharacters().filter((c) => c.id !== id));
      this.characters = this.localCharacters();
      return;
    }
    await this.call('DELETE', `/api/characters/${id}`);
    await this.refresh();
  }

  /** Offline characters remember where they were. */
  saveLocalPosition(id: string, pos: [number, number, number], name?: string): void {
    const list = this.localCharacters();
    const c = list.find((x) => x.id === id);
    if (!c) return;
    c.pos = pos;
    if (name) c.name = name;
    this.saveLocal(list);
  }

  private localCharacters(): Character[] {
    try {
      const v = JSON.parse(store.get(LOCAL_KEY) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private saveLocal(list: Character[]): void {
    store.set(LOCAL_KEY, JSON.stringify(list));
  }
}
