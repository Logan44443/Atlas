import * as THREE from 'three/webgpu';
import type { Input } from './input';

/** Free-roam camera used before the character exists (and as a debug camera). */
export class FlyCamera {
  yaw = -0.6;
  pitch = -0.25;
  speed = 18;

  constructor(private camera: THREE.PerspectiveCamera, private input: Input, private groundAt: (x: number, z: number) => number) {}

  update(dt: number): void {
    const i = this.input;
    if (i.buttons || i.pointerLocked) {
      this.yaw -= i.mouseDX * 0.0025;
      this.pitch = THREE.MathUtils.clamp(this.pitch - i.mouseDY * 0.0025, -1.45, 1.45);
    }
    if (i.wheel) this.speed = THREE.MathUtils.clamp(this.speed * (i.wheel > 0 ? 0.8 : 1.25), 2, 400);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const v = new THREE.Vector3();
    if (i.isDown('KeyW')) v.add(fwd);
    if (i.isDown('KeyS')) v.sub(fwd);
    if (i.isDown('KeyD')) v.add(right);
    if (i.isDown('KeyA')) v.sub(right);
    if (i.isDown('KeyE') || i.isDown('Space')) v.y += 1;
    if (i.isDown('KeyQ') || i.isDown('ControlLeft')) v.y -= 1;
    const boost = i.isDown('ShiftLeft') ? 4 : 1;
    if (v.lengthSq() > 0) this.camera.position.addScaledVector(v.normalize(), this.speed * boost * dt);
    const ground = this.groundAt(this.camera.position.x, this.camera.position.z);
    this.camera.position.y = Math.max(this.camera.position.y, Math.max(ground, 0) + 1.5);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
