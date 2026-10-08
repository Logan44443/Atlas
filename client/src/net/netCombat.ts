import * as THREE from 'three/webgpu';
import { Client, type Room } from 'colyseus.js';
import type { ElementId, Slot, StatusType } from '@shared/combat';
import { createEntity, setMods, type SimEntity, type SimEvent } from '@shared/sim/combatSim';
import { NET, ROOM_NAME, type CorrectMsg, type InviteMsg, type JoinOptions, type MoveMsg, type PartyInfo, type V3, type WelcomeMsg, type XpMsg } from '@shared/net';
import { computeMods, newProgress, type Progress } from '@shared/progression';
import { applyArtsToEntity, createPlayerEntity, PLAYER_SHAPE, type CombatHost, type QuestLine, type XpGain } from '../game/combat/host';
import { sideOf } from '@shared/factions';

/** What the client reads from a replicated entity (see server/schema.ts). */
interface EntityStateView {
  id: string;
  name: string;
  kind: string;
  team: string;
  el: string;
  lv: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  chi: number;
  maxChi: number;
  dead: boolean;
  blk: boolean;
  st: string;
  slow: number;
  sh: boolean;
  wu: number;
  pvp: boolean;
  fac: string;
  role: string;
  title: string;
}

interface WorldStateView {
  shard: string;
  entities: { forEach(cb: (v: EntityStateView, k: string) => void): void; get(k: string): EntityStateView | undefined };
}

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Remote {
  entity: SimEntity;
  samples: Sample[];
}

export function defaultServerUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname || 'localhost'}:${NET.port}`;
}

const SHIELD_STUB = { remaining: 1, reduction: 0, blocksProjectiles: false, reflects: false, radius: 1, element: 'air' as ElementId };

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Online play: combat runs on the shard server. This mirrors the entities the
 * server lets us see (interest area), interpolates remote movement about
 * 100 ms behind, sends our predicted position and forwards cast requests.
 */
export class NetCombat implements CombatHost {
  readonly online = true;
  readonly entities = new Map<string, SimEntity>();
  readonly me: SimEntity;
  time = 0;
  shard: string;
  /** Server clock minus local clock, ms (from ping/pong). */
  clockOffset = 0;
  rtt = 0;
  private remotes = new Map<string, Remote>();
  private queue: SimEvent[] = [];
  private sendT = 0;
  private seq = 0;
  private pingT = 0;
  private closed = false;
  corrections: CorrectMsg[] = [];
  notices: Array<{ text: string; warn?: boolean }> = [];
  onClose: (() => void) | null = null;
  progress: Progress = newProgress();
  readonly xpLog: XpGain[] = [];
  party: PartyInfo | null = null;
  readonly invites: InviteMsg[] = [];
  readonly questLines: QuestLine[] = [];

  private constructor(
    readonly room: Room<WorldStateView>,
    welcome: WelcomeMsg,
    name: string,
    element: ElementId,
    private player: { swimming: boolean },
  ) {
    this.shard = welcome.shard;
    this.clockOffset = welcome.serverTime - Date.now();
    this.me = createPlayerEntity(welcome.id, name, element);
    this.me.pos.set(...welcome.spawn);
    this.entities.set(this.me.id, this.me);

    room.onMessage('ev', (evs: SimEvent[]) => this.queue.push(...evs));
    room.onMessage('imp', (v: V3) => this.me.pendingImpulse.add(new THREE.Vector3(v[0], v[1], v[2])));
    room.onMessage('correct', (m: CorrectMsg) => this.corrections.push(m));
    room.onMessage('notice', (m: { text: string; warn?: boolean }) => this.notices.push(m));
    room.onMessage('xp', (m: XpMsg) => {
      this.applyProgress(m.progress);
      this.xpLog.push({ amount: m.amount, reason: m.reason, levelUp: m.levelUp });
    });
    room.onMessage('progress', (p: Progress) => this.applyProgress(p));
    room.onMessage('party', (p: PartyInfo | null) => {
      this.party = p;
      this.me.party = p?.id ?? '';
    });
    room.onMessage('invite', (m: InviteMsg) => this.invites.push(m));
    room.onMessage('quest', (m: QuestLine) => this.questLines.push(m));
    room.onMessage('pong', (m: { t: number; s: number }) => {
      const now = Date.now();
      this.rtt = now - m.t;
      this.clockOffset = m.s + this.rtt / 2 - now;
    });
    room.onStateChange((s) => this.onState(s));
    room.onLeave(() => {
      this.closed = true;
      this.onClose?.();
    });
    this.onState(room.state);
  }

  /** Join (or create) a shard. Rejects if no server answers within the timeout. */
  static async connect(
    url: string,
    opts: JoinOptions,
    who: { name: string; element: ElementId; faction: string },
    player: { swimming: boolean },
    shardId?: string | null,
  ): Promise<NetCombat> {
    const client = new Client(url);
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no shard server answered')), NET.connectTimeoutMs));
    const room = (await Promise.race([shardId ? client.joinById<WorldStateView>(shardId, opts) : client.joinOrCreate<WorldStateView>(ROOM_NAME, opts), timeout])) as Room<WorldStateView>;
    const welcome = await Promise.race([
      new Promise<WelcomeMsg>((res) => room.onMessage('welcome', res)),
      timeout,
    ]);
    const net = new NetCombat(room, welcome, who.name, who.element, player);
    net.me.faction = who.faction;
    net.me.side = sideOf(who.faction) ?? '';
    net.me.level = welcome.level;
    net.applyProgress(welcome.progress);
    return net;
  }

  get serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  get connected(): boolean {
    return !this.closed;
  }

  leave(): void {
    this.closed = true;
    this.room.leave();
  }

  cast(slot: Slot, dir: THREE.Vector3): void {
    if (this.closed) return;
    this.room.send('cast', { slot, dir: [dir.x, dir.y, dir.z] });
  }

  teleport(x: number, y: number, z: number): void {
    if (!this.closed) this.room.send('tp', [x, y, z]);
  }

  setPvp(on: boolean): void {
    if (!this.closed) this.room.send('pvp', on);
  }

  /** The server's word on level/XP/mastery. Mods are mirrored so predicted cooldowns match. */
  private applyProgress(p: Progress): void {
    this.progress = p;
    this.me.level = p.level;
    setMods(this.me, computeMods(this.me.element, p.mastery));
    applyArtsToEntity(this.me, p);
  }

  talkTo(npcId: string): void {
    if (!this.closed) this.room.send('quest:talk', npcId);
  }
  equipArt(id: string | null): void {
    if (!this.closed) this.room.send('art:equip', id);
  }
  /** Dev shards only: XP and clock shifts for tests. */
  devXp(amount: number): void {
    if (!this.closed) this.room.send('dev:xp', amount);
  }
  devClock(hours: number): void {
    if (!this.closed) this.room.send('dev:clock', hours);
  }

  setMastery(alloc: Record<string, number>): void {
    if (!this.closed) this.room.send('mastery', alloc);
  }
  respec(): void {
    if (!this.closed) this.room.send('respec');
  }
  invite(entityId: string): void {
    if (!this.closed) this.room.send('party:invite', entityId);
  }
  answerInvite(accept: boolean): void {
    if (!this.closed) this.room.send(accept ? 'party:accept' : 'party:decline');
  }
  leaveParty(): void {
    if (!this.closed) this.room.send('party:leave');
  }
  kick(entityId: string): void {
    if (!this.closed) this.room.send('party:kick', entityId);
  }

  private onState(s: WorldStateView): void {
    const now = performance.now();
    const seen = new Set<string>();
    s.entities.forEach((st, id) => {
      seen.add(id);
      if (id === this.me.id) {
        this.applyCommon(this.me, st);
        return;
      }
      let r = this.remotes.get(id);
      if (!r) {
        const e =
          st.kind === 'player'
            ? createPlayerEntity(id, st.name, (st.el || null) as ElementId | null)
            : st.kind === 'npc'
              ? createEntity({ id, name: st.name, kind: 'npc', team: st.team, role: st.role, title: st.title, element: (st.el || null) as ElementId | null, ...PLAYER_SHAPE })
              : createEntity({ id, name: st.name, kind: 'dummy', team: st.team, radius: 0.4, height: 2.2 });
        e.pos.set(st.x, st.y, st.z);
        e.yaw = st.yaw;
        r = { entity: e, samples: [] };
        this.remotes.set(id, r);
        this.entities.set(id, e);
      }
      const last = r.samples[r.samples.length - 1];
      if (!last || last.x !== st.x || last.y !== st.y || last.z !== st.z || last.yaw !== st.yaw) {
        // Starting to move after standing still: re-anchor the old position one
        // patch ago so we don't slide across the whole idle gap.
        const patch = 1000 / NET.patchRate;
        if (last && now - last.t > patch * 2) r.samples.push({ ...last, t: now - patch });
        r.samples.push({ t: now, x: st.x, y: st.y, z: st.z, yaw: st.yaw });
        if (r.samples.length > 30) r.samples.shift();
      }
      this.applyCommon(r.entity, st);
      r.entity.blocking = st.blk;
      r.entity.windup = st.wu;
      if (st.kind !== 'dummy' && st.el) r.entity.element = st.el as ElementId;
      if (st.kind === 'player') Object.assign(r.entity, PLAYER_SHAPE);
    });
    for (const id of [...this.remotes.keys()]) {
      if (!seen.has(id)) {
        this.remotes.delete(id);
        this.entities.delete(id);
      }
    }
  }

  private applyCommon(e: SimEntity, st: EntityStateView): void {
    e.name = st.name;
    e.team = st.team;
    e.level = st.lv;
    e.hp = st.hp;
    e.maxHp = st.maxHp;
    e.chi = st.chi;
    e.maxChi = st.maxChi;
    e.dead = st.dead;
    e.pvp = st.pvp;
    e.faction = st.fac;
    e.side = sideOf(st.fac) ?? '';
    e.shield = st.sh ? (e.shield ?? { ...SHIELD_STUB }) : null;
    const want = st.st ? (st.st.split(',') as StatusType[]) : [];
    for (const k of [...e.statuses.keys()]) if (!want.includes(k)) e.statuses.delete(k);
    for (const k of want) {
      const cur = e.statuses.get(k);
      const amount = k === 'slow' ? st.slow : 0;
      if (cur) cur.amount = amount;
      else e.statuses.set(k, { type: k, remaining: 1, dps: 0, amount, tickAcc: 0, source: null });
    }
  }

  update(dt: number, aim: THREE.Vector3): SimEvent[] {
    this.time += dt;
    // Remote entities: render NET.interpolationDelayMs in the past, between two snapshots.
    const rt = performance.now() - NET.interpolationDelayMs;
    for (const r of this.remotes.values()) {
      const s = r.samples;
      if (!s.length) continue;
      let i = s.length - 1;
      while (i > 0 && s[i].t > rt) i--;
      const a = s[i];
      const b = s[i + 1];
      const e = r.entity;
      if (b && b.t > a.t) {
        const k = Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t)));
        e.pos.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
        e.yaw = lerpAngle(a.yaw, b.yaw, k);
      } else {
        e.pos.set(a.x, a.y, a.z);
        e.yaw = a.yaw;
      }
      // Drop samples we'll never interpolate from again.
      while (s.length > 2 && s[1].t < rt) s.shift();
    }

    this.sendT += dt;
    if (!this.closed && this.sendT >= 1 / NET.moveSendRate) {
      this.sendT = 0;
      const m = this.me;
      const msg: MoveMsg = {
        seq: ++this.seq,
        p: [+m.pos.x.toFixed(3), +m.pos.y.toFixed(3), +m.pos.z.toFixed(3)],
        yaw: +m.yaw.toFixed(3),
        aim: [+aim.x.toFixed(3), +aim.y.toFixed(3), +aim.z.toFixed(3)],
        blk: m.blocking,
        inv: m.invulnerable,
        gr: m.grounded,
        sw: this.player.swimming,
      };
      this.room.send('move', msg);
    }
    this.pingT -= dt;
    if (!this.closed && this.pingT <= 0) {
      this.pingT = 2;
      this.room.send('ping', Date.now());
    }
    const out = this.queue;
    this.queue = [];
    return out;
  }
}
