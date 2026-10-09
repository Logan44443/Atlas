import * as THREE from 'three/webgpu';
import { POINTS, type WarPoint } from '@shared/territory';
import { SIDES, factionById, type Side } from '@shared/factions';
import type { TerrMsg } from '@shared/net';
import { TOON_RAMP } from './materials';
import { Builder, BOX, CYL, ROOF4 } from './hubs';
import type { Physics } from '../game/physics';

const NEUTRAL = '#d9d6cf';
const FLAG_W = 2.4;
const FLAG_H = 1.5;

/** A wooden outpost: palisade with two gates, a watchtower and some crates. */
function buildOutpost(b: Builder, y0: number): void {
  const R = 12;
  const segs = 24;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    // Gates face +z and -z.
    if (Math.abs(Math.sin(am)) > 0.97) continue;
    const len = 2 * R * Math.sin((a1 - a0) / 2) + 0.3;
    b.box('#6b4f33', Math.cos(am) * R, y0, Math.sin(am) * R, len, 2.6, 0.6, -am + Math.PI / 2);
    b.add(ROOF4, '#5a412a', Math.cos(am) * R, y0 + 2.8, Math.sin(am) * R, -am + Math.PI / 4, 0.7, 0.5, 0.7);
  }
  // Watchtower in the north-east corner.
  const tx = 6;
  const tz = -6;
  for (const [dx, dz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) b.box('#5c432b', tx + dx, y0, tz + dz, 0.4, 6, 0.4);
  b.box('#7a5b3c', tx, y0 + 6, tz, 3.6, 0.3, 3.6);
  for (const [dx, dz, w, d] of [[0, -1.7, 3.6, 0.2], [0, 1.7, 3.6, 0.2], [-1.7, 0, 0.2, 3.6], [1.7, 0, 0.2, 3.6]]) b.box('#6b4f33', tx + dx, y0 + 6.3, tz + dz, w, 0.9, d, 0, false);
  b.add(ROOF4, '#3f4a5c', tx, y0 + 8.1, tz, 0, 5, 1.6, 5);
  // Supplies.
  b.box('#8a6a45', -6, y0, 5, 1.2, 1, 1.2, 0.3);
  b.box('#8a6a45', -4.6, y0, 5.6, 1, 0.9, 1, 0.9);
  b.box('#9c7b52', -5.4, y0 + 1, 5.2, 0.9, 0.8, 0.9, 0.5, false);
  b.add(CYL, '#4a3a2a', 6, y0 + 0.5, 6, 0, 1, 1, 1);
}

interface PointView {
  pt: WarPoint;
  flag: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshToonNodeMaterial>;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicNodeMaterial>;
  fill: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicNodeMaterial>;
  key: string;
  phase: number;
}

/**
 * Territory points in the world (Phase 11): the outposts' buildings, a flag on
 * every point in its holder's colours, and during a war the capture circle,
 * which fills toward the side that is taking it.
 */
export class TerritoryView {
  readonly group = new THREE.Group();
  private views: PointView[] = [];
  private t = 0;

  constructor(groundAt: (x: number, z: number) => number, physics: Physics) {
    this.group.name = 'Territory';
    const mat = new THREE.MeshToonNodeMaterial({ vertexColors: true, gradientMap: TOON_RAMP, side: THREE.DoubleSide });
    const flagGeo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, 6, 1).translate(FLAG_W / 2, 0, 0);
    const ringGeo = new THREE.RingGeometry(0.96, 1, 64).rotateX(-Math.PI / 2);
    const fillGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    for (const pt of POINTS) {
      const y0 = groundAt(pt.x, pt.z) - 0.2;
      const b = new Builder();
      // Shrines already have their building (hubs.ts): the pole stands on the central pillar.
      const poleBase = pt.kind === 'shrine' ? y0 + 5.3 : y0;
      const poleH = pt.kind === 'shrine' ? 5 : 9;
      if (pt.kind === 'outpost') buildOutpost(b, y0);
      b.add(CYL, '#3c3a36', 0, poleBase + poleH / 2, 0, 0, 0.18, poleH, 0.18);
      b.add(BOX, '#c9a64a', 0, poleBase + poleH + 0.15, 0, 0, 0.35, 0.3, 0.35);
      const geo = b.build();
      if (geo) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pt.x, 0, pt.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `point ${pt.id}`;
        this.group.add(mesh);
      }
      for (const bx of b.boxes) physics.addStaticBox(pt.x + bx.c.x, bx.c.y, pt.z + bx.c.z, bx.h.x, bx.h.y, bx.h.z, bx.yaw);

      const flag = new THREE.Mesh(flagGeo, new THREE.MeshToonNodeMaterial({ color: NEUTRAL, gradientMap: TOON_RAMP, side: THREE.DoubleSide }));
      flag.position.set(pt.x + 0.1, poleBase + poleH - FLAG_H / 2 - 0.1, pt.z);
      flag.castShadow = true;
      flag.name = `flag ${pt.id}`;
      const ringMat = new THREE.MeshBasicNodeMaterial({ color: NEUTRAL, transparent: true, opacity: 0.75, depthWrite: false });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.scale.setScalar(pt.captureRadius);
      ring.position.set(pt.x, y0 + 0.35, pt.z);
      ring.renderOrder = 5;
      const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicNodeMaterial({ color: NEUTRAL, transparent: true, opacity: 0.16, depthWrite: false }));
      fill.position.set(pt.x, y0 + 0.3, pt.z);
      fill.renderOrder = 4;
      ring.visible = fill.visible = false;
      this.group.add(flag, ring, fill);
      this.views.push({ pt, flag, ring, fill, key: '', phase: pt.x * 0.013 + pt.z * 0.007 });
    }
  }

  update(dt: number, terr: TerrMsg): void {
    this.t += dt;
    for (const v of this.views) {
      const st = terr.points.find((p) => p.id === v.pt.id);
      const owner = st?.owner ?? '';
      const capColor = st?.capSide ? (SIDES[st.capSide as Side]?.color ?? NEUTRAL) : NEUTRAL;
      const key = `${owner}|${terr.open}|${capColor}|${st ? Math.round(st.progress * 50) : 0}`;
      if (key !== v.key) {
        v.key = key;
        v.flag.material.color.set(factionById(owner)?.color ?? NEUTRAL);
        v.ring.visible = v.fill.visible = terr.open;
        v.ring.material.color.set(capColor);
        v.fill.material.color.set(capColor);
        // The disc grows with the capture meter.
        v.fill.scale.setScalar(Math.max(0.05, st?.progress ?? 0) * v.pt.captureRadius);
      }
      // A little wind in the flag.
      v.flag.rotation.y = Math.sin(this.t * 1.7 + v.phase) * 0.35;
      v.flag.scale.y = 1 + Math.sin(this.t * 3.1 + v.phase) * 0.04;
    }
  }
}
