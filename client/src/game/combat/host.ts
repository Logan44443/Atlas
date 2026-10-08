import * as THREE from 'three/webgpu';
import type { Slot } from '@shared/combat';
import { CombatSim, createEntity, setMods, type SimEntity, type SimEvent } from '@shared/sim/combatSim';
import { XpRules, addXp, computeMods, newProgress, sanitizeAlloc, type Progress, type XpPlayer } from '@shared/progression';
import type { InviteMsg, PartyInfo } from '@shared/net';
import { spawnDummies, updateDummy, type DummyBrain } from '@shared/sim/dummies';
import { spawnNpcs, spawnMasters, updateNpc, type NpcBrain } from '@shared/sim/npcs';
import { QuestRules, sanitizeArts, equippedAbility, artById, ARTS, masterId, type QuestNews } from '@shared/arts';
import characterData from '@data/character.json';

/** Where combat rules run: in this tab (offline) or on the shard server (online). */
export interface CombatHost {
  readonly online: boolean;
  /** Everything that can be hit and that this client knows about. */
  readonly entities: Map<string, SimEntity>;
  readonly me: SimEntity;
  /** Authority clock (seconds). */
  readonly time: number;
  cast(slot: Slot, dir: THREE.Vector3): void;
  /** Called every frame after the local entity has been synced from the player controller. */
  update(dt: number, aim: THREE.Vector3): SimEvent[];

  // Progression (Phase 7). The authority decides; these are its latest answers.
  readonly progress: Progress;
  /** XP gains since the UI last drained them. */
  readonly xpLog: XpGain[];
  /** Messages for the player (zone HUD). */
  readonly notices: Array<{ text: string; warn?: boolean }>;
  setMastery(alloc: Record<string, number>): void;
  respec(): void;

  // Special Arts (Phase 8): talk to masters, equip a learned art.
  /** Masters' answers since the UI last drained them. */
  readonly questLines: QuestLine[];
  talkTo(npcId: string): void;
  equipArt(id: string | null): void;

  // Parties (online only).
  readonly party: PartyInfo | null;
  readonly invites: InviteMsg[];
  invite(entityId: string): void;
  answerInvite(accept: boolean): void;
  leaveParty(): void;
  kick(entityId: string): void;
}

export interface QuestLine {
  art: string;
  npc: string;
  line: string;
}

/** Push the art state into the entity (equipped ability, lightning redirect). */
export function applyArtsToEntity(e: SimEntity, p: Progress): void {
  e.art = equippedAbility(p.arts);
  e.canRedirect = p.arts.learned.includes('lightning');
}

export interface XpGain {
  amount: number;
  reason: string;
  levelUp: number;
}

const CAP = characterData.capsule;
export const PLAYER_SHAPE = { radius: CAP.radius + 0.1, height: (CAP.halfHeight + CAP.radius) * 2 };

export function createPlayerEntity(id: string, name: string, element: SimEntity['element']): SimEntity {
  return createEntity({ id, name, kind: 'player', team: 'players', element, ...PLAYER_SHAPE });
}

/** Offline play: the shared sim, dummy/NPC AI and XP rules run right here. */
export class LocalCombat implements CombatHost {
  readonly online = false;
  readonly sim: CombatSim;
  readonly me: SimEntity;
  readonly brains: DummyBrain[];
  readonly npcs: NpcBrain[];
  readonly progress: Progress;
  readonly xpLog: XpGain[] = [];
  readonly notices: Array<{ text: string; warn?: boolean }> = [];
  readonly party = null;
  readonly invites: InviteMsg[] = [];
  readonly questLines: QuestLine[] = [];
  private reviveT = -1;
  private xp = new XpRules();
  private quests = new QuestRules();
  private still = 0;
  private stillFrom = new THREE.Vector3();
  private self: XpPlayer;
  private slowT = 0;

  constructor(name: string, element: SimEntity['element'], spawn: { x: number; z: number }, private groundAt: (x: number, z: number) => number, progress?: Partial<Progress>) {
    this.sim = new CombatSim(groundAt);
    this.me = createPlayerEntity('player', name, element);
    this.progress = newProgress({ ...progress, mastery: {}, arts: sanitizeArts(element, progress?.arts) });
    if (element) this.progress.mastery = sanitizeAlloc(element, this.progress.level, progress?.mastery);
    applyArtsToEntity(this.me, this.progress);
    this.me.level = this.progress.level;
    setMods(this.me, computeMods(element, this.progress.mastery));
    this.me.hp = this.me.maxHp;
    this.sim.add(this.me);
    this.self = { entity: this.me, progress: this.progress, respawnedAt: 0 };
    this.brains = spawnDummies(this.sim, spawn, groundAt);
    this.npcs = [...spawnNpcs(this.sim, groundAt), ...spawnMasters(this.sim, groundAt)];
  }

  talkTo(npcId: string): void {
    const art = ARTS.find((a) => masterId(a.id) === npcId);
    if (!art) return;
    const news = this.quests.talk(this.questPlayer(), art.id, this.me.ctx.night);
    this.questLines.push({ art: art.id, npc: npcId, line: news.line ?? '' });
    this.questNews(news);
  }

  equipArt(id: string | null): void {
    const a = this.progress.arts;
    if (id !== null && (!a.learned.includes(id) || !artById(id)?.ability)) return;
    a.equipped = id;
    applyArtsToEntity(this.me, this.progress);
  }

  private questPlayer() {
    return { entity: this.me, progress: this.progress, still: this.still };
  }

  private questNews(n: QuestNews): void {
    if (n.notice) this.notices.push({ text: n.notice });
    if (n.rankLoss) this.progress.rank = Math.max(1, this.progress.rank - n.rankLoss);
    if (n.learned) applyArtsToEntity(this.me, this.progress);
  }

  setMastery(alloc: Record<string, number>): void {
    if (!this.me.element) return;
    this.progress.mastery = sanitizeAlloc(this.me.element, this.progress.level, alloc);
    setMods(this.me, computeMods(this.me.element, this.progress.mastery));
  }

  respec(): void {
    this.setMastery({});
    this.notices.push({ text: 'Mastery points refunded' });
  }

  invite(): void {
    this.notices.push({ text: 'Parties need a shard server (you are offline)', warn: true });
  }
  answerInvite(): void {}
  leaveParty(): void {}
  kick(): void {}

  private grant(amount: number, reason: string): void {
    const levelUp = addXp(this.progress, amount);
    if (levelUp) {
      this.me.level = this.progress.level;
      const passive = this.quests.checkPassive(this.questPlayer());
      if (passive) this.questNews(passive);
      this.me.hp = this.me.maxHp;
      this.me.chi = this.me.maxChi;
      this.sim.events.push({ t: 'level', target: this.me.id, level: this.me.level });
    }
    this.xpLog.push({ amount, reason, levelUp });
  }

  get entities() {
    return this.sim.entities;
  }
  get time() {
    return this.sim.time;
  }

  cast(slot: Slot, dir: THREE.Vector3): void {
    this.sim.cast(this.me, slot, dir);
  }

  update(dt: number, aim: THREE.Vector3): SimEvent[] {
    this.sim.updateAim(this.me, aim);
    this.sim.update(dt);
    for (const b of this.brains) updateDummy(b, dt, this.sim, this.groundAt);
    for (const b of this.npcs) updateNpc(b, dt, this.sim, this.groundAt);
    for (const ev of this.sim.events) {
      if (ev.t !== 'death' || ev.source !== this.me.id || ev.target === this.me.id) continue;
      const victim = this.sim.entities.get(ev.target);
      if (!victim) continue;
      for (const a of this.xp.onKill(victim, this.self, new Map([[this.me.id, this.self]]), [this.me.id], this.sim.time)) this.grant(a.amount, a.reason);
      for (const n of this.quests.onKill(this.questPlayer(), victim, this.me.ctx.night)) this.questNews(n);
    }
    this.slowT += dt;
    if (this.slowT >= 1) {
      this.slowT = 0;
      const a = this.xp.discover(this.self);
      if (a) this.grant(a.amount, a.reason);
      this.still = this.me.pos.distanceTo(this.stillFrom) < 0.6 ? this.still + 1 : 0;
      this.stillFrom.copy(this.me.pos);
      for (const n of this.quests.tick(this.questPlayer(), this.me.ctx.night)) this.questNews(n);
    }
    // No death penalty offline: get back up after a moment.
    if (this.me.dead && this.reviveT < 0) this.reviveT = 2;
    if (this.reviveT >= 0) {
      this.reviveT -= dt;
      if (this.reviveT < 0) {
        this.sim.revive(this.me);
        this.self.respawnedAt = this.sim.time;
      }
    }
    return this.sim.drain();
  }
}
