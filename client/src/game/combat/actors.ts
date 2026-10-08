import * as THREE from 'three/webgpu';
import characterData from '@data/character.json';
import combatData from '@data/combat.json';
import type { ElementId } from '@shared/combat';
import { Combatant, CFG } from './combatant';
import type { Player } from '../player';
import type { CombatSystem } from './combatSystem';
import { TOON_RAMP } from '../../world/materials';

const CAP = characterData.capsule;

export class PlayerCombatant extends Combatant {
  private _center = new THREE.Vector3();
  private _feet = new THREE.Vector3();

  constructor(readonly player: Player, name: string, element: ElementId) {
    super('player', name, 'player', element, CFG.health);
  }
  get center() {
    return this._center.copy(this.player.renderPos).setY(this.player.renderPos.y + 1.1);
  }
  get feet() {
    return this._feet.copy(this.player.renderPos);
  }
  get radius() {
    return CAP.radius + 0.1;
  }
  get height() {
    return (CAP.halfHeight + CAP.radius) * 2;
  }
  get grounded() {
    return this.player.grounded;
  }
  knockback(impulse: THREE.Vector3) {
    this.player.knockback(impulse);
  }
  isInvulnerable() {
    if (!this.player.isDodging) return false;
    const t = this.player.dodgeProgress * characterData.dodge.duration;
    return t >= CFG.dodgeInvulnerable[0] && t <= CFG.dodgeInvulnerable[1];
  }
  /** Push status effects into the movement controller. */
  sync(): void {
    this.player.moveScale = this.moveScale;
    this.player.rooted = this.has('root');
    this.player.staggered = this.has('stagger');
  }
}

interface DummyDef {
  id: string;
  name: string;
  hp: number;
  offset: number[];
  attacks: boolean;
  attackEvery?: number;
  attackDamage?: number;
  attackSpeed?: number;
}

/** Straw training dummy on a post. Can be knocked about, respawns after "death". */
export class Dummy extends Combatant {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private home = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private _center = new THREE.Vector3();
  private respawnT = 0;
  private attackT: number;
  private wobble = 0;
  private glow: THREE.Mesh | null = null;
  readonly hpBar: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; sprite: THREE.Sprite };

  constructor(readonly def: DummyDef, home: THREE.Vector3, private groundAt: (x: number, z: number) => number) {
    super(def.id, def.name, 'enemy', null, def.hp);
    this.home.copy(home);
    this.pos.copy(home);
    this.attackT = def.attackEvery ?? 3;
    const m = (c: string) => new THREE.MeshToonNodeMaterial({ color: c, gradientMap: TOON_RAMP });
    const wood = m('#7a5534');
    const straw = m(def.attacks ? '#c9763a' : '#d8c27a');
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.9, 6), wood);
    post.position.y = 0.95;
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.55, 4, 10), straw);
    torso.position.y = 1.25;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), straw);
    head.position.y = 1.95;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 6), wood);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 1.5;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.08, 10), m(def.attacks ? '#3a2a20' : '#a33'));
    band.position.y = 1.2;
    this.body.add(torso, head, bar, band);
    if (def.attacks) {
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
    this.hpBar = { canvas, tex, sprite };
    this.drawBar();
    this.root.name = `dummy ${def.id}`;
  }

  get center() {
    return this._center.copy(this.pos).setY(this.pos.y + 1.3);
  }
  get feet() {
    return this.pos;
  }
  get radius() {
    return 0.4;
  }
  get height() {
    return 2.2;
  }
  knockback(impulse: THREE.Vector3) {
    this.vel.add(impulse.clone().setY(0).multiplyScalar(0.6));
    this.wobble = Math.min(1, this.wobble + impulse.length() * 0.08);
  }

  private lastHp = -1;
  drawBar(): void {
    if (this.lastHp === this.hp) return;
    this.lastHp = this.hp;
    const c = this.hpBar.canvas.getContext('2d')!;
    c.clearRect(0, 0, 128, 32);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(4, 10, 120, 12);
    c.fillStyle = this.hp / this.maxHp > 0.3 ? '#e2503c' : '#ff8a3c';
    c.fillRect(6, 12, 116 * (this.hp / this.maxHp), 8);
    this.hpBar.tex.needsUpdate = true;
  }

  update(dt: number, combat: CombatSystem, target: Combatant | null): void {
    if (this.dead) {
      this.respawnT += dt;
      this.root.visible = this.respawnT < 0.6;
      this.body.rotation.x = Math.min(Math.PI / 2, this.respawnT * 4);
      if (this.respawnT >= combatData.dummyRespawnSeconds) {
        this.dead = false;
        this.respawnT = 0;
        this.hp = this.maxHp;
        this.statuses.clear();
        this.pos.copy(this.home);
        this.vel.set(0, 0, 0);
        this.body.rotation.set(0, 0, 0);
        this.root.visible = true;
      }
      this.drawBar();
      return;
    }
    // Slide back toward the post's home spot after knockback.
    if (!this.has('root')) this.pos.addScaledVector(this.vel, dt);
    this.vel.multiplyScalar(Math.exp(-dt * 4));
    this.pos.lerp(tmpHome(this.home), 1 - Math.exp(-dt * 0.8));
    this.pos.y = this.groundAt(this.pos.x, this.pos.z);
    this.root.position.copy(this.pos);
    this.wobble *= Math.exp(-dt * 3);
    this.body.rotation.z = Math.sin(combat.time * 14) * this.wobble * 0.35;
    if (this.has('stagger')) this.body.rotation.x = Math.sin(combat.time * 20) * 0.1;

    if (this.def.attacks && target && !target.dead && !this.has('stagger') && !this.has('root')) {
      const toT = new THREE.Vector3().subVectors(target.feet, this.pos);
      const dist = toT.length();
      this.root.rotation.y = Math.atan2(toT.x, toT.z);
      if (dist < 30) {
        this.attackT -= dt;
        // Visible wind-up so players can learn to time a perfect block.
        const windup = 0.7;
        if (this.glow) this.glow.scale.setScalar(this.attackT < windup ? 0.2 + (1 - this.attackT / windup) * 1.6 : 0.01);
        if (this.attackT <= 0) {
          this.attackT = this.def.attackEvery ?? 3;
          const from = this.center.clone().add(new THREE.Vector3(0, 0.2, 0));
          const dir = target.center.clone().sub(from).normalize();
          combat.spawnProjectile(
            this,
            { slot: 'basic', id: 'dummy_bolt', name: 'Dummy Bolt', kind: 'projectile', damage: this.def.attackDamage ?? 10, chiCost: 0, cooldown: 0, range: 34, speed: this.def.attackSpeed ?? 18, radius: 0.35, vfx: 'fire_bolt', anim: '' },
            'fire',
            from,
            dir,
            1,
          );
        }
      } else if (this.glow) this.glow.scale.setScalar(0.01);
    }
    this.drawBar();
  }
}

const _h = new THREE.Vector3();
function tmpHome(h: THREE.Vector3) {
  return _h.copy(h);
}
