// World clock shared by client and server so day/night (and the element
// bonuses that depend on it) agree everywhere.
import timeData from '../data/time.json';
import type { ElementContext } from './combat';
import type { TerrainSampler } from './terrain';

/** Fixed epoch so every shard and client derives the same in-game time from wall time. */
const EPOCH_MS = Date.UTC(2026, 0, 1);

/** In-game days elapsed (fractional) at a wall-clock time. */
export function worldDays(nowMs: number): number {
  return timeData.startHour / 24 + (nowMs - EPOCH_MS) / (timeData.dayLengthMinutes * 60_000);
}

export const hourOf = (days: number) => (((days % 1) + 1) % 1) * 24;

/** 0 = new moon, 1 = full moon. */
export function moonPhaseOf(days: number): number {
  const p = (((days / timeData.moonCycleDays) % 1) + 1) % 1;
  return 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
}

/** Unit vector toward the sun. Travels east->west, tilted toward the south. */
export function sunDirOf(hour: number, out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
  const a = ((hour - 6) / 12) * Math.PI;
  const tilt = (timeData.sunTiltDegrees * Math.PI) / 180;
  const x = Math.cos(a);
  const y = Math.sin(a) * Math.cos(tilt);
  const z = Math.sin(a) * Math.sin(tilt);
  const l = Math.hypot(x, y, z);
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  return out;
}

/** 0 by day, 1 at full night. */
export function nightFactorOf(sunY: number): number {
  const t = Math.min(1, Math.max(0, (-sunY + 0.05) / 0.2));
  return t * t * (3 - 2 * t);
}

export interface ContextWorld {
  seaLevel: number;
  biomes: { rockSlope: number; grassMaxHeight: number };
}

/** Bending context (time of day, water nearby, standing on rock) at a spot. */
export function elementContextAt(
  sampler: TerrainSampler,
  world: ContextWorld,
  nearWaterMeters: number,
  pos: { x: number; y: number; z: number },
  days: number,
  swimming: boolean,
  grounded: boolean,
  groundAt: (x: number, z: number) => number = (x, z) => sampler.height(x, z),
): ElementContext {
  let nearWater = swimming;
  for (let k = 0; k < 8 && !nearWater; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (groundAt(pos.x + Math.cos(a) * nearWaterMeters, pos.z + Math.sin(a) * nearWaterMeters) < world.seaLevel) nearWater = true;
  }
  const ny = sampler.slopeY(pos.x, pos.z);
  const onRock = ny < world.biomes.rockSlope + 0.05 || pos.y > world.biomes.grassMaxHeight;
  const sun = sunDirOf(hourOf(days));
  return { night: nightFactorOf(sun.y), sunHeight: sun.y, moonPhase: moonPhaseOf(days), nearWater, onRock, grounded };
}

/** 0 by day, 1 at full night, at a world time (in-game days). */
export const nightAt = (days: number): number => nightFactorOf(sunDirOf(hourOf(days)).y);
