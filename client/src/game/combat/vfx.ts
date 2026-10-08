import * as THREE from 'three/webgpu';
import { instancedDynamicBufferAttribute, uv, smoothstep, vec4, mrt, float } from 'three/tsl';
import { registerBloomSource } from '../../engine/renderer';

export interface ParticleSpec {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  life: number;
  size: [number, number];
  color: THREE.Color;
  colorEnd?: THREE.Color;
  alpha?: [number, number];
  drag?: number;
  gravity?: number;
}

/**
 * CPU-simulated billboard particles rendered as ONE instanced sprite draw call
 * per blend mode. Additive particles also feed the bloom pass.
 */
class ParticlePool {
  readonly sprite: THREE.Sprite;
  private max: number;
  private n = 0;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array; // start, end
  private col: Float32Array; // r,g,b start, r,g,b end
  private alpha: Float32Array; // start, end
  private phys: Float32Array; // drag, gravity
  private aPos: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;

  constructor(max: number, additive: boolean) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max * 2);
    this.col = new Float32Array(max * 6);
    this.alpha = new Float32Array(max * 2);
    this.phys = new Float32Array(max * 2);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const c = instancedDynamicBufferAttribute(this.aCol, 'vec4') as unknown as ReturnType<typeof vec4>;
    const soft = smoothstep(0.5, 0.15, uv().sub(0.5).length());
    mat.positionNode = instancedDynamicBufferAttribute(this.aPos);
    mat.scaleNode = instancedDynamicBufferAttribute(this.aSize);
    mat.colorNode = vec4(c.rgb, float(1));
    mat.opacityNode = c.a.mul(soft);
    mat.fog = !additive;
    if (additive) registerBloomSource(mat, mrt({ emissive: vec4(c.rgb.mul(c.a).mul(soft), 1) }));
    this.sprite = new THREE.Sprite(mat);
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = additive ? 30 : 29;
    this.sprite.name = additive ? 'vfx-additive' : 'vfx-alpha';
  }

  emit(s: ParticleSpec): void {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos.set([s.pos.x, s.pos.y, s.pos.z], i * 3);
    this.vel.set(s.vel ? [s.vel.x, s.vel.y, s.vel.z] : [0, 0, 0], i * 3);
    this.life[i] = 0;
    this.maxLife[i] = s.life;
    this.size[i * 2] = s.size[0];
    this.size[i * 2 + 1] = s.size[1];
    const ce = s.colorEnd ?? s.color;
    this.col.set([s.color.r, s.color.g, s.color.b, ce.r, ce.g, ce.b], i * 6);
    this.alpha[i * 2] = s.alpha?.[0] ?? 1;
    this.alpha[i * 2 + 1] = s.alpha?.[1] ?? 0;
    this.phys[i * 2] = s.drag ?? 0;
    this.phys[i * 2 + 1] = s.gravity ?? 0;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.pos.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.vel.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.life[i] = this.life[j];
    this.maxLife[i] = this.maxLife[j];
    this.size.copyWithin(i * 2, j * 2, j * 2 + 2);
    this.col.copyWithin(i * 6, j * 6, j * 6 + 6);
    this.alpha.copyWithin(i * 2, j * 2, j * 2 + 2);
    this.phys.copyWithin(i * 2, j * 2, j * 2 + 2);
  }

  update(dt: number): void {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) this.kill(i);
    }
    const P = this.aPos.array as Float32Array;
    const C = this.aCol.array as Float32Array;
    const S = this.aSize.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i] / this.maxLife[i];
      const drag = Math.exp(-this.phys[i * 2] * dt);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag + this.phys[i * 2 + 1] * dt;
      this.vel[i * 3 + 2] *= drag;
      for (let k = 0; k < 3; k++) {
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
        P[i * 3 + k] = this.pos[i * 3 + k];
        C[i * 4 + k] = this.col[i * 6 + k] + (this.col[i * 6 + 3 + k] - this.col[i * 6 + k]) * t;
      }
      C[i * 4 + 3] = this.alpha[i * 2] + (this.alpha[i * 2 + 1] - this.alpha[i * 2]) * t;
      S[i] = this.size[i * 2] + (this.size[i * 2 + 1] - this.size[i * 2]) * t;
    }
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
    this.sprite.count = this.n;
    this.sprite.visible = this.n > 0;
  }

  get alive(): number {
    return this.n;
  }
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const tmpV = new THREE.Vector3();

export const PALETTE = {
  fire: { core: new THREE.Color(4, 2.2, 0.6), hot: new THREE.Color(2.2, 0.9, 0.2), mid: new THREE.Color(1.8, 0.45, 0.08), end: new THREE.Color('#3a0a02') },
  water: { core: new THREE.Color(0.8, 1.8, 3), hot: new THREE.Color(0.7, 1.4, 2.0), mid: new THREE.Color('#3a9fe0'), end: new THREE.Color('#123a70') },
  earth: { core: new THREE.Color('#b59a72'), hot: new THREE.Color('#d6c3a0'), mid: new THREE.Color('#8b7350'), end: new THREE.Color('#4a3c2a') },
  air: { core: new THREE.Color(2, 2.2, 2.4), hot: new THREE.Color('#ffffff'), mid: new THREE.Color('#dfe9f2'), end: new THREE.Color('#9fb3c6') },
  hit: { core: new THREE.Color(3, 3, 3), hot: new THREE.Color('#ffffff'), mid: new THREE.Color('#ffe9b0'), end: new THREE.Color('#ffb060') },
} as const;
export type Palette = (typeof PALETTE)[keyof typeof PALETTE];

/** Element-flavoured effect helpers on top of the two particle pools. */
export class Vfx {
  readonly group = new THREE.Group();
  private glow = new ParticlePool(6000, true);
  private dust = new ParticlePool(2500, false);

  constructor() {
    this.group.add(this.glow.sprite, this.dust.sprite);
    this.group.name = 'VFX';
  }

  update(dt: number): void {
    this.glow.update(dt);
    this.dust.update(dt);
  }

  get count(): number {
    return this.glow.alive + this.dust.alive;
  }

  private pool(p: Palette) {
    return p === PALETTE.earth ? this.dust : this.glow;
  }

  /** Continuous trail behind a moving thing (call every frame). */
  trail(p: Palette, pos: THREE.Vector3, dir: THREE.Vector3, size: number, dt: number, rate = 120): void {
    const n = Math.max(1, Math.round(rate * dt * (0.5 + Math.random())));
    for (let i = 0; i < n; i++) {
      this.pool(p).emit({
        pos: tmpV.set(pos.x + rnd(-1, 1) * size * 0.3, pos.y + rnd(-1, 1) * size * 0.3, pos.z + rnd(-1, 1) * size * 0.3).clone(),
        vel: new THREE.Vector3(rnd(-1, 1), rnd(0, 1.5), rnd(-1, 1)).addScaledVector(dir, -2),
        life: rnd(0.25, 0.5),
        size: [size * rnd(0.9, 1.4), size * 0.2],
        color: p.hot,
        colorEnd: p.end,
        alpha: [0.9, 0],
        drag: 2,
        gravity: p === PALETTE.fire ? 2 : p === PALETTE.earth ? -6 : 0,
      });
    }
  }

  burst(p: Palette, pos: THREE.Vector3, count: number, speed: number, size: number, life = 0.6): void {
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(-0.2, 1), rnd(-1, 1)).normalize().multiplyScalar(speed * rnd(0.3, 1));
      this.pool(p).emit({
        pos: pos.clone(),
        vel: v,
        life: life * rnd(0.6, 1.2),
        size: [size * rnd(0.6, 1.3), size * 0.1],
        color: i % 3 === 0 ? p.hot : p.mid,
        colorEnd: p.end,
        alpha: [1, 0],
        drag: 3,
        gravity: p === PALETTE.fire ? 3 : p === PALETTE.earth ? -12 : -1,
      });
    }
  }

  /** Particles around a horizontal circle (rings, quake waves). */
  ring(p: Palette, center: THREE.Vector3, radius: number, count: number, up = 2, size = 0.6): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * rnd(0.85, 1.05);
      this.pool(p).emit({
        pos: new THREE.Vector3(center.x + Math.cos(a) * r, center.y + rnd(0, 0.4), center.z + Math.sin(a) * r),
        vel: new THREE.Vector3(0, up * rnd(0.5, 1.2), 0),
        life: rnd(0.4, 0.8),
        size: [size * rnd(0.8, 1.4), size * 0.2],
        color: p.hot,
        colorEnd: p.end,
        alpha: [0.9, 0],
        drag: 1,
        gravity: p === PALETTE.earth ? -8 : 0.5,
      });
    }
  }

  /** Spiral column (tornado, vortex). */
  swirl(p: Palette, center: THREE.Vector3, radius: number, height: number, count: number, time: number): void {
    for (let i = 0; i < count; i++) {
      const h = Math.random();
      const a = time * 6 + h * 12 + Math.random() * 0.6;
      const r = radius * (0.3 + h * 0.8);
      this.glow.emit({
        pos: new THREE.Vector3(center.x + Math.cos(a) * r, center.y + h * height, center.z + Math.sin(a) * r),
        vel: new THREE.Vector3(-Math.sin(a) * 6, 1.5, Math.cos(a) * 6),
        life: rnd(0.3, 0.6),
        size: [0.7, 0.2],
        color: p.mid,
        colorEnd: p.end,
        alpha: [0.6, 0],
        drag: 1,
      });
    }
  }

  /** Cone spray (breath, surge). */
  cone(p: Palette, origin: THREE.Vector3, dir: THREE.Vector3, range: number, angleDeg: number, count: number): void {
    const spread = Math.tan(THREE.MathUtils.degToRad(angleDeg) / 2);
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    for (let i = 0; i < count; i++) {
      const v = dir.clone().addScaledVector(right, rnd(-1, 1) * spread).addScaledVector(up, rnd(-0.6, 0.6) * spread).normalize();
      const speed = range / 0.5;
      this.glow.emit({
        pos: origin.clone(),
        vel: v.multiplyScalar(speed * rnd(0.7, 1.1)),
        life: rnd(0.35, 0.55),
        size: [0.3, 1.6],
        color: p.hot,
        colorEnd: p.end,
        alpha: [1, 0],
        drag: 1.5,
        gravity: p === PALETTE.fire ? 3 : -2,
      });
    }
  }
}
