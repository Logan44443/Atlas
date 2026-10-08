// Factions, hubs and zones (DESIGN sections 4-5). Pure data helpers shared by
// client, server, workers and the world build.
import factionData from '../data/factions.json';
import zoneData from '../data/zones.json';
import worldData from '../data/world.json';
import type { TerrainConfig } from './terrain';

export type Side = 'order' | 'outlaw';
export type FactionId = 'sentinel' | 'lantern' | 'freeisles' | 'redfang' | 'ash' | 'hollowmoon';

export interface Hub {
  name: string;
  x: number;
  z: number;
  radius: number;
  safeRadius: number;
  style: 'fort' | 'temple' | 'harbor' | 'den';
}

export interface Faction {
  id: FactionId;
  name: string;
  side: Side;
  color: string;
  trim: string;
  emblem: string;
  identity: string;
  perk: { type: string; value: number; text: string };
  hub: Hub;
}

export interface ContestedZone {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  flatRadius: number;
}

export const FACTIONS = factionData.factions as Faction[];
export const SIDES = factionData.sides as Record<Side, { name: string; color: string }>;
export const CONTESTED = zoneData.contested as ContestedZone[];
export const PVP = zoneData.pvp;
export const NPC_CFG = factionData.npcs;

export const factionById = (id: string | null | undefined): Faction | undefined => FACTIONS.find((f) => f.id === id);
export const sideOf = (id: string | null | undefined): Side | null => factionById(id)?.side ?? null;

export type Zone =
  | { kind: 'safe'; name: string; faction: FactionId }
  | { kind: 'contested'; name: string; id: string }
  | { kind: 'wilds'; name: string };

export function zoneAt(x: number, z: number): Zone {
  for (const f of FACTIONS) {
    if (Math.hypot(x - f.hub.x, z - f.hub.z) <= f.hub.safeRadius) return { kind: 'safe', name: f.hub.name, faction: f.id };
  }
  for (const c of CONTESTED) {
    if (Math.hypot(x - c.x, z - c.z) <= c.radius) return { kind: 'contested', name: c.name, id: c.id };
  }
  return { kind: 'wilds', name: 'Wilds' };
}

export interface Flat {
  x: number;
  z: number;
  radius: number;
  blend: number;
}

/** Areas the terrain is levelled for: hub plazas and shrine platforms. */
export const FLATS: Flat[] = [
  ...FACTIONS.map((f) => ({ x: f.hub.x, z: f.hub.z, radius: f.hub.radius + 6, blend: 34 })),
  ...CONTESTED.map((c) => ({ x: c.x, z: c.z, radius: c.flatRadius, blend: 24 })),
];

/** world.json plus the flattened sites: what every TerrainSampler should be built from. */
export function terrainConfig(): TerrainConfig {
  return { ...(worldData as unknown as TerrainConfig), flats: FLATS };
}

/** A spawn point inside a faction's hub plaza (respawns and new characters). */
export function hubSpawn(faction: string, rand = Math.random): { x: number; z: number } {
  const f = factionById(faction) ?? FACTIONS[0];
  const a = rand() * Math.PI * 2;
  const r = 14 + rand() * 6;
  return { x: f.hub.x + Math.cos(a) * r * 0.5, z: f.hub.z + 18 + Math.sin(a) * r * 0.3 };
}
