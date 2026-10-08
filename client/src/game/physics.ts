import RAPIER from '@dimforge/rapier3d-compat';
import { CHUNK_SAMPLES, chunkKey } from '@shared/world';
import characterData from '@data/character.json';
import type { Obstacle } from '@shared/props';

export { RAPIER };

/**
 * Rapier world. Terrain colliders exist only for near-ring chunks (added and
 * removed by the streamer's hooks), which keeps the broadphase small.
 */
export class Physics {
  readonly world: RAPIER.World;
  private terrain = new Map<string, RAPIER.Collider>();
  /** tree trunks and boulders of near chunks */
  private props = new Map<string, RAPIER.Collider[]>();

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: characterData.gravity, z: 0 });
  }

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  addTerrainChunk(cx: number, cz: number, size: number, heights: Float32Array): void {
    const key = chunkKey(cx, cz);
    if (this.terrain.has(key)) return;
    const n = CHUNK_SAMPLES;
    // Rapier wants column-major with rows along Z.
    const cm = new Float32Array(n * n);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) cm[x * n + z] = heights[z * n + x];
    const desc = RAPIER.ColliderDesc.heightfield(n - 1, n - 1, cm, { x: size, y: 1, z: size })
      .setTranslation(cx * size + size / 2, 0, cz * size + size / 2)
      .setFriction(0.8);
    this.terrain.set(key, this.world.createCollider(desc));
  }

  removeTerrainChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    for (const p of this.props.get(key) ?? []) this.world.removeCollider(p, false);
    this.props.delete(key);
    const c = this.terrain.get(key);
    if (!c) return;
    this.world.removeCollider(c, false);
    this.terrain.delete(key);
  }

  /** Trees and rocks are solid: one upright cylinder per trunk or boulder. */
  addPropChunk(cx: number, cz: number, obstacles: Obstacle[]): void {
    const key = chunkKey(cx, cz);
    if (this.props.has(key)) return;
    this.props.set(
      key,
      obstacles.map((o) =>
        this.world.createCollider(RAPIER.ColliderDesc.cylinder(o.height / 2, o.radius).setTranslation(o.x, o.y + o.height / 2, o.z).setFriction(0.4)),
      ),
    );
  }

  get propColliderCount(): number {
    let n = 0;
    for (const l of this.props.values()) n += l.length;
    return n;
  }

  /** Static box (walls, buildings), rotated by `yaw` around Y. */
  addStaticBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setFriction(0.6);
    return this.world.createCollider(desc);
  }

  removeCollider(c: RAPIER.Collider): void {
    this.world.removeCollider(c, false);
  }

  hasTerrainAt(x: number, z: number, size: number): boolean {
    return this.terrain.has(chunkKey(Math.floor(x / size), Math.floor(z / size)));
  }

  get terrainColliderCount(): number {
    return this.terrain.size;
  }

  /** First hit distance along a ray, ignoring `exclude`. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, exclude?: RAPIER.Collider): number | null {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRay(ray, maxDist, true, undefined, undefined, exclude);
    return hit ? hit.timeOfImpact : null;
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }
}
