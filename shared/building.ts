// Camps and bases (Phase 9, DESIGN section 10): pieces, placement rules,
// inventories, raid windows and structure damage. Pure rules shared by the
// shard server and offline play; transport and rendering live elsewhere.
import piecesData from '../data/buildings/pieces.json';
import rulesData from '../data/buildings/rules.json';
import matData from '../data/crafting/materials.json';
import worldData from '../data/world.json';
import crewsJson from '../data/crews.json';
import territoryData from '../data/territory.json';
import { FACTIONS, PLOTS, factionById, zoneAt } from './factions';

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
  /** faction rank needed to build it (standing.json) */
  rank?: number;
  /** spirit-warded: share of incoming structure damage it shrugs off */
  ward?: number;
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
  /** crew base pieces (Phase 11): the crew they belong to; the owner is whoever built it */
  crew?: string;
  /** crew hall: the crew's tag, the UTC hour its raid window opens, and when it was last sacked */
  tag?: string;
  raidStart?: number;
  sackedAt?: number;
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

/** Is a crew base's own raid window (starting at UTC hour `start`) open at `ms`? */
export function crewRaidOpen(start: number, ms: number): boolean {
  const h = (ms / HOUR) % 24;
  return (h - start + 24) % 24 < crewsJson.raid.hours;
}

export function crewRaidText(start: number, ms: number): string {
  const h = (ms / HOUR) % 24;
  const into = (h - start + 24) % 24;
  const hours = crewsJson.raid.hours;
  const fmt = (x: number) => `${Math.floor(x)} h ${Math.floor((x % 1) * 60)} m`;
  const span = `${String(start).padStart(2, '0')}:00-${String((start + hours) % 24).padStart(2, '0')}:00 UTC`;
  return into < hours ? `Raid window open (${span}, ${fmt(hours - into)} left)` : `Raid window ${span} (opens in ${fmt((start - h + 24) % 24)})`;
}

// ---- camps ----------------------------------------------------------------------------

/** Pieces a crew base of this crew level may hold (before workshops). */
export const basePieces = (level: number): number => crewsJson.base.pieces + crewsJson.base.piecesPerLevel * (level - 1);

/** The crew base plot a point falls on, if any. */
export const plotAt = (x: number, z: number) => PLOTS.find((p) => Math.hypot(p.x - x, p.z - z) <= territoryData.plotRadius);

/** Who is building: a character and what they carry. */
export interface Builder {
  charId: string;
  name: string;
  side: string;
  faction: string;
  x: number;
  z: number;
  inv: Inventory;
  /** faction rank (rank-gated pieces) */
  rank?: number;
  /** their crew, if any (crew halls and base pieces) */
  crew?: { id: string; tag: string; officer: boolean; level: number; raidStart: number } | null;
}

/** Where a placement really goes: the grid, and a crew hall onto its plot's centre. */
export function snapFor(piece: string, x: number, z: number, rot: number): { x: number; z: number; rot: number } {
  const p = snapPlacement(x, z, rot);
  if (pieceById(piece)?.effect === 'hall') {
    const plot = plotAt(x, z);
    if (plot) return { x: plot.x, z: plot.z, rot: p.rot };
  }
  return p;
}

export interface Placement {
  piece: string;
  x: number;
  z: number;
  rot: number;
}

export type DamageResult = { kind: 'hit' | 'broke'; s: Structure; amount: number; sacked?: boolean } | { kind: 'refused'; reason: string } | null;

/** Who is hitting a structure. */
export interface Raider {
  side: string;
  element: string | null;
  faction?: string;
}

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

  /** A character's camp (crew base pieces they built belong to the crew). */
  ofOwner(charId: string): Structure[] {
    return [...this.all.values()].filter((s) => s.owner === charId && !s.crew);
  }
  ofCrew(crew: string): Structure[] {
    return [...this.all.values()].filter((s) => s.crew === crew);
  }
  campfireOf(charId: string): Structure | undefined {
    for (const s of this.all.values()) if (s.owner === charId && s.piece === 'campfire' && !s.crew) return s;
    return undefined;
  }
  hallOf(crew: string): Structure | undefined {
    for (const s of this.all.values()) if (s.crew === crew && pieceById(s.piece)?.effect === 'hall') return s;
    return undefined;
  }
  halls(): Structure[] {
    return [...this.all.values()].filter((s) => pieceById(s.piece)?.effect === 'hall');
  }
  /** Workshops raise a camp's or base's piece limit. */
  workshopBonus(list: Structure[]): number {
    return Math.min(BUILD.workshop.maxCounted, list.filter((s) => pieceById(s.piece)?.effect === 'workshop').length) * BUILD.workshop.pieces;
  }
  /** The base a crew member is building in: their crew's hall when the spot is within its radius. */
  private baseFor(b: Builder, x: number, z: number): Structure | undefined {
    const hall = b.crew ? this.hallOf(b.crew.id) : undefined;
    return hall && Math.hypot(x - hall.x, z - hall.z) <= crewsJson.base.radius ? hall : undefined;
  }
  near(x: number, z: number, r: number): Structure[] {
    return [...this.all.values()].filter((s) => Math.hypot(s.x - x, s.z - z) <= r);
  }

  /** Why this placement isn't allowed, or null. */
  check(b: Builder, p: Placement): string | null {
    const def = pieceById(p.piece);
    if (!def) return 'Unknown piece';
    if (def.rank && (b.rank ?? 1) < def.rank) return `${def.name} needs faction rank ${def.rank}`;
    const zone = zoneAt(p.x, p.z);
    if (zone.kind !== 'wilds') return 'Camps can only be built in the Wilds';
    for (const f of FACTIONS) if (Math.hypot(p.x - f.hub.x, p.z - f.hub.z) < BUILD.minHubDistance + f.hub.safeRadius) return `Too close to ${f.hub.name}`;
    if (Math.hypot(p.x - b.x, p.z - b.z) > BUILD.placeRange + (def.effect === 'hall' ? territoryData.plotRadius : 0)) return 'Too far away to build there';
    const fire = this.campfireOf(b.charId);
    const base = this.baseFor(b, p.x, p.z);
    if (def.effect === 'hall') {
      if (!b.crew) return 'Crew halls are for crews: found or join one first';
      if (!b.crew.officer) return 'Only crew officers and the leader raise the hall';
      if (this.hallOf(b.crew.id)) return 'Your crew already has a hall';
      const plot = plotAt(p.x, p.z);
      if (!plot) return 'Crew halls go on a base plot (marked on the world map)';
      for (const h of this.halls()) if (plotAt(h.x, h.z) === plot) return `That plot belongs to [${h.tag ?? '?'}]`;
      for (const s of this.all.values()) {
        if (s.piece === 'campfire' && Math.hypot(s.x - p.x, s.z - p.z) < crewsJson.base.radius + BUILD.campRadius) return `Too close to ${s.ownerName}'s camp`;
      }
    } else if (def.effect === 'respawn') {
      if (fire) return 'You already have a camp (remove your campfire to move it)';
      for (const s of this.all.values()) {
        if (s.piece === 'campfire' && Math.hypot(s.x - p.x, s.z - p.z) < BUILD.campRadius * 2) return `Too close to ${s.ownerName}'s camp`;
        if (pieceById(s.piece)?.effect === 'hall' && Math.hypot(s.x - p.x, s.z - p.z) < crewsJson.base.radius + BUILD.campRadius) return `Too close to the [${s.tag ?? '?'}] crew base`;
      }
    } else if (base && b.crew) {
      const pieces = this.ofCrew(b.crew.id);
      const max = basePieces(b.crew.level) + this.workshopBonus(pieces);
      if (pieces.length >= max) return `Your crew base holds at most ${max} pieces`;
    } else {
      if (!fire) return b.crew && this.hallOf(b.crew.id) ? `Build within ${crewsJson.base.radius} m of your crew hall, or place a campfire for a camp` : 'Place a campfire first: it marks your camp';
      if (Math.hypot(p.x - fire.x, p.z - fire.z) > BUILD.campRadius) return `Must be within ${BUILD.campRadius} m of your campfire`;
      const mine = this.ofOwner(b.charId);
      const max = BUILD.maxPieces + this.workshopBonus(mine);
      if (mine.length >= max) return `A camp holds at most ${max} pieces`;
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
    const p = { piece: raw.piece, ...snapFor(raw.piece, raw.x, raw.z, raw.rot) };
    const err = this.check(b, p);
    if (err) return err;
    const def = pieceById(p.piece)!;
    takeItems(b.inv, def.cost);
    const hall = def.effect === 'hall';
    const crew = hall ? b.crew!.id : def.effect === 'respawn' ? undefined : this.baseFor(b, p.x, p.z)?.crew;
    const s: Structure = {
      id: `s${now.toString(36)}${(this.seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      owner: b.charId, ownerName: b.name, side: b.side, faction: b.faction, piece: p.piece,
      x: p.x, y: +restHeight(p.piece, p.x, p.z, p.rot, this.groundAt).toFixed(2), z: p.z, rot: p.rot,
      hp: def.hp, maxHp: def.hp, ownerSeen: now,
      ...(def.effect === 'storage' ? { store: {} } : {}),
      ...(crew ? { crew } : {}),
      ...(hall ? { tag: b.crew!.tag, raidStart: b.crew!.raidStart } : {}),
    };
    this.add(s);
    return s;
  }

  /** Something about a structure changed outside the rules (crew raid hour, tag): tell the listeners. */
  changed(s: Structure): void {
    if (this.all.get(s.id) === s) this.emit(s, 'hp');
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

  /** The owner (or, in a crew base, a crew officer) takes a piece down and gets half its cost back (bag space permitting). */
  remove(b: Builder, id: string): Structure | string {
    const s = this.all.get(id);
    const crewOfficer = !!s?.crew && b.crew?.id === s.crew && b.crew.officer;
    if (!s || (s.owner !== b.charId && !crewOfficer)) return 'That is not yours';
    if (Math.hypot(s.x - b.x, s.z - b.z) > BUILD.placeRange + (pieceById(s.piece)?.effect === 'hall' ? 4 : 0)) return 'Get closer to take it down';
    if (s.piece === 'campfire' && !s.crew && this.ofOwner(b.charId).length > 1) return 'Take down the rest of your camp first';
    if (pieceById(s.piece)?.effect === 'hall') {
      if (!crewOfficer) return 'Only crew officers and the leader take the hall down';
      if (this.ofCrew(s.crew!).length > 1) return 'Take down the rest of the base first';
    }
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
  /** Is this structure's raid window open? Camps share the world's; crew bases have their own. */
  raidWindow(s: Structure, now = Date.now()): { open: boolean; text: string } {
    if (this.forceRaid !== null) return { open: this.forceRaid, text: this.forceRaid ? 'Raid window open (forced)' : 'Raid window shut (forced)' };
    if (s.crew) {
      const start = this.hallOf(s.crew)?.raidStart ?? crewsJson.raid.defaultStart;
      return { open: crewRaidOpen(start, now), text: crewRaidText(start, now) };
    }
    return { open: raidOpen(now), text: raidText(now) };
  }

  /**
   * Bending hits a structure. Only the other side can damage it, only during its
   * raid window (the Ash Syndicate may chip at it outside one) and never inside a
   * safe zone. Earth hits harder, spirit wards soak some of it.
   */
  damage(id: string, amount: number, attacker: Raider, now = Date.now()): DamageResult {
    const s = this.all.get(id);
    if (!s || amount <= 0) return null;
    if (!attacker.side || attacker.side === s.side) return null;
    if (zoneAt(s.x, s.z).kind === 'safe') return null;
    const def = pieceById(s.piece);
    const window = this.raidWindow(s, now);
    let dmg = amount * (attacker.element === 'earth' ? BUILD.earthBonus : 1) * (1 - (def?.ward ?? 0));
    let floor = 0;
    if (!window.open) {
      const ash = factionById(attacker.faction)?.perk;
      if (ash?.type !== 'offWindowRaids') return { kind: 'refused', reason: `${s.crew ? 'This base' : 'Camps'} can only be raided in the raid window. ${window.text}` };
      floor = Math.ceil(s.maxHp * (ash.floor ?? 0.5));
      if (s.hp <= floor) return { kind: 'refused', reason: 'Outside the raid window even the Ash Syndicate can only weaken it this far' };
      dmg *= ash.value;
    }
    dmg = Math.max(1, Math.round(dmg));
    // The campfire and the crew hall are cores: they can be beaten down but never destroyed.
    const core = def?.effect === 'respawn' || def?.effect === 'hall';
    s.hp = Math.max(core ? 1 : floor, s.hp - dmg);
    if (s.hp <= 0) {
      this.delete(id);
      return { kind: 'broke', s, amount: dmg };
    }
    // Beating a crew hall down in its raid window sacks the base (once per window).
    let sacked = false;
    if (def?.effect === 'hall' && s.hp <= 1 && window.open && now - (s.sackedAt ?? 0) > crewsJson.raid.hours * HOUR) {
      s.sackedAt = now;
      sacked = true;
    }
    this.emit(s, 'hp');
    return { kind: 'hit', s, amount: dmg, sacked };
  }

  /** Owner online: stamp their camp so it doesn't burn down. */
  touch(charId: string, now = Date.now()): void {
    for (const s of this.all.values()) if (s.owner === charId && !s.crew) s.ownerSeen = now;
  }
  /** A crew member is online: the base stays. */
  touchCrew(crew: string, now = Date.now()): void {
    for (const s of this.all.values()) if (s.crew === crew) s.ownerSeen = now;
  }

  /**
   * Camps whose owner has been away too long burn down, and so do crew bases
   * nobody from the crew has visited for burnOfflineDays. `online` says whether
   * a structure's people are around. Returns the removed structures.
   */
  burnAbandoned(online: (s: Structure) => boolean, now = Date.now()): Structure[] {
    const out: Structure[] = [];
    for (const s of [...this.all.values()]) {
      const limit = s.crew ? crewsJson.base.burnOfflineDays * 24 * HOUR : BUILD.burnOfflineHours * HOUR;
      if (online(s) || now - s.ownerSeen < limit) continue;
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
