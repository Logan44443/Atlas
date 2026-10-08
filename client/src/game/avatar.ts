import * as THREE from 'three/webgpu';
import { TOON_RAMP } from '../world/materials';

export type Element = 'fire' | 'water' | 'earth' | 'air';

export const ELEMENT_COLORS: Record<Element, { main: string; trim: string }> = {
  fire: { main: '#c8432b', trim: '#f2b24a' },
  water: { main: '#2f6fb8', trim: '#a9d8f2' },
  earth: { main: '#4f7a2e', trim: '#c9a86a' },
  air: { main: '#e2a53a', trim: '#f6e8c2' },
};

export interface AvatarPose {
  speed: number; // horizontal m/s
  grounded: boolean;
  vy: number;
  dodge: number; // 0..1 progress, 0 = not dodging
  swimming: boolean;
  blocking?: boolean;
}

function mat(hex: string): THREE.MeshToonNodeMaterial {
  return new THREE.MeshToonNodeMaterial({ color: hex, gradientMap: TOON_RAMP });
}

/** Limb hanging down from a pivot (shoulder/hip). */
function limb(len: number, radius: number, m: THREE.Material): { pivot: THREE.Group; lower: THREE.Group } {
  const pivot = new THREE.Group();
  const upper = new THREE.Mesh(new THREE.CapsuleGeometry(radius, len * 0.5 - radius, 3, 8), m);
  upper.position.y = -len * 0.25;
  pivot.add(upper);
  const lower = new THREE.Group();
  lower.position.y = -len * 0.5;
  const lm = new THREE.Mesh(new THREE.CapsuleGeometry(radius * 0.9, len * 0.5 - radius, 3, 8), m);
  lm.position.y = -len * 0.25;
  lower.add(lm);
  pivot.add(lower);
  return { pivot, lower };
}

/**
 * Placeholder character built from primitives, animated procedurally
 * (walk/run cycle, jump, dodge roll, swim, block). Origin is at the feet.
 * Swapped for a rigged glTF + Mixamo clips once mechanics settle.
 */
export class Avatar {
  readonly root = new THREE.Group();
  private body = new THREE.Group(); // rolls during dodge
  private torso: THREE.Group;
  private head: THREE.Mesh;
  private armL: ReturnType<typeof limb>;
  private armR: ReturnType<typeof limb>;
  private legL: ReturnType<typeof limb>;
  private legR: ReturnType<typeof limb>;
  private phase = 0;
  private time = 0;

  constructor(element: Element = 'fire') {
    const c = ELEMENT_COLORS[element];
    const cloth = mat(c.main);
    const trim = mat(c.trim);
    const skin = mat('#e6b48f');
    const dark = mat('#2b2522');

    this.root.add(this.body);
    this.body.position.y = 0.95;

    this.torso = new THREE.Group();
    this.body.add(this.torso);
    const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.42, 4, 10), cloth);
    chest.position.y = 0.32;
    chest.scale.set(1, 1, 0.8);
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.255, 0.255, 0.1, 12), trim);
    belt.position.y = 0.1;
    belt.scale.z = 0.82;
    const sash = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.04), trim);
    sash.position.set(0.05, 0.36, 0.2);
    sash.rotation.z = 0.6;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), skin);
    this.head.position.y = 0.82;
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.175, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), dark);
    hair.position.y = 0.84;
    hair.rotation.x = -0.25;
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), dark);
    knot.position.set(0, 1.0, -0.06);
    this.torso.add(chest, belt, sash, this.head, hair, knot);

    this.armL = limb(0.62, 0.065, cloth);
    this.armR = limb(0.62, 0.065, cloth);
    this.armL.pivot.position.set(-0.31, 0.58, 0);
    this.armR.pivot.position.set(0.31, 0.58, 0);
    for (const a of [this.armL, this.armR]) {
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), skin);
      hand.position.y = -0.32;
      a.lower.add(hand);
    }
    this.torso.add(this.armL.pivot, this.armR.pivot);

    this.legL = limb(0.86, 0.085, dark);
    this.legR = limb(0.86, 0.085, dark);
    this.legL.pivot.position.set(-0.12, 0.02, 0);
    this.legR.pivot.position.set(0.12, 0.02, 0);
    for (const l of [this.legL, this.legR]) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.24), trim);
      foot.position.set(0, -0.43, 0.06);
      l.lower.add(foot);
    }
    this.body.add(this.legL.pivot, this.legR.pivot);

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.root.name = 'Avatar';
  }

  update(dt: number, p: AvatarPose): void {
    this.time += dt;
    const run = THREE.MathUtils.clamp(p.speed / 8.8, 0, 1);
    const moving = p.speed > 0.3;
    this.phase += dt * (moving ? 2.2 + p.speed * 1.15 : 0);
    const s = Math.sin(this.phase);
    const c = Math.cos(this.phase);
    const damp = 1 - Math.exp(-dt * 14);
    const set = (o: THREE.Object3D, x: number, z = 0) => {
      o.rotation.x += (x - o.rotation.x) * damp;
      o.rotation.z += (z - o.rotation.z) * damp;
    };

    let legSwing = moving ? 0.45 + run * 0.5 : 0;
    let armSwing = moving ? 0.35 + run * 0.65 : 0;
    let lean = moving ? 0.06 + run * 0.22 : 0;
    let bob = moving ? Math.abs(c) * (0.03 + run * 0.05) : Math.sin(this.time * 2) * 0.012;
    let kneeL = moving ? Math.max(0, -s) * (0.6 + run * 0.6) : 0.05;
    let kneeR = moving ? Math.max(0, s) * (0.6 + run * 0.6) : 0.05;
    let armSpreadL = 0.08;
    let armSpreadR = -0.08;
    let armBaseL = 0;
    let armBaseR = 0;

    if (!p.grounded && !p.swimming) {
      // Airborne: tuck legs, arms out.
      legSwing = 0.15;
      armSwing = 0.1;
      kneeL = kneeR = p.vy > 0 ? 0.9 : 0.4;
      armSpreadL = 0.7;
      armSpreadR = -0.7;
      lean = 0.1;
      bob = 0;
    }
    if (p.swimming) {
      lean = 1.1;
      legSwing = 0.35;
      kneeL = kneeR = 0.2;
      armBaseL = armBaseR = -2.6;
      armSwing = 0.9;
      bob = Math.sin(this.time * 3) * 0.04 - 0.5;
    }
    if (p.blocking) {
      armBaseL = armBaseR = -1.5;
      armSpreadL = -0.5;
      armSpreadR = 0.5;
      armSwing *= 0.2;
    }

    set(this.legL.pivot, s * legSwing);
    set(this.legR.pivot, -s * legSwing);
    set(this.legL.lower, kneeL);
    set(this.legR.lower, kneeR);
    set(this.armL.pivot, armBaseL - s * armSwing, armSpreadL);
    set(this.armR.pivot, armBaseR + s * armSwing, armSpreadR);
    set(this.armL.lower, -0.25 - run * 0.6);
    set(this.armR.lower, -0.25 - run * 0.6);
    this.torso.rotation.x += (lean - this.torso.rotation.x) * damp;
    this.torso.rotation.y = moving && p.grounded ? s * 0.08 * (0.5 + run) : this.torso.rotation.y * (1 - damp);

    // Dodge: full forward roll around the body centre, crouched.
    if (p.dodge > 0) {
      const e = p.dodge;
      this.body.rotation.x = e * Math.PI * 2;
      this.body.position.y = 0.95 - Math.sin(e * Math.PI) * 0.4;
      kneeL = kneeR = 1.4;
      set(this.legL.lower, 1.6);
      set(this.legR.lower, 1.6);
    } else {
      this.body.rotation.x = 0;
      this.body.position.y = 0.95 + bob;
    }
  }
}
