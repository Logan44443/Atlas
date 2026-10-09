// Wild creatures and bosses (Phase 10). Dens are a pure function of the world
// seed; the authority (shard or offline tab) fills the dens near players with
// creatures, runs their AI, schedules world bosses and turns their deaths into
// rewards. Shared so the server and offline play behave the same.
import { Vector3 } from 'three';
import wildData from '../../data/wildlife.json';
import bossData from '../../data/bosses.json';
import { hash2 } from '../noise';
import { TerrainSampler } from '../terrain';
import { FACTIONS, terrainConfig, zoneAt } from '../factions';
import { CombatSim, createEntity, center, canHarm, handOf, type SimEntity } from './combatSim';
import type { AbilityDef, ElementId, StatusDef } from '../combat';
import { levelFactor, type Progress } from '../progression';
import type { Inventory } from '../building';
import worldData from '../../data/world.json';

export const WILD = wildData;
export const BOSS_CFG = bossData;

/** A creature or pet attack (data/wildlife.json, data/pets). */
export interface CreatureAttack {
  kind: 'melee' | 'charge' | 'slam' | 'spit' | 'cone';
  name?: string;
  damage: number;
  range: number;
  every: number;
  windup: number;
  knockback?: number;
  radius?: number;
  distance?: number;
  speed?: number;
  angle?: number;
  duration?: number;
  tick?: number;
  status?: StatusDef;
}

export interface Species {
  id: string;
  name: string;
  shape: string;
  color: string;
  accent: string;
  scale: number;
  temper: 'passive' | 'neutral' | 'aggressive';
  hp: number;
  speed: number;
  levels: [number, number];
  pack: [number, number];
  xp: number;
  heights: [number, number];
  forest?: boolean;
  loot: Inventory;
  tame: string | null;
  attack: CreatureAttack | null;
}
export const SPECIES = wildData.species as unknown as Species[];
export const speciesById = (id: string) => SPECIES.find((s) => s.id === id);

export interface BossMove {
  kind: 'melee' | 'ring' | 'cone' | 'projectile' | 'charge' | 'summon';
  name: string;
  damage?: number;
  range?: number;
  radius?: number;
  angle?: number;
  duration?: number;
  tick?: number;
  windup: number;
  knockback?: number;
  pull?: number;
  lift?: number;
  speed?: number;
  count?: number;
  spread?: number;
  splash?: number;
  gravity?: number;
  distance?: number;
  species?: string;
  status?: StatusDef;
  at?: 'self' | 'target';
}
export interface BossDef {
  id: string;
  name: string;
  /** a proper name ("Frostfang", "The Hollow Stag") that takes no "the" */
  proper?: boolean;
  tier: 'legendary' | 'world' | 'mini';
  element: ElementId;
  shape: string;
  color: string;
  accent: string;
  scale: number;
  radius: number;
  height: number;
  x: number;
  z: number;
  level: number;
  minHp: number;
  hpPerPlayer: number;
  speed: number;
  arena: number;
  xp: number;
  loot: Inventory;
  pet?: string;
  respawnSeconds?: number;
  schedule?: { everyMinutes: number; offsetMinutes: number; upMinutes: number; nightOnly?: boolean };
  phases: Array<{ below: number; every: number; moves: string[]; enrage?: number }>;
}
export const BOSSES = bossData.bosses as unknown as BossDef[];
/** "the Sun Dragon", while proper names ("Frostfang", "The Hollow Stag") stand alone. */
export function theName(b: { name: string; proper?: boolean }, capital = false): string {
  return b.proper ? b.name : `${capital ? 'The' : 'the'} ${b.name}`;
}
export const MOVES = bossData.moves as unknown as Record<string, BossMove>;
export const bossById = (id: string) => BOSSES.find((b) => b.id === id);

// ---- dens ---------------------------------------------------------------------

export interface Den {
  id: string;
  species: string;
  x: number;
  z: number;
  level: number;
  count: number;
}

let sampler: TerrainSampler | null = null;
const terrain = () => (sampler ??= new TerrainSampler(terrainConfig()));
const CELL = wildData.denCell;
const SEED = worldData.seed;
const HALF = (worldData.worldChunks * worldData.chunkSize) / 2 - 40;

/** Distance to the nearest faction hub (creatures get tougher further out). */
export function hubDistance(x: number, z: number): number {
  let d = Infinity;
  for (const f of FACTIONS) d = Math.min(d, Math.hypot(x - f.hub.x, z - f.hub.z));
  return d;
}

const denCache = new Map<string, Den | null>();
/** The den of grid cell (i, j), if it has one. Deterministic. */
export function denAt(i: number, j: number): Den | null {
  const key = `${i}_${j}`;
  if (denCache.has(key)) return denCache.get(key)!;
  let den: Den | null = null;
  const h0 = hash2(i, j, SEED + 77);
  if (h0 < wildData.denChance) {
    const x = (i + 0.15 + hash2(i, j, SEED + 78) * 0.7) * CELL;
    const z = (j + 0.15 + hash2(i, j, SEED + 79) * 0.7) * CELL;
    const s = terrain();
    const y = s.height(x, z);
    const hubD = hubDistance(x, z);
    const nearBoss = BOSSES.some((b) => Math.hypot(x - b.x, z - b.z) < b.arena + 30);
    if (Math.abs(x) < HALF && Math.abs(z) < HALF && hubD >= wildData.minHubDistance && zoneAt(x, z).kind !== 'safe' && !nearBoss) {
      const fits = SPECIES.filter((sp) => y >= sp.heights[0] && y <= sp.heights[1]);
      if (fits.length) {
        const sp = fits[Math.floor(hash2(i, j, SEED + 80) * fits.length)];
        const level = Math.round(Math.min(sp.levels[1], Math.max(sp.levels[0], 1 + hubD / wildData.metresPerLevel)));
        const count = sp.pack[0] + Math.floor(hash2(i, j, SEED + 81) * (sp.pack[1] - sp.pack[0] + 1));
        den = { id: `den_${i}_${j}`, species: sp.id, x: +x.toFixed(1), z: +z.toFixed(1), level, count };
      }
    }
  }
  denCache.set(key, den);
  if (denCache.size > 20000) denCache.clear();
  return den;
}

/** Dens whose centre is within r of (x, z). */
export function densNear(x: number, z: number, r: number): Den[] {
  const out: Den[] = [];
  for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
    for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
      const d = denAt(i, j);
      if (d && Math.hypot(d.x - x, d.z - z) <= r) out.push(d);
    }
  }
  return out;
}

// ---- boss schedule ---------------------------------------------------------------

/**
 * Is this world/legendary boss's window open at wall time `now` (ms)? Every shard
 * computes the same answer, so they all rise at once. Returns the window index
 * (to remember a kill until the next window) or -1.
 */
export function bossWindow(b: BossDef, now: number, night: number): number {
  const s = b.schedule;
  if (!s) return -1;
  const cycle = s.everyMinutes * 60_000;
  const t = now - s.offsetMinutes * 60_000;
  const idx = Math.floor(t / cycle);
  if (t - idx * cycle >= s.upMinutes * 60_000) return -1;
  if (s.nightOnly && night < 0.5) return -1;
  return idx;
}

/** Minutes until the next window opens (0 if it is open now). */
export function bossNextMinutes(b: BossDef, now: number): number {
  const s = b.schedule;
  if (!s) return 0;
  const cycle = s.everyMinutes * 60_000;
  const t = now - s.offsetMinutes * 60_000;
  const into = ((t % cycle) + cycle) % cycle;
  if (into < s.upMinutes * 60_000) return 0;
  return Math.ceil((cycle - into) / 60_000);
}

// ---- brains ------------------------------------------------------------------

interface Brain {
  entity: SimEntity;
  species: Species | null;
  boss: BossDef | null;
  den: Den | null;
  home: Vector3;
  vel: Vector3;
  target: string | null;
  /** who hurt us lately -> seconds of grudge */
  grudges: Map<string, number>;
  thinkT: number;
  attackT: number;
  /** telegraph running: seconds left, and the move it releases */
  windT: number;
  windTotal: number;
  windMove: (() => void) | null;
  fleeT: number;
  /** charging: seconds left, direction, then the hit */
  lungeT: number;
  lungeDir: Vector3;
  lungeHit: (() => void) | null;
  wander: Vector3;
  wanderT: number;
  /** passive creatures are calm while someone tries to tame them */
  calmUntil: number;
  // bosses
  phase: number;
  window: number;
  summoned: boolean;
  trial: { player: string; until: number; pet: string } | null;
  /** seconds since it died (bodies linger so hosts can hand out rewards first) */
  deadT: number;
}

/** What the host turns into XP, loot, messages and pet events. */
export type WildNews =
  | { t: 'xp'; id: string; amount: number; reason: string }
  | { t: 'loot'; id: string; items: Inventory }
  | { t: 'notice'; id: string; text: string; warn?: boolean }
  | { t: 'announce'; text: string }
  | { t: 'bond'; id: string; boss: string; pet: string }
  | { t: 'rare'; id: string; boss: string; pet: string }
  | { t: 'trial'; id: string; pet: string; won: boolean }
  /** helped beat a boss (coins, faction orders) */
  | { t: 'boss'; id: string; tier: string };

/** A player as the wildlife sees them. */
export interface WildPlayer {
  entity: SimEntity;
  progress: Progress;
}

const tmp = new Vector3();
const tmp2 = new Vector3();
const vfxOf = (st?: StatusDef): ElementId => (st?.type === 'burn' ? 'fire' : st?.type === 'slow' ? 'water' : 'earth');

function turn(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, k);
}

export class Wildlife {
  readonly brains = new Map<string, Brain>();
  /** den id -> seconds until it may refill (after its creatures died) */
  private denCooldown = new Map<string, number>();
  private activeDens = new Set<string>();
  private slowT = 0;
  private bossKilled = new Map<string, number>();
  private miniRespawn = new Map<string, number>();
  /** dev: force the Bond Trial chance */
  forceBond: boolean | null = null;
  private nextId = 1;
  /** wall clock (ms) and night factor, set by the host each tick */
  now = Date.now();
  night = 0;

  constructor(private sim: CombatSim, private groundAt: (x: number, z: number) => number) {}

  // ---- spawning -------------------------------------------------------------

  private ground(x: number, z: number, water = false): number {
    const g = this.groundAt(x, z);
    return water ? Math.max(g, worldData.seaLevel - 0.4) : Math.max(g, worldData.seaLevel - 0.6);
  }

  private spawnCreature(sp: Species, x: number, z: number, level: number, den: Den | null, id?: string): Brain {
    const hp = Math.round(sp.hp * (1 + 0.08 * (level - 1)));
    const e = createEntity({
      id: id ?? `wild_${this.nextId++}`, name: sp.name, kind: 'creature', team: 'wild', element: null, level, hp, maxHp: hp,
      pos: new Vector3(x, this.ground(x, z, sp.shape === 'serpent'), z), radius: 0.55 * sp.scale + 0.15, height: 1.3 * sp.scale + 0.2,
      beast: sp.id, scale: sp.scale, bounty: sp.xp, yaw: Math.random() * Math.PI * 2,
    });
    this.sim.add(e);
    const b = this.newBrain(e, sp, null, den);
    this.brains.set(e.id, b);
    return b;
  }

  private newBrain(e: SimEntity, species: Species | null, boss: BossDef | null, den: Den | null): Brain {
    return {
      entity: e, species, boss, den, home: e.pos.clone(), vel: new Vector3(), target: null, grudges: new Map(), thinkT: Math.random() * 0.5,
      attackT: 1 + Math.random(), windT: -1, windTotal: 1, windMove: null, fleeT: 0, lungeT: 0, lungeDir: new Vector3(), lungeHit: null,
      wander: e.pos.clone(), wanderT: 0, calmUntil: 0, phase: 0, window: -1, summoned: false, trial: null, deadT: 0,
    };
  }

  /** Remove a creature from the world (tamed, despawned). */
  remove(id: string): void {
    this.brains.delete(id);
    this.sim.remove(id);
  }

  spawnBoss(def: BossDef, window = -1, at?: { x: number; z: number }): SimEntity {
    const x = at?.x ?? def.x;
    const z = at?.z ?? def.z;
    const e = createEntity({
      id: `boss_${def.id}`, name: def.name, kind: 'creature', team: 'wild', element: def.element, level: def.level, hp: def.minHp, maxHp: def.minHp,
      pos: new Vector3(x, this.ground(x, z, def.shape === 'serpent'), z), radius: def.radius, height: def.height, beast: def.shape, scale: def.scale,
      bounty: 0, role: def.tier === 'mini' ? 'miniboss' : 'boss', title: def.tier === 'legendary' ? 'Legendary' : def.tier === 'world' ? 'World boss' : 'Rare beast',
    });
    e.damagers = new Map();
    this.sim.add(e);
    const b = this.newBrain(e, null, def, null);
    b.window = window;
    this.brains.set(e.id, b);
    return e;
  }

  /** A Bond Trial: a smaller spirit of the boss that only `player` can fight. */
  spawnTrial(def: BossDef, player: SimEntity, petId: string): SimEntity {
    const c = bossData.bond;
    const dir = tmp.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    const x = player.pos.x + dir.x * 9;
    const z = player.pos.z + dir.z * 9;
    const hp = Math.round(c.trialHp + c.trialHpPerLevel * player.level);
    const e = createEntity({
      id: `trial_${player.id}`, name: `Spirit of ${theName(def)}`, kind: 'creature', team: 'wild', element: def.element, level: player.level, hp, maxHp: hp,
      pos: new Vector3(x, this.ground(x, z), z), radius: def.radius * 0.6, height: def.height * 0.6, beast: def.shape, scale: def.scale * 0.6,
      role: 'trial', title: 'Bond Trial', trialOf: player.id,
    });
    // Boss moves are tuned for a raid; the spirit hits a lone challenger softer.
    e.aura = c.trialPower;
    this.sim.add(e);
    const b = this.newBrain(e, null, def, null);
    b.trial = { player: player.id, until: this.sim.time + c.trialSeconds, pet: petId };
    b.target = player.id;
    this.brains.set(e.id, b);
    return e;
  }

  /** Bosses currently in this world (for the HUD, advice and tests). */
  get bosses(): SimEntity[] {
    return [...this.brains.values()].filter((b) => b.boss && !b.trial).map((b) => b.entity);
  }

  /** Calm a creature while a player feeds it (taming). */
  calm(id: string, seconds: number): void {
    const b = this.brains.get(id);
    if (b) {
      b.calmUntil = this.sim.time + seconds;
      b.target = null;
      b.fleeT = 0;
    }
  }

  brainOf(id: string): { species: Species | null; boss: BossDef | null } | undefined {
    return this.brains.get(id);
  }

  /** Fill dens near players, empty far ones, run bosses' schedules. Returns news. */
  update(dt: number, players: WildPlayer[]): WildNews[] {
    const news: WildNews[] = [];
    this.slowT += dt;
    if (this.slowT >= 1) {
      this.slowT = 0;
      this.populate(players, 1, news);
    }
    for (const b of [...this.brains.values()]) this.think(b, dt, players, news);
    return news;
  }

  private populate(players: WildPlayer[], dt: number, news: WildNews[]): void {
    const live = players.map((p) => p.entity);
    // Dens.
    const want = new Map<string, Den>();
    for (const p of live) for (const d of densNear(p.pos.x, p.pos.z, wildData.activateRadius)) want.set(d.id, d);
    for (const [id, t] of this.denCooldown) t - dt <= 0 ? this.denCooldown.delete(id) : this.denCooldown.set(id, t - dt);
    for (const d of want.values()) {
      if (this.activeDens.has(d.id) || this.denCooldown.has(d.id)) continue;
      this.activeDens.add(d.id);
      const sp = speciesById(d.species)!;
      for (let k = 0; k < d.count; k++) {
        const a = (k / d.count) * Math.PI * 2 + hash2(k, d.count, 5);
        this.spawnCreature(sp, d.x + Math.cos(a) * 3, d.z + Math.sin(a) * 3, d.level, d);
      }
    }
    const nearAny = (x: number, z: number, r: number) => live.some((e) => Math.hypot(e.pos.x - x, e.pos.z - z) <= r);
    for (const id of [...this.activeDens]) {
      const den = [...this.brains.values()].filter((b) => b.den?.id === id);
      const d = den[0]?.den ?? want.get(id);
      if (d && nearAny(d.x, d.z, wildData.despawnRadius)) {
        // A wiped-out den refills after a while.
        if (den.length && den.every((b) => b.entity.dead && b.deadT > 3)) {
          for (const b of den) this.remove(b.entity.id);
          this.activeDens.delete(id);
          this.denCooldown.set(id, wildData.respawnSeconds);
        }
        continue;
      }
      // Nobody around: pack up (unless still fighting).
      if (den.some((b) => !b.entity.dead && this.sim.time - b.entity.lastCombat < 8)) continue;
      for (const b of den) this.remove(b.entity.id);
      this.activeDens.delete(id);
    }
    // Summoned adds and dead strays with no den vanish after a while.
    for (const b of [...this.brains.values()]) {
      if (b.den || b.boss) continue;
      if ((b.entity.dead && b.deadT > 3) || !nearAny(b.entity.pos.x, b.entity.pos.z, wildData.despawnRadius)) this.remove(b.entity.id);
    }
    // Bosses.
    for (const def of BOSSES) {
      const id = `boss_${def.id}`;
      const cur = this.brains.get(id);
      if (def.tier === 'mini') {
        if (cur) {
          if (cur.entity.dead) {
            if (cur.deadT < 3) continue;
            this.remove(id);
            this.miniRespawn.set(def.id, def.respawnSeconds ?? 180);
          } else if (!nearAny(def.x, def.z, wildData.despawnRadius + 60) && this.sim.time - cur.entity.lastCombat > 10) this.remove(id);
          continue;
        }
        const t = (this.miniRespawn.get(def.id) ?? 0) - dt;
        this.miniRespawn.set(def.id, t);
        if (t <= 0 && nearAny(def.x, def.z, wildData.activateRadius + 60)) this.spawnBoss(def);
        continue;
      }
      const w = bossWindow(def, this.now, this.night);
      if (cur) {
        if (cur.entity.dead) {
          if (cur.deadT > 3) this.remove(id);
        }
        else if (w !== cur.window && cur.window !== -2 && this.sim.time - cur.entity.lastCombat > 15) {
          this.remove(id);
          news.push({ t: 'announce', text: `${theName(def, true)} has gone back into hiding.` });
        }
        continue;
      }
      if (w >= 0 && this.bossKilled.get(def.id) !== w) {
        this.spawnBoss(def, w);
        const dir = compassText(def.x, def.z);
        news.push({ t: 'announce', text: `${def.tier === 'legendary' ? 'Legendary' : 'World'} boss: ${theName(def)} has risen ${dir}!` });
      }
    }
  }

  /** Dev/test: raise a boss right now (optionally somewhere else). */
  forceBoss(id: string, at?: { x: number; z: number }): SimEntity | null {
    const def = bossById(id);
    if (!def) return null;
    const cur = this.brains.get(`boss_${def.id}`);
    if (cur) this.remove(cur.entity.id);
    const e = this.spawnBoss(def, -2, at);
    return e;
  }

  // ---- AI ----------------------------------------------------------------------

  private think(b: Brain, dt: number, players: WildPlayer[], news: WildNews[]): void {
    const e = b.entity;
    const sim = this.sim;
    if (e.dead) {
      e.windup = 0;
      b.deadT += dt;
      return;
    }
    // Trial timer / challenger gone.
    if (b.trial) {
      const p = sim.entities.get(b.trial.player);
      if (!p || p.dead || sim.time > b.trial.until) {
        news.push({ t: 'trial', id: b.trial.player, pet: b.trial.pet, won: false });
        this.remove(e.id);
        return;
      }
    }
    for (const ev of sim.events) {
      if (ev.t === 'hit' && ev.target === e.id && ev.source && ev.result !== 'dodged') {
        b.grudges.set(ev.source, 20);
        if (b.species?.temper === 'passive') b.fleeT = wildData.fleeSeconds;
      }
    }
    for (const [k, v] of b.grudges) v - dt <= 0 ? b.grudges.delete(k) : b.grudges.set(k, v - dt);
    if (b.boss && !b.trial) this.scaleBoss(b, players);

    // Knockback.
    b.vel.addScaledVector(e.pendingImpulse.setY(0), b.boss ? 0.15 : 0.6);
    e.pendingImpulse.set(0, 0, 0);
    b.vel.multiplyScalar(Math.exp(-dt * 4));
    const rooted = e.statuses.has('root');
    if (!rooted) e.pos.addScaledVector(b.vel, dt);

    b.thinkT -= dt;
    if (b.thinkT <= 0) {
      b.thinkT = wildData.thinkEvery;
      this.pickTarget(b);
    }
    const leash = b.boss ? (b.trial ? 1e9 : b.boss.arena) : wildData.leash;
    const target = b.target ? sim.entities.get(b.target) : undefined;
    const speedMul = (1 - (e.statuses.get('slow')?.amount ?? 0)) * (b.boss ? this.enrage(b) : 1);
    const speed = (b.boss?.speed ?? b.species!.speed) * speedMul;
    let moveTo: Vector3 | null = null;
    let moveSpeed = speed;

    if (b.lungeT > 0) {
      // Charging: run straight, hit at the end.
      b.lungeT -= dt;
      if (!rooted) e.pos.addScaledVector(b.lungeDir, dt * (b.boss ? 22 : 18));
      if (b.lungeT <= 0 && b.lungeHit) {
        const hit = b.lungeHit;
        b.lungeHit = null;
        hit();
      }
    } else if (b.windT >= 0) {
      // Telegraph: stand and wind up, then release.
      b.windT -= dt;
      e.windup = Math.min(1, 1 - b.windT / Math.max(0.01, b.windTotal));
      if (target) e.yaw = turn(e.yaw, Math.atan2(target.pos.x - e.pos.x, target.pos.z - e.pos.z), dt * 6);
      if (b.windT < 0) {
        e.windup = 0;
        const m = b.windMove;
        b.windMove = null;
        if (!e.statuses.has('stagger')) m?.();
      }
    } else if (b.fleeT > 0 && b.calmUntil < sim.time) {
      b.fleeT -= dt;
      const from = [...b.grudges.keys()].map((id) => sim.entities.get(id)).find((o) => o && !o.dead);
      if (from) {
        tmp.set(e.pos.x - from.pos.x, 0, e.pos.z - from.pos.z).normalize().multiplyScalar(10).add(e.pos);
        moveTo = tmp2.copy(tmp);
        moveSpeed = speed * 1.1;
      }
    } else if (target && !target.dead) {
      const d = Math.hypot(target.pos.x - e.pos.x, target.pos.z - e.pos.z) - target.radius - e.radius;
      e.yaw = turn(e.yaw, Math.atan2(target.pos.x - e.pos.x, target.pos.z - e.pos.z), dt * 8);
      b.attackT -= dt;
      const reach = b.boss ? 4 : b.species?.attack?.range ?? 2;
      if (d > reach * 0.8 && !(b.species?.attack?.kind === 'spit' && d < reach * 0.9)) {
        moveTo = target.pos;
        moveSpeed = speed;
      }
      if (b.attackT <= 0 && !e.statuses.has('stagger')) {
        if (b.boss) this.bossMove(b, target, players, news);
        else if (b.species?.attack && d <= (b.species.attack.range ?? 2) + 0.3) this.creatureAttack(b, b.species.attack, target);
      }
    } else if (e.pos.distanceTo(b.home) > 3 && (b.boss || Math.hypot(e.pos.x - b.home.x, e.pos.z - b.home.z) > leash * 0.5)) {
      moveTo = b.home;
      moveSpeed = speed;
    } else if (!b.boss) {
      // Graze around the den.
      b.wanderT -= dt;
      if (b.wanderT <= 0) {
        b.wanderT = 3 + Math.random() * 5;
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 10;
        b.wander.set(b.home.x + Math.cos(a) * r, 0, b.home.z + Math.sin(a) * r);
      }
      moveTo = b.wander;
      moveSpeed = speed * 0.3;
    }
    // Back home and out of the fight: heal up.
    if (!target && Math.hypot(e.pos.x - b.home.x, e.pos.z - b.home.z) < 4 && sim.time - e.lastCombat > 6 && e.hp < e.maxHp) {
      e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.2 * dt);
      // Fully recovered: the last attempt no longer counts toward rewards.
      if (e.hp >= e.maxHp) e.damagers?.clear();
    }

    if (moveTo && !rooted && !e.statuses.has('stagger') && b.windT < 0 && b.lungeT <= 0) {
      tmp.set(moveTo.x - e.pos.x, 0, moveTo.z - e.pos.z);
      const d = tmp.length();
      if (d > 0.4) {
        e.pos.addScaledVector(tmp.normalize(), Math.min(d, moveSpeed * dt));
        if (!target || b.fleeT > 0) e.yaw = turn(e.yaw, Math.atan2(tmp.x, tmp.z), dt * 8);
      }
    }
    // Stay inside the arena / near the den.
    const off = tmp.set(e.pos.x - b.home.x, 0, e.pos.z - b.home.z);
    if (off.length() > leash) {
      e.pos.set(b.home.x + (off.x / off.length()) * leash, e.pos.y, b.home.z + (off.z / off.length()) * leash);
      if (!b.trial) b.target = null;
    }
    e.pos.y = this.ground(e.pos.x, e.pos.z, e.beast === 'serpent' || e.beast === 'eel');
  }

  private enrage(b: Brain): number {
    return b.boss?.phases[b.phase]?.enrage ?? 1;
  }

  private pickTarget(b: Brain): void {
    const e = b.entity;
    const sim = this.sim;
    const leash = b.boss ? (b.trial ? 1e9 : b.boss.arena + 10) : wildData.leash + 6;
    const inRange = (o: SimEntity) => Math.hypot(o.pos.x - b.home.x, o.pos.z - b.home.z) < leash;
    const cur = b.target ? sim.entities.get(b.target) : undefined;
    if (b.trial) {
      b.target = b.trial.player;
      return;
    }
    if (cur && !cur.dead && canHarm(e, cur, sim.time) && inRange(cur)) {
      // Bosses switch to whoever hurts them most now and then.
      if (!b.boss || Math.random() > 0.15) return;
    }
    b.target = null;
    if (b.species?.temper === 'passive' || b.calmUntil > sim.time) return;
    let best = Infinity;
    for (const o of sim.entities.values()) {
      if (o.dead || (o.kind !== 'player' && o.kind !== 'pet') || !canHarm(e, o, sim.time) || !inRange(o)) continue;
      const d = o.pos.distanceTo(e.pos);
      const aggro = b.boss ? b.boss.arena : b.species?.temper === 'aggressive' ? wildData.aggroRange : 0;
      if (!b.grudges.has(o.id) && !(o.owner && b.grudges.has(o.owner)) && d > aggro) continue;
      const score = d - (b.grudges.has(o.id) ? 8 : 0);
      if (score < best) {
        best = score;
        b.target = o.id;
      }
    }
  }

  private telegraph(b: Brain, seconds: number, release: () => void): void {
    b.windT = seconds;
    b.windTotal = seconds;
    b.windMove = release;
    b.entity.windup = 0.01;
  }

  private creatureAttack(b: Brain, a: CreatureAttack, target: SimEntity): void {
    const e = b.entity;
    b.attackT = a.every;
    const el = vfxOf(a.status);
    const def = attackAbility(a);
    this.telegraph(b, a.windup, () => {
      const t = this.sim.entities.get(target.id);
      if (!t || t.dead) return;
      const dir = center(t).sub(center(e)).normalize();
      if (a.kind === 'charge') {
        b.lungeDir.copy(dir).setY(0).normalize();
        const dist = Math.min(a.distance ?? 8, Math.max(2, e.pos.distanceTo(t.pos) - 1));
        b.lungeT = dist / 18;
        b.lungeHit = () => this.sim.perform(e, { ...def, kind: 'melee', angle: 120 }, b.lungeDir, null, el);
        return;
      }
      if (a.kind === 'spit') {
        this.sim.spawnProjectile(e, def, el, handOf(e, dir), dir, (1 + 0.04 * (e.level - 1)));
        return;
      }
      this.sim.perform(e, def, dir, null, el);
    });
    if (a.windup >= 0.5) this.sim.events.push({ t: 'charge', caster: e.id, ability: def.id, element: el, duration: a.windup });
  }

  // ---- bosses -----------------------------------------------------------------

  /** Health follows how many people are in the arena. */
  private scaleBoss(b: Brain, players: WildPlayer[]): void {
    const def = b.boss!;
    const e = b.entity;
    const n = players.filter((p) => Math.hypot(p.entity.pos.x - b.home.x, p.entity.pos.z - b.home.z) < def.arena + 30).length;
    const want = Math.max(def.minHp, def.hpPerPlayer * n);
    if (want > e.maxHp) {
      const ratio = e.hp / e.maxHp;
      e.maxHp = want;
      e.hp = Math.round(want * ratio);
    }
    const frac = e.hp / e.maxHp;
    let ph = 0;
    def.phases.forEach((p, i) => {
      if (frac <= p.below) ph = i;
    });
    if (ph !== b.phase) {
      b.phase = ph;
      this.sim.events.push({ t: 'status', target: e.id, status: 'stagger', duration: 0.01 });
    }
  }

  private bossMove(b: Brain, target: SimEntity, _players: WildPlayer[], news: WildNews[]): void {
    const def = b.boss!;
    const e = b.entity;
    const phase = def.phases[b.phase] ?? def.phases[0];
    const enr = phase.enrage ?? 1;
    b.attackT = phase.every / enr;
    let pool = phase.moves.filter((m) => MOVES[m]);
    if (b.trial) pool = pool.filter((m) => MOVES[m].kind !== 'summon');
    // Don't bite from across the arena.
    const dist = e.pos.distanceTo(target.pos);
    pool = pool.filter((m) => MOVES[m].kind !== 'melee' || dist < (MOVES[m].range ?? 4) + 2);
    if (b.summoned) pool = pool.filter((m) => MOVES[m].kind !== 'summon');
    if (!pool.length) return;
    const id = pool[Math.floor(Math.random() * pool.length)];
    const m = MOVES[id];
    const el = def.element;
    const windup = m.windup / Math.sqrt(enr);
    const def2 = moveAbility(id, m);
    // Ground telegraphs so people can get out of the way.
    const tPos = target.pos.clone();
    if (m.kind === 'ring') {
      const at = m.at === 'target' ? tPos : e.pos;
      this.sim.events.push({ t: 'tele', owner: e.id, shape: 'ring', pos: [at.x, at.y, at.z], dir: [0, 0, 1], radius: m.radius ?? 5, angle: 360, duration: windup });
    } else if (m.kind === 'cone') {
      const d = tmp.subVectors(tPos, e.pos).setY(0).normalize();
      this.sim.events.push({ t: 'tele', owner: e.id, shape: 'cone', pos: [e.pos.x, e.pos.y, e.pos.z], dir: [d.x, 0, d.z], radius: m.range ?? 12, angle: m.angle ?? 50, duration: windup });
    } else if (m.kind === 'charge') {
      const d = tmp.subVectors(tPos, e.pos).setY(0).normalize();
      this.sim.events.push({ t: 'tele', owner: e.id, shape: 'line', pos: [e.pos.x, e.pos.y, e.pos.z], dir: [d.x, 0, d.z], radius: m.distance ?? 14, angle: (m.radius ?? 3) * 2, duration: windup });
    }
    this.sim.events.push({ t: 'charge', caster: e.id, ability: id, element: el, duration: windup });
    this.telegraph(b, windup, () => {
      const t = this.sim.entities.get(target.id);
      const aim = t && !t.dead ? center(t) : tPos.clone().setY(tPos.y + 1);
      const dir = aim.sub(center(e)).normalize();
      switch (m.kind) {
        case 'melee':
        case 'cone':
          this.sim.perform(e, def2, dir, null, el);
          break;
        case 'ring': {
          if (m.at === 'target') {
            // Rings at a target: a short-lived area anchored there (owner stays where it is).
            const ghost = { ...e, pos: tPos.clone() } as SimEntity;
            this.sim.perform(ghost, def2, dir, null, el);
          } else this.sim.perform(e, def2, dir, null, el);
          break;
        }
        case 'projectile':
          this.sim.perform(e, def2, dir, null, el);
          break;
        case 'charge': {
          b.lungeDir.copy(dir).setY(0).normalize();
          const dist = Math.min(m.distance ?? 14, Math.max(3, e.pos.distanceTo(tPos)));
          b.lungeT = dist / 22;
          b.lungeHit = () => this.sim.perform(e, { ...def2, kind: 'ring', radius: m.radius ?? 3.5, duration: 0.2, tick: 0.01 }, b.lungeDir, null, el);
          break;
        }
        case 'summon': {
          const sp = speciesById(m.species ?? 'wolf');
          if (!sp) break;
          b.summoned = true;
          for (let i = 0; i < (m.count ?? 2); i++) {
            const a = Math.random() * Math.PI * 2;
            const add = this.spawnCreature(sp, e.pos.x + Math.cos(a) * 6, e.pos.z + Math.sin(a) * 6, Math.max(sp.levels[0], def.level - 8), null);
            add.target = target.id;
            add.home.copy(b.home);
          }
          news.push({ t: 'notice', id: target.id, text: `${theName(def, true)} calls for help!`, warn: true });
          break;
        }
      }
    });
  }

  // ---- deaths -------------------------------------------------------------------

  /**
   * A creature died: loot for the killer, and for bosses XP + loot for everyone
   * who helped, the legendary bond roll, rare pet offers and trial results.
   * `killer` is the player credited (pets credit their owner).
   */
  onDeath(victimId: string, killer: string | null, players: Map<string, WildPlayer>): WildNews[] {
    const b = this.brains.get(victimId);
    if (!b) return [];
    const out: WildNews[] = [];
    const e = b.entity;
    if (b.trial) {
      out.push({ t: 'trial', id: b.trial.player, pet: b.trial.pet, won: killer === b.trial.player });
      this.remove(e.id);
      return out;
    }
    if (b.species) {
      if (killer && players.has(killer) && Object.keys(b.species.loot).length) out.push({ t: 'loot', id: killer, items: { ...b.species.loot } });
      return out;
    }
    const def = b.boss;
    if (!def) return out;
    if (def.tier !== 'mini') {
      this.bossKilled.set(def.id, b.window);
      out.push({ t: 'announce', text: `${theName(def, true)} has been defeated!` });
    }
    const dmg = e.damagers ?? new Map<string, number>();
    // Everyone who dealt at least contributionMin of the damage it took shares the rewards.
    let total = 0;
    for (const v of dmg.values()) total += v;
    const min = BOSS_CFG.contributionMin * Math.max(1, total);
    for (const [id, amount] of dmg) {
      const p = players.get(id);
      if (!p || amount < min) continue;
      if (Math.hypot(p.entity.pos.x - e.pos.x, p.entity.pos.z - e.pos.z) > BOSS_CFG.rewardRadius) continue;
      const xp = Math.round(def.xp * levelFactor(p.progress.level, def.level));
      if (xp > 0) out.push({ t: 'xp', id, amount: xp, reason: `defeated ${theName(def)}` });
      else out.push({ t: 'xp', id, amount: 0, reason: `no XP: ${theName(def)} is far below your level` });
      out.push({ t: 'loot', id, items: { ...def.loot } });
      out.push({ t: 'boss', id, tier: def.tier });
      if (def.tier === 'mini' && def.pet) out.push({ t: 'rare', id, boss: def.id, pet: def.pet });
      if (def.tier === 'legendary' && def.pet && p.entity.element === def.element) {
        const pity = p.progress.pets.pity[def.id] ?? 0;
        const chance = bondChance(pity);
        const won = this.forceBond ?? Math.random() < chance;
        if (won) {
          p.progress.pets.pity[def.id] = 0;
          out.push({ t: 'bond', id, boss: def.id, pet: def.pet });
        } else {
          p.progress.pets.pity[def.id] = pity + 1;
          out.push({ t: 'notice', id, text: `${theName(def, true)} did not answer your call (bond chance now ${Math.round(bondChance(pity + 1) * 100)}%)` });
        }
      }
    }
    return out;
  }
}

/** Bond Trial chance after `pity` failed rolls (bad-luck protection). */
export function bondChance(pity: number): number {
  const c = BOSS_CFG.bond;
  return Math.min(c.maxChance, c.baseChance + c.pityStep * pity);
}

/** "to the north-east, 1.2 km from the centre" style hint for announcements. */
export function compassText(x: number, z: number): string {
  return `in the ${bearingName(Math.atan2(x, -z))} of the world`;
}

/** Bearing (radians, 0 = north = -z, clockwise) as a compass word. */
export function bearingName(a: number): string {
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const i = Math.round((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return names[i];
}

/** "320 m to the north-east" from (fx, fz) to (tx, tz). */
export function directions(fx: number, fz: number, tx: number, tz: number): string {
  const d = Math.hypot(tx - fx, tz - fz);
  const dist = d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`;
  return `${dist} to the ${bearingName(Math.atan2(tx - fx, -(tz - fz)))}`;
}

/** AbilityDef for a creature or pet attack. */
export function attackAbility(a: CreatureAttack): AbilityDef {
  const base = { slot: 'basic' as const, id: `beast_${a.kind}`, name: a.name ?? 'Attack', damage: a.damage, chiCost: 0, cooldown: 0, vfx: '', anim: '', knockback: a.knockback, status: a.status };
  switch (a.kind) {
    case 'spit':
      return { ...base, kind: 'projectile', range: Math.max(a.range, 20) + 6, speed: a.speed ?? 24, radius: 0.35 };
    case 'slam':
      return { ...base, kind: 'ring', radius: a.radius ?? 3, duration: 0.3, tick: 0.01 };
    case 'cone':
      return { ...base, kind: 'cone', range: a.range, angle: a.angle ?? 40, duration: a.duration ?? 1, tick: a.tick ?? 0.3 };
    default:
      return { ...base, kind: 'melee', range: a.range + 0.6, angle: 110 };
  }
}

/** AbilityDef for a boss move. */
export function moveAbility(id: string, m: BossMove): AbilityDef {
  const base: AbilityDef = {
    slot: 'heavy', id, name: m.name, kind: 'melee', damage: m.damage ?? 0, chiCost: 0, cooldown: 0, vfx: '', anim: '',
    knockback: m.knockback, status: m.status, pull: m.pull, lift: m.lift,
  };
  switch (m.kind) {
    case 'ring':
      return { ...base, kind: 'ring', radius: m.radius, duration: m.duration ?? 0.3, tick: m.tick ?? 0.3 };
    case 'cone':
      return { ...base, kind: 'cone', range: m.range, angle: m.angle, duration: m.duration ?? 1, tick: m.tick ?? 0.3 };
    case 'projectile':
      return { ...base, kind: 'projectile', range: m.range, speed: m.speed, radius: m.radius, count: m.count, spread: m.spread, splash: m.splash, gravity: m.gravity };
    default:
      return { ...base, kind: 'melee', range: m.range ?? 4.5, angle: m.angle ?? 90 };
  }
}
