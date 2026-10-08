import * as THREE from 'three/webgpu';
import type { AbilityDef, ElementId } from '@shared/combat';
import { KITS, COMBOS, center, handOf, type SimEntity, type SimEvent } from '@shared/sim/combatSim';
import { artById } from '@shared/arts';
import { fresnel } from './shaders';
import { PALETTE, paletteOf, type Palette, type Vfx } from './vfx';

const LEVEL_PALETTE = paletteOf('#ffd76a', true);
const HEAL_PALETTE = paletteOf('#7dffb0', true);
const LAVA_PALETTE = paletteOf('#ff5a1a', true);
const LIGHTNING_PALETTE = paletteOf('#a8d8ff', true);
const BLOOD_PALETTE = paletteOf('#c0102a', true);
const SPIRIT_PALETTE = paletteOf('#9fe8ff', true);
/** Art abilities with their own look (by ability id). */
const ART_PALETTES: Record<string, Palette> = { healing: HEAL_PALETTE, lava: LAVA_PALETTE, lightning: LIGHTNING_PALETTE, blood: BLOOD_PALETTE, spirit: SPIRIT_PALETTE, combustion: paletteOf('#ffb347', true), metal: paletteOf('#c8ccd4') };
const COMBO_PALETTES = new Map(COMBOS.map((c) => [c.id, { pal: paletteOf(c.color, c.elements.includes('fire')), soft: !c.elements.includes('fire') }]));

export function paletteFor(el: ElementId | null): Palette {
  return el ? PALETTE[el] : PALETTE.hit;
}

export type GestureStyle = 'push' | 'stomp' | 'spin' | 'breath';
const STYLE: Record<string, GestureStyle> = { stomp: 'stomp', spin: 'spin', breath: 'breath', surge: 'breath' };

/** How a cast looks on the caster's body. */
export function gestureFor(def: AbilityDef): { style: GestureStyle; duration: number } {
  const duration = def.kind === 'cone' ? def.duration ?? 0.3 : def.kind === 'ring' ? 0.5 : 0.3;
  return { style: STYLE[def.anim] ?? 'push', duration };
}

export function abilityDef(element: ElementId, id: string): AbilityDef | undefined {
  return KITS[element]?.abilities.find((a) => a.id === id) ?? artById(id)?.ability ?? undefined;
}

interface ProjView {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  gravity: number;
  radius: number;
  element: ElementId;
  life: number;
}

interface AreaView {
  owner: string;
  ability: string;
  element: ElementId;
  kind: 'ring' | 'cone';
  pos: THREE.Vector3;
  remaining: number;
  radius: number;
  range: number;
  angle: number;
  swirl: boolean;
  follow: boolean;
  time: number;
}

interface DashView {
  owner: string;
  element: ElementId;
  dir: THREE.Vector3;
  remaining: number;
}

const v3 = (a: [number, number, number], out = new THREE.Vector3()) => out.set(a[0], a[1], a[2]);
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Turns combat events (from the local sim or the server) into meshes and
 * particles. Owns no game rules: projectiles here are only extrapolated for
 * display between the authoritative 'proj' and 'projEnd' events.
 */
export class CombatView {
  readonly group = new THREE.Group();
  private projectiles = new Map<number, ProjView>();
  private areas: AreaView[] = [];
  private combos: Array<{ id: string; pos: THREE.Vector3; radius: number; remaining: number }> = [];
  private dashes: DashView[] = [];
  private shields = new Map<string, { mesh: THREE.Mesh; remaining: number }>();
  private gestures = new Map<string, { t: number; dur: number; style: GestureStyle }>();
  private charges: Array<{ id: string; pal: Palette; remaining: number }> = [];
  private grabs: Array<{ owner: string; target: string; remaining: number }> = [];
  private glows: Array<{ id: string; pal: Palette; remaining: number; trail: boolean }> = [];
  private walls = new Map<number, THREE.Mesh>();
  private wallGeo = new THREE.CylinderGeometry(1, 1.1, 1, 18, 1, true);
  private wallMat = new THREE.MeshToonNodeMaterial({ color: '#4a3b30', side: THREE.DoubleSide });
  private projGeo = {
    fire: new THREE.SphereGeometry(0.3, 12, 8),
    water: new THREE.SphereGeometry(0.28, 12, 8),
    earth: new THREE.DodecahedronGeometry(0.45, 0),
    air: new THREE.TorusGeometry(0.35, 0.08, 6, 16),
  };
  private projMat: Record<ElementId, THREE.Material>;
  private time = 0;

  constructor(
    private vfx: Vfx,
    private entities: () => Map<string, SimEntity>,
    /** Aim of an entity for cone effects (the local player's comes from the camera). */
    private aimOf: (e: SimEntity) => THREE.Vector3,
    private localId: () => string,
  ) {
    this.group.name = 'Combat';
    this.projMat = {
      fire: new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(4, 1.8, 0.4) }),
      water: new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.6, 1.5, 2.6), transparent: true, opacity: 0.85 }),
      earth: new THREE.MeshToonNodeMaterial({ color: '#8a7354' }),
      air: new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1.6, 1.8, 2), transparent: true, opacity: 0.6 }),
    };
  }

  private ent(id: string | null): SimEntity | undefined {
    return id ? this.entities().get(id) : undefined;
  }

  /** Start a cast gesture on an entity's avatar. */
  startGesture(id: string, def: AbilityDef): void {
    const g = gestureFor(def);
    this.gestures.set(id, { t: g.duration, dur: g.duration, style: g.style });
  }

  gesture(id: string): { cast: number; castStyle: GestureStyle } {
    const g = this.gestures.get(id);
    return g ? { cast: 1 - g.t / g.dur, castStyle: g.style } : { cast: 0, castStyle: 'push' };
  }

  handle(ev: SimEvent): void {
    switch (ev.t) {
      case 'cast': {
        const caster = this.ent(ev.caster);
        const def = abilityDef(ev.element, ev.ability);
        if (!caster || !def) break;
        if (ev.caster !== this.localId()) {
          this.startGesture(ev.caster, def);
          caster.yaw = Math.atan2(ev.dir[0], ev.dir[2]);
        }
        if (def.windup) this.vfx.burst(ART_PALETTES[def.id] ?? paletteFor(ev.element), handOf(caster, v3(ev.dir)), 20, 1.5, 0.5, def.windup);
        break;
      }
      case 'charge':
        this.charges.push({ id: ev.caster, pal: ART_PALETTES[ev.ability] ?? paletteFor(ev.element), remaining: ev.duration });
        break;
      case 'beam':
        this.lightning(v3(ev.from), v3(ev.to, tmp2), ev.redirected);
        break;
      case 'heal': {
        const t = this.ent(ev.target);
        if (t) this.vfx.burst(HEAL_PALETTE, center(t, tmp), 6, 2, 0.35, 0.6);
        break;
      }
      case 'wall': {
        this.walls.get(ev.id)?.removeFromParent();
        const m = new THREE.Mesh(this.wallGeo, this.wallMat);
        m.scale.set(ev.radius, 2.6, ev.radius);
        m.position.set(ev.pos[0], ev.pos[1] + 1.1, ev.pos[2]);
        m.castShadow = m.receiveShadow = true;
        this.group.add(m);
        this.walls.set(ev.id, m);
        this.vfx.ring(PALETTE.earth, v3(ev.pos), ev.radius, 50, 5, 0.8);
        break;
      }
      case 'wallEnd': {
        const m = this.walls.get(ev.id);
        if (m) {
          this.vfx.ring(PALETTE.earth, tmp.copy(m.position).setY(m.position.y - 1), m.scale.x, 40, 3, 0.7);
          m.removeFromParent();
          this.walls.delete(ev.id);
        }
        break;
      }
      case 'grab':
        this.grabs.push({ owner: ev.owner, target: ev.target, remaining: ev.duration });
        break;
      case 'fly':
      case 'spirit': {
        const i = this.glows.findIndex((g) => g.id === ev.target);
        if (i >= 0) this.glows.splice(i, 1);
        if (ev.duration > 0) this.glows.push({ id: ev.target, pal: ev.t === 'fly' ? PALETTE.air : SPIRIT_PALETTE, remaining: ev.duration, trail: ev.t === 'fly' });
        const t = this.ent(ev.target);
        if (t) this.vfx.burst(ev.t === 'fly' ? PALETTE.air : SPIRIT_PALETTE, center(t, tmp), 40, 6, 0.6, 0.8);
        break;
      }
      case 'proj': {
        const mesh = new THREE.Mesh(this.projGeo[ev.element], this.projMat[ev.element]);
        mesh.scale.setScalar(ev.radius / 0.35);
        const pos = v3(ev.pos);
        mesh.position.copy(pos);
        this.group.add(mesh);
        this.projectiles.set(ev.id, { mesh, pos, vel: v3(ev.vel), gravity: ev.gravity, radius: ev.radius, element: ev.element, life: 6 });
        this.vfx.burst(paletteFor(ev.element), pos, 8, 3, 0.4, 0.25);
        break;
      }
      case 'projEnd': {
        const p = this.projectiles.get(ev.id);
        const pos = v3(ev.pos);
        const pal = paletteFor(ev.element);
        if (ev.splash) {
          this.vfx.burst(pal, pos, 60, ev.splash * 3, 1.0, 0.7);
          this.vfx.ring(pal, pos, ev.splash, 30, 3, 0.8);
        } else this.vfx.burst(pal, pos, 10, 4, 0.4, 0.35);
        if (p) {
          this.group.remove(p.mesh);
          this.projectiles.delete(ev.id);
        }
        break;
      }
      case 'reflect': {
        const p = this.projectiles.get(ev.id);
        if (p) {
          v3(ev.pos, p.pos);
          v3(ev.vel, p.vel);
          p.life = 6;
        }
        this.vfx.burst(PALETTE.hit, v3(ev.pos), 40, 9, 0.5);
        break;
      }
      case 'hit': {
        const t = this.ent(ev.target);
        if (!t || ev.result === 'dodged') break;
        const c = center(t, tmp);
        if (ev.result === 'perfect') this.vfx.burst(PALETTE.hit, c, 40, 9, 0.5);
        else if (!ev.dot) this.vfx.burst(paletteFor(ev.element), c, 14, 5, 0.45, 0.4);
        break;
      }
      case 'area':
        this.areas.push({
          owner: ev.owner, ability: ev.ability, element: ev.element, kind: ev.kind, pos: v3(ev.pos), remaining: ev.duration, radius: ev.radius,
          range: ev.range, angle: ev.angle, swirl: ev.swirl, follow: ev.follow, time: 0,
        });
        break;
      case 'combo': {
        const pos = v3(ev.pos);
        this.combos.push({ id: ev.combo, pos, radius: ev.radius, remaining: ev.duration });
        const c = COMBO_PALETTES.get(ev.combo);
        if (c) this.vfx.burst(c.pal, tmp.copy(pos).setY(pos.y + 1), 50, 9, 1.2, 0.8);
        break;
      }
      case 'level': {
        const t = this.ent(ev.target);
        if (t) {
          this.vfx.ring(LEVEL_PALETTE, t.pos, 1.4, 80, 5, 0.5);
          this.vfx.burst(LEVEL_PALETTE, center(t, tmp), 60, 6, 0.6, 1);
        }
        break;
      }
      case 'melee': {
        const o = v3(ev.pos);
        const flat = v3(ev.dir);
        const up = new THREE.Vector3(0, 1, 0);
        for (let i = 0; i < 18; i++) {
          const a = THREE.MathUtils.degToRad((i / 17 - 0.5) * ev.angle);
          const v = tmp2.copy(flat).applyAxisAngle(up, a);
          this.vfx.burst(paletteFor(ev.element), tmp.copy(o).addScaledVector(v, ev.range * 0.8), 2, 2, 0.5, 0.35);
        }
        break;
      }
      case 'shield': {
        this.removeShield(ev.target);
        const p = paletteFor(ev.element);
        const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
        mat.colorNode = fresnel(p.mid, 0.25);
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(ev.radius, 24, 16), mat);
        this.group.add(mesh);
        this.shields.set(ev.target, { mesh, remaining: ev.duration + 0.5 });
        const t = this.ent(ev.target);
        if (t) {
          mesh.position.copy(center(t, tmp));
          this.vfx.burst(p, mesh.position, 30, 6, 0.6);
        }
        break;
      }
      case 'shieldEnd':
        this.removeShield(ev.target);
        break;
      case 'dash': {
        this.dashes.push({ owner: ev.owner, element: ev.element, dir: v3(ev.dir), remaining: ev.duration });
        const o = this.ent(ev.owner);
        if (o && ev.lift) this.vfx.ring(paletteFor(ev.element), o.pos, 1.2, 40, 6, 0.9);
        break;
      }
      default:
        break;
    }
  }

  /** A jagged bolt drawn with short-lived glow particles. */
  private lightning(from: THREE.Vector3, to: THREE.Vector3, redirected: boolean): void {
    const pal = redirected ? paletteOf('#ffe27a', true) : LIGHTNING_PALETTE;
    const len = from.distanceTo(to);
    const steps = Math.max(6, Math.round(len * 2.5));
    const p = from.clone();
    const off = new THREE.Vector3();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (i % 3 === 0) off.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(Math.min(1.2, len * 0.04));
      p.lerpVectors(from, to, t).add(i === steps ? off.set(0, 0, 0) : off);
      this.vfx.burst(pal, p, 2, 0.4, 0.45, 0.22);
    }
    this.vfx.burst(pal, to, 30, 8, 0.6, 0.45);
    this.vfx.burst(pal, from, 12, 4, 0.5, 0.3);
  }

  private removeShield(id: string): void {
    const s = this.shields.get(id);
    if (!s) return;
    this.group.remove(s.mesh);
    s.mesh.geometry.dispose();
    this.shields.delete(id);
  }

  update(dt: number): void {
    this.time += dt;
    for (const [id, g] of this.gestures) {
      g.t -= dt;
      if (g.t <= 0) this.gestures.delete(id);
    }
    for (const [id, p] of this.projectiles) {
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += dt * 8;
      p.mesh.rotation.y += dt * 5;
      this.vfx.trail(paletteFor(p.element), p.pos, tmp.copy(p.vel).normalize(), p.radius * 1.4, dt, p.element === 'earth' ? 30 : 140);
      p.life -= dt;
      // The end event can go missing if the projectile leaves our interest area.
      if (p.life <= 0) {
        this.group.remove(p.mesh);
        this.projectiles.delete(id);
      }
    }
    for (let i = this.areas.length - 1; i >= 0; i--) {
      const a = this.areas[i];
      a.time += dt;
      a.remaining -= dt;
      const owner = this.ent(a.owner);
      if (a.remaining <= 0 || !owner || owner.dead) {
        this.areas.splice(i, 1);
        continue;
      }
      if (a.follow) a.pos.copy(owner.pos);
      const pal = ART_PALETTES[a.ability] ?? paletteFor(a.element);
      if (a.ability === 'lava') {
        this.vfx.cloud(pal, a.pos, a.radius, Math.max(1, Math.round(dt * 90)), false);
        continue;
      }
      if (a.kind === 'ring') {
        if (a.swirl) this.vfx.swirl(pal, a.pos, a.radius * 0.6, a.element === 'air' ? 7 : 2.5, Math.round(dt * 260), a.time);
        else this.vfx.ring(pal, a.pos, a.radius * Math.min(1, a.time * 4), Math.round(dt * 220), a.element === 'earth' ? 4 : 2.5, 0.7);
      } else {
        const dir = this.aimOf(owner);
        this.vfx.cone(pal, handOf(owner, dir, tmp), dir, a.range, a.angle, Math.round(dt * 300));
      }
    }
    for (let i = this.combos.length - 1; i >= 0; i--) {
      const c = this.combos[i];
      c.remaining -= dt;
      const look = COMBO_PALETTES.get(c.id);
      if (c.remaining <= 0 || !look) {
        this.combos.splice(i, 1);
        continue;
      }
      this.vfx.cloud(look.pal, c.pos, c.radius, Math.max(1, Math.round(dt * c.radius * 14)), look.soft);
    }
    for (let i = this.dashes.length - 1; i >= 0; i--) {
      const d = this.dashes[i];
      d.remaining -= dt;
      const o = this.ent(d.owner);
      if (d.remaining <= 0 || !o) {
        this.dashes.splice(i, 1);
        continue;
      }
      this.vfx.trail(paletteFor(d.element), tmp.copy(o.pos).setY(o.pos.y + 0.4), d.dir, 0.8, dt, 400);
    }
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      c.remaining -= dt;
      const o = this.ent(c.id);
      if (c.remaining <= 0 || !o || o.dead) {
        this.charges.splice(i, 1);
        continue;
      }
      const dir = this.aimOf(o);
      this.vfx.burst(c.pal, handOf(o, dir, tmp), Math.max(1, Math.round(dt * 60)), 2.5, 0.35, 0.25);
    }
    for (let i = this.grabs.length - 1; i >= 0; i--) {
      const g = this.grabs[i];
      g.remaining -= dt;
      const o = this.ent(g.owner);
      const t = this.ent(g.target);
      if (g.remaining <= 0 || !o || !t || o.dead || t.dead) {
        this.grabs.splice(i, 1);
        continue;
      }
      const a = center(o, tmp);
      const b = center(t, tmp2);
      for (let k = 0; k < Math.max(2, Math.round(dt * 80)); k++) this.vfx.burst(BLOOD_PALETTE, a.clone().lerp(b, Math.random()), 1, 0.6, 0.3, 0.3);
      this.vfx.burst(BLOOD_PALETTE, b, Math.max(1, Math.round(dt * 30)), 1.5, 0.4, 0.4);
    }
    for (let i = this.glows.length - 1; i >= 0; i--) {
      const g = this.glows[i];
      g.remaining -= dt;
      const o = this.ent(g.id);
      if (g.remaining <= 0 || !o || o.dead) {
        this.glows.splice(i, 1);
        continue;
      }
      if (g.trail) this.vfx.trail(g.pal, tmp.copy(o.pos).setY(o.pos.y + 0.6), DOWN, 0.6, dt, 120);
      else if (Math.random() < dt * 25) this.vfx.ring(g.pal, o.pos, 0.9, 2, 1.5, 0.4);
    }
    for (const [id, s] of this.shields) {
      const t = this.ent(id);
      s.remaining -= dt;
      if (!t || s.remaining <= 0) {
        this.removeShield(id);
        continue;
      }
      s.mesh.position.copy(center(t, tmp));
    }
    // Lingering status visuals.
    for (const e of this.entities().values()) {
      if (e.dead) continue;
      if (e.statuses.has('burn') && Math.random() < dt * 20) this.vfx.trail(PALETTE.fire, center(e, tmp), DOWN, 0.4, dt, 30);
      if (e.statuses.has('root') && Math.random() < dt * 10) this.vfx.ring(PALETTE.water, e.pos, 0.6, 2, 0.5, 0.4);
    }
  }

  get stats() {
    return { projectiles: this.projectiles.size, areas: this.areas.length, combos: this.combos.length };
  }
}
