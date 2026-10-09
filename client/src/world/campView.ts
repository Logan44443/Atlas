import * as THREE from 'three/webgpu';
import { mrt, vec4, vertexColor } from 'three/tsl';
import { factionById } from '@shared/factions';
import { halfExtents, pieceById, type Camps, type Structure } from '@shared/building';
import { nodesNear, type NodeType } from '@shared/resources';
import { Builder as Geo, BOX, CYL, TENT, ROOF4 } from './hubs';
import { TOON_RAMP } from './materials';
import { registerBloomSource } from '../engine/renderer';
import type { Physics } from '../game/physics';
import type RAPIER from '@dimforge/rapier3d-compat';

const TIER: Record<string, string> = {
  wood_wall: '#8a6a43', wood_gate: '#7a5b38', stone_wall: '#9a958c', mud_wall: '#6e5136', brick_wall: '#8a3b2a',
  obsidian_wall: '#26222e', metal_wall: '#8d99a6', glass_window: '#7a5b38',
};
const SPHERE = new THREE.IcosahedronGeometry(0.5, 1);

/** Primitive art for one piece, in local space (base at y = 0, facing +z before rotation). */
function drawPiece(s: Structure, b: Geo, glow: Geo): void {
  const def = pieceById(s.piece)!;
  const [w, h, d] = def.size;
  const team = factionById(s.faction)?.color ?? '#888888';
  switch (s.piece) {
    case 'campfire':
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        b.add(SPHERE, '#6d6a66', Math.cos(a) * 0.65, 0.12, Math.sin(a) * 0.65, 0, 0.35, 0.25, 0.35);
      }
      b.add(CYL, '#5b3d24', 0, 0.15, 0, 0, 0.18, 1.1, 0.18, Math.PI / 2, 0.4);
      b.add(CYL, '#5b3d24', 0, 0.15, 0, Math.PI / 2, 0.18, 1.1, 0.18, Math.PI / 2, -0.4);
      glow.add(TENT, '#ffb347', 0, 0.55, 0, 0, 0.32, 0.8, 0.32);
      glow.add(TENT, '#ff6a2a', 0.12, 0.45, 0.05, 0.7, 0.2, 0.5, 0.2);
      break;
    case 'tent':
      b.add(TENT, team, 0, h / 2, 0, Math.PI / 6, w / 2, h, d / 2);
      b.add(BOX, '#3b2a1c', 0, 0.6, d / 2 - 0.2, 0, 0.7, 1.2, 0.1);
      break;
    case 'chest':
      b.box('#7a5230', 0, 0, 0, w, h * 0.7, d, 0, false);
      b.box('#5e3e22', 0, h * 0.7, 0, w, h * 0.3, d, 0, false);
      b.box('#c9a24a', 0, h * 0.45, d / 2, 0.18, 0.25, 0.05, 0, false);
      break;
    case 'wood_gate':
      b.box(TIER.wood_gate, -w / 2 + 0.2, 0, 0, 0.4, h, d, 0, false);
      b.box(TIER.wood_gate, w / 2 - 0.2, 0, 0, 0.4, h, d, 0, false);
      b.box(TIER.wood_gate, 0, h - 0.4, 0, w, 0.4, d, 0, false);
      b.box(team, 0, h - 0.9, d / 2 + 0.02, 0.8, 0.5, 0.02, 0, false);
      break;
    case 'glass_window':
      b.box(TIER.glass_window, 0, 0, 0, w, 0.8, d, 0, false);
      b.box(TIER.glass_window, 0, h - 0.4, 0, w, 0.4, d, 0, false);
      b.box(TIER.glass_window, -w / 2 + 0.15, 0, 0, 0.3, h, d, 0, false);
      b.box(TIER.glass_window, w / 2 - 0.15, 0, 0, 0.3, h, d, 0, false);
      b.box('#a8dcf0', 0, 0.8, 0, w - 0.6, h - 1.2, d * 0.4, 0, false);
      break;
    case 'watchtower':
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box('#6b4f33', x * (w / 2 - 0.2), 0, z * (d / 2 - 0.2), 0.35, h - 1.6, 0.35, 0, false);
      b.box('#8a6a43', 0, h - 1.8, 0, w, 0.25, d, 0, false);
      b.box('#9a958c', 0, 0, 0, w * 0.9, 1.2, d * 0.9, 0, false);
      b.add(ROOF4, team, 0, h - 0.6, 0, 0, w * 0.95, 1.2, d * 0.95);
      break;
    case 'sandstone_bridge':
      b.box('#d8c08a', 0, 0, 0, w, h, d, 0, false);
      b.box('#c4a970', -w / 2 + 0.1, h, 0, 0.2, 0.5, d, 0, false);
      b.box('#c4a970', w / 2 - 0.1, h, 0, 0.2, 0.5, d, 0, false);
      break;
    case 'steam_vent':
      b.add(CYL, '#7d7a75', 0, h / 2, 0, 0, w, h, d);
      b.add(CYL, '#d8dde0', 0, h + 0.02, 0, 0, w * 0.7, 0.05, d * 0.7);
      break;
    case 'forge':
      b.box('#7d7a75', 0, 0, 0, w, h * 0.7, d, 0, false);
      b.box('#6a6762', w / 2 - 0.5, h * 0.7, -d / 2 + 0.5, 0.7, h * 0.6, 0.7, 0, false);
      glow.box('#ff7a2a', 0, 0.4, d / 2, w * 0.45, 0.5, 0.06, 0, false);
      break;
    case 'ice_lantern':
      b.add(CYL, '#6b4f33', 0, h * 0.4, 0, 0, 0.14, h * 0.8, 0.14);
      glow.add(BOX, '#bfe6ff', 0, h * 0.85, 0, Math.PI / 4, 0.32, 0.4, 0.32);
      break;
    case 'element_shrine':
      b.box('#9a958c', 0, 0, 0, w, 0.5, d, 0, false);
      b.add(CYL, '#b8b2a6', 0, 0.5 + (h - 1.2) / 2, 0, 0, 0.7, h - 1.2, 0.7);
      glow.add(SPHERE, team, 0, h - 0.4, 0, 0, 0.6, 0.6, 0.6);
      break;
    case 'training_dummy':
      b.add(CYL, '#7a5230', 0, h / 2, 0, 0, 0.22, h, 0.22);
      b.box('#7a5230', 0, h * 0.7, 0, 1.0, 0.16, 0.16, 0, false);
      b.add(SPHERE, '#c9b48a', 0, h, 0, 0, 0.4, 0.4, 0.4);
      break;
    case 'crew_hall':
      // Stone base, timber hall, a tall roof in the crew's faction colour, and a tag banner over the door.
      b.box('#8d8a84', 0, 0, 0, w, 0.6, d, 0, false);
      b.box('#c9c0ae', 0, 0.6, 0, w - 1, h - 2.1, d - 1, 0, false);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box('#6b4f33', x * (w / 2 - 0.6), 0.6, z * (d / 2 - 0.6), 0.5, h - 2.1, 0.5, 0, false);
      b.add(ROOF4, team, 0, h - 0.75, 0, 0, w * 1.05, 2.4, d * 1.05);
      b.box('#3b2a1c', 0, 0.6, d / 2 - 0.45, 1.6, 2.2, 0.1, 0, false);
      b.box(team, 0, 3.0, d / 2 - 0.42, 2.2, 0.8, 0.06, 0, false);
      glow.add(SPHERE, '#ffd27a', -1.4, 2.2, d / 2, 0, 0.35, 0.35, 0.35);
      glow.add(SPHERE, '#ffd27a', 1.4, 2.2, d / 2, 0, 0.35, 0.35, 0.35);
      break;
    case 'faction_banner':
      b.add(CYL, '#4a3a2a', 0, h / 2, 0, 0, 0.18, h, 0.18);
      b.box(team, 0.75, h - 2.2, 0, 1.4, 1.9, 0.05, 0, false);
      b.box('#c9a64a', 0, h, 0, 0.3, 0.25, 0.3, 0, false);
      break;
    case 'pet_stable':
      for (const x of [-1, 1]) for (const z of [-1, 1]) b.box('#6b4f33', x * (w / 2 - 0.2), 0, z * (d / 2 - 0.2), 0.3, h - 0.5, 0.3, 0, false);
      b.box('#8a6a43', 0, 0, -d / 2 + 0.1, w, 1.2, 0.15, 0, false);
      b.add(ROOF4, '#7a5b38', 0, h - 0.25, 0, 0, w * 0.8, 1, d * 1.1);
      b.box('#d8c06a', -0.8, 0, 0.2, 1.4, 0.4, 1, 0, false);
      b.box('#7a5230', 1, 0, 0.5, 1, 0.5, 0.6, 0, false);
      break;
    case 'workshop':
      b.box('#9a958c', 0, 0, 0, w, h * 0.75, d, 0, false);
      b.box('#6b4f33', 0, h * 0.75, 0, w + 0.3, 0.2, d + 0.3, 0, false);
      b.add(CYL, '#6a6762', w / 2 - 0.5, h * 0.75 + 0.5, -d / 2 + 0.5, 0, 0.4, 1, 0.4);
      b.box('#7a5230', 0, 0.9, d / 2 + 0.3, w * 0.7, 0.12, 0.6, 0, false);
      glow.box('#ff9a3c', 0, 0.3, d / 2, 0.8, 0.5, 0.05, 0, false);
      break;
    case 'metal_gate':
      b.box('#8d99a6', -w / 2 + 0.2, 0, 0, 0.4, h, d, 0, false);
      b.box('#8d99a6', w / 2 - 0.2, 0, 0, 0.4, h, d, 0, false);
      b.box('#5d6670', 0, h - 0.5, 0, w, 0.5, d, 0, false);
      for (let x = -w / 2 + 0.7; x < w / 2 - 0.4; x += 0.5) b.box('#5d6670', x, h - 1.1, 0, 0.08, 0.6, d * 0.5, 0, false);
      b.box(team, 0, h - 1.6, d / 2 + 0.02, 0.8, 0.5, 0.02, 0, false);
      break;
    case 'spirit_wall':
    case 'spirit_gate': {
      const gate = s.piece === 'spirit_gate';
      if (gate) {
        b.box('#cfd8e8', -w / 2 + 0.25, 0, 0, 0.5, h, d, 0, false);
        b.box('#cfd8e8', w / 2 - 0.25, 0, 0, 0.5, h, d, 0, false);
        b.box('#cfd8e8', 0, h - 0.45, 0, w, 0.45, d, 0, false);
      } else b.box('#cfd8e8', 0, 0, 0, w, h, d, 0, false);
      // Glowing ward runes.
      for (const x of gate ? [-w / 2 + 0.25, w / 2 - 0.25] : [-w / 4, w / 4]) glow.box('#9fe6ff', x, h * 0.35, d / 2 + 0.02, 0.18, h * 0.4, 0.02, 0, false);
      break;
    }
    default:
      // Walls.
      b.box(TIER[s.piece] ?? '#8a6a43', 0, 0, 0, w, h, d, 0, false);
      if (s.piece === 'wood_wall') for (let x = -w / 2 + 0.3; x < w / 2; x += 0.6) b.box('#6b4f33', x, h, 0, 0.18, 0.25, d, 0, false);
      if (s.piece === 'metal_wall') b.box('#5d6670', 0, h * 0.45, d / 2 + 0.01, w * 0.9, 0.12, 0.02, 0, false);
  }
}

interface Built {
  s: Structure;
  group: THREE.Group;
  collider: RAPIER.Collider | null;
}

/** Meshes and colliders for camp structures, kept in sync with a Camps instance. */
export class StructureView {
  readonly group = new THREE.Group();
  private built = new Map<string, Built>();
  private mat = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: TOON_RAMP });
  private glowMat = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
  private camps: Camps | null = null;
  private unlisten: (() => void) | null = null;

  constructor(private physics: Physics) {
    this.group.name = 'structures';
    registerBloomSource(this.glowMat, mrt({ emissive: vec4(vertexColor().mul(0.9), 1) }));
  }

  /** Follow a (new) host's camps. */
  bind(camps: Camps): void {
    this.unlisten?.();
    for (const id of [...this.built.keys()]) this.drop(id);
    this.camps = camps;
    for (const s of camps.all.values()) this.build(s);
    this.unlisten = camps.listen((s, change) => {
      if (change === 'del') this.drop(s.id);
      else if (!this.built.has(s.id)) this.build(s);
    });
  }

  get count(): number {
    return this.built.size;
  }

  private build(s: Structure): void {
    const def = pieceById(s.piece);
    if (!def) return;
    const b = new Geo();
    const glow = new Geo();
    drawPiece(s, b, glow);
    const g = new THREE.Group();
    g.name = `struct:${s.id}`;
    g.position.set(s.x, s.y, s.z);
    g.rotation.y = (s.rot * Math.PI) / 2;
    const geo = b.build();
    if (geo) {
      const m = new THREE.Mesh(geo, this.mat);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    const gg = glow.build();
    if (gg) g.add(new THREE.Mesh(gg, this.glowMat));
    this.group.add(g);
    const [hx, hy, hz] = halfExtents(s.piece, s.rot);
    const collider = def.solid ? this.physics.addStaticBox(s.x, s.y + hy, s.z, hx, hy, hz) : null;
    this.built.set(s.id, { s, group: g, collider });
  }

  private drop(id: string): void {
    const b = this.built.get(id);
    if (!b) return;
    this.group.remove(b.group);
    b.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    if (b.collider) this.physics.removeCollider(b.collider);
    this.built.delete(id);
  }

  /** The nearest structure (optionally matching) within r of (x, z). */
  nearest(x: number, z: number, r: number, filter?: (s: Structure) => boolean): Structure | null {
    let best: Structure | null = null;
    let bd = r;
    for (const s of this.camps?.all.values() ?? []) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d <= bd && (!filter || filter(s))) {
        bd = d;
        best = s;
      }
    }
    return best;
  }
}

// ---- resource nodes ------------------------------------------------------------

const NODE_LOOK: Record<NodeType, { geo: THREE.BufferGeometry; color: string; scale: [number, number, number]; lift: number; rx?: number }> = {
  timber: { geo: new THREE.CylinderGeometry(0.35, 0.4, 3.2, 7), color: '#6b4a2c', scale: [1, 1, 1], lift: 0.3, rx: Math.PI / 2 },
  boulder: { geo: new THREE.DodecahedronGeometry(1, 0), color: '#8f8a80', scale: [1.3, 0.9, 1.1], lift: 0.4 },
  sand: { geo: new THREE.CylinderGeometry(1.8, 2.2, 0.35, 10), color: '#e2cc8e', scale: [1, 1, 1], lift: 0.05 },
  ore_node: { geo: new THREE.DodecahedronGeometry(0.9, 0), color: '#5a4c44', scale: [1, 1.2, 1], lift: 0.4 },
  hot_spring: { geo: new THREE.CylinderGeometry(1.8, 1.8, 0.12, 14), color: '#7fd0d8', scale: [1, 1, 1], lift: 0.06 },
  ash_pile: { geo: new THREE.ConeGeometry(1.2, 0.8, 8), color: '#4a4542', scale: [1, 1, 1], lift: 0.35 },
};

/** Instanced meshes for resource nodes around the player (rebuilt as they travel). */
export class ResourceView {
  readonly group = new THREE.Group();
  private meshes = new Map<NodeType, THREE.InstancedMesh>();
  private at = new THREE.Vector2(1e9, 1e9);
  private readonly cap = 400;
  private readonly radius = 150;
  /** Nodes currently shown (for prompts). */
  shown: ReturnType<typeof nodesNear> = [];

  constructor(private groundAt: (x: number, z: number) => number) {
    this.group.name = 'resources';
    for (const [type, look] of Object.entries(NODE_LOOK) as Array<[NodeType, (typeof NODE_LOOK)[NodeType]]>) {
      const mat = new THREE.MeshToonNodeMaterial({ color: look.color, gradientMap: TOON_RAMP });
      const m = new THREE.InstancedMesh(look.geo, mat, this.cap);
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.name = `nodes:${type}`;
      this.meshes.set(type, m);
      this.group.add(m);
    }
  }

  update(x: number, z: number): void {
    if (Math.hypot(x - this.at.x, z - this.at.y) < 24) return;
    this.at.set(x, z);
    this.shown = nodesNear(x, z, this.radius);
    const counts = new Map<NodeType, number>();
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const n of this.shown) {
      const mesh = this.meshes.get(n.type)!;
      const i = counts.get(n.type) ?? 0;
      if (i >= this.cap) continue;
      const look = NODE_LOOK[n.type];
      const yaw = (n.x * 12.9898 + n.z * 78.233) % (Math.PI * 2);
      q.setFromEuler(e.set(look.rx ?? 0, yaw, 0, 'YXZ'));
      const y = this.groundAt(n.x, n.z) + look.lift;
      m4.compose(new THREE.Vector3(n.x, y, n.z), q, new THREE.Vector3(...look.scale));
      mesh.setMatrixAt(i, m4);
      counts.set(n.type, i + 1);
    }
    for (const [type, mesh] of this.meshes) {
      mesh.count = counts.get(type) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
