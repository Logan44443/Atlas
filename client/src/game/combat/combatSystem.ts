import * as THREE from 'three/webgpu';
import { fresnel } from './shaders';
import type { AbilityDef, ElementId, StatusDef } from '@shared/combat';
import { matchup } from '@shared/combat';
import { CFG, type Combatant } from './combatant';
import { PALETTE, type Vfx, type Palette } from './vfx';

export interface CombatEvent {
  kind: 'damage' | 'heal' | 'blocked' | 'perfect' | 'dodged' | 'immune' | 'death' | 'status';
  target: Combatant;
  source: Combatant | null;
  amount?: number;
  text?: string;
}

interface Projectile {
  owner: Combatant;
  ability: AbilityDef;
  element: ElementId;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  travelled: number;
  power: number;
  mesh: THREE.Object3D;
  reflected: boolean;
}

interface Area {
  owner: Combatant;
  ability: AbilityDef;
  element: ElementId;
  kind: 'ring' | 'cone';
  center: THREE.Vector3;
  /** cone: aim direction getter so breath follows the caster */
  dir?: () => THREE.Vector3;
  origin?: () => THREE.Vector3;
  follow: boolean;
  remaining: number;
  tickAcc: number;
  power: number;
  time: number;
}

const tmp = new THREE.Vector3();

export function paletteFor(el: ElementId | null): Palette {
  return el ? PALETTE[el] : PALETTE.hit;
}

/**
 * Projectiles, area effects, hits, blocking/countering, statuses and resources.
 * Written so its rules can move server-side in Phase 5 (it never reads input).
 */
export class CombatSystem {
  readonly group = new THREE.Group();
  readonly combatants: Combatant[] = [];
  private projectiles: Projectile[] = [];
  private areas: Area[] = [];
  private listeners: Array<(e: CombatEvent) => void> = [];
  private projGeo = {
    fire: new THREE.SphereGeometry(0.3, 12, 8),
    water: new THREE.SphereGeometry(0.28, 12, 8),
    earth: new THREE.DodecahedronGeometry(0.45, 0),
    air: new THREE.TorusGeometry(0.35, 0.08, 6, 16),
  };
  private projMat: Record<ElementId, THREE.Material>;
  time = 0;

  constructor(private vfx: Vfx, private groundAt: (x: number, z: number) => number) {
    this.group.name = 'Combat';
    this.projMat = {
      fire: new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(4, 1.8, 0.4) }),
      water: new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.6, 1.5, 2.6), transparent: true, opacity: 0.85 }),
      earth: new THREE.MeshToonNodeMaterial({ color: '#8a7354' }),
      air: new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1.6, 1.8, 2), transparent: true, opacity: 0.6 }),
    };
  }

  on(l: (e: CombatEvent) => void): void {
    this.listeners.push(l);
  }
  private emit(e: CombatEvent): void {
    for (const l of this.listeners) l(e);
  }

  add(c: Combatant): void {
    this.combatants.push(c);
  }

  enemiesOf(c: Combatant): Combatant[] {
    return this.combatants.filter((o) => o !== c && o.team !== c.team && !o.dead);
  }

  // ---- spawning -------------------------------------------------------------

  spawnProjectile(owner: Combatant, ability: AbilityDef, element: ElementId, origin: THREE.Vector3, dir: THREE.Vector3, power: number): void {
    const mesh = new THREE.Mesh(this.projGeo[element], this.projMat[element]);
    const s = (ability.radius ?? 0.4) / 0.35;
    mesh.scale.setScalar(s);
    mesh.position.copy(origin);
    this.group.add(mesh);
    this.projectiles.push({
      owner,
      ability,
      element,
      pos: origin.clone(),
      vel: dir.clone().normalize().multiplyScalar(ability.speed ?? 30),
      travelled: 0,
      power,
      mesh,
      reflected: false,
    });
  }

  spawnArea(owner: Combatant, ability: AbilityDef, element: ElementId, center: THREE.Vector3, power: number, follow: boolean, dir?: () => THREE.Vector3, origin?: () => THREE.Vector3): void {
    this.areas.push({
      owner,
      ability,
      element,
      kind: ability.kind === 'cone' ? 'cone' : 'ring',
      center: center.clone(),
      dir,
      origin,
      follow,
      remaining: ability.duration ?? 0.5,
      tickAcc: ability.tick ?? 0.5, // first tick immediately
      power,
      time: 0,
    });
  }

  /** Instant melee arc in front of the caster. */
  melee(owner: Combatant, ability: AbilityDef, element: ElementId, dir: THREE.Vector3, power: number, comboMul = 1): number {
    let hits = 0;
    const range = ability.range ?? 4;
    const cosA = Math.cos(THREE.MathUtils.degToRad((ability.angle ?? 60) / 2));
    const o = owner.center;
    const flat = dir.clone().setY(0).normalize();
    for (const t of this.enemiesOf(owner)) {
      tmp.subVectors(t.center, o);
      const d = tmp.length();
      if (d - t.radius > range) continue;
      tmp.y = 0;
      if (tmp.normalize().dot(flat) < cosA && d > t.radius + 0.5) continue;
      this.hit(owner, t, ability, element, power * comboMul, flat, null);
      hits++;
    }
    // Swing visual.
    for (let i = 0; i < 18; i++) {
      const a = THREE.MathUtils.degToRad(((i / 17) - 0.5) * (ability.angle ?? 60));
      const v = flat.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      this.vfx.burst(paletteFor(element), o.clone().addScaledVector(v, range * 0.8), 2, 2, 0.5, 0.35);
    }
    return hits;
  }

  shield(owner: Combatant, ability: AbilityDef, element: ElementId): void {
    if (owner.shield?.mesh) this.group.remove(owner.shield.mesh);
    const p = paletteFor(element);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    mat.colorNode = fresnel(p.mid, 0.25);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(ability.radius ?? 1.5, 24, 16), mat);
    this.group.add(mesh);
    owner.shield = {
      remaining: ability.duration ?? 2,
      reduction: ability.reduction ?? 0.5,
      blocksProjectiles: !!ability.blocksProjectiles,
      reflects: !!ability.reflects,
      radius: ability.radius ?? 1.5,
      element,
      mesh,
    };
    this.vfx.burst(p, owner.center, 30, 6, 0.6);
  }

  // ---- hits -----------------------------------------------------------------

  /**
   * Resolve one hit. Returns 'reflected' when a perfect block bounced a
   * projectile, so the caller can redirect it instead of destroying it.
   */
  hit(src: Combatant, target: Combatant, ability: AbilityDef, element: ElementId, power: number, dir: THREE.Vector3, proj: Projectile | null): 'hit' | 'reflected' | 'avoided' {
    if (target.dead) return 'avoided';
    const now = this.time;
    if (target.isInvulnerable()) {
      this.emit({ kind: 'dodged', target, source: src, text: 'Dodged' });
      return 'avoided';
    }
    src.lastCombat = target.lastCombat = now;
    let dmg = ability.damage * power * matchup(CFG, element, target.element);

    if (target.blocking) {
      const perfect = now - target.blockStart <= CFG.block.perfectWindow;
      if (perfect) {
        this.emit({ kind: 'perfect', target, source: src, text: 'Counter!' });
        this.vfx.burst(PALETTE.hit, target.center, 40, 9, 0.5);
        target.chi = Math.min(target.maxChi, target.chi + CFG.block.chiPerBlockedHit * 3);
        if (proj) return 'reflected';
        this.applyStatus(target, src, { type: 'stagger', duration: CFG.block.staggerSeconds });
        return 'avoided';
      }
      dmg *= CFG.block.damageTaken;
      target.chi = Math.min(target.maxChi, target.chi + CFG.block.chiPerBlockedHit);
      this.emit({ kind: 'blocked', target, source: src, text: 'Blocked' });
    }
    if (target.shield) dmg *= 1 - target.shield.reduction;

    dmg = Math.max(1, Math.round(dmg));
    target.hp = Math.max(0, target.hp - dmg);
    this.emit({ kind: 'damage', target, source: src, amount: dmg });
    this.vfx.burst(paletteFor(element), target.center, 14, 5, 0.45, 0.4);

    if (ability.status) this.applyStatus(target, src, ability.status);
    if (ability.knockback && !target.blocking) {
      target.knockback(dir.clone().setY(0).normalize().multiplyScalar(ability.knockback).setY(ability.knockback * 0.35));
    }
    if (target.hp <= 0) {
      target.dead = true;
      this.emit({ kind: 'death', target, source: src });
    }
    return 'hit';
  }

  applyStatus(target: Combatant, source: Combatant | null, s: StatusDef): void {
    const cur = target.statuses.get(s.type);
    if (cur) {
      cur.remaining = Math.max(cur.remaining, s.duration);
      cur.dps = Math.max(cur.dps, s.dps ?? 0);
      cur.amount = Math.max(cur.amount, s.amount ?? 0);
    } else {
      target.statuses.set(s.type, { type: s.type, remaining: s.duration, dps: s.dps ?? 0, amount: s.amount ?? 0, tickAcc: 0, source });
    }
    this.emit({ kind: 'status', target, source, text: s.type });
  }

  // ---- simulation -----------------------------------------------------------

  update(dt: number): void {
    this.time += dt;
    this.updateProjectiles(dt);
    this.updateAreas(dt);
    for (const c of this.combatants) this.updateCombatant(c, dt);
  }

  private updateCombatant(c: Combatant, dt: number): void {
    if (c.dead) return;
    const regen = c.inCombat(this.time) ? CFG.chi.regenInCombat : CFG.chi.regenOutOfCombat;
    c.chi = Math.min(c.maxChi, c.chi + regen * dt);
    for (const [k, s] of c.statuses) {
      s.remaining -= dt;
      if (s.type === 'burn') {
        s.tickAcc += dt;
        const tick = 0.5;
        while (s.tickAcc >= tick) {
          s.tickAcc -= tick;
          const dmg = Math.max(1, Math.round(s.dps * tick));
          c.hp = Math.max(0, c.hp - dmg);
          c.lastCombat = this.time;
          this.emit({ kind: 'damage', target: c, source: s.source, amount: dmg, text: 'burn' });
          if (c.hp <= 0 && !c.dead) {
            c.dead = true;
            this.emit({ kind: 'death', target: c, source: s.source });
          }
        }
        if (Math.random() < dt * 20) this.vfx.trail(PALETTE.fire, c.center, new THREE.Vector3(0, -1, 0), 0.4, dt, 30);
      }
      if (s.type === 'root' && Math.random() < dt * 10) this.vfx.ring(PALETTE.water, c.feet, 0.6, 2, 0.5, 0.4);
      if (s.remaining <= 0) c.statuses.delete(k);
    }
    if (c.shield) {
      c.shield.remaining -= dt;
      c.shield.mesh?.position.copy(c.center);
      if (c.shield.remaining <= 0) {
        if (c.shield.mesh) this.group.remove(c.shield.mesh);
        c.shield = null;
      }
    }
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      // Sub-step so fast projectiles can't tunnel through targets on slow frames.
      const total = p.vel.length() * dt;
      const steps = Math.max(1, Math.ceil(total / 0.3));
      const h = dt / steps;
      let done = false;
      for (let k = 0; k < steps && !done; k++) done = this.stepProjectile(p, h);
      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += dt * 8;
      p.mesh.rotation.y += dt * 5;
      this.vfx.trail(paletteFor(p.element), p.pos, tmp.copy(p.vel).normalize(), (p.ability.radius ?? 0.4) * 1.4, dt, p.element === 'earth' ? 30 : 140);
      if (done) {
        if (p.ability.splash) this.splash(p);
        else this.vfx.burst(paletteFor(p.element), p.pos, 10, 4, 0.4, 0.35);
        this.group.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }
  }

  /** Advance one sub-step; returns true when the projectile is finished. */
  private stepProjectile(p: Projectile, dt: number): boolean {
    if (p.ability.gravity) p.vel.y -= p.ability.gravity * dt;
    p.pos.addScaledVector(p.vel, dt);
    p.travelled += p.vel.length() * dt;
    if (p.travelled > (p.ability.range ?? 30) * (p.reflected ? 1.5 : 1)) return true;
    if (p.pos.y < this.groundAt(p.pos.x, p.pos.z) + 0.1) return true;
    const dir = tmp.copy(p.vel).normalize().clone();
    const pr = p.ability.radius ?? 0.4;
    for (const t of this.combatants) {
      if (t.dead || t === p.owner || t.team === p.owner.team) continue;
      // Shields stop or bounce enemy projectiles at the bubble's surface.
      if (t.shield?.blocksProjectiles && p.pos.distanceTo(t.center) < t.shield.radius + pr) {
        this.vfx.burst(paletteFor(t.shield.element), p.pos, 16, 6, 0.4);
        // Fire burns through air barriers (soft matchup flavour).
        if (t.shield.element === 'air' && p.element === 'fire') {
          if (t.shield.mesh) this.group.remove(t.shield.mesh);
          t.shield = null;
        } else if (t.shield.reflects) {
          this.reflect(p, t);
          return false;
        } else return true;
      }
      if (t.distanceTo(p.pos) <= pr) {
        const r = this.hit(p.owner, t, p.ability, p.element, p.power, dir, p);
        if (r === 'reflected') {
          this.reflect(p, t);
          return false;
        }
        if (r === 'avoided') continue; // passes through a dodging target
        return true;
      }
    }
    return false;
  }

  private reflect(p: Projectile, by: Combatant): void {
    const back = p.owner.center.clone().sub(p.pos).normalize();
    p.vel.copy(back).multiplyScalar(p.vel.length() * CFG.block.reflectSpeedScale);
    p.owner = by;
    p.reflected = true;
    p.travelled = 0;
  }

  private splash(p: Projectile): void {
    const r = p.ability.splash!;
    this.vfx.burst(paletteFor(p.element), p.pos, 60, r * 3, 1.0, 0.7);
    this.vfx.ring(paletteFor(p.element), p.pos, r, 30, 3, 0.8);
    for (const t of this.combatants) {
      if (t.dead || t.team === p.owner.team) continue;
      if (t.distanceTo(p.pos) <= r) this.hit(p.owner, t, p.ability, p.element, p.power, tmp.subVectors(t.center, p.pos), null);
    }
  }

  private updateAreas(dt: number): void {
    for (let i = this.areas.length - 1; i >= 0; i--) {
      const a = this.areas[i];
      a.time += dt;
      a.remaining -= dt;
      a.tickAcc += dt;
      const pal = paletteFor(a.element);
      if (a.follow) a.center.copy(a.owner.feet);
      const ab = a.ability;
      if (a.kind === 'ring') {
        const radius = ab.radius ?? 5;
        if (ab.pull || ab.lift) this.vfx.swirl(pal, a.center, radius * 0.6, ab.lift ? 7 : 2.5, Math.round(dt * 260), a.time);
        else this.vfx.ring(pal, a.center, radius * Math.min(1, a.time * 4), Math.round(dt * 220), a.element === 'earth' ? 4 : 2.5, 0.7);
        for (const t of this.enemiesOf(a.owner)) {
          const d = Math.hypot(t.feet.x - a.center.x, t.feet.z - a.center.z);
          if (d > radius + t.radius) continue;
          if (ab.pull) {
            const v = tmp.subVectors(a.center, t.feet).setY(0).normalize().multiplyScalar(ab.pull * dt * 3);
            t.knockback(v.setY(ab.lift ? ab.lift * dt * 2 : 0));
          }
        }
      } else if (a.dir && a.origin) {
        this.vfx.cone(pal, a.origin(), a.dir(), ab.range ?? 10, ab.angle ?? 40, Math.round(dt * 300));
      }
      const tick = ab.tick ?? 0.5;
      while (a.tickAcc >= tick) {
        a.tickAcc -= tick;
        for (const t of this.enemiesOf(a.owner)) {
          if (a.kind === 'ring') {
            const d = Math.hypot(t.feet.x - a.center.x, t.feet.z - a.center.z);
            if (d <= (ab.radius ?? 5) + t.radius) this.hit(a.owner, t, ab, a.element, a.power, tmp.subVectors(t.feet, a.center), null);
          } else if (a.dir && a.origin) {
            const o = a.origin();
            const d = a.dir();
            tmp.subVectors(t.center, o);
            const dist = tmp.length();
            if (dist - t.radius > (ab.range ?? 10)) continue;
            if (tmp.normalize().dot(d) < Math.cos(THREE.MathUtils.degToRad((ab.angle ?? 40) / 2))) continue;
            this.hit(a.owner, t, ab, a.element, a.power, d.clone(), null);
          }
        }
      }
      if (a.remaining <= 0) this.areas.splice(i, 1);
    }
  }

  get stats() {
    return { projectiles: this.projectiles.length, areas: this.areas.length };
  }
}
