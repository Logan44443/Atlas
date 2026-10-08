// Wire protocol between the browser and a shard (WorldRoom).
import netData from '../data/net.json';
import type { ElementId, Slot } from './combat';
import type { SimEvent } from './sim/combatSim';

export const NET = netData;
export const ROOM_NAME = 'world';

export type V3 = [number, number, number];

/** Options sent with joinOrCreate / joinById. */
export interface JoinOptions {
  name: string;
  element: ElementId;
}

/** Client -> server, ~20 Hz: where the predicted character is. */
export interface MoveMsg {
  seq: number;
  p: V3;
  yaw: number;
  /** aim direction, for channelled cones */
  aim: V3;
  blk: boolean;
  /** inside the dodge's invulnerable window */
  inv: boolean;
  gr: boolean;
  sw: boolean;
}

export interface CastMsg {
  slot: Slot;
  dir: V3;
}

/** Server -> client once after joining. */
export interface WelcomeMsg {
  id: string;
  shard: string;
  spawn: V3;
  serverTime: number;
  tickRate: number;
}

/** Server -> client: the move was rejected, snap back here. */
export interface CorrectMsg {
  seq: number;
  p: V3;
  reason: string;
}

/** Server -> client each tick: combat events near you. */
export type EventsMsg = SimEvent[];

/** Server -> client: knockback/pull to apply to your own character. */
export type ImpulseMsg = V3;

export const STATUS_CODES = ['burn', 'slow', 'root', 'stagger'] as const;
