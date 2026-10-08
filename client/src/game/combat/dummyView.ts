import * as THREE from 'three/webgpu';
import { DUMMIES } from '@shared/sim/dummies';
import type { SimEntity } from '@shared/sim/combatSim';
import { TOON_RAMP } from '../../world/materials';

/** Straw training dummy on a post, drawn from a sim entity (local or replicated). */
export class DummyView {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private glow: THREE.Mesh | null = null;
  private wobble = 0;
  private deadT = 0;
  private lastHp = -1;
  private time = 0;
  private bar: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture };

  constructor(readonly entity: SimEntity) {
    const def = DUMMIES.find((d) => entity.id.endsWith(d.id));
    const attacks = !!def?.attacks;
    const m = (c: string) => new THREE.MeshToonNodeMaterial({ color: c, gradientMap: TOON_RAMP });
    const wood = m('#7a5534');
    const straw = m(attacks ? '#c9763a' : '#d8c27a');
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.9, 6), wood);
    post.position.y = 0.95;
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.55, 4, 10), straw);
    torso.position.y = 1.25;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), straw);
    head.position.y = 1.95;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 6), wood);
    arm.rotation.z = Math.PI / 2;
    arm.position.y = 1.5;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.08, 10), m(attacks ? '#3a2a20' : '#a33'));
    band.position.y = 1.2;
    this.body.add(torso, head, arm, band);
    if (attacks) {
      this.glow = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(4, 1.6, 0.3) }));
      this.glow.position.set(0.65, 1.5, 0.15);
      this.glow.scale.setScalar(0.01);
      this.body.add(this.glow);
    }
    this.root.add(post, this.body);
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 32;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sm = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
    sm.fog = false;
    const sprite = new THREE.Sprite(sm);
    sprite.scale.set(1.3, 0.32, 1);
    sprite.position.y = 2.5;
    this.root.add(sprite);
    this.bar = { canvas, tex };
    this.root.name = `dummy ${entity.id}`;
    this.root.position.copy(entity.pos);
  }

  /** Called on knockback hits so the straw body sways. */
  shake(amount: number): void {
    this.wobble = Math.min(1, this.wobble + amount * 0.08);
  }

  private drawBar(): void {
    const e = this.entity;
    if (this.lastHp === e.hp) return;
    this.lastHp = e.hp;
    const c = this.bar.canvas.getContext('2d')!;
    c.clearRect(0, 0, 128, 32);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(4, 10, 120, 12);
    c.fillStyle = e.hp / e.maxHp > 0.3 ? '#e2503c' : '#ff8a3c';
    c.fillRect(6, 12, 116 * (e.hp / e.maxHp), 8);
    this.bar.tex.needsUpdate = true;
  }

  update(dt: number): void {
    const e = this.entity;
    this.time += dt;
    this.drawBar();
    if (e.dead) {
      this.deadT += dt;
      this.root.visible = this.deadT < 0.6;
      this.body.rotation.x = Math.min(Math.PI / 2, this.deadT * 4);
      return;
    }
    this.deadT = 0;
    this.root.visible = true;
    this.root.position.lerp(e.pos, 1 - Math.exp(-dt * 20));
    this.root.rotation.y = e.yaw;
    this.wobble *= Math.exp(-dt * 3);
    this.body.rotation.set(e.statuses.has('stagger') ? Math.sin(this.time * 20) * 0.1 : 0, 0, Math.sin(this.time * 14) * this.wobble * 0.35);
    // Visible wind-up so players can learn to time a perfect block.
    if (this.glow) this.glow.scale.setScalar(e.windup > 0 ? 0.2 + e.windup * 1.6 : 0.01);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.bar.tex.dispose();
  }
}
