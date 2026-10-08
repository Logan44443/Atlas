// Authoritative combat simulation. Runs on the Colyseus server and, in offline
// play, in the browser. It never touches rendering or input: it consumes cast
// requests and emits events that clients turn into visuals.
// Uses three's math classes only (safe in Node).
import { Vector3 } from 'three';
import fireKit from '../../data/abilities/fire.json';
import waterKit from '../../data/abilities/water.json';
import earthKit from '../../data/abilities/earth.json';
import airKit from '../../data/abilities/air.json';
import combatData from '../../data/combat.json';
import {
  matchup, elementPower, canBend, levelPower,
  type AbilityDef, type CombatConfig, type ElementContext, type ElementId, type ElementKit, type Slot, type StatusDef, type StatusType,
} from '../combat';
import { zoneAt, PVP } from '../factions';
import { modKit, NO_MODS, PROG, type Mods } from '../progression';
import comboData from '../../data/partyCombos.json';

export interface PartyCombo {
  id: string;
  name: string;
  elements: ElementId[];
  radius: number;
  duration: number;
  tick: number;
  damage: number;
  status?: StatusDef;
  color: string;
}
export const COMBOS = comboData.combos as PartyCombo[];
export const comboFor = (a: ElementId, b: ElementId): PartyCombo | undefined =>
  a === b ? undefined : COMBOS.find((c) => c.elements.includes(a) && c.elements.includes(b));

export const CFG = combatData as unknown as CombatConfig;
export const KITS: Record<ElementId, ElementKit> = {
  fire: fireKit as ElementKit,
  water: waterKit as ElementKit,
  earth: earthKit as ElementKit,
  air: airKit as ElementKit,
};

export type Team = string;

export interface ActiveStatus {
  type: StatusType;
  remaining: number;
  dps: number;
  amount: number;
  tickAcc: number;
  source: string | null;
}

export interface Shield {
  remaining: number;
  reduction: number;
  blocksProjectiles: boolean;
  reflects: boolean;
  radius: number;
  element: ElementId;
}

/** Anything that can be hit. Position is the feet; capsule is radius/height. */
export interface SimEntity {
  id: string;
  name: string;
  kind: 'player' | 'dummy' | 'npc';
  /** NPC role (vendor, trainer, quest, guard, fighter) and title shown on its nameplate. */
  role?: string;
  title?: string;
  team: Team;
  element: ElementId | null;
  level: number;
  pos: Vector3;
  radius: number;
  height: number;
  hp: number;
  maxHp: number;
  chi: number;
  maxChi: number;
  lastCombat: number;
  statuses: Map<StatusType, ActiveStatus>;
  shield: Shield | null;
  blocking: boolean;
  blockStart: number;
  invulnerable: boolean;
  grounded: boolean;
  dead: boolean;
  cooldowns: Map<Slot, number>;
  combo: number;
  comboT: number;
  /** Knockback the owner (client or dummy AI) should apply. */
  pendingImpulse: Vector3;
  /** Element context for bending bonuses (time of day etc.), set by the host each tick. */
  ctx: ElementContext;
  /** Opted in to PvP (wilds): flagged players of opposite sides can fight. */
  pvp: boolean;
  /** Faction id and side ('order' | 'outlaw'); '' for none (dummies, wild creatures). */
  faction: string;
  side: string;
  /** Sim time until which other players can't hurt this entity (spawn protection). */
  protectedUntil: number;
  /** Facing, for remote rendering. */
  yaw: number;
  /** 0..1 attack telegraph (dummies), replicated so players can time blocks. */
  windup: number;
  /** Mastery modifiers (players); NO_MODS otherwise. Set through setMods(). */
  mods: Mods;
  /** Party id ('' = none). Party members' different elements combine into combos. */
  party: string;
  /** Last party hit on this entity, for combo detection. */
  mark: { source: string; element: ElementId; party: string; t: number } | null;
  comboReadyAt: number;
}

/**
 * Who may damage whom. Zones: nobody fights inside a safe zone, opposite sides
 * always may in contested territory, and in the wilds players need both PvP
 * flags up. Allies (same side) never hurt each other. Dummies only fight players.
 */
export function canHarm(a: SimEntity, b: SimEntity, time = 0): boolean {
  if (a === b || b.dead) return false;
  if (a.kind === 'dummy' || b.kind === 'dummy') return a.kind !== b.kind && (a.kind === 'player' || b.kind === 'player');
  if (a.side && a.side === b.side) return false;
  const zb = zoneAt(b.pos.x, b.pos.z).kind;
  const za = zoneAt(a.pos.x, a.pos.z).kind;
  if (za === 'safe' || zb === 'safe') return false;
  if (a.kind === 'player' && b.kind === 'player') {
    if (b.protectedUntil > time) return false;
    if (za === 'contested' || zb === 'contested') return true;
    return a.pvp && b.pvp;
  }
  // NPCs: rival sides fight; wild creatures fight everyone.
  return true;
}

export type SimEvent =
  | { t: 'cast'; caster: string; ability: string; slot: Slot; element: ElementId; dir: [number, number, number] }
  | { t: 'proj'; id: number; owner: string; ability: string; element: ElementId; pos: [number, number, number]; vel: [number, number, number]; radius: number; gravity: number }
  | { t: 'projEnd'; id: number; pos: [number, number, number]; splash: number; element: ElementId }
  | { t: 'reflect'; id: number; owner: string; pos: [number, number, number]; vel: [number, number, number] }
  | { t: 'hit'; target: string; source: string | null; amount: number; element: ElementId | null; result: 'hit' | 'blocked' | 'perfect' | 'dodged' | 'miss'; dot?: boolean; crit?: boolean }
  | { t: 'level'; target: string; level: number }
  | { t: 'combo'; id: number; combo: string; name: string; pos: [number, number, number]; radius: number; duration: number; members: [string, string] }
  | { t: 'status'; target: string; status: StatusType; duration: number }
  | { t: 'area'; id: number; owner: string; ability: string; element: ElementId; kind: 'ring' | 'cone'; pos: [number, number, number]; duration: number; radius: number; range: number; angle: number; swirl: boolean; follow: boolean }
  | { t: 'melee'; owner: string; element: ElementId; pos: [number, number, number]; dir: [number, number, number]; range: number; angle: number }
  | { t: 'shield'; target: string; element: ElementId; radius: number; duration: number }
  | { t: 'shieldEnd'; target: string }
  | { t: 'dash'; owner: string; element: ElementId; dir: [number, number, number]; distance: number; duration: number; lift: number }
  | { t: 'impulse'; target: string; v: [number, number, number] }
  | { t: 'death'; target: string; source: string | null }
  | { t: 'respawn'; target: string }
  | { t: 'castFail'; caster: string; slot: Slot; reason: string };

interface Projectile {
  id: number;
  owner: SimEntity;
  ability: AbilityDef;
  element: ElementId;
  pos: Vector3;
  vel: Vector3;
  travelled: number;
  power: number;
  reflected: boolean;
}

interface Area {
  id: number;
  owner: SimEntity;
  ability: AbilityDef;
  element: ElementId;
  kind: 'ring' | 'cone';
  center: Vector3;
  dir: Vector3;
  follow: boolean;
  remaining: number;
  tickAcc: number;
  power: number;
}

const arr = (v: Vector3): [number, number, number] => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
const tmp = new Vector3();
const UP = new Vector3(0, 1, 0);

export function defaultContext(): ElementContext {
  return { night: 0, sunHeight: 1, moonPhase: 0, nearWater: false, onRock: false, grounded: true };
}

export function createEntity(p: Partial<SimEntity> & Pick<SimEntity, 'id' | 'name' | 'kind' | 'team'>): SimEntity {
  return {
    element: null,
    level: 1,
    pos: new Vector3(),
    radius: 0.45,
    height: 1.8,
    hp: CFG.health,
    maxHp: CFG.health,
    chi: CFG.chi.max,
    maxChi: CFG.chi.max,
    lastCombat: -1e9,
    statuses: new Map(),
    shield: null,
    blocking: false,
    blockStart: -1e9,
    invulnerable: false,
    grounded: true,
    dead: false,
    cooldowns: new Map(),
    combo: 0,
    comboT: 0,
    pendingImpulse: new Vector3(),
    ctx: defaultContext(),
    pvp: false,
    faction: '',
    side: '',
    protectedUntil: 0,
    yaw: 0,
    windup: 0,
    mods: NO_MODS,
    party: '',
    mark: null,
    comboReadyAt: 0,
    ...p,
  };
}

/** Apply mastery modifiers to a player: max health/chi follow, keeping the current fill ratio. */
export function setMods(e: SimEntity, mods: Mods): void {
  const hpRatio = e.maxHp > 0 ? e.hp / e.maxHp : 1;
  e.mods = mods;
  e.maxHp = Math.round(CFG.health * (1 + mods.hp));
  e.hp = e.dead ? 0 : Math.max(1, Math.round(e.maxHp * hpRatio));
  e.maxChi = CFG.chi.max + mods.maxChi;
  e.chi = Math.min(e.chi, e.maxChi);
}

/** The caster's abilities with mastery applied. */
export const kitOf = (e: SimEntity): ElementKit => modKit(KITS[e.element ?? 'fire'], e.mods);

export const center = (e: SimEntity, out = new Vector3()) => out.copy(e.pos).setY(e.pos.y + e.height * 0.6);
/** Where projectiles leave the caster: chest height, slightly forward along `dir`. */
export const handOf = (e: SimEntity, dir: Vector3, out = new Vector3()) =>
  center(e, out).addScaledVector(tmp.copy(dir).setY(0).normalize(), 0.55).setY(e.pos.y + e.height * 0.78);

function distToCapsule(e: SimEntity, p: Vector3): number {
  const y = Math.min(Math.max(p.y, e.pos.y + e.radius), e.pos.y + e.height - e.radius);
  return Math.hypot(p.x - e.pos.x, p.y - y, p.z - e.pos.z) - e.radius;
}

export class CombatSim {
  readonly entities = new Map<string, SimEntity>();
  readonly projectiles: Projectile[] = [];
  readonly areas: Area[] = [];
  events: SimEvent[] = [];
  time = 0;
  private nextId = 1;

  constructor(private groundAt: (x: number, z: number) => number) {}

  add(e: SimEntity): void {
    this.entities.set(e.id, e);
  }
  remove(id: string): void {
    this.entities.delete(id);
  }
  /** Returns and clears events produced since the last call. */
  drain(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
  enemiesOf(e: SimEntity): SimEntity[] {
    const out: SimEntity[] = [];
    for (const o of this.entities.values()) if (!o.dead && canHarm(e, o, this.time)) out.push(o);
    return out;
  }

  // ---- casting --------------------------------------------------------------

  /** Validate + execute a cast. `dir` is the aim direction chosen by the client. */
  cast(caster: SimEntity, slot: Slot, dirIn: Vector3): boolean {
    const fail = (reason: string) => (this.events.push({ t: 'castFail', caster: caster.id, slot, reason }), false);
    if (caster.dead || !caster.element) return false;
    const kit = kitOf(caster);
    const def = kit.abilities.find((a) => a.slot === slot);
    if (!def) return false;
    if ((caster.cooldowns.get(slot) ?? 0) > 0.05) return fail('cooldown');
    if (caster.statuses.has('stagger')) return fail('Staggered');
    if (caster.blocking) return fail('Blocking');
    if (!canBend(CFG, kit, caster.ctx)) return fail('Earth needs solid ground');
    if (caster.chi < def.chiCost) return fail('Not enough chi');
    if (def.kind === 'dash' && caster.statuses.has('root')) return fail('Rooted');

    caster.chi -= def.chiCost;
    caster.cooldowns.set(slot, def.cooldown);
    caster.lastCombat = this.time;
    const power = elementPower(CFG, caster.element, caster.ctx) * levelPower(caster.level);
    const dir = dirIn.clone().normalize();
    const el = caster.element;
    this.events.push({ t: 'cast', caster: caster.id, ability: def.id, slot, element: el, dir: arr(dir) });

    let mul = 1;
    if (def.combo) {
      caster.combo = (caster.combo % def.combo) + 1;
      caster.comboT = 1;
      if (caster.combo === def.combo) mul = 1 + (def.comboBonus ?? 0);
    }

    switch (def.kind) {
      case 'projectile': {
        const release = () => {
          if (caster.dead) return;
          const origin = handOf(caster, dir);
          const n = def.count ?? 1;
          for (let i = 0; i < n; i++) {
            const d = dir.clone();
            if (n > 1) d.applyAxisAngle(UP, ((i - (n - 1) / 2) * (def.spread ?? 6) * Math.PI) / 180);
            if (def.gravity) d.y += (def.gravity * (def.range ?? 20)) / (2 * (def.speed ?? 30) ** 2);
            this.spawnProjectile(caster, def, el, origin, d, power * mul);
          }
        };
        if (def.windup) this.later(def.windup, release);
        else release();
        break;
      }
      case 'melee':
        this.melee(caster, def, el, dir, power * mul);
        break;
      case 'dash':
        this.events.push({ t: 'dash', owner: caster.id, element: el, dir: arr(dir.clone().setY(0).normalize()), distance: def.distance ?? 8, duration: def.duration ?? 0.3, lift: def.lift ?? 0 });
        break;
      case 'shield':
        caster.shield = {
          remaining: def.duration ?? 2,
          reduction: def.reduction ?? 0.5,
          blocksProjectiles: !!def.blocksProjectiles,
          reflects: !!def.reflects,
          radius: def.radius ?? 1.5,
          element: el,
        };
        this.events.push({ t: 'shield', target: caster.id, element: el, radius: caster.shield.radius, duration: caster.shield.remaining });
        break;
      case 'ring':
      case 'cone': {
        const a: Area = {
          id: this.nextId++,
          owner: caster,
          ability: def,
          element: el,
          kind: def.kind,
          center: caster.pos.clone(),
          dir,
          follow: def.kind === 'cone',
          remaining: def.duration ?? 0.5,
          tickAcc: def.tick ?? 0.5,
          power,
        };
        this.areas.push(a);
        this.events.push({
          t: 'area', id: a.id, owner: caster.id, ability: def.id, element: el, kind: a.kind, pos: arr(a.center), duration: a.remaining,
          radius: def.radius ?? 0, range: def.range ?? 0, angle: def.angle ?? 0, swirl: !!(def.pull || def.lift), follow: a.follow,
        });
        if (def.selfHeal) caster.hp = Math.min(caster.maxHp, caster.hp + def.selfHeal);
        break;
      }
    }
    return true;
  }

  /** Cone abilities track the caster's latest aim. */
  updateAim(caster: SimEntity, dir: Vector3): void {
    for (const a of this.areas) if (a.owner === caster && a.kind === 'cone') a.dir.copy(dir).normalize();
  }

  private timers: Array<{ t: number; fn: () => void }> = [];
  private later(t: number, fn: () => void): void {
    this.timers.push({ t, fn });
  }

  spawnProjectile(owner: SimEntity, ability: AbilityDef, element: ElementId, origin: Vector3, dir: Vector3, power: number): void {
    const p: Projectile = {
      id: this.nextId++,
      owner,
      ability,
      element,
      pos: origin.clone(),
      vel: dir.clone().normalize().multiplyScalar(ability.speed ?? 30),
      travelled: 0,
      power,
      reflected: false,
    };
    this.projectiles.push(p);
    this.events.push({ t: 'proj', id: p.id, owner: owner.id, ability: ability.id, element, pos: arr(p.pos), vel: arr(p.vel), radius: ability.radius ?? 0.4, gravity: ability.gravity ?? 0 });
  }

  private melee(owner: SimEntity, ability: AbilityDef, element: ElementId, dir: Vector3, power: number): void {
    const range = ability.range ?? 4;
    const cosA = Math.cos((((ability.angle ?? 60) / 2) * Math.PI) / 180);
    const o = center(owner);
    const flat = dir.clone().setY(0).normalize();
    this.events.push({ t: 'melee', owner: owner.id, element, pos: arr(o), dir: arr(flat), range, angle: ability.angle ?? 60 });
    for (const t of this.enemiesOf(owner)) {
      const c = center(t, new Vector3());
      tmp.subVectors(c, o);
      const d = tmp.length();
      if (d - t.radius > range) continue;
      tmp.y = 0;
      if (tmp.normalize().dot(flat) < cosA && d > t.radius + 0.5) continue;
      this.hit(owner, t, ability, element, power, flat, null);
    }
  }

  // ---- hits -----------------------------------------------------------------

  hit(src: SimEntity, target: SimEntity, ability: AbilityDef, element: ElementId, power: number, dir: Vector3, proj: Projectile | null): 'hit' | 'reflected' | 'avoided' {
    if (target.dead) return 'avoided';
    if (target.invulnerable) {
      this.events.push({ t: 'hit', target: target.id, source: src.id, amount: 0, element, result: 'dodged' });
      return 'avoided';
    }
    src.lastCombat = target.lastCombat = this.time;
    // Blinded attackers (steam, sandstorm) miss some of their hits.
    if (src.statuses.has('blind') && Math.random() < comboData.blind.missChance) {
      this.events.push({ t: 'hit', target: target.id, source: src.id, amount: 0, element, result: 'miss' });
      return 'avoided';
    }
    let dmg = ability.damage * power * matchup(CFG, element, target.element);
    const crit = src.mods.crit > 0 && Math.random() < src.mods.crit;
    if (crit) dmg *= PROG.crit.multiplier;
    // Anti-griefing: much higher-level players hit low-level ones softly.
    if (src.kind === 'player' && target.kind === 'player' && src.level - target.level >= PVP.lowLevelGap) dmg *= PVP.lowLevelDamageScale;
    let result: 'hit' | 'blocked' = 'hit';
    if (target.blocking) {
      if (this.time - target.blockStart <= CFG.block.perfectWindow) {
        this.events.push({ t: 'hit', target: target.id, source: src.id, amount: 0, element, result: 'perfect' });
        target.chi = Math.min(target.maxChi, target.chi + CFG.block.chiPerBlockedHit * 3);
        if (proj) return 'reflected';
        this.applyStatus(target.id, src, { type: 'stagger', duration: CFG.block.staggerSeconds });
        return 'avoided';
      }
      dmg *= CFG.block.damageTaken;
      target.chi = Math.min(target.maxChi, target.chi + CFG.block.chiPerBlockedHit);
      result = 'blocked';
    }
    if (target.shield) dmg *= 1 - target.shield.reduction;
    dmg *= 1 - target.mods.armor;
    dmg = Math.max(1, Math.round(dmg));
    target.hp = Math.max(0, target.hp - dmg);
    this.events.push({ t: 'hit', target: target.id, source: src.id, amount: dmg, element, result, ...(crit ? { crit } : {}) });
    if (!ability.partyCombo) this.comboCheck(src, target, element);
    if (ability.status) this.applyStatus(target.id, src, ability.status);
    if (ability.knockback && !target.blocking) {
      const v = dir.clone().setY(0).normalize().multiplyScalar(ability.knockback).setY(ability.knockback * 0.35);
      this.impulse(target, v);
    }
    if (target.hp <= 0) this.kill(target, src.id);
    return 'hit';
  }

  /**
   * Party combos: a hit from one member on a target another member just hit
   * with a different element bursts into that pair's combo at the target.
   */
  private comboCheck(src: SimEntity, target: SimEntity, element: ElementId): void {
    if (!src.party || src.kind !== 'player' || target.dead) return;
    const m = target.mark;
    if (m && m.party === src.party && m.source !== src.id && this.time - m.t <= comboData.windowSeconds && this.time >= target.comboReadyAt) {
      const def = comboFor(m.element, element);
      if (def) {
        target.comboReadyAt = this.time + comboData.targetCooldown;
        target.mark = null;
        this.spawnCombo(src, def, target.pos, [m.source, src.id]);
        return;
      }
    }
    target.mark = { source: src.id, element, party: src.party, t: this.time };
  }

  spawnCombo(owner: SimEntity, c: PartyCombo, at: Vector3, members: [string, string]): void {
    const ability: AbilityDef = {
      slot: 'control', id: c.id, name: c.name, kind: 'ring', damage: c.damage, chiCost: 0, cooldown: 0,
      radius: c.radius, duration: c.duration, tick: c.tick, status: c.status, vfx: c.id, anim: '', partyCombo: true,
    };
    const a: Area = {
      id: this.nextId++, owner, ability, element: owner.element ?? 'fire', kind: 'ring', center: at.clone(), dir: new Vector3(0, 0, 1),
      follow: false, remaining: c.duration, tickAcc: c.tick, power: levelPower(owner.level),
    };
    this.areas.push(a);
    this.events.push({ t: 'combo', id: a.id, combo: c.id, name: c.name, pos: arr(a.center), radius: c.radius, duration: c.duration, members });
  }

  impulse(target: SimEntity, v: Vector3): void {
    target.pendingImpulse.add(v);
    this.events.push({ t: 'impulse', target: target.id, v: arr(v) });
  }

  kill(target: SimEntity, source: string | null): void {
    if (target.dead) return;
    target.dead = true;
    target.statuses.clear();
    if (target.shield) {
      target.shield = null;
      this.events.push({ t: 'shieldEnd', target: target.id });
    }
    this.events.push({ t: 'death', target: target.id, source });
  }

  revive(target: SimEntity): void {
    target.dead = false;
    target.hp = target.maxHp;
    target.chi = target.maxChi;
    target.statuses.clear();
    this.events.push({ t: 'respawn', target: target.id });
  }

  applyStatus(targetId: string, source: SimEntity | null, s: StatusDef): void {
    const target = this.entities.get(targetId);
    if (!target || target.dead) return;
    const cur = target.statuses.get(s.type);
    if (cur) {
      cur.remaining = Math.max(cur.remaining, s.duration);
      cur.dps = Math.max(cur.dps, s.dps ?? 0);
      cur.amount = Math.max(cur.amount, s.amount ?? 0);
    } else {
      target.statuses.set(s.type, { type: s.type, remaining: s.duration, dps: s.dps ?? 0, amount: s.amount ?? 0, tickAcc: 0, source: source?.id ?? null });
    }
    this.events.push({ t: 'status', target: target.id, status: s.type, duration: s.duration });
  }

  // ---- tick -----------------------------------------------------------------

  update(dt: number): void {
    this.time += dt;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      this.timers[i].t -= dt;
      if (this.timers[i].t <= 0) this.timers.splice(i, 1)[0].fn();
    }
    this.updateProjectiles(dt);
    this.updateAreas(dt);
    for (const e of this.entities.values()) this.updateEntity(e, dt);
  }

  private updateEntity(e: SimEntity, dt: number): void {
    for (const [k, v] of e.cooldowns) e.cooldowns.set(k, Math.max(0, v - dt));
    e.comboT -= dt;
    if (e.comboT <= 0) e.combo = 0;
    if (e.dead) return;
    const inCombat = this.time - e.lastCombat < CFG.chi.combatTimeout;
    e.chi = Math.min(e.maxChi, e.chi + (inCombat ? CFG.chi.regenInCombat : CFG.chi.regenOutOfCombat) * (1 + e.mods.regen) * dt);
    for (const [k, s] of e.statuses) {
      s.remaining -= dt;
      if (s.type === 'burn') {
        s.tickAcc += dt;
        while (s.tickAcc >= 0.5) {
          s.tickAcc -= 0.5;
          const dmg = Math.max(1, Math.round(s.dps * 0.5));
          e.hp = Math.max(0, e.hp - dmg);
          e.lastCombat = this.time;
          this.events.push({ t: 'hit', target: e.id, source: s.source, amount: dmg, element: 'fire', result: 'hit', dot: true });
          if (e.hp <= 0) {
            this.kill(e, s.source);
            return;
          }
        }
      }
      if (s.remaining <= 0) e.statuses.delete(k);
    }
    if (e.shield) {
      e.shield.remaining -= dt;
      if (e.shield.remaining <= 0) {
        e.shield = null;
        this.events.push({ t: 'shieldEnd', target: e.id });
      }
    }
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const steps = Math.max(1, Math.ceil((p.vel.length() * dt) / 0.3));
      let done = false;
      for (let k = 0; k < steps && !done; k++) done = this.stepProjectile(p, dt / steps);
      if (done) {
        if (p.ability.splash) this.splash(p);
        this.events.push({ t: 'projEnd', id: p.id, pos: arr(p.pos), splash: p.ability.splash ?? 0, element: p.element });
        this.projectiles.splice(i, 1);
      }
    }
  }

  private stepProjectile(p: Projectile, dt: number): boolean {
    if (p.ability.gravity) p.vel.y -= p.ability.gravity * dt;
    p.pos.addScaledVector(p.vel, dt);
    p.travelled += p.vel.length() * dt;
    if (p.travelled > (p.ability.range ?? 30) * (p.reflected ? 1.5 : 1)) return true;
    if (p.pos.y < this.groundAt(p.pos.x, p.pos.z) + 0.1) return true;
    const pr = p.ability.radius ?? 0.4;
    const c = new Vector3();
    for (const t of this.entities.values()) {
      if (t.dead || !canHarm(p.owner, t, this.time)) continue;
      if (t.shield?.blocksProjectiles && p.pos.distanceTo(center(t, c)) < t.shield.radius + pr) {
        if (t.shield.element === 'air' && p.element === 'fire') {
          // Fire burns away Air's barriers.
          t.shield = null;
          this.events.push({ t: 'shieldEnd', target: t.id });
        } else if (t.shield.reflects) {
          this.reflect(p, t);
          return false;
        } else return true;
      }
      if (distToCapsule(t, p.pos) <= pr) {
        const r = this.hit(p.owner, t, p.ability, p.element, p.power, p.vel.clone().normalize(), p);
        if (r === 'reflected') {
          this.reflect(p, t);
          return false;
        }
        if (r === 'avoided') continue;
        return true;
      }
    }
    return false;
  }

  private reflect(p: Projectile, by: SimEntity): void {
    const back = center(p.owner).sub(p.pos).normalize();
    p.vel.copy(back).multiplyScalar(p.vel.length() * CFG.block.reflectSpeedScale);
    p.owner = by;
    p.reflected = true;
    p.travelled = 0;
    this.events.push({ t: 'reflect', id: p.id, owner: by.id, pos: arr(p.pos), vel: arr(p.vel) });
  }

  private splash(p: Projectile): void {
    const r = p.ability.splash!;
    for (const t of this.entities.values()) {
      if (t.dead || !canHarm(p.owner, t, this.time)) continue;
      if (distToCapsule(t, p.pos) <= r) this.hit(p.owner, t, p.ability, p.element, p.power, tmp.subVectors(t.pos, p.pos).clone(), null);
    }
  }

  private updateAreas(dt: number): void {
    for (let i = this.areas.length - 1; i >= 0; i--) {
      const a = this.areas[i];
      a.remaining -= dt;
      a.tickAcc += dt;
      if (a.follow) a.center.copy(a.owner.pos);
      const ab = a.ability;
      if (a.kind === 'ring' && ab.pull) {
        for (const t of this.enemiesOf(a.owner)) {
          const d = Math.hypot(t.pos.x - a.center.x, t.pos.z - a.center.z);
          if (d > (ab.radius ?? 5) + t.radius) continue;
          const v = tmp.subVectors(a.center, t.pos).setY(0).normalize().multiplyScalar(ab.pull * dt * 3).setY(ab.lift ? ab.lift * dt * 2 : 0);
          t.pendingImpulse.add(v);
        }
      }
      const tick = ab.tick ?? 0.5;
      while (a.tickAcc >= tick) {
        a.tickAcc -= tick;
        const o = handOf(a.owner, a.dir);
        for (const t of this.enemiesOf(a.owner)) {
          if (a.kind === 'ring') {
            const d = Math.hypot(t.pos.x - a.center.x, t.pos.z - a.center.z);
            if (d <= (ab.radius ?? 5) + t.radius) this.hit(a.owner, t, ab, a.element, a.power, tmp.subVectors(t.pos, a.center).clone(), null);
          } else {
            const c = center(t);
            tmp.subVectors(c, o);
            const dist = tmp.length();
            if (dist - t.radius > (ab.range ?? 10)) continue;
            if (tmp.normalize().dot(a.dir) < Math.cos((((ab.angle ?? 40) / 2) * Math.PI) / 180)) continue;
            this.hit(a.owner, t, ab, a.element, a.power, a.dir.clone(), null);
          }
        }
      }
      if (a.remaining <= 0 || a.owner.dead) this.areas.splice(i, 1);
    }
  }
}
