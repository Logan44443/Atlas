// Wire protocol between the browser and a shard (WorldRoom).
import netData from '../data/net.json';
import type { Slot } from './combat';
import type { Progress } from './progression';
import type { SimEvent } from './sim/combatSim';

export const NET = netData;
export const ROOM_NAME = 'world';

export type V3 = [number, number, number];

/** Options sent with joinOrCreate / joinById. */
export interface JoinOptions {
  /** session token from the account API */
  token: string;
  characterId: string;
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
  characterId: string;
  faction: string;
  level: number;
  /** level, xp, mastery, discovered landmarks */
  progress: Progress;
}

/** Server -> client: XP gained (amount may be 0 with a reason, e.g. anti-griefing). */
export interface XpMsg {
  amount: number;
  reason: string;
  levelUp: number;
  progress: Progress;
}

export interface PartyMember {
  id: string;
  name: string;
  element: string;
  level: number;
  hp: number;
  maxHp: number;
  x: number;
  z: number;
  dead: boolean;
}

/** Server -> client: your party (sent on change and once a second), or null when you have none. */
export interface PartyInfo {
  id: string;
  leader: string;
  members: PartyMember[];
}

/** Server -> client: someone invited you to their party. */
export interface InviteMsg {
  from: string;
  name: string;
  expires: number;
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
