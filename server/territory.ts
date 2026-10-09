// The territory war, shared by every shard in this process: one Territory
// whose capture circles count the players of all shards. Each room reports who
// stands where once a second; a 1 s ticker advances the meters and hands the
// news to every room (rewards go to whichever room holds the player). Income
// from points a crew took goes straight to that crew's bank.
import { Territory, presenceAt, pointById, type Presence, type TerrNews } from '../shared/territory';
import { giveItems, itemsText } from '../shared/building';
import { bankCap, crewLevelOf } from '../shared/crews';
import { crews, crewChanged } from './crews';
import { sendTo } from './online';
import type { Store } from './db/store';

export const territory = new Territory();
const reports = new Map<string, Map<string, Presence[]>>();
const listeners = new Set<(news: TerrNews[]) => void>();
let store: Store | null = null;
let dirty = false;
/** dev builds: shift the war clock along with a shard's dev:clock */
export const terrClock = { shiftMs: 0 };

/** A room's latest head count inside the capture circles. */
export function reportPresence(roomId: string, players: Parameters<typeof presenceAt>[0], groundAt: (x: number, z: number) => number, time: number): void {
  reports.set(roomId, presenceAt(players, groundAt, time));
}

export function dropReport(roomId: string): void {
  reports.delete(roomId);
}

export function onTerritory(fn: (news: TerrNews[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const terrNow = (): number => Date.now() + terrClock.shiftMs;

export async function initTerritory(s: Store): Promise<void> {
  store = s;
  territory.load(await s.loadTerritory());
  setInterval(tick, 1000).unref();
  setInterval(() => void flushTerritory(), 10_000).unref();
  console.log(`[territory] ${[...territory.states.values()].filter((p) => p.owner).length} points held; ${territory.text(terrNow())}`);
}

function tick(): void {
  const merged = new Map<string, Presence[]>();
  for (const r of reports.values()) for (const [id, list] of r) merged.set(id, [...(merged.get(id) ?? []), ...list]);
  const news = territory.update(1, merged, terrNow());
  if (!news.length) return;
  for (const n of news) {
    if (n.t === 'captured' || n.t === 'lost') dirty = true;
    if (n.t === 'income' && n.crew) payCrew(n);
  }
  for (const fn of listeners) fn(news);
}

/** Income from a point a crew took goes to its bank (materials up to the bank's room). */
function payCrew(n: Extract<TerrNews, { t: 'income' }>): void {
  const c = crews.byId.get(n.crew);
  if (!c) return;
  const got = giveItems(c.bank, n.items, bankCap(crewLevelOf(c.xp)));
  c.coins += n.coins;
  crewChanged(c);
  const pt = pointById(n.point);
  const text = `${pt?.name ?? 'A point'} paid the crew bank ${n.coins} coins${Object.keys(got).length ? ` and ${itemsText(got)}` : ''}`;
  for (const m of c.members) sendTo(m.charId, 'notice', { text });
}

export async function flushTerritory(): Promise<void> {
  if (!store || !dirty) return;
  dirty = false;
  try {
    await store.saveTerritory(territory.save());
  } catch (e) {
    dirty = true;
    console.error('[territory] save failed', e);
  }
}
