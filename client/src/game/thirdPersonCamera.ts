import * as THREE from 'three/webgpu';
import characterData from '@data/character.json';
import type { Input } from '../engine/input';
import type { Settings } from '../engine/settings';
import type { Physics } from './physics';
import type { Player } from './player';

const C = characterData.camera;

/** Over-the-shoulder orbit camera with terrain collision. */
export class ThirdPersonCamera {
  yaw = Math.PI * 0.75;
  pitch = -0.25;
  distance = C.distance;
  private currentDist = C.distance;
  private pivot = new THREE.Vector3();
  private smoothedTarget = new THREE.Vector3();
  private first = true;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private settings: Settings,
    private physics: Physics,
    private groundAt: (x: number, z: number) => number,
  ) {
    camera.fov = C.fov;
    camera.updateProjectionMatrix();
  }

  update(dt: number, player: Player): void {
    const i = this.input;
    const sens = 0.0024 * this.settings.data.mouseSensitivity;
    const inv = this.settings.data.invertY ? -1 : 1;
    if (i.pointerLocked || i.isDown('Mouse2') || (i.isDown('Mouse0') && !i.pointerLocked)) {
      this.yaw -= i.mouseDX * sens;
      this.pitch = THREE.MathUtils.clamp(this.pitch - i.mouseDY * sens * inv, C.minPitch, C.maxPitch);
    }
    if (i.wheel) this.distance = THREE.MathUtils.clamp(this.distance * (i.wheel > 0 ? 1.12 : 0.89), C.minDistance, C.maxDistance);

    // Smooth the follow target a little so steps and bumps don't jolt the view.
    const target = player.renderPos;
    if (this.first) {
      this.smoothedTarget.copy(target);
      this.first = false;
    } else this.smoothedTarget.lerp(target, 1 - Math.exp(-dt * C.followLerp));
    this.smoothedTarget.x = target.x;
    this.smoothedTarget.z = target.z;

    const cp = Math.cos(this.pitch);
    const back = new THREE.Vector3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const shoulder = C.shoulder * THREE.MathUtils.clamp(this.distance / C.distance, 0.4, 1);
    this.pivot.copy(this.smoothedTarget).add(new THREE.Vector3(0, C.height, 0)).addScaledVector(right, shoulder);

    // Pull in when terrain is between the pivot and the camera; ease back out.
    let want = this.distance;
    const hit = this.physics.raycast(this.pivot.x, this.pivot.y, this.pivot.z, back.x, back.y, back.z, want + 0.3, player.collider);
    if (hit !== null) want = Math.max(0.6, hit - 0.3);
    this.currentDist = want < this.currentDist ? want : THREE.MathUtils.lerp(this.currentDist, want, 1 - Math.exp(-dt * 4));

    const pos = this.pivot.clone().addScaledVector(back, this.currentDist);
    const floor = Math.max(this.groundAt(pos.x, pos.z), 0) + 0.35;
    if (pos.y < floor) pos.y = floor;
    this.camera.position.copy(pos);
    this.camera.lookAt(this.pivot.x - back.x, this.pivot.y - back.y, this.pivot.z - back.z);
  }
}
