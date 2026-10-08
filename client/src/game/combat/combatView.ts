import * as THREE from 'three/webgpu';
import type { AbilityDef, ElementId } from '@shared/combat';
import { KITS, COMBOS, center, handOf, type SimEntity, type SimEvent } from '@shared/sim/combatSim';
import { fresnel } from './shaders';
import { PALETTE, paletteOf, type Palette, type Vfx } from './vfx';

const LEVEL_PALETTE = paletteOf('#ffd76a', true);
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
  return KITS[element]?.abilities.find((a) => a.id === id);
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
        if (def.windup) this.vfx.burst(paletteFor(ev.element), handOf(caster, v3(ev.dir)), 20, 1.5, 0.5, def.windup);
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
          owner: ev.owner, element: ev.element, kind: ev.kind, pos: v3(ev.pos), remaining: ev.duration, radius: ev.radius,
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
      const pal = paletteFor(a.element);
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
