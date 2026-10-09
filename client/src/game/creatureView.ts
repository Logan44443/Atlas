import * as THREE from 'three/webgpu';
import type { SimEntity } from '@shared/sim/combatSim';
import { BOSSES, bossById, speciesById } from '@shared/sim/wildlife';
import { petDef } from '@shared/pets';
import { TOON_RAMP } from '../world/materials';
import { Nameplate } from './nameplate';

// Wild creatures, bosses and pets, built from primitives with toon materials
// (placeholder art like everything else). One parametric body per shape:
// quad, hare, turtle, bird, serpent, dragon, bison, titan, toad, stag, rhino.

interface Look {
  shape: string;
  color: string;
  accent: string;
  /** spirit (Bond Trial): translucent and glowing */
  ghost?: boolean;
}

/** What an entity should look like, from its species, boss or pet data. */
export function lookOf(e: SimEntity): Look {
  if (e.kind === 'pet') {
    const d = petDef(e.beast);
    if (d) return { shape: d.shape, color: d.color, accent: d.accent };
  }
  const sp = speciesById(e.beast);
  if (sp) return { shape: sp.shape, color: sp.color, accent: sp.accent };
  const boss = bossById(e.id.replace(/^boss_/, '')) ?? BOSSES.find((b) => e.name.endsWith(b.name));
  if (boss) return { shape: boss.shape, color: boss.color, accent: boss.accent, ghost: e.role === 'trial' };
  return { shape: 'quad', color: '#887766', accent: '#ccbbaa' };
}

const mats = new Map<string, THREE.Material>();
function mat(color: string, ghost = false): THREE.Material {
  const key = `${color}${ghost ? 'g' : ''}`;
  let m = mats.get(key);
  if (!m) {
    if (ghost) {
      const g = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), transparent: true, opacity: 0.55, depthWrite: false });
      m = g;
    } else m = new THREE.MeshToonNodeMaterial({ color, gradientMap: TOON_RAMP });
    mats.set(key, m);
  }
  return m;
}

const geo = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 12, 8),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
  capsule: new THREE.CapsuleGeometry(0.5, 1, 4, 10),
  dome: new THREE.SphereGeometry(0.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
};

interface Parts {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Object3D | null;
  legs: THREE.Object3D[];
  wings: THREE.Object3D[];
  tail: THREE.Object3D | null;
  segments: THREE.Object3D[];
  /** height of the back (for riders) */
  seat: number;
  /** extra hover height (birds, dragons in the air) */
  hover: number;
}

function part(g: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(g, m);
  mesh.scale.set(sx, sy, sz);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

/** A leg pivoting at the hip so it can swing. */
function leg(m: THREE.Material, x: number, y: number, z: number, len: number, thick: number): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  pivot.add(part(geo.cyl, m, thick, len, thick, 0, -len / 2, 0));
  return pivot;
}

function build(look: Look): Parts {
  const g = look.ghost;
  const c = mat(look.color, g);
  const a = mat(look.accent, g);
  const dark = mat('#1d1a18', g);
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const p: Parts = { root, body, head: null, legs: [], wings: [], tail: null, segments: [], seat: 1, hover: 0 };
  const quad = (o: { len: number; h: number; w: number; legLen: number; legT: number; neck?: number; headS?: number }) => {
    const y = o.legLen + o.h / 2;
    body.add(part(geo.capsule, c, o.w, o.len * 0.5, o.w, 0, y, 0).rotateX(Math.PI / 2));
    const head = new THREE.Group();
    head.position.set(0, y + (o.neck ?? 0.15), o.len * 0.55 + 0.15);
    const hs = o.headS ?? o.w * 0.75;
    head.add(part(geo.sphere, c, hs, hs * 0.9, hs * 1.2));
    head.add(part(geo.sphere, a, hs * 0.55, hs * 0.45, hs * 0.6, 0, -hs * 0.12, hs * 0.5));
    for (const s of [-1, 1]) head.add(part(geo.sphere, dark, hs * 0.14, hs * 0.14, hs * 0.14, s * hs * 0.28, hs * 0.15, hs * 0.48));
    body.add(head);
    p.head = head;
    for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const l = leg(c, sx * o.w * 0.32, o.legLen, sz * o.len * 0.32, o.legLen, o.legT);
      body.add(l);
      p.legs.push(l);
    }
    const tail = new THREE.Group();
    tail.position.set(0, y + o.h * 0.1, -o.len * 0.55);
    tail.add(part(geo.cone, a, o.w * 0.25, o.len * 0.45, o.w * 0.25, 0, 0, -o.len * 0.2).rotateX(-Math.PI / 2.4));
    body.add(tail);
    p.tail = tail;
    p.seat = y + o.w * 0.45;
    return { y, hs };
  };
  switch (look.shape) {
    case 'hare': {
      const { hs } = quad({ len: 0.7, h: 0.5, w: 0.5, legLen: 0.22, legT: 0.1, neck: 0.18, headS: 0.4 });
      for (const s of [-1, 1]) p.head!.add(part(geo.capsule, c, 0.09, 0.32, 0.06, s * 0.1, hs * 0.75, -0.05).rotateZ(s * 0.15));
      break;
    }
    case 'turtle': {
      body.add(part(geo.dome, c, 1.4, 0.9, 1.7, 0, 0.3, 0));
      body.add(part(geo.cyl, a, 1.35, 0.12, 1.65, 0, 0.3, 0));
      const head = new THREE.Group();
      head.position.set(0, 0.42, 0.95);
      head.add(part(geo.sphere, a, 0.38, 0.32, 0.45));
      body.add(head);
      p.head = head;
      for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
        const l = leg(a, sx * 0.55, 0.32, sz * 0.6, 0.3, 0.22);
        body.add(l);
        p.legs.push(l);
      }
      p.seat = 0.8;
      break;
    }
    case 'bird': {
      body.add(part(geo.sphere, c, 0.7, 0.6, 1.1, 0, 0, 0));
      const head = new THREE.Group();
      head.position.set(0, 0.3, 0.6);
      head.add(part(geo.sphere, c, 0.4, 0.4, 0.45));
      head.add(part(geo.cone, a, 0.16, 0.4, 0.16, 0, -0.05, 0.3).rotateX(Math.PI / 2));
      body.add(head);
      p.head = head;
      for (const s of [-1, 1]) {
        const w = new THREE.Group();
        w.position.set(s * 0.3, 0.15, 0);
        w.add(part(geo.box, c, 1.3, 0.06, 0.6, s * 0.65, 0, 0));
        w.add(part(geo.box, a, 0.5, 0.05, 0.4, s * 1.25, 0, -0.05));
        body.add(w);
        p.wings.push(w);
      }
      p.tail = part(geo.box, a, 0.4, 0.05, 0.5, 0, 0.05, -0.65);
      body.add(p.tail);
      p.hover = 2.2;
      p.seat = 0.4;
      break;
    }
    case 'serpent':
    case 'dragon': {
      const n = look.shape === 'dragon' ? 8 : 7;
      for (let i = 0; i < n; i++) {
        const r = 0.55 - i * 0.04;
        const s = part(geo.sphere, i % 2 ? a : c, r * 1.4, r * 1.3, r * 1.6, 0, 0.55, -i * 0.62);
        body.add(s);
        p.segments.push(s);
      }
      const head = new THREE.Group();
      head.position.set(0, 0.85, 0.75);
      head.add(part(geo.sphere, c, 0.8, 0.6, 1.0));
      head.add(part(geo.box, a, 0.55, 0.18, 0.6, 0, -0.2, 0.35));
      for (const s of [-1, 1]) head.add(part(geo.sphere, mat('#ffe066', look.ghost), 0.13, 0.13, 0.13, s * 0.25, 0.15, 0.42));
      if (look.shape === 'dragon') for (const s of [-1, 1]) head.add(part(geo.cone, a, 0.12, 0.6, 0.12, s * 0.22, 0.45, -0.2).rotateX(-0.6));
      body.add(head);
      p.head = head;
      if (look.shape === 'dragon') {
        for (const s of [-1, 1]) {
          const w = new THREE.Group();
          w.position.set(s * 0.45, 1.0, -0.6);
          w.add(part(geo.box, a, 2.2, 0.06, 1.1, s * 1.1, 0, 0));
          body.add(w);
          p.wings.push(w);
        }
        p.hover = 1.2;
      }
      p.seat = 1.2;
      break;
    }
    case 'bison': {
      quad({ len: 2.2, h: 1.5, w: 1.6, legLen: 0.7, legT: 0.32, neck: 0.25, headS: 1.0 });
      body.add(part(geo.sphere, a, 1.7, 0.5, 2.3, 0, 2.0, 0));
      for (const s of [-1, 1]) p.head!.add(part(geo.cone, mat('#f6efe0', look.ghost), 0.14, 0.5, 0.14, s * 0.45, 0.3, 0.1).rotateZ(-s * 1.1));
      p.tail!.scale.set(3, 1, 1);
      p.seat = 2.3;
      break;
    }
    case 'titan': {
      quad({ len: 2.0, h: 1.4, w: 1.7, legLen: 0.6, legT: 0.4, neck: 0.1, headS: 0.9 });
      for (let i = 0; i < 4; i++) body.add(part(geo.dome, a, 1.5 - i * 0.15, 0.6, 0.7, 0, 1.6, 0.7 - i * 0.5));
      for (const l of p.legs) l.add(part(geo.cone, mat('#e8e0c8', look.ghost), 0.12, 0.3, 0.12, 0.1, -0.62, 0.15).rotateX(Math.PI / 2));
      p.seat = 2.2;
      break;
    }
    case 'toad': {
      body.add(part(geo.sphere, c, 2.0, 1.2, 1.9, 0, 0.75, 0));
      body.add(part(geo.sphere, a, 1.6, 0.6, 1.5, 0, 0.45, 0.2));
      const head = new THREE.Group();
      head.position.set(0, 1.0, 0.8);
      for (const s of [-1, 1]) head.add(part(geo.sphere, mat('#ffcf5a', look.ghost), 0.32, 0.32, 0.32, s * 0.55, 0.4, 0));
      head.add(part(geo.box, dark, 1.2, 0.08, 0.1, 0, -0.1, 0.25));
      body.add(head);
      p.head = head;
      for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
        const l = leg(c, sx * 0.9, 0.45, sz * 0.6, 0.45, 0.3);
        l.rotation.z = sx * 0.6;
        body.add(l);
        p.legs.push(l);
      }
      p.seat = 1.4;
      break;
    }
    case 'stag': {
      quad({ len: 1.4, h: 0.9, w: 0.8, legLen: 1.1, legT: 0.14, neck: 0.55, headS: 0.55 });
      const antler = mat('#d8ccff', look.ghost);
      for (const s of [-1, 1]) {
        p.head!.add(part(geo.cyl, antler, 0.06, 0.8, 0.06, s * 0.2, 0.55, -0.05).rotateZ(-s * 0.35));
        p.head!.add(part(geo.cyl, antler, 0.05, 0.45, 0.05, s * 0.42, 0.75, 0.05).rotateZ(-s * 1.0));
      }
      p.seat = 2.0;
      break;
    }
    case 'rhino': {
      const { hs } = quad({ len: 1.8, h: 1.2, w: 1.3, legLen: 0.55, legT: 0.3, neck: 0.05, headS: 0.85 });
      p.head!.add(part(geo.cone, mat('#e8e0c8', look.ghost), 0.2, 0.6, 0.2, 0, hs * 0.25, hs * 0.65).rotateX(0.5));
      body.add(part(geo.box, a, 1.35, 0.2, 1.4, 0, 1.75, 0));
      p.seat = 1.9;
      break;
    }
    default:
      quad({ len: 1.1, h: 0.7, w: 0.6, legLen: 0.45, legT: 0.12, neck: 0.25, headS: 0.5 });
      for (const s of [-1, 1]) p.head!.add(part(geo.cone, c, 0.12, 0.22, 0.08, s * 0.16, 0.26, -0.05));
  }
  return p;
}

/** Small health bar sprite over a creature. */
class HpBar {
  readonly sprite: THREE.Sprite;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private last = -1;
  constructor() {
    this.canvas.width = 128;
    this.canvas.height = 16;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.SpriteNodeMaterial({ map: this.tex, transparent: true, depthWrite: false });
    m.fog = false;
    this.sprite = new THREE.Sprite(m);
    this.sprite.scale.set(1.1, 0.14, 1);
    this.sprite.renderOrder = 20;
  }
  draw(frac: number, color: string): void {
    const f = Math.round(frac * 116);
    if (f === this.last) return;
    this.last = f;
    const c = this.canvas.getContext('2d')!;
    c.clearRect(0, 0, 128, 16);
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.fillRect(4, 3, 120, 10);
    c.fillStyle = color;
    c.fillRect(6, 5, f, 6);
    this.tex.needsUpdate = true;
  }
  dispose(): void {
    this.tex.dispose();
  }
}

interface View {
  parts: Parts;
  plate: Nameplate;
  plateKey: string;
  bar: HpBar;
  last: THREE.Vector3;
  speed: number;
  t: number;
  deadT: number;
  scale: number;
  /** what it was built as (a swapped pet keeps its id) */
  beast: string;
}

/** Riders sink this far into the back so their legs straddle it. */
const STRADDLE = 0.45;

/** Draws every creature and pet the host knows about. */
export class CreatureView {
  readonly group = new THREE.Group();
  private views = new Map<string, View>();
  /** The pet I'm riding (from my own 'mount' events): drawn under my predicted position, not the lagging mirror. */
  myMount: string | null = null;
  readonly myPos = new THREE.Vector3();

  get count(): number {
    return this.views.size;
  }

  /** Height of the pet's back if `ownerId` is riding it (0 when not mounted). */
  seatOf(ownerId: string, entities: Map<string, SimEntity>, myId = ''): number {
    if (ownerId === myId) {
      const v = this.myMount ? this.views.get(this.myMount) : undefined;
      return v ? Math.max(0.2, (v.parts.seat + v.parts.hover) * v.scale - STRADDLE) : 0;
    }
    for (const [id, v] of this.views) {
      const e = entities.get(id);
      if (!e || e.kind !== 'pet' || e.owner !== ownerId) continue;
      // Another rider: their pet is put on their position every server tick.
      const o = entities.get(ownerId);
      if (o && Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z) < 0.35) return Math.max(0.2, (v.parts.seat + v.parts.hover) * v.scale - STRADDLE);
    }
    return 0;
  }

  update(dt: number, entities: Map<string, SimEntity>, myId: string): void {
    for (const e of entities.values()) {
      if (e.kind !== 'creature' && e.kind !== 'pet') continue;
      let v = this.views.get(e.id);
      if (v && (v.beast !== e.beast || v.scale !== (e.scale || 1))) {
        this.drop(e.id);
        v = undefined;
      }
      if (!v) {
        const parts = build(lookOf(e));
        const plate = new Nameplate('');
        const bar = new HpBar();
        parts.root.add(plate.sprite, bar.sprite);
        parts.root.position.copy(e.pos);
        parts.root.name = `creature ${e.name}`;
        this.group.add(parts.root);
        v = { parts, plate, plateKey: '', bar, last: e.pos.clone(), speed: 0, t: Math.random() * 10, deadT: 0, scale: e.scale || 1, beast: e.beast };
        parts.root.scale.setScalar(v.scale);
        this.views.set(e.id, v);
      }
      this.animate(v, e, dt, entities, myId);
    }
    for (const id of [...this.views.keys()]) if (!entities.has(id)) this.drop(id);
  }

  private drop(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    v.parts.root.removeFromParent();
    v.bar.dispose();
    this.views.delete(id);
  }

  private animate(v: View, e: SimEntity, dt: number, entities: Map<string, SimEntity>, myId: string): void {
    const p = v.parts;
    v.t += dt;
    // Name: level + name, bosses with their title, pets with their owner.
    const boss = e.role === 'boss' || e.role === 'miniboss' || e.role === 'trial';
    const text = e.kind === 'pet' ? `${e.name}${e.owner === myId ? '' : ` · ${entities.get(e.owner)?.name ?? ''}`}` : `Lv ${e.level} ${e.name}`;
    const color = e.kind === 'pet' ? (e.owner === myId ? '#8dff9a' : '#c8e6ff') : boss ? '#ffb35a' : '#ffd9a0';
    if (v.plateKey !== text + color) {
      v.plateKey = text + color;
      v.plate.set(text, color);
    }
    const s = v.scale;
    const top = (p.seat + p.hover + 0.8) * 1;
    v.plate.sprite.position.y = top + 0.35 / s;
    v.plate.sprite.scale.set(1.6 / s, 0.4 / s, 1);
    v.bar.sprite.position.y = top + 0.05 / s;
    v.bar.sprite.scale.set(1.1 / s, 0.14 / s, 1);
    v.bar.sprite.visible = !e.dead && (e.hp < e.maxHp || boss);
    v.bar.draw(e.maxHp > 0 ? e.hp / e.maxHp : 0, e.kind === 'pet' ? '#5fd36a' : '#e2503c');
    v.plate.sprite.visible = !e.dead;

    if (e.dead) {
      v.deadT += dt;
      p.body.rotation.z = Math.min(Math.PI / 2, v.deadT * 3);
      p.root.position.y = e.pos.y - Math.max(0, v.deadT - 2) * 0.5;
      p.root.visible = v.deadT < 4;
      return;
    }
    v.deadT = 0;
    p.root.visible = true;
    p.body.rotation.z = 0;
    const dx = (e.id === this.myMount ? this.myPos : e.pos).x - v.last.x;
    const dz = (e.id === this.myMount ? this.myPos : e.pos).z - v.last.z;
    if (dt > 0) v.speed += (Math.hypot(dx, dz) / dt - v.speed) * Math.min(1, dt * 8);
    const pos = e.id === this.myMount ? this.myPos : e.pos;
    v.last.copy(pos);
    p.root.position.copy(pos);
    p.root.rotation.y = e.id === this.myMount ? entities.get(myId)?.yaw ?? e.yaw : e.yaw;
    // Hovering things bob in the air (riders sit on top: see seatOf).
    p.body.position.y = p.hover + (p.hover ? Math.sin(v.t * 2) * 0.15 : 0);
    const gait = v.speed / Math.max(0.6, s);
    const swing = Math.min(0.7, gait * 0.09);
    const phase = v.t * (4 + gait * 1.2);
    p.legs.forEach((l, i) => (l.rotation.x = Math.sin(phase + (i === 0 || i === 3 ? 0 : Math.PI)) * swing));
    for (const w of p.wings) w.rotation.z = Math.sin(v.t * (p.hover ? 7 : 3)) * (p.hover ? 0.55 : 0.25) * Math.sign(w.position.x);
    p.segments.forEach((sg, i) => (sg.position.x = Math.sin(v.t * 3 - i * 0.8) * 0.25 * Math.min(1, gait * 0.3 + 0.3)));
    if (p.tail) p.tail.rotation.y = Math.sin(v.t * 5) * 0.3;
    // Wind-up: rear back, then lunge (the telegraph players learn to read).
    const w = e.windup;
    p.body.rotation.x = -w * 0.35 + (e.statuses.has('stagger') ? Math.sin(v.t * 25) * 0.08 : 0);
    if (p.head) p.head.rotation.x = -w * 0.4;
    if (v.speed < 0.3 && p.head && !w) p.head.rotation.x = Math.sin(v.t * 0.7) * 0.15 + 0.12;
  }
}
