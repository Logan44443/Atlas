import * as THREE from 'three/webgpu';
import characterData from '@data/character.json';
import controlsData from '@data/controls.json';
import worldData from '@data/world.json';
import artsData from '@data/arts.json';
import { RAPIER, type Physics } from './physics';
import type { Controls } from '../engine/settings';
import type { AvatarPose } from './avatar';

const C = characterData;
const FIXED_DT = 1 / 60;

/**
 * Third-person character on a Rapier kinematic character controller.
 * Runs at a fixed 60 Hz; render position is interpolated between steps.
 * (Later the server becomes authoritative and this turns into client-side prediction.)
 */
export class Player {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private kcc: RAPIER.KinematicCharacterController;
  readonly velocity = new THREE.Vector3();
  grounded = false;
  swimming = false;
  facing = 0; // yaw radians
  private prev = new THREE.Vector3();
  private curr = new THREE.Vector3();
  private acc = 0;
  private coyote = 0;
  private jumpBuffer = 0;
  private dodgeT = 0;
  private dodgeCd = 0;
  private dodgeDir = new THREE.Vector3();
  blocking = false;
  /** Set by combat statuses. */
  moveScale = 1;
  rooted = false;
  staggered = false;
  // Special Arts movement (Phase 8).
  /** Glider learned: jump in the air opens it. */
  canGlide = false;
  gliding = false;
  /** Seconds of flight left. */
  private flyT = 0;
  /** Spirit projection: the body stays put. */
  frozen = false;
  private dashT = 0;
  private dashVel = new THREE.Vector3();
  private faceYaw: number | null = null;
  private faceT = 0;
  /** Feet position for rendering (interpolated). */
  readonly renderPos = new THREE.Vector3();
  private readonly centerOffset = C.capsule.halfHeight + C.capsule.radius;

  constructor(
    private physics: Physics,
    private controls: Controls,
    spawn: THREE.Vector3,
    private groundAt: (x: number, z: number) => number,
    private chunkSize: number,
  ) {
    const w = physics.world;
    const y = spawn.y + this.centerOffset + 0.05;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, y, spawn.z));
    this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(C.capsule.halfHeight, C.capsule.radius), this.body);
    this.kcc = w.createCharacterController(0.02);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.enableAutostep(C.stepHeight, 0.2, false);
    this.kcc.enableSnapToGround(C.snapToGround);
    this.kcc.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(C.maxSlopeDegrees));
    this.kcc.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(C.maxSlopeDegrees + 5));
    this.kcc.setSlideEnabled(true);
    this.curr.set(spawn.x, y, spawn.z);
    this.prev.copy(this.curr);
    this.renderPos.set(spawn.x, spawn.y, spawn.z);
  }

  /** Flight art: fly freely for `seconds` (0 lands). */
  fly(seconds: number): void {
    this.flyT = seconds;
    if (seconds > 0) this.gliding = false;
  }

  get flying(): boolean {
    return this.flyT > 0;
  }

  get flightLeft(): number {
    return this.flyT;
  }

  /** Ability movement: dash `distance` along `dir` over `duration`, optionally launching upward. */
  dash(dir: THREE.Vector3, distance: number, duration: number, lift = 0): void {
    this.dashT = duration;
    this.dashVel.copy(dir).setY(0).normalize().multiplyScalar(distance / duration);
    if (lift > 0) {
      this.velocity.y = lift;
      this.grounded = false;
    }
  }
  get isDashing(): boolean {
    return this.dashT > 0;
  }

  knockback(impulse: THREE.Vector3): void {
    this.velocity.x += impulse.x;
    this.velocity.z += impulse.z;
    this.velocity.y = Math.max(this.velocity.y, impulse.y);
    if (impulse.y > 0) this.grounded = false;
    this.gliding = false;
  }

  /** Turn to face `yaw` for a moment (casting toward the aim point). */
  faceFor(yaw: number, seconds: number): void {
    this.faceYaw = yaw;
    this.faceT = seconds;
  }

  get dodgeProgress(): number {
    return this.dodgeT > 0 ? 1 - this.dodgeT / C.dodge.duration : 0;
  }
  get isDodging(): boolean {
    return this.dodgeT > 0;
  }

  /** World position of the capsule centre (latest physics step). */
  get position(): THREE.Vector3 {
    return this.curr;
  }

  teleport(x: number, z: number): void {
    const y = Math.max(this.groundAt(x, z), worldData.seaLevel) + this.centerOffset + 0.1;
    this.body.setTranslation({ x, y, z }, true);
    this.curr.set(x, y, z);
    this.prev.copy(this.curr);
    this.velocity.set(0, 0, 0);
  }

  update(frameDt: number, cameraYaw: number): void {
    // Edge-triggered inputs are sampled once per frame and consumed by the next step.
    if (this.controls.pressed('jump')) {
      // In the air with a glider: jump opens or closes it instead.
      if (this.canGlide && !this.grounded && this.coyote <= 0 && !this.swimming && !this.flying) this.gliding = !this.gliding;
      else this.jumpBuffer = C.jumpBuffer;
    }
    const dodgePressed =
      this.controls.pressed('dodge') ||
      (['moveForward', 'moveBack', 'moveLeft', 'moveRight'] as const).some((a) => this.controls.doubleTapped(a, controlsData.doubleTapDodgeSeconds));
    if (dodgePressed) this.tryDodge(cameraYaw);
    this.blocking = this.controls.down('block') && (this.grounded || this.coyote > 0) && !this.isDodging && !this.swimming;

    this.acc += Math.min(frameDt, 0.25);
    while (this.acc >= FIXED_DT) {
      this.prev.copy(this.curr);
      this.step(FIXED_DT, cameraYaw);
      this.acc -= FIXED_DT;
    }
    const a = this.acc / FIXED_DT;
    this.renderPos.lerpVectors(this.prev, this.curr, a);
    this.renderPos.y -= this.centerOffset;
  }

  private moveInput(cameraYaw: number): THREE.Vector3 {
    const f = (this.controls.down('moveForward') ? 1 : 0) - (this.controls.down('moveBack') ? 1 : 0);
    const r = (this.controls.down('moveRight') ? 1 : 0) - (this.controls.down('moveLeft') ? 1 : 0);
    const v = new THREE.Vector3();
    if (!f && !r) return v;
    const fwd = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    return v.addScaledVector(fwd, f).addScaledVector(right, r).normalize();
  }

  private tryDodge(cameraYaw: number): void {
    if (this.dodgeCd > 0 || this.isDodging || this.swimming || this.rooted || this.staggered || this.frozen) return;
    const dir = this.moveInput(cameraYaw);
    if (dir.lengthSq() === 0) dir.set(Math.sin(this.facing), 0, Math.cos(this.facing)).negate(); // backstep
    this.dodgeDir.copy(dir);
    this.dodgeT = C.dodge.duration;
    this.dodgeCd = C.dodge.cooldown + C.dodge.duration;
  }

  private step(dt: number, cameraYaw: number): void {
    const t = this.body.translation();
    const feetY = t.y - this.centerOffset;
    const groundHere = this.groundAt(t.x, t.z);
    const hasCollider = this.physics.hasTerrainAt(t.x, t.z, this.chunkSize);
    this.swimming = feetY < worldData.seaLevel - C.swim.depth + 0.05 && groundHere < worldData.seaLevel - C.swim.depth;

    const input = this.moveInput(cameraYaw);
    const sprint = this.controls.down('sprint');
    let speed = this.swimming ? C.swim.speed : sprint ? C.runSpeed : C.walkSpeed;
    if (this.blocking) speed *= 0.35;
    speed *= this.moveScale;
    if (this.rooted || this.staggered || this.frozen) speed = 0;
    if (this.flying) speed = artsData.flight.speed * this.moveScale;
    else if (this.gliding) speed = artsData.glider.speed * this.moveScale;
    const target = input.clone().multiplyScalar(speed);
    const accel = C.acceleration * (this.grounded || this.swimming || this.flying || this.gliding ? 1 : C.airControl);
    const hv = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    const dv = target.sub(hv);
    const maxDv = accel * dt;
    if (dv.length() > maxDv) dv.setLength(maxDv);
    hv.add(dv);

    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      // Fast start, eased end.
      const k = 1 - this.dodgeProgress;
      const v = (C.dodge.distance / C.dodge.duration) * (0.6 + k * 0.8);
      hv.copy(this.dodgeDir).multiplyScalar(v);
    }
    if (this.dashT > 0) {
      this.dashT -= dt;
      hv.copy(this.dashVel);
      if (this.dashT <= 0) hv.multiplyScalar(0.35);
    }
    // The body left behind by spirit projection drops straight down: no drift, no glider.
    if (this.frozen) {
      hv.set(0, 0, 0);
      this.gliding = false;
    }
    this.velocity.x = hv.x;
    this.velocity.z = hv.z;

    // Vertical.
    this.coyote = this.grounded ? C.coyoteTime : Math.max(0, this.coyote - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.grounded || this.swimming) this.gliding = false;
    if (this.flying) {
      // Flight: no gravity; jump climbs, sprint dives.
      this.flyT = Math.max(0, this.flyT - dt);
      const climb = artsData.flight.climb;
      this.velocity.y = this.controls.down('jump') ? climb : this.controls.down('sprint') ? -climb : 0;
      this.jumpBuffer = 0;
    } else if (this.swimming) {
      // Float with the head above the surface; jump to hop out onto a shore.
      const targetFeet = worldData.seaLevel - C.swim.depth;
      this.velocity.y = (targetFeet - feetY) * 6;
      if (this.jumpBuffer > 0) {
        this.velocity.y = C.jumpVelocity * 0.8;
        this.jumpBuffer = 0;
      }
    } else {
      if (this.jumpBuffer > 0 && this.coyote > 0 && !this.isDodging && !this.rooted && !this.staggered && !this.frozen) {
        this.velocity.y = C.jumpVelocity;
        this.jumpBuffer = 0;
        this.coyote = 0;
        this.grounded = false;
      }
      this.velocity.y = Math.max(this.velocity.y + C.gravity * dt, -C.maxFallSpeed);
      if (this.gliding) this.velocity.y = Math.max(this.velocity.y, -artsData.glider.fallSpeed);
      if (this.grounded && this.velocity.y < 0) this.velocity.y = -2;
    }

    const desired = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
    this.kcc.computeColliderMovement(this.collider, desired);
    const m = this.kcc.computedMovement();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.grounded = this.kcc.computedGrounded();
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;

    // Safety net: never end up under the terrain (streaming hiccups, tunnelling).
    const minY = this.groundAt(next.x, next.z) + this.centerOffset - 0.05;
    if (next.y < minY - 0.5 || (!hasCollider && next.y < minY)) {
      next.y = minY + 0.05;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.grounded = true;
    }
    this.body.setNextKinematicTranslation(next);
    this.curr.set(next.x, next.y, next.z);

    // Face the movement direction (or the camera while blocking).
    this.faceT = Math.max(0, this.faceT - dt);
    const faceTarget =
      this.faceT > 0 && this.faceYaw !== null
        ? this.faceYaw
        : this.blocking
          ? cameraYaw + Math.PI
          : hv.lengthSq() > 0.25
            ? Math.atan2(hv.x, hv.z)
            : this.facing;
    let d = faceTarget - this.facing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.facing += d * Math.min(1, C.turnSpeed * dt);

    this.physics.step(dt);
  }

  pose(): AvatarPose {
    return {
      speed: Math.hypot(this.velocity.x, this.velocity.z),
      grounded: this.grounded,
      vy: this.velocity.y,
      dodge: this.dodgeProgress,
      swimming: this.swimming || this.flying || this.gliding,
      blocking: this.blocking,
    };
  }
}
