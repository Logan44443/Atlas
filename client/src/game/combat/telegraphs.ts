import * as THREE from 'three/webgpu';
import type { SimEvent } from '@shared/sim/combatSim';

// Bosses paint where their next big move lands: a red ring, cone or charge
// lane on the ground that fills up until it goes off. Get out of the red.

interface Tele {
  mesh: THREE.Mesh;
  fill: THREE.Mesh;
  t: number;
  duration: number;
}

const edgeMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.18, 0.1), transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
const fillMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1.6, 0.35, 0.15), transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });

export class Telegraphs {
  readonly group = new THREE.Group();
  private list: Tele[] = [];

  constructor(private groundAt: (x: number, z: number) => number) {}

  handle(ev: SimEvent): void {
    if (ev.t !== 'tele') return;
    let geo: THREE.BufferGeometry;
    if (ev.shape === 'ring') geo = new THREE.CircleGeometry(ev.radius, 40);
    else if (ev.shape === 'cone') {
      const a = (ev.angle * Math.PI) / 180;
      geo = new THREE.CircleGeometry(ev.radius, 24, Math.PI / 2 - a / 2, a);
    } else geo = new THREE.PlaneGeometry(ev.angle, ev.radius).translate(0, ev.radius / 2, 0);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, edgeMat);
    const fill = new THREE.Mesh(geo, fillMat);
    fill.scale.setScalar(0.01);
    mesh.add(fill);
    const [x, , z] = ev.pos;
    mesh.position.set(x, this.groundAt(x, z) + 0.12, z);
    // Cones and lanes point along dir (geometry points to -z after the flip... rotate to face dir).
    if (ev.shape !== 'ring') mesh.rotation.y = Math.atan2(ev.dir[0], ev.dir[2]) + Math.PI;
    mesh.renderOrder = 3;
    this.group.add(mesh);
    this.list.push({ mesh, fill, t: 0, duration: Math.max(0.2, ev.duration) });
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const tl = this.list[i];
      tl.t += dt;
      const k = Math.min(1, tl.t / tl.duration);
      tl.fill.scale.setScalar(Math.max(0.01, k));
      if (tl.t > tl.duration + 0.15) {
        tl.mesh.removeFromParent();
        tl.mesh.geometry.dispose();
        this.list.splice(i, 1);
      }
    }
  }
}
