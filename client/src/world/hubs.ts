import * as THREE from 'three/webgpu';
import { mrt, vec4, color } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FACTIONS, CONTESTED, type Faction } from '@shared/factions';
import { ARTS } from '@shared/arts';
import { TOON_RAMP } from './materials';
import { registerBloomSource } from '../engine/renderer';
import type { Physics } from '../game/physics';

/** Collects coloured primitives and merges them into one draw call. */
class Builder {
  private parts: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  readonly boxes: Array<{ c: THREE.Vector3; h: THREE.Vector3; yaw: number }> = [];

  add(geo: THREE.BufferGeometry, hex: string, x: number, y: number, z: number, yaw = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0): void {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.deleteAttribute('uv');
    const c = new THREE.Color(hex);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.q.setFromEuler(this.e.set(rx, yaw, rz, 'YXZ'));
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz));
    g.applyMatrix4(this.m);
    this.parts.push(g);
  }

  /** Box with its base at y; also becomes a physics collider when `solid`. */
  box(hex: string, x: number, y: number, z: number, w: number, h: number, d: number, yaw = 0, solid = true): void {
    this.add(BOX, hex, x, y + h / 2, z, yaw, w, h, d);
    if (solid) this.boxes.push({ c: new THREE.Vector3(x, y + h / 2, z), h: new THREE.Vector3(w / 2, h / 2, d / 2), yaw });
  }

  build(): THREE.BufferGeometry | null {
    if (!this.parts.length) return null;
    const g = mergeGeometries(this.parts, false);
    g.computeVertexNormals();
    return g;
  }
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const ROOF4 = new THREE.ConeGeometry(0.75, 1, 4, 1).rotateY(Math.PI / 4);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const TENT = new THREE.ConeGeometry(1, 1, 6, 1);
const FLAG = new THREE.PlaneGeometry(1, 1);

const STYLE = {
  fort: { wall: '#9a9488', wallTop: '#7f796f', house: '#c9c0ae', roof: '#4a5a78', wood: '#6b4f33', wallH: 4.2 },
  temple: { wall: '#e8dcc6', wallTop: '#9c3b26', house: '#efe4cf', roof: '#9c3b26', wood: '#7a3a22', wallH: 3.2 },
  harbor: { wall: '#7a5b3c', wallTop: '#5c432b', house: '#d8c7a4', roof: '#2f6f73', wood: '#6b4f33', wallH: 3.0 },
  den: { wall: '#4a3b31', wallTop: '#2e241e', house: '#6a5446', roof: '#2a2a2a', wood: '#3c2c22', wallH: 3.4 },
} as const;

function buildHub(f: Faction, groundY: number): { geo: THREE.BufferGeometry | null; lanterns: THREE.Vector3[]; boxes: Builder['boxes'] } {
  const b = new Builder();
  const s = STYLE[f.hub.style];
  const R = f.hub.radius - 2;
  const lanterns: THREE.Vector3[] = [];
  const y0 = groundY - 0.3;

  // Perimeter wall with a gate facing +z.
  const segs = 30;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    if (Math.abs(Math.atan2(Math.sin(am), Math.cos(am)) - Math.PI / 2) < 0.2) continue; // gate gap (angle measured from +x toward +z)
    const x = Math.cos(am) * R;
    const z = Math.sin(am) * R;
    const len = 2 * R * Math.sin((a1 - a0) / 2) + 0.4;
    const yaw = -am + Math.PI / 2;
    b.box(s.wall, x, y0, z, len, s.wallH, 1.2, yaw);
    b.box(s.wallTop, x, y0 + s.wallH, z, len, 0.5, 1.6, yaw, false);
  }
  // Gate posts, lintel and banners.
  for (const side of [-1, 1]) {
    b.box(s.wood, side * 4.6, y0, R, 1.4, s.wallH + 2.2, 1.6);
    b.add(CYL, '#4a3a2a', side * 6.5, y0 + 3.5, R + 1.2, 0, 0.12, 7, 0.12);
    b.add(FLAG, f.color, side * 6.5 + side * 0.9, y0 + 5.6, R + 1.2, 0, 1.6, 2.4, 1);
    b.add(FLAG, f.color, side * 6.5 + side * 0.9, y0 + 5.6, R + 1.2, Math.PI, 1.6, 2.4, 1);
    lanterns.push(new THREE.Vector3(side * 4.6, y0 + s.wallH + 2.6, R + 1.0));
  }
  b.box(f.color, 0, y0 + s.wallH + 1.6, R, 10.6, 0.9, 1.8, 0, false);

  // Houses in a ring, skipping the gate side and the NPC stalls in the middle.
  const houses = 7;
  for (let i = 0; i < houses; i++) {
    const a = Math.PI / 2 + 0.75 + (i / (houses - 1)) * (Math.PI * 2 - 1.5);
    const r = R * 0.68;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const yaw = Math.atan2(-x, -z);
    const w = 7 + (i % 3);
    const d = 6 + ((i * 7) % 3);
    const h = f.hub.style === 'den' ? 3.4 : 4;
    if (f.hub.style === 'den' && i % 2 === 1) {
      b.add(TENT, s.roof, x, y0 + 2.2, z, yaw, 3.6, 4.4, 3.6);
      b.boxes.push({ c: new THREE.Vector3(x, y0 + 1.5, z), h: new THREE.Vector3(2.4, 1.5, 2.4), yaw });
      continue;
    }
    b.box(s.house, x, y0, z, w, h, d, yaw);
    b.add(ROOF4, s.roof, x, y0 + h + 1.4, z, yaw, w * 1.05, 2.8, d * 1.05);
    // Door facing the plaza.
    const dx = Math.sin(yaw) * (d / 2 + 0.02);
    const dz = Math.cos(yaw) * (d / 2 + 0.02);
    b.box(s.wood, x + dx, y0, z + dz, 1.4, 2.4, 0.1, yaw, false);
    lanterns.push(new THREE.Vector3(x + dx * 1.15 + Math.cos(yaw) * 1.2, y0 + 2.8, z + dz * 1.15 - Math.sin(yaw) * 1.2));
  }

  // Market stalls for the vendor / trainer / envoy.
  for (const [sx, sz] of [[-10, 9], [10, 9], [0, -11]]) {
    b.box(s.wood, sx, y0, sz, 3.4, 1.0, 1.2, 0);
    b.add(ROOF4, f.color, sx, y0 + 3.0, sz, 0, 4.4, 0.9, 2.6);
    for (const px of [-1.5, 1.5]) b.add(CYL, s.wood, sx + px, y0 + 1.3, sz - 0.4, 0, 0.12, 2.6, 0.12);
  }

  // Centrepiece by style.
  switch (f.hub.style) {
    case 'fort':
      for (const [tx, tz] of [[R * 0.7, -R * 0.7], [-R * 0.7, -R * 0.7]]) {
        b.box(s.wall, tx, y0, tz, 4.5, 11, 4.5);
        b.add(ROOF4, s.roof, tx, y0 + 12.4, tz, 0, 6.5, 3, 6.5);
        lanterns.push(new THREE.Vector3(tx, y0 + 11.6, tz + 2.6));
      }
      b.box(s.wall, 0, y0, -2, 3, 1.2, 3);
      b.add(CYL, '#4a3a2a', 0, y0 + 6, -2, 0, 0.18, 10, 0.18);
      b.add(FLAG, f.color, 1.6, y0 + 9.6, -2, 0, 3, 2, 1);
      b.add(FLAG, f.color, 1.6, y0 + 9.6, -2, Math.PI, 3, 2, 1);
      break;
    case 'temple':
      for (let k = 0; k < 3; k++) {
        const w = 9 - k * 2.4;
        b.box(s.house, 0, y0 + k * 3.6, -4, w, 3.0, w, 0, k === 0);
        b.add(ROOF4, s.roof, 0, y0 + k * 3.6 + 3.4, -4, 0, w * 1.5, 1.0, w * 1.5);
      }
      lanterns.push(new THREE.Vector3(0, y0 + 11.2, -4));
      break;
    case 'harbor':
      b.add(CYL, s.wood, 0, y0 + 7, -3, 0, 0.35, 14, 0.35);
      b.add(FLAG, '#f2efe6', 0, y0 + 8, -2.2, 0, 4, 6, 1, 0.05);
      for (let k = 0; k < 6; k++) b.box('#8a6b45', -6 + (k % 3) * 1.3, y0, -6 + Math.floor(k / 3) * 1.3, 1.2, 1.2, 1.2, k * 0.3);
      break;
    case 'den':
      b.add(CYL, '#2a2420', 0, y0 + 0.4, -2, 0, 4, 0.8, 4);
      lanterns.push(new THREE.Vector3(0, y0 + 1.2, -2));
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        lanterns.push(new THREE.Vector3(Math.cos(a) * 7, y0 + 3.2, -2 + Math.sin(a) * 7));
        b.add(CYL, s.wood, Math.cos(a) * 7, y0 + 1.6, -2 + Math.sin(a) * 7, 0, 0.1, 3.2, 0.1);
      }
      break;
  }
  return { geo: b.build(), lanterns, boxes: b.boxes };
}

function buildShrine(groundY: number): { geo: THREE.BufferGeometry | null; lanterns: THREE.Vector3[]; boxes: Builder['boxes'] } {
  const b = new Builder();
  const y0 = groundY - 0.3;
  b.add(CYL, '#8d8a84', 0, y0 + 0.4, 0, 0, 18, 0.8, 18);
  b.add(CYL, '#a7a39b', 0, y0 + 1.0, 0, 0, 10, 0.6, 10);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    b.box('#6f6a62', Math.cos(a) * 7, y0 + 0.8, Math.sin(a) * 7, 1.2, 6, 1.2);
  }
  b.box('#5c5852', 0, y0 + 1.3, 0, 1.6, 4, 1.6);
  return { geo: b.build(), lanterns: [new THREE.Vector3(0, y0 + 6.2, 0)], boxes: b.boxes };
}

/** A master's camp: sitting mat, small tent and a lantern post. */
function buildCamp(groundY: number): { geo: THREE.BufferGeometry | null; lanterns: THREE.Vector3[]; boxes: Builder['boxes'] } {
  const b = new Builder();
  const y0 = groundY - 0.2;
  b.add(CYL, '#7b3f2a', 0, y0 + 0.25, 0, 0, 3.2, 0.1, 3.2);
  b.add(TENT, '#c9b48a', 4, y0 + 1.4, -2.5, 0.4, 2.2, 2.8, 2.2);
  b.boxes.push({ c: new THREE.Vector3(4, y0 + 1, -2.5), h: new THREE.Vector3(1.4, 1, 1.4), yaw: 0 });
  b.add(CYL, '#4a3a2a', -2.6, y0 + 1.4, 1.6, 0, 0.12, 2.8, 0.12);
  for (let k = 0; k < 5; k++) b.add(BOX, '#8a8580', Math.cos(k * 1.3) * 2.2, y0 + 0.15, Math.sin(k * 1.3) * 2.2 + 0.4, k, 0.5, 0.35, 0.4);
  return { geo: b.build(), lanterns: [new THREE.Vector3(-2.6, y0 + 3, 1.6)], boxes: b.boxes };
}

/** A stone cairn marking a quest point (springs, veins, summits). */
function buildCairn(groundY: number): { geo: THREE.BufferGeometry | null; lanterns: THREE.Vector3[]; boxes: Builder['boxes'] } {
  const b = new Builder();
  const y0 = groundY - 0.2;
  b.add(BOX, '#77736c', 0, y0 + 0.4, 0, 0.3, 1.4, 0.8, 1.2);
  b.add(BOX, '#8d8a84', 0, y0 + 1.1, 0, 1.0, 1.0, 0.6, 0.9);
  b.add(BOX, '#a7a39b', 0, y0 + 1.6, 0, 0.5, 0.6, 0.5, 0.6);
  return { geo: b.build(), lanterns: [new THREE.Vector3(0, y0 + 2.2, 0)], boxes: [] };
}

/** Faction hub towns and contested-zone shrines, plus their wall/building colliders. */
export class Hubs {
  readonly group = new THREE.Group();

  constructor(groundAt: (x: number, z: number) => number, physics: Physics) {
    this.group.name = 'Hubs';
    const mat = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: TOON_RAMP, side: THREE.DoubleSide });
    const lanternGeo = new THREE.SphereGeometry(0.32, 10, 8);
    const sites: Array<{ x: number; z: number; color: string; built: ReturnType<typeof buildHub> }> = [];
    for (const f of FACTIONS) sites.push({ x: f.hub.x, z: f.hub.z, color: f.color, built: buildHub(f, groundAt(f.hub.x, f.hub.z)) });
    for (const c of CONTESTED) sites.push({ x: c.x, z: c.z, color: '#ffd27a', built: buildShrine(groundAt(c.x, c.z)) });
    // Special Arts: masters' camps and quest cairns (shrines already have a building).
    const marked = new Set<string>([...CONTESTED, ...ARTS.flatMap((a) => (a.master ? [a.master] : []))].map((c) => `${c.x},${c.z}`));
    for (const art of ARTS) {
      if (art.master) sites.push({ x: art.master.x, z: art.master.z, color: '#ffb35a', built: buildCamp(groundAt(art.master.x, art.master.z)) });
      for (const step of art.steps) {
        for (const pt of step.points ?? []) {
          const near = [...marked].some((k) => {
            const [x, z] = k.split(',').map(Number);
            return Math.hypot(x - pt.x, z - pt.z) < 25;
          });
          if (near) continue;
          marked.add(`${pt.x},${pt.z}`);
          sites.push({ x: pt.x, z: pt.z, color: '#7fd8ff', built: buildCairn(groundAt(pt.x, pt.z)) });
        }
      }
    }

    for (const site of sites) {
      const { geo, lanterns, boxes } = site.built;
      if (geo) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(site.x, 0, site.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = 'hub';
        this.group.add(mesh);
      }
      if (lanterns.length) {
        const lm = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(site.color).multiplyScalar(1.6) });
        registerBloomSource(lm, mrt({ emissive: vec4(color(new THREE.Color(site.color)).mul(0.9), 1) }));
        const inst = new THREE.InstancedMesh(lanternGeo, lm, lanterns.length);
        const m = new THREE.Matrix4();
        lanterns.forEach((p, i) => inst.setMatrixAt(i, m.makeTranslation(site.x + p.x, p.y, site.z + p.z)));
        inst.name = 'lanterns';
        this.group.add(inst);
      }
      for (const bx of boxes) physics.addStaticBox(site.x + bx.c.x, bx.c.y, site.z + bx.c.z, bx.h.x, bx.h.y, bx.h.z, bx.yaw);
    }
  }
}
