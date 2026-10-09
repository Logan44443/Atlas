// Progression rules shared by the shard server and offline play: XP curve,
// kill/discovery rewards with the anti-griefing rules, mastery trees and the
// combat modifiers they grant. Pure data + math, no DOM.
import progressionData from '../data/progression.json';
import masteryData from '../data/mastery.json';
import type { AbilityDef, ElementId, ElementKit, Slot } from './combat';
import { SLOTS } from './combat';
import { FACTIONS, CONTESTED, OUTPOSTS, PVP, zoneAt } from './factions';
import { newArtsState, type ArtsState } from './arts';
import type { Inventory } from './building';
import { newPetsState, type PetsState } from './petsState';
import { newStanding, type Standing } from './standing';
import type { SimEntity } from './sim/combatSim';

export const PROG = progressionData;

// ---- levels -----------------------------------------------------------------

export function xpToNext(level: number): number {
  if (level >= PROG.maxLevel) return 0;
  return Math.round(PROG.xpCurve.base * level ** PROG.xpCurve.exponent);
}

/** What a character carries between sessions. */
export interface Progress {
  level: number;
  xp: number;
  mastery: Record<string, number>;
  discovered: string[];
  /** Special Arts: learned, equipped, quests in progress (Phase 8) */
  arts: ArtsState;
  /** faction rank 1-10 */
  rank: number;
  /** materials carried (Phase 9) */
  inv: Inventory;
  /** one-time building XP milestones reached */
  milestones: string[];
  /** pets, rare pet quests and Bond Trial luck (Phase 10) */
  pets: PetsState;
  /** faction rank points, bounty/honour, coins and the current faction order (Phase 11) */
  standing: Standing;
}

export function newProgress(p: Partial<Progress> = {}): Progress {
  return { level: 1, xp: 0, mastery: {}, discovered: [], arts: newArtsState(), rank: 1, inv: {}, milestones: [], pets: newPetsState(), standing: newStanding(), ...p };
}

/** Adds XP (levelling up as needed) and returns how many levels were gained. */
export function addXp(p: Progress, amount: number): number {
  if (amount <= 0 || p.level >= PROG.maxLevel) return 0;
  p.xp += Math.round(amount);
  let gained = 0;
  while (p.level < PROG.maxLevel && p.xp >= xpToNext(p.level)) {
    p.xp -= xpToNext(p.level);
    p.level++;
    gained++;
  }
  if (p.level >= PROG.maxLevel) p.xp = 0;
  return gained;
}

// ---- mastery ----------------------------------------------------------------

export type EffectKey = 'dmg' | 'cd' | 'chi' | 'radius' | 'range' | 'status' | 'dot' | 'duration' | 'knock' | 'crit' | 'hp' | 'maxChi' | 'regen' | 'armor';
export interface MasteryNode {
  id: string;
  name: string;
  tier: number;
  max: number;
  text: string;
  effects: Partial<Record<EffectKey, number>> & { slots?: Slot[] };
}
export interface MasteryBranch {
  id: string;
  name: string;
  text: string;
  nodes: MasteryNode[];
}

export const TIER_POINTS = masteryData.tierPoints;
const TREES = masteryData.trees as Record<ElementId, MasteryBranch[]>;

export const treeFor = (el: ElementId): MasteryBranch[] => TREES[el];
export const pointsEarned = (level: number): number => (level - 1) * PROG.pointsPerLevel;
export const pointsSpent = (alloc: Record<string, number>): number => Object.values(alloc).reduce((a, b) => a + b, 0);
export const branchPoints = (b: MasteryBranch, alloc: Record<string, number>): number => b.nodes.reduce((a, n) => a + (alloc[n.id] ?? 0), 0);

/** Why a point can't go into this node (null = it can). */
export function cannotRaise(el: ElementId, level: number, alloc: Record<string, number>, nodeId: string): string | null {
  for (const b of treeFor(el)) {
    const n = b.nodes.find((x) => x.id === nodeId);
    if (!n) continue;
    if ((alloc[n.id] ?? 0) >= n.max) return 'Already at max rank';
    if (pointsSpent(alloc) >= pointsEarned(level)) return 'No mastery points left';
    // Points in this node don't count toward its own tier requirement.
    const before = branchPoints(b, alloc) - b.nodes.filter((x) => x.tier >= n.tier).reduce((a, x) => a + (alloc[x.id] ?? 0), 0);
    if (before < TIER_POINTS[n.tier]) return `Needs ${TIER_POINTS[n.tier]} points in ${b.name}`;
    return null;
  }
  return 'Unknown skill';
}

/**
 * Rebuilds an allocation point by point (tier order) so it only keeps what the
 * rules allow. The server runs every allocation it receives or loads through this.
 */
export function sanitizeAlloc(el: ElementId, level: number, raw: unknown): Record<string, number> {
  const want = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const b of treeFor(el)) {
    for (const n of [...b.nodes].sort((a, c) => a.tier - c.tier)) {
      const r = Math.floor(Number(want[n.id]) || 0);
      for (let i = 0; i < r; i++) {
        if (cannotRaise(el, level, out, n.id)) break;
        out[n.id] = (out[n.id] ?? 0) + 1;
      }
    }
  }
  return out;
}

// ---- modifiers ----------------------------------------------------------------

export interface SlotMods {
  dmg: number;
  cd: number;
  chi: number;
  radius: number;
  range: number;
  status: number;
  dot: number;
  duration: number;
  knock: number;
}
export interface Mods {
  slots: Record<Slot, SlotMods>;
  crit: number;
  hp: number;
  maxChi: number;
  regen: number;
  armor: number;
}

const SLOT_KEYS: Array<keyof SlotMods> = ['dmg', 'cd', 'chi', 'radius', 'range', 'status', 'dot', 'duration', 'knock'];
const zeroSlot = (): SlotMods => ({ dmg: 0, cd: 0, chi: 0, radius: 0, range: 0, status: 0, dot: 0, duration: 0, knock: 0 });
const emptyMods = (): Mods => ({ slots: Object.fromEntries(SLOTS.map((s) => [s, zeroSlot()])) as Record<Slot, SlotMods>, crit: 0, hp: 0, maxChi: 0, regen: 0, armor: 0 });

/** Unmodified (NPCs, dummies, fresh characters). Shared and never mutated. */
export const NO_MODS: Mods = emptyMods();

export function computeMods(el: ElementId | null, alloc: Record<string, number>): Mods {
  if (!el || !Object.keys(alloc).length) return NO_MODS;
  const m = emptyMods();
  for (const b of treeFor(el)) {
    for (const n of b.nodes) {
      const r = alloc[n.id] ?? 0;
      if (!r) continue;
      const fx = n.effects;
      const slots = fx.slots ?? SLOTS;
      for (const k of SLOT_KEYS) if (fx[k]) for (const s of slots) m.slots[s][k] += fx[k]! * r;
      m.crit += (fx.crit ?? 0) * r;
      m.hp += (fx.hp ?? 0) * r;
      m.maxChi += (fx.maxChi ?? 0) * r;
      m.regen += (fx.regen ?? 0) * r;
      m.armor += (fx.armor ?? 0) * r;
    }
  }
  // Caps so stacking can't break the game.
  for (const s of SLOTS) {
    m.slots[s].cd = Math.min(0.5, m.slots[s].cd);
    m.slots[s].chi = Math.min(0.5, m.slots[s].chi);
  }
  m.crit = Math.min(0.5, m.crit);
  m.armor = Math.min(0.4, m.armor);
  return m;
}

const kitCache = new WeakMap<Mods, Map<ElementKit, ElementKit>>();

/** The element kit with mastery modifiers applied (memoised per Mods object). */
export function modKit(kit: ElementKit, mods: Mods): ElementKit {
  if (mods === NO_MODS) return kit;
  let byKit = kitCache.get(mods);
  if (!byKit) kitCache.set(mods, (byKit = new Map()));
  let out = byKit.get(kit);
  if (!out) {
    out = { ...kit, abilities: kit.abilities.map((a) => modAbility(a, mods.slots[a.slot])) };
    byKit.set(kit, out);
  }
  return out;
}

export function modAbility(a: AbilityDef, m: SlotMods): AbilityDef {
  const d: AbilityDef = { ...a };
  d.damage = a.damage * (1 + m.dmg);
  d.cooldown = a.cooldown * (1 - m.cd);
  d.chiCost = Math.round(a.chiCost * (1 - m.chi));
  if (a.radius !== undefined) d.radius = a.radius * (1 + m.radius);
  if (a.splash !== undefined) d.splash = a.splash * (1 + m.radius);
  if (a.range !== undefined) d.range = a.range * (1 + m.range);
  if (a.distance !== undefined) d.distance = a.distance * (1 + m.range);
  if (a.duration !== undefined && (a.kind === 'ring' || a.kind === 'cone' || a.kind === 'shield')) d.duration = a.duration * (1 + m.duration);
  if (a.knockback !== undefined) d.knockback = a.knockback * (1 + m.knock);
  if (a.status) {
    const s = { ...a.status, duration: a.status.duration * (1 + m.status) };
    if (s.dps !== undefined) s.dps = s.dps * (1 + m.dot);
    if (s.amount !== undefined) s.amount = Math.min(0.9, s.amount * (1 + m.dot));
    d.status = s;
  }
  return d;
}

// ---- XP rewards ---------------------------------------------------------------

export interface Landmark {
  id: string;
  name: string;
  x: number;
  z: number;
  xp: number;
}
export const LANDMARKS: Landmark[] = [
  ...FACTIONS.map((f) => ({ id: `hub_${f.id}`, name: f.hub.name, x: f.hub.x, z: f.hub.z, xp: PROG.discovery.hub })),
  ...CONTESTED.map((c) => ({ id: c.id, name: c.name, x: c.x, z: c.z, xp: PROG.discovery.shrine })),
  ...OUTPOSTS.map((c) => ({ id: c.id, name: c.name, x: c.x, z: c.z, xp: PROG.discovery.outpost })),
];

export interface XpAward {
  /** entity id of the player who gets it */
  id: string;
  amount: number;
  reason: string;
}

/** A player the XP rules can credit. */
export interface XpPlayer {
  entity: SimEntity;
  progress: Progress;
  /** sim time of the last respawn (spawn-kill rule) */
  respawnedAt: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Level-difference factor: tougher targets give more, much weaker ones nothing. */
export function levelFactor(killerLevel: number, victimLevel: number): number {
  const L = PROG.levelDiff;
  if (killerLevel - victimLevel >= L.greyGap) return 0;
  return clamp(1 + L.perLevel * (victimLevel - killerLevel), L.min, L.max);
}

/**
 * Turns kills and exploration into XP. One per host (shard or offline tab);
 * it remembers recent PvP kills for the diminishing-returns rule.
 */
export class XpRules {
  private recentKills = new Map<string, number[]>();

  /**
   * @param members ids of the killer's party members (including the killer), or just the killer
   */
  onKill(victim: SimEntity, killer: XpPlayer, players: Map<string, XpPlayer>, members: string[], time: number): XpAward[] {
    let base = 0;
    let reason = victim.name;
    let isDummy = false;
    // Wild creatures pay their bounty; bosses reward everyone who fought (shared/sim/wildlife.ts).
    if (victim.kind === 'creature') base = victim.damagers ? 0 : victim.bounty;
    else if (victim.kind === 'npc') base = (PROG.kill.npc as Record<string, number>)[victim.role ?? ''] ?? 0;
    else if (victim.kind === 'dummy') {
      isDummy = true;
      base = (PROG.kill.dummy as Record<string, number>)[victim.id.replace(/^.*?(dummy_)/, '$1')] ?? 0;
    } else if (victim.kind === 'player') {
      const vp = players.get(victim.id);
      if (vp && time - vp.respawnedAt < PROG.pvp.spawnKillSeconds) return [{ id: killer.entity.id, amount: 0, reason: 'no XP for spawn kills' }];
      const key = `${killer.entity.id}>${victim.id}`;
      const times = (this.recentKills.get(key) ?? []).filter((t) => time - t < PROG.pvp.repeatWindowSeconds);
      const n = times.length;
      times.push(time);
      this.recentKills.set(key, times);
      if (n > PROG.pvp.maxRepeats) return [{ id: killer.entity.id, amount: 0, reason: `no XP: killed ${victim.name} too often` }];
      base = PROG.kill.player * PROG.pvp.repeatFactor ** n;
      // Flagged PvP in the Wilds pays a bonus (DESIGN section 5).
      if (zoneAt(victim.pos.x, victim.pos.z).kind === 'wilds' && killer.entity.pvp) base *= 1 + PVP.flaggedXpBonus;
      reason = `defeated ${victim.name}`;
    }
    if (base <= 0) return [];

    const share = PROG.party;
    const eligible = members
      .map((id) => players.get(id))
      .filter((p): p is XpPlayer => !!p && (p === killer || (!p.entity.dead && Math.hypot(p.entity.pos.x - victim.pos.x, p.entity.pos.z - victim.pos.z) <= share.shareRadius)));
    if (!eligible.includes(killer)) eligible.push(killer);
    const total = base * (1 + share.bonusPerMember * (eligible.length - 1));
    const out: XpAward[] = [];
    for (const p of eligible) {
      if (isDummy && p.progress.level > PROG.kill.dummyMaxLevel) continue;
      const amount = Math.round((total / eligible.length) * levelFactor(p.progress.level, victim.level));
      if (amount > 0) out.push({ id: p.entity.id, amount, reason: p === killer ? reason : `party: ${reason}` });
      else if (p === killer) out.push({ id: p.entity.id, amount: 0, reason: `no XP: ${victim.name} is far below your level` });
    }
    return out;
  }

  /** First visit to a landmark. */
  discover(p: XpPlayer): XpAward | null {
    const e = p.entity;
    for (const l of LANDMARKS) {
      if (p.progress.discovered.includes(l.id)) continue;
      if (Math.hypot(e.pos.x - l.x, e.pos.z - l.z) > PROG.discovery.radius) continue;
      p.progress.discovered.push(l.id);
      return { id: e.id, amount: l.xp, reason: `discovered ${l.name}` };
    }
    return null;
  }
}
