// Wire protocol between the browser and a shard (WorldRoom).
import netData from '../data/net.json';
import type { Slot } from './combat';
import type { Progress } from './progression';
import type { SimEvent } from './sim/combatSim';
import type { PointState } from './territory';
import type { CrewRole } from './crews';
import type { Inventory } from './building';

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

// ---- Phase 11: territory, chat, crews, shop ------------------------------------------

/** Server -> client once a second: the territory war and who holds what. */
export interface TerrMsg {
  open: boolean;
  text: string;
  points: PointState[];
  /** crew halls standing on base plots (world map) */
  halls: Array<{ plot: string; tag: string; faction: string; x: number; z: number }>;
}

export type ChatChannel = 'say' | 'shard' | 'faction' | 'crew' | 'party' | 'whisper';

/** Client -> server. `to` = a character name for whispers. */
export interface ChatSend {
  ch: ChatChannel;
  text: string;
  to?: string;
}

/** Server -> client. */
export interface ChatMsg {
  ch: ChatChannel | 'system';
  from: string;
  text: string;
  faction?: string;
  tag?: string;
  /** whispers: who it went to */
  to?: string;
}

/** Client -> server: everything you can do in the crew panel. */
export type CrewAction =
  | { a: 'create'; name: string; tag: string }
  | { a: 'invite'; target: string }
  | { a: 'accept' }
  | { a: 'decline' }
  | { a: 'leave' }
  | { a: 'kick'; charId: string }
  | { a: 'role'; charId: string; role: CrewRole }
  | { a: 'raid'; hour: number }
  | { a: 'motd'; text: string }
  | { a: 'bank'; items: Inventory; put: boolean }
  | { a: 'coins'; n: number; put: boolean };

/** Server -> client: a crew wants you. */
export interface CrewInviteMsg {
  crew: string;
  name: string;
  tag: string;
  from: string;
  expires: number;
}

/** Client -> server: trade or travel with a Quartermaster (`npc`). */
export type ShopAction = { npc: string } & ({ a: 'buy'; item: string; n: number } | { a: 'sell'; item: string; n: number } | { a: 'pardon' } | { a: 'travel'; dest: string });

/** Server -> client: fast travel (or any server-side move): put the character here. */
export type WarpMsg = V3;
