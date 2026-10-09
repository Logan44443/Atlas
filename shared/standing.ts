// Faction standing (Phase 11, DESIGN section 4): rank points and faction rank
// 1-10, Outlaw bounties (infamy) and Order honour, coins, and the faction
// orders the Envoy hands out. Pure rules shared by the shard and offline play.
import standingData from '../data/standing.json';
import { CONTESTED_ZONES, factionById } from './factions';
import { hasItems, materialName, takeItems, type Inventory } from './building';

export const STANDING = standingData;
const RANK_POINTS = STANDING.rankPoints;
export const MAX_RANK = RANK_POINTS.length;

export interface OrderState {
  /** order template id (data/standing.json orders) */
  id: string;
  /** how many are needed and done so far */
  n: number;
  have: number;
  /** deliver: material id; visit: territory point id */
  item?: string;
  place?: string;
}

export interface Standing {
  /** faction rank points (rank = rankOf(points)) */
  points: number;
  /** Outlaw bounty as of infamyAt (wall ms); see infamyNow() */
  infamy: number;
  infamyAt: number;
  /** Order: total bounty collected */
  honor: number;
  coins: number;
  /** the Envoy's current order */
  order: OrderState | null;
  ordersDone: number;
  /** faction ranks whose pet egg has been handed out */
  eggs: number[];
}

export const newStanding = (s: Partial<Standing> = {}): Standing => ({
  points: 0, infamy: 0, infamyAt: 0, honor: 0, coins: STANDING.coins.startCoins, order: null, ordersDone: 0, eggs: [], ...s,
});

const int = (v: unknown, min = 0, max = 1e12): number => Math.min(max, Math.max(min, Math.floor(Number(v) || 0)));

/** Whatever a save holds, made safe (unknown fields dropped, numbers clamped). */
export function sanitizeStanding(raw: unknown): Standing {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = newStanding({
    points: int(r.points),
    infamy: int(r.infamy, 0, STANDING.infamy.max),
    infamyAt: int(r.infamyAt),
    honor: int(r.honor),
    coins: r.coins === undefined ? STANDING.coins.startCoins : int(r.coins),
    ordersDone: int(r.ordersDone),
    eggs: Array.isArray(r.eggs) ? [...new Set(r.eggs.map((x) => int(x, 1, MAX_RANK)))] : [],
  });
  const o = r.order as Record<string, unknown> | null | undefined;
  if (o && typeof o === 'object' && orderDef(String(o.id))) {
    s.order = { id: String(o.id), n: int(o.n, 1, 100), have: int(o.have, 0, 100) };
    if (typeof o.item === 'string') s.order.item = o.item;
    if (typeof o.place === 'string') s.order.place = o.place;
  }
  return s;
}

// ---- rank -------------------------------------------------------------------------

export function rankOf(points: number): number {
  let r = 1;
  for (let i = 1; i < RANK_POINTS.length; i++) if (points >= RANK_POINTS[i]) r = i + 1;
  return r;
}
export const rankTitle = (rank: number): string => STANDING.rankTitles[Math.min(MAX_RANK, Math.max(1, rank)) - 1];
/** Points needed for the next rank, or null at the top. */
export const nextRankPoints = (rank: number): number | null => (rank < MAX_RANK ? RANK_POINTS[rank] : null);

/** Something that carries standing and a faction rank (Progress does). */
export interface Ranked {
  standing: Standing;
  rank: number;
}

/** Add rank points; returns how many ranks were gained. */
export function addPoints(p: Ranked, n: number): number {
  if (n <= 0) return 0;
  const before = p.rank;
  p.standing.points += Math.round(n);
  p.rank = rankOf(p.standing.points);
  return Math.max(0, p.rank - before);
}

/** Lose whole ranks (forbidden arts): points drop to the start of the lower rank. */
export function dropRanks(p: Ranked, n: number): void {
  const to = Math.max(1, rankOf(p.standing.points) - n);
  p.standing.points = RANK_POINTS[to - 1];
  p.rank = to;
}

export const crewRank = (): number => STANDING.unlocks.find((u) => u.crew)?.rank ?? 1;
/** Pet egg tiers owed for ranks reached but not yet handed out. */
export function eggsOwed(p: Ranked): Array<{ rank: number; tier: string }> {
  return STANDING.unlocks.filter((u) => u.egg && p.rank >= u.rank && !p.standing.eggs.includes(u.rank)).map((u) => ({ rank: u.rank, tier: u.egg! }));
}

// ---- bounties ---------------------------------------------------------------------

const HOUR = 3_600_000;

/** An Outlaw's bounty right now (it wears off over real time). */
export function infamyNow(s: Standing, now: number): number {
  if (s.infamy <= 0) return 0;
  return Math.max(0, Math.round(s.infamy - (STANDING.infamy.decayPerHour * Math.max(0, now - s.infamyAt)) / HOUR));
}
export function addInfamy(s: Standing, n: number, now: number): number {
  s.infamy = Math.min(STANDING.infamy.max, infamyNow(s, now) + n);
  s.infamyAt = now;
  return s.infamy;
}
export function clearInfamy(s: Standing, now: number): number {
  const had = infamyNow(s, now);
  s.infamy = 0;
  s.infamyAt = now;
  return had;
}

// ---- coins ------------------------------------------------------------------------

/** Coins for defeating a wild creature of this level. */
export const creatureCoins = (level: number, rand = Math.random): number => Math.max(1, Math.round(level * STANDING.coins.creaturePerLevel * (0.5 + rand())));
export const bossCoins = (tier: string): number => (STANDING.coins.boss as Record<string, number>)[tier] ?? 0;
/** What a mastery respec costs at this level with this many points spent. */
export const respecCost = (level: number, spent: number): number => (level < STANDING.coins.respecFreeBelowLevel ? 0 : spent * STANDING.coins.respecPerPoint);

// ---- faction orders -----------------------------------------------------------------

export interface OrderDef {
  id: string;
  kind: 'kill' | 'visit' | 'capture' | 'deliver' | 'boss';
  target?: string;
  items?: string[];
  n: [number, number];
  points: number;
  coins: number;
  xpPerLevel: number;
  minLevel?: number;
  text: string;
}
export const ORDERS = STANDING.orders as OrderDef[];
export const orderDef = (id: string): OrderDef | undefined => ORDERS.find((o) => o.id === id);

/** Someone the order rules can read and update. */
export interface OrderPlayer {
  progress: Ranked & { level: number; inv: Inventory };
  entity: { faction: string; side: string; pos: { x: number; z: number } };
}

export interface OrderReward {
  points: number;
  coins: number;
  xp: number;
  reason: string;
}

export interface OrderTalk {
  line: string;
  reward?: OrderReward;
  rankUp?: number;
}

const placeName = (id: string | undefined): string => CONTESTED_ZONES.find((c) => c.id === id)?.name ?? 'the frontier';

/** "Defeat 5 wild creatures (2/5)" style text for the HUD and the Envoy. */
export function orderText(o: OrderState): string {
  const d = orderDef(o.id);
  if (!d) return '';
  const text = d.text.replace('{n}', String(o.n)).replace('{item}', materialName(o.item ?? '')).replace('{place}', placeName(o.place));
  return o.have >= o.n ? `${text} (done: report to your Envoy)` : d.kind === 'deliver' || o.n <= 1 ? text : `${text} (${o.have}/${o.n})`;
}

/** Point the compass at the order's place (visit orders). */
export function orderTarget(o: OrderState | null): { x: number; z: number; name: string } | null {
  if (!o || o.have >= o.n || orderDef(o.id)?.kind !== 'visit') return null;
  const c = CONTESTED_ZONES.find((z) => z.id === o.place);
  return c ? { x: c.x, z: c.z, name: c.name } : null;
}

export class OrderRules {
  constructor(private rand: () => number = Math.random) {}

  /** A fresh order that suits this player (never the same one twice in a row). */
  give(p: OrderPlayer, last?: string): OrderState {
    const level = p.progress.level;
    const pool = ORDERS.filter((d) => (d.minLevel ?? 1) <= level && d.id !== last);
    const d = pool[Math.floor(this.rand() * pool.length)] ?? ORDERS[0];
    const n = d.n[0] + Math.floor(this.rand() * (d.n[1] - d.n[0] + 1));
    const o: OrderState = { id: d.id, n, have: 0 };
    if (d.kind === 'deliver') o.item = d.items![Math.floor(this.rand() * d.items!.length)];
    if (d.kind === 'visit') o.place = CONTESTED_ZONES[Math.floor(this.rand() * CONTESTED_ZONES.length)].id;
    return o;
  }

  /** Talking to an Envoy: hand out, check on, or reward the current order. */
  talk(p: OrderPlayer, envoyFaction: string): OrderTalk {
    const s = p.progress.standing;
    if (envoyFaction !== p.entity.faction) {
      const mine = factionById(p.entity.faction);
      return { line: `I take orders from my own people. ${mine ? `The ${mine.name} Envoy has work for you.` : ''}`.trim() };
    }
    if (!s.order) {
      s.order = this.give(p);
      return { line: `I have work for you. ${orderText(s.order)}` };
    }
    const o = s.order;
    const d = orderDef(o.id)!;
    if (d.kind === 'deliver' && o.have < o.n) {
      const cost = { [o.item!]: o.n };
      if (!hasItems(p.progress.inv, cost)) return { line: `Still waiting on those supplies. ${orderText(o)} You carry ${p.progress.inv[o.item!] ?? 0}.` };
      takeItems(p.progress.inv, cost);
      o.have = o.n;
    }
    if (o.have < o.n) return { line: `How goes it? ${orderText(o)}` };
    const reward: OrderReward = { points: d.points, coins: d.coins, xp: d.xpPerLevel * p.progress.level, reason: 'faction order' };
    const rankUp = addPoints(p.progress, reward.points);
    s.coins += reward.coins;
    s.ordersDone++;
    s.order = this.give(p, o.id);
    return { line: `Well done. The faction will remember it. Next: ${orderText(s.order)}`, reward, rankUp };
  }

  /** Count a kill toward the order. `paid` = the kill gave XP (so farming low-levels doesn't count). Returns a notice when it completes. */
  onKill(p: OrderPlayer, victim: { kind: string; side: string; role?: string }, paid: boolean): string | null {
    const o = p.progress.standing.order;
    const d = o && orderDef(o.id);
    if (!o || !d || d.kind !== 'kill' || o.have >= o.n) return null;
    const enemy = !!victim.side && victim.side !== p.entity.side;
    const counts =
      (d.target === 'creature' && victim.kind === 'creature') ||
      (d.target === 'npc' && victim.kind === 'npc' && enemy && victim.role !== 'master') ||
      (d.target === 'player' && victim.kind === 'player' && enemy && paid);
    return counts ? this.step(o) : null;
  }

  onCapture(p: OrderPlayer): string | null {
    return this.stepIf(p, 'capture');
  }

  onBoss(p: OrderPlayer): string | null {
    return this.stepIf(p, 'boss');
  }

  /** Once a second: visit orders complete within 30 m of their place. */
  tick(p: OrderPlayer): string | null {
    const t = orderTarget(p.progress.standing.order);
    if (!t || Math.hypot(p.entity.pos.x - t.x, p.entity.pos.z - t.z) > 30) return null;
    return this.step(p.progress.standing.order!);
  }

  private stepIf(p: OrderPlayer, kind: OrderDef['kind']): string | null {
    const o = p.progress.standing.order;
    if (!o || orderDef(o.id)?.kind !== kind || o.have >= o.n) return null;
    return this.step(o);
  }

  private step(o: OrderState): string | null {
    o.have++;
    return o.have >= o.n ? 'Faction order done: report to your Envoy' : `Faction order: ${o.have}/${o.n}`;
  }
}

/** Coins move between a player and a vendor or crew. */
export function payCoins(s: Standing, n: number): boolean {
  if (n < 0 || s.coins < n) return false;
  s.coins -= n;
  return true;
}
