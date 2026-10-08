// Camps and bases (Phase 9, DESIGN section 10): pieces, placement rules,
// inventories, raid windows and structure damage. Pure rules shared by the
// shard server and offline play; transport and rendering live elsewhere.
import piecesData from '../data/buildings/pieces.json';
import rulesData from '../data/buildings/rules.json';
import matData from '../data/crafting/materials.json';
import worldData from '../data/world.json';
import { FACTIONS, zoneAt } from './factions';

export interface PieceDef {
  id: string;
  name: string;
  kind: string;
  /** [width, height, depth] in metres */
  size: [number, number, number];
  hp: number;
  cost: Record<string, number>;
  solid: boolean;
  effect?: string;
  tier: string;
}

export const PIECES = piecesData.pieces as unknown as PieceDef[];
export const BUILD = rulesData;
export const MATERIALS = matData.materials;
export const BAG_CAP = matData.bagCapacity;
export const CHEST_CAP = matData.chestCapacity;
export const pieceById = (id: string): PieceDef | undefined => PIECES.find((p) => p.id === id);
export const materialName = (id: string): string => MATERIALS.find((m) => m.id === id)?.name ?? id;
const MATERIAL_IDS = new Set(MATERIALS.map((m) => m.id));

// ---- inventories ----------------------------------------------------------------

export type Inventory = Record<string, number>;

export const invTotal = (inv: Inventory): number => Object.values(inv).reduce((a, b) => a + b, 0);

/** Known materials only, whole non-negative counts, at most `cap` items in total. */
export function sanitizeInv(raw: unknown, cap = BAG_CAP): Inventory {
  const out: Inventory = {};
  if (!raw || typeof raw !== 'object') return out;
  let room = cap;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Math.min(room, Math.max(0, Math.floor(Number(v) || 0)));
    if (!MATERIAL_IDS.has(k) || n <= 0) continue;
    out[k] = n;
    room -= n;
  }
  return out;
}

export const hasItems = (inv: Inventory, cost: Inventory): boolean => Object.entries(cost).every(([k, n]) => (inv[k] ?? 0) >= n);

/** "3 Wood, 1 Glass" still needed, or '' when the inventory covers the cost. */
export function shortfall(inv: Inventory, cost: Inventory): string {
  return Object.entries(cost)
    .filter(([k, n]) => (inv[k] ?? 0) < n)
    .map(([k, n]) => `${n - (inv[k] ?? 0)} ${materialName(k)}`)
    .join(', ');
}

export function takeItems(inv: Inventory, cost: Inventory): boolean {
  if (!hasItems(inv, cost)) return false;
  for (const [k, n] of Object.entries(cost)) {
    inv[k] -= n;
    if (inv[k] <= 0) delete inv[k];
  }
  return true;
}

/** Adds what fits under `cap`; returns what was actually added. */
export function giveItems(inv: Inventory, items: Inventory, cap = BAG_CAP): Inventory {
  let room = cap - invTotal(inv);
  const added: Inventory = {};
  for (const [k, v] of Object.entries(items)) {
    const n = Math.min(room, Math.max(0, Math.floor(v)));
    if (n <= 0) continue;
    inv[k] = (inv[k] ?? 0) + n;
    added[k] = n;
    room -= n;
  }
  return added;
}

/** Move `items` between a bag and a chest (put = into the chest). Returns why it (partly) failed, or ''. */
export function moveItems(bag: Inventory, chest: Inventory, items: Inventory, put: boolean): string {
  const [from, to, cap] = put ? [bag, chest, CHEST_CAP] : [chest, bag, BAG_CAP];
  if (!hasItems(from, items)) return put ? "You don't carry that much" : "The chest doesn't hold that much";
  takeItems(from, items);
  const moved = giveItems(to, items, cap);
  // Whatever didn't fit goes back where it came from.
  const back: Inventory = {};
  for (const [k, n] of Object.entries(items)) if (n - (moved[k] ?? 0) > 0) back[k] = n - (moved[k] ?? 0);
  giveItems(from, back, 1e9);
  return invTotal(back) > 0 ? (put ? 'The chest is full' : 'Your bag is full') : '';
}

export const itemsText = (items: Inventory): string =>
  Object.entries(items)
    .map(([k, n]) => `${n} ${materialName(k)}`)
    .join(', ');

// ---- structures -----------------------------------------------------------------

export interface Structure {
  id: string;
  /** owning character id */
  owner: string;
  ownerName: string;
  side: string;
  faction: string;
  piece: string;
  x: number;
  /** base (feet) height */
  y: number;
  z: number;
  /** quarter turns 0-3 */
  rot: number;
  hp: number;
  maxHp: number;
  /** chest contents */
  store?: Inventory;
  /** wall time (ms) the owner was last online; camps of owners gone burnOfflineHours burn down */
  ownerSeen: number;
}

/** Axis-aligned half extents (rotation is in quarter turns, so boxes stay axis aligned). */
export function halfExtents(pieceId: string, rot: number): [number, number, number] {
  const [w, h, d] = pieceById(pieceId)?.size ?? [1, 1, 1];
  return rot % 2 ? [d / 2, h / 2, w / 2] : [w / 2, h / 2, d / 2];
}

/** What the combat sim needs to stop projectiles and hit structures. */
export interface Solid {
  id: string;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  solid: boolean;
  side: string;
}

export function solidOf(s: Structure): Solid {
  const [hx, hy, hz] = halfExtents(s.piece, s.rot);
  return { id: s.id, x: s.x, y: s.y, z: s.z, hx, hy, hz, solid: !!pieceById(s.piece)?.solid, side: s.side };
}

/** Snap a placement to the build grid. */
export function snapPlacement(x: number, z: number, rot: number): { x: number; z: number; rot: number } {
  const g = BUILD.grid;
  return { x: Math.round(x / g) * g, z: Math.round(z / g) * g, rot: ((Math.round(rot) % 4) + 4) % 4 };
}

/** Where a piece rests: on the lowest corner (sunk a little) or, for walkways, at least on the water. */
export function restHeight(pieceId: string, x: number, z: number, rot: number, groundAt: (x: number, z: number) => number): number {
  const [hx, , hz] = halfExtents(pieceId, rot);
  const hs = [groundAt(x - hx, z - hz), groundAt(x + hx, z - hz), groundAt(x - hx, z + hz), groundAt(x + hx, z + hz), groundAt(x, z)];
  const walk = pieceById(pieceId)?.effect === 'walkway';
  const base = walk ? Math.max(...hs) : Math.min(...hs) - 0.15;
  return walk ? Math.max(base, worldData.seaLevel + 0.2) : base;
}

// ---- raid windows ------------------------------------------------------------------

const HOUR = 3_600_000;

/** Is a raid window open at wall time `ms` (UTC)? */
export function raidOpen(ms = Date.now()): boolean {
  const h = (ms / HOUR) % 24;
  return BUILD.raidWindowsUtc.some((w) => ((h - w.start + 24) % 24) < w.hours);
}

/** Text for the UI: "Raid window open (1 h 20 m left)" / "Raids open at 19:00 UTC (in 3 h 5 m)". */
export function raidText(ms = Date.now()): string {
  const h = (ms / HOUR) % 24;
  const fmt = (hours: number) => `${Math.floor(hours)} h ${Math.floor((hours % 1) * 60)} m`;
  for (const w of BUILD.raidWindowsUtc) {
    const into = (h - w.start + 24) % 24;
    if (into < w.hours) return `Raid window open (${fmt(w.hours - into)} left)`;
  }
  const next = Math.min(...BUILD.raidWindowsUtc.map((w) => (w.start - h + 24) % 24));
  const start = BUILD.raidWindowsUtc.find((w) => Math.abs(((w.start - h + 24) % 24) - next) < 1e-9)!.start;
  return `Raids open at ${String(start).padStart(2, '0')}:00 UTC (in ${fmt(next)})`;
}

// ---- camps ----------------------------------------------------------------------------

/** Who is building: a character and what they carry. */
export interface Builder {
  charId: string;
  name: string;
  side: string;
  faction: string;
  x: number;
  z: number;
  inv: Inventory;
}

export interface Placement {
  piece: string;
  x: number;
  z: number;
  rot: number;
}

export type DamageResult = { kind: 'hit' | 'broke'; s: Structure; amount: number } | { kind: 'refused'; reason: string } | null;

type Listener = (s: Structure, change: 'add' | 'hp' | 'del') => void;

/**
 * Every structure in the world. The shard server keeps one for the whole
 * process (all shards share the same world); offline play keeps one per tab.
 */
export class Camps {
  readonly all = new Map<string, Structure>();
  /** Collision boxes for the combat sim (shared Map, kept in sync). */
  readonly solids = new Map<string, Solid>();
  private listeners = new Set<Listener>();
  private seq = 0;
  /** dev/tests: force the raid window open (true) or shut (false) */
  forceRaid: boolean | null = null;

  constructor(private groundAt: (x: number, z: number) => number) {}

  listen(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(s: Structure, change: 'add' | 'hp' | 'del'): void {
    for (const fn of this.listeners) fn(s, change);
  }

  /** Bring back saved structures (no rule checks: they were checked when placed). */
  load(list: Structure[]): void {
    for (const s of list) {
      if (!pieceById(s.piece)) continue;
      this.all.set(s.id, s);
      this.solids.set(s.id, solidOf(s));
    }
  }

  ofOwner(charId: string): Structure[] {
    return [...this.all.values()].filter((s) => s.owner === charId);
  }
  campfireOf(charId: string): Structure | undefined {
    for (const s of this.all.values()) if (s.owner === charId && s.piece === 'campfire') return s;
    return undefined;
  }
  near(x: number, z: number, r: number): Structure[] {
    return [...this.all.values()].filter((s) => Math.hypot(s.x - x, s.z - z) <= r);
  }

  /** Why this placement isn't allowed, or null. */
  check(b: Builder, p: Placement): string | null {
    const def = pieceById(p.piece);
    if (!def) return 'Unknown piece';
    const zone = zoneAt(p.x, p.z);
    if (zone.kind !== 'wilds') return 'Camps can only be built in the Wilds';
    for (const f of FACTIONS) if (Math.hypot(p.x - f.hub.x, p.z - f.hub.z) < BUILD.minHubDistance + f.hub.safeRadius) return `Too close to ${f.hub.name}`;
    if (Math.hypot(p.x - b.x, p.z - b.z) > BUILD.placeRange) return 'Too far away to build there';
    const fire = this.campfireOf(b.charId);
    if (def.effect === 'respawn') {
      if (fire) return 'You already have a camp (remove your campfire to move it)';
      for (const s of this.all.values()) {
        if (s.piece === 'campfire' && Math.hypot(s.x - p.x, s.z - p.z) < BUILD.campRadius * 2) return `Too close to ${s.ownerName}'s camp`;
      }
    } else {
      if (!fire) return 'Place a campfire first: it marks your camp';
      if (Math.hypot(p.x - fire.x, p.z - fire.z) > BUILD.campRadius) return `Must be within ${BUILD.campRadius} m of your campfire`;
      if (this.ofOwner(b.charId).length >= BUILD.maxPieces) return `A camp holds at most ${BUILD.maxPieces} pieces`;
    }
    if (def.effect !== 'walkway' && this.groundAt(p.x, p.z) < worldData.seaLevel - 0.2) return "Can't build on water (sandstone bridges can)";
    const [hx, , hz] = halfExtents(p.piece, p.rot);
    for (const s of this.all.values()) {
      const [sx, , sz] = halfExtents(s.piece, s.rot);
      // 5 cm of slack so walls can sit end to end.
      if (Math.abs(s.x - p.x) < hx + sx - 0.05 && Math.abs(s.z - p.z) < hz + sz - 0.05) return 'Something is already there';
    }
    const short = shortfall(b.inv, def.cost);
    if (short) return `Needs ${short} more`;
    return null;
  }

  /** Check, pay and place. Returns the new structure or why not. */
  place(b: Builder, raw: Placement, now = Date.now()): Structure | string {
    const p = { piece: raw.piece, ...snapPlacement(raw.x, raw.z, raw.rot) };
    const err = this.check(b, p);
    if (err) return err;
    const def = pieceById(p.piece)!;
    takeItems(b.inv, def.cost);
    const s: Structure = {
      id: `s${now.toString(36)}${(this.seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      owner: b.charId, ownerName: b.name, side: b.side, faction: b.faction, piece: p.piece,
      x: p.x, y: +restHeight(p.piece, p.x, p.z, p.rot, this.groundAt).toFixed(2), z: p.z, rot: p.rot,
      hp: def.hp, maxHp: def.hp, ownerSeen: now,
      ...(def.effect === 'storage' ? { store: {} } : {}),
    };
    this.add(s);
    return s;
  }

  /** Mirror a structure the authority sent (clients). */
  upsert(s: Structure): void {
    if (!pieceById(s.piece)) return;
    const had = this.all.get(s.id);
    if (had) Object.assign(had, s);
    else this.all.set(s.id, s);
    this.solids.set(s.id, solidOf(had ?? s));
    this.emit(had ?? s, had ? 'hp' : 'add');
  }

  private add(s: Structure): void {
    this.all.set(s.id, s);
    this.solids.set(s.id, solidOf(s));
    this.emit(s, 'add');
  }

  delete(id: string): Structure | undefined {
    const s = this.all.get(id);
    if (!s) return undefined;
    this.all.delete(id);
    this.solids.delete(id);
    this.emit(s, 'del');
    return s;
  }

  /** The owner takes a piece down and gets half its cost back (bag space permitting). */
  remove(b: Builder, id: string): Structure | string {
    const s = this.all.get(id);
    if (!s || s.owner !== b.charId) return 'That is not yours';
    if (Math.hypot(s.x - b.x, s.z - b.z) > BUILD.placeRange) return 'Get closer to take it down';
    if (s.piece === 'campfire' && this.ofOwner(b.charId).length > 1) return 'Take down the rest of your camp first';
    if (s.store && invTotal(s.store) > 0) return 'Empty the chest first';
    const def = pieceById(s.piece)!;
    const refund: Inventory = {};
    for (const [k, n] of Object.entries(def.cost)) if (Math.floor(n / 2) > 0) refund[k] = Math.floor(n / 2);
    giveItems(b.inv, refund);
    this.delete(id);
    return s;
  }

  /**
   * Bending hits a structure. Only the other side can damage it, only during a
   * raid window and never inside a safe zone. Earth hits harder.
   */
  damage(id: string, amount: number, attacker: { side: string; element: string | null }, now = Date.now()): DamageResult {
    const s = this.all.get(id);
    if (!s || amount <= 0) return null;
    if (!attacker.side || attacker.side === s.side) return null;
    if (zoneAt(s.x, s.z).kind === 'safe') return null;
    if (!(this.forceRaid ?? raidOpen(now))) return { kind: 'refused', reason: `Camps can only be raided in the raid window. ${raidText(now)}` };
    const dmg = Math.round(amount * (attacker.element === 'earth' ? BUILD.earthBonus : 1));
    // The campfire is the camp's core: it can be beaten down but never destroyed.
    const core = pieceById(s.piece)?.effect === 'respawn';
    s.hp = Math.max(core ? 1 : 0, s.hp - dmg);
    if (s.hp <= 0) {
      this.delete(id);
      return { kind: 'broke', s, amount: dmg };
    }
    this.emit(s, 'hp');
    return { kind: 'hit', s, amount: dmg };
  }

  /** Owner online: stamp their camp so it doesn't burn down. */
  touch(charId: string, now = Date.now()): void {
    for (const s of this.all.values()) if (s.owner === charId) s.ownerSeen = now;
  }

  /** Camps whose owner has been away too long burn down. Returns the removed structures. */
  burnAbandoned(online: (charId: string) => boolean, now = Date.now()): Structure[] {
    const limit = BUILD.burnOfflineHours * HOUR;
    const out: Structure[] = [];
    for (const s of [...this.all.values()]) {
      if (online(s.owner) || now - s.ownerSeen < limit) continue;
      this.delete(s.id);
      out.push(s);
    }
    return out;
  }

  /** The camp (if any) whose effect pieces of `effect` stand within `r` of (x, z). */
  effectNear(x: number, z: number, effect: string, r: number, filter?: (s: Structure) => boolean): Structure | undefined {
    for (const s of this.all.values()) {
      if (pieceById(s.piece)?.effect !== effect || Math.hypot(s.x - x, s.z - z) > r) continue;
      if (!filter || filter(s)) return s;
    }
    return undefined;
  }
}
