import * as THREE from 'three/webgpu';
import type { ElementId } from '@shared/combat';
import type { Obstacles } from '@shared/props';
import type { SimEvent } from '@shared/sim/combatSim';

// Bending leaves marks where it lands: scorch on trees, cracked craters in the
// ground, wet splashes that dry, wind-scoured swirls. Flat decals oriented to
// the surface (a trunk's side, a boulder, the terrain), one instanced mesh per
// element so hundreds of marks cost four draw calls.

const CAP = 96;
const LIFE: Record<ElementId, number> = { fire: 90, earth: 120, water: 25, air: 45 };

function texture(el: ElementId): THREE.CanvasTexture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const c = cv.getContext('2d')!;
  const rnd = (() => {
    let x = el.length * 9301 + 49297;
    return () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  })();
  const blob = (r: number, col: string, alpha: number) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, r);
    g.addColorStop(0, col.replace('A', String(alpha)));
    g.addColorStop(0.65, col.replace('A', String(alpha * 0.75)));
    g.addColorStop(1, col.replace('A', '0'));
    c.fillStyle = g;
    c.beginPath();
    c.arc(64, 64, r, 0, Math.PI * 2);
    c.fill();
  };
  switch (el) {
    case 'fire':
      blob(60, 'rgba(20,14,10,A)', 0.85);
      blob(26, 'rgba(255,120,40,A)', 0.25);
      for (let i = 0; i < 9; i++) {
        c.strokeStyle = 'rgba(15,10,8,0.7)';
        c.lineWidth = 2 + rnd() * 3;
        const a = rnd() * Math.PI * 2;
        c.beginPath();
        c.moveTo(64, 64);
        c.lineTo(64 + Math.cos(a) * (40 + rnd() * 22), 64 + Math.sin(a) * (40 + rnd() * 22));
        c.stroke();
      }
      break;
    case 'earth':
      blob(56, 'rgba(70,52,36,A)', 0.75);
      c.strokeStyle = 'rgba(30,22,14,0.85)';
      for (let i = 0; i < 7; i++) {
        let x = 64;
        let y = 64;
        let a = rnd() * Math.PI * 2;
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(x, y);
        for (let k = 0; k < 5; k++) {
          a += (rnd() - 0.5) * 1.2;
          x += Math.cos(a) * 11;
          y += Math.sin(a) * 11;
          c.lineTo(x, y);
          c.lineWidth = Math.max(1, 3 - k * 0.5);
        }
        c.stroke();
      }
      blob(18, 'rgba(25,18,12,A)', 0.8);
      break;
    case 'water':
      blob(58, 'rgba(30,50,70,A)', 0.5);
      for (let i = 0; i < 10; i++) {
        const a = rnd() * Math.PI * 2;
        const r = 30 + rnd() * 26;
        c.fillStyle = 'rgba(30,50,70,0.45)';
        c.beginPath();
        c.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 3 + rnd() * 5, 0, Math.PI * 2);
        c.fill();
      }
      break;
    case 'air':
      c.strokeStyle = 'rgba(235,240,230,0.55)';
      c.lineWidth = 3;
      for (let i = 0; i < 4; i++) {
        c.beginPath();
        for (let t = 0; t < 1; t += 0.02) {
          const a = t * Math.PI * 3 + (i * Math.PI) / 2;
          const r = 8 + t * 50;
          const x = 64 + Math.cos(a) * r;
          const y = 64 + Math.sin(a) * r;
          if (t === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
      }
      break;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Slot {
  born: number;
  life: number;
  size: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

class Layer {
  readonly mesh: THREE.InstancedMesh;
  private slots: Array<Slot | null> = new Array(CAP).fill(null);
  private next = 0;
  private m = new THREE.Matrix4();
  private sc = new THREE.Vector3();

  constructor(el: ElementId) {
    const mat = new THREE.MeshBasicNodeMaterial({ map: texture(el), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.side = THREE.DoubleSide;
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, CAP);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = `marks:${el}`;
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < CAP; i++) this.mesh.setMatrixAt(i, this.m);
    this.mesh.count = CAP;
  }

  add(pos: THREE.Vector3, normal: THREE.Vector3, size: number, life: number, now: number): void {
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    // Random spin so repeated marks don't look stamped.
    quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * Math.PI * 2));
    this.slots[this.next] = { born: now, life, size, pos: pos.clone().addScaledVector(normal, 0.03), quat };
    this.next = (this.next + 1) % CAP;
  }

  update(now: number): number {
    let live = 0;
    for (let i = 0; i < CAP; i++) {
      const s = this.slots[i];
      if (!s) continue;
      const age = now - s.born;
      if (age > s.life) {
        this.slots[i] = null;
        this.m.makeScale(0, 0, 0);
      } else {
        // Pop in, then shrink away over the last fifth of its life.
        const k = Math.min(1, age * 8) * Math.min(1, (s.life - age) / (s.life * 0.2));
        this.m.compose(s.pos, s.quat, this.sc.setScalar(s.size * k));
        live++;
      }
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    return live;
  }
}

const ELS: ElementId[] = ['fire', 'water', 'earth', 'air'];

export class BendingMarks {
  readonly group = new THREE.Group();
  private layers = new Map<ElementId, Layer>();
  private time = 0;
  private n = new THREE.Vector3();
  private p = new THREE.Vector3();
  count = 0;

  constructor(private obstacles: Obstacles, private groundAt: (x: number, z: number) => number) {
    for (const el of ELS) {
      const l = new Layer(el);
      this.layers.set(el, l);
      this.group.add(l.mesh);
    }
  }

  /**
   * Leave a mark where bending struck (x, y, z): on a trunk or boulder if one is
   * right there, otherwise on the ground below.
   */
  strike(el: ElementId, x: number, y: number, z: number, size: number): void {
    const layer = this.layers.get(el);
    if (!layer) return;
    const near = this.obstacles.near(x, z, 0.9);
    const o = near.find((ob) => y > ob.y - 0.5 && y < ob.y + ob.height + 0.6);
    if (o) {
      // On the side of the trunk / rock, facing where the hit came from.
      this.n.set(x - o.x, 0, z - o.z);
      if (this.n.lengthSq() < 1e-4) this.n.set(1, 0, 0);
      this.n.normalize();
      const hy = Math.min(Math.max(y, o.y + 0.3), o.y + o.height - 0.2);
      this.p.set(o.x + this.n.x * o.radius, hy, o.z + this.n.z * o.radius);
      if (o.type === 'rock') this.n.y = 0.6;
      layer.add(this.p, this.n.normalize(), Math.min(size, o.radius * 1.6 + 0.4), LIFE[el], this.time);
      return;
    }
    const g = this.groundAt(x, z);
    if (y - g > 2.5) return; // exploded in the air
    // Terrain normal from the slope.
    const e = 0.6;
    this.n.set(this.groundAt(x - e, z) - this.groundAt(x + e, z), 2 * e, this.groundAt(x, z - e) - this.groundAt(x, z + e)).normalize();
    this.p.set(x, g, z);
    layer.add(this.p, this.n, size, LIFE[el], this.time);
  }

  /** Turn combat events into marks. */
  handle(ev: SimEvent): void {
    switch (ev.t) {
      case 'projEnd':
        this.strike(ev.element, ev.pos[0], ev.pos[1], ev.pos[2], ev.splash ? ev.splash * 1.2 : 1.1);
        break;
      case 'beam':
        this.strike(ev.element, ev.to[0], ev.to[1], ev.to[2], 1.4);
        break;
      case 'melee': {
        const x = ev.pos[0] + ev.dir[0] * ev.range * 0.8;
        const z = ev.pos[2] + ev.dir[2] * ev.range * 0.8;
        if (this.obstacles.near(x, z, 0.8).length) this.strike(ev.element, x, ev.pos[1], z, 0.9);
        break;
      }
      case 'area':
        if (ev.kind === 'ring' && ev.radius > 0 && !ev.follow) this.strike(ev.element, ev.pos[0], ev.pos[1], ev.pos[2], Math.min(ev.radius * 1.6, 9));
        break;
    }
  }

  update(dt: number): void {
    this.time += dt;
    let n = 0;
    for (const l of this.layers.values()) n += l.update(this.time);
    this.count = n;
  }
}
