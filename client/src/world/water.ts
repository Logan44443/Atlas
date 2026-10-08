import * as THREE from 'three/webgpu';
import worldData from '@data/world.json';
import { createWaterMaterial } from './materials';

/** Infinite-looking stylized sea: a big plane that follows the camera. */
export class Water {
  readonly mesh: THREE.Mesh;
  constructor() {
    const geo = new THREE.PlaneGeometry(6000, 6000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, createWaterMaterial());
    this.mesh.position.y = worldData.seaLevel;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'Water';
  }
  follow(p: THREE.Vector3): void {
    this.mesh.position.x = Math.round(p.x / 64) * 64;
    this.mesh.position.z = Math.round(p.z / 64) * 64;
  }
}
