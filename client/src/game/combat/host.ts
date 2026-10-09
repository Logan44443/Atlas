import * as THREE from 'three/webgpu';
import type { Slot } from '@shared/combat';
import { CombatSim, createEntity, setMods, type SimEntity, type SimEvent } from '@shared/sim/combatSim';
import { XpRules, addXp, computeMods, newProgress, pointsSpent, sanitizeAlloc, type Progress, type XpPlayer } from '@shared/progression';
import type { ChatMsg, ChatSend, CrewAction, CrewInviteMsg, InviteMsg, PartyInfo, ShopAction, TerrMsg, V3 } from '@shared/net';
import { spawnDummies, updateDummy, type DummyBrain } from '@shared/sim/dummies';
import { spawnNpcs, spawnMasters, updateNpc, type NpcBrain } from '@shared/sim/npcs';
import { QuestRules, sanitizeArts, equippedAbility, artById, ARTS, masterId, type QuestNews } from '@shared/arts';
import characterData from '@data/character.json';
import { BUILD, Camps, giveItems, itemsText, moveItems, pieceById, sanitizeInv, type Builder, type Inventory } from '@shared/building';
import { CraftRules, type Crafter } from '@shared/crafting';
import { milestoneXp, shrineBonus } from '@shared/campRules';
import { Wildlife, type WildNews } from '@shared/sim/wildlife';
import { PET_RULES, PetRules, petDef, sanitizePets, type TrustGame } from '@shared/pets';
import { Obstacles } from '@shared/props';
import { TerrainSampler } from '@shared/terrain';
import { terrainConfig } from '@shared/factions';
import { worldDays, nightAt } from '@shared/clock';
import { OrderRules, addPoints, dropRanks, payCoins, rankOf, respecCost, sanitizeStanding } from '@shared/standing';
import {
  SHOP, boonFor, bossRewards, buy, captureRewards, hatchEggs, heldRewards, incomeRewards, killRewards, pardon, sell, travel, travelSpots, xpScale,
  type FactionNews,
} from '@shared/factionRules';
import { Territory, pointById, presenceAt, type PointSave, type TerrNews } from '@shared/territory';
import { WarBands } from '@shared/sim/warbands';
import type { CrewView } from '@shared/crews';

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

  // Camps and bending crafting (Phase 9).
  /** structures the authority has told us about (a mirror online) */
  readonly camps: Camps;
  /** the character id that owns this player's camp */
  readonly charId: string;
  place(piece: string, x: number, z: number, rot: number): void;
  removeStruct(id: string): void;
  channel(): void;
  gather(nodeId: string | null): void;
  forge(recipe: string): void;
  chest(id: string, items: Inventory, put: boolean): void;

  // Wildlife and pets (Phase 10).
  /** trust games to play (taming) */
  readonly trustGames: TrustGame[];
  /** world-wide announcements (bosses) */
  readonly announcements: string[];
  /** feed the nearest tameable animal and start the trust game */
  tame(): void;
  trust(success: boolean): void;
  setPet(uid: string | null): void;
  feedPet(uid: string): void;
  toggleMount(): void;

  // Parties (online only).
  readonly party: PartyInfo | null;
  readonly invites: InviteMsg[];
  invite(entityId: string): void;
  answerInvite(accept: boolean): void;
  leaveParty(): void;
  kick(entityId: string): void;

  // Territory wars, faction standing, crews, chat and the Quartermaster (Phase 11).
  /** the war and who holds each point (the authority's latest word) */
  readonly terr: TerrMsg;
  /** your crew (online only) and crew invites waiting for an answer */
  readonly crew: CrewView | null;
  readonly crewInvites: CrewInviteMsg[];
  /** chat lines since the UI last drained them */
  readonly chat: ChatMsg[];
  /** moves the authority made (fast travel): put the character here */
  readonly warps: V3[];
  sendChat(m: ChatSend): void;
  crewAction(a: CrewAction): void;
  shop(a: ShopAction): void;
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

const CAMPS_KEY = 'fw.camps';

/** A pet stable of your side within reach keeps your pets fed. */
const stableNear = (camps: Camps, e: SimEntity) => !!camps.effectNear(e.pos.x, e.pos.z, 'stable', BUILD.stableRadius, (s) => s.side === e.side);
const TERR_KEY = 'fw.territory';

/** Tree trunks and boulders, shared by every offline host in this tab. */
let obstacles: Obstacles | null = null;
export const worldObstacles = () => (obstacles ??= new Obstacles(new TerrainSampler(terrainConfig())));

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
  readonly camps: Camps;
  charId = 'local';
  private crafts = new CraftRules();
  readonly wild: Wildlife;
  readonly pets: PetRules;
  readonly trustGames: TrustGame[] = [];
  readonly announcements: string[] = [];
  readonly territory: Territory;
  readonly bands: WarBands;
  private orders = new OrderRules();
  terr: TerrMsg;
  readonly crew = null;
  readonly crewInvites: CrewInviteMsg[] = [];
  readonly chat: ChatMsg[] = [];
  readonly warps: V3[] = [];

  constructor(name: string, element: SimEntity['element'], spawn: { x: number; z: number }, private groundAt: (x: number, z: number) => number, progress?: Partial<Progress>) {
    this.sim = new CombatSim(groundAt);
    this.me = createPlayerEntity('player', name, element);
    const standing = sanitizeStanding(progress?.standing);
    this.progress = newProgress({ ...progress, mastery: {}, arts: sanitizeArts(element, progress?.arts), standing, rank: rankOf(standing.points) });
    if (element) this.progress.mastery = sanitizeAlloc(element, this.progress.level, progress?.mastery);
    applyArtsToEntity(this.me, this.progress);
    this.me.level = this.progress.level;
    setMods(this.me, computeMods(element, this.progress.mastery));
    this.me.hp = this.me.maxHp;
    this.sim.add(this.me);
    this.self = { entity: this.me, progress: this.progress, respawnedAt: 0 };
    this.brains = spawnDummies(this.sim, spawn, groundAt);
    this.npcs = [...spawnNpcs(this.sim, groundAt), ...spawnMasters(this.sim, groundAt)];
    this.progress.inv = sanitizeInv(progress?.inv);
    this.progress.milestones = Array.isArray(progress?.milestones) ? [...progress.milestones] : [];
    this.progress.pets = sanitizePets(progress?.pets);
    // Wildlife, bosses and pets (Phase 10); bending stops on trees and rocks.
    const obs = worldObstacles();
    this.sim.obstacleAt = (x, y, z, r) => obs.hit(x, y, z, r);
    this.wild = new Wildlife(this.sim, groundAt);
    this.pets = new PetRules(this.sim, this.wild, groundAt);
    // Offline camps live in this browser.
    this.camps = new Camps(groundAt);
    try {
      this.camps.load(JSON.parse(localStorage.getItem(CAMPS_KEY) ?? '[]'));
    } catch {
      /* no saved camps */
    }
    this.sim.solids = this.camps.solids;
    this.camps.listen(() => {
      try {
        localStorage.setItem(CAMPS_KEY, JSON.stringify([...this.camps.all.values()]));
      } catch {
        /* storage full or blocked */
      }
    });
    // Territory wars run on the same schedule offline: you against the war bands.
    let saved: PointSave[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(TERR_KEY) ?? '[]');
    } catch {
      /* nothing saved */
    }
    this.territory = new Territory(Array.isArray(saved) ? saved : []);
    this.bands = new WarBands(this.sim, groundAt);
    if (this.territory.isOpen(Date.now())) this.bands.raise((id) => this.territory.states.get(id)?.owner ?? '');
    this.terr = this.terrMsg();
  }

  private terrMsg(): TerrMsg {
    const now = Date.now();
    return { open: this.territory.isOpen(now), text: this.territory.text(now), points: this.territory.snapshot(), halls: [] };
  }

  private builder(): Builder {
    const e = this.me;
    return { charId: this.charId, name: e.name, side: e.side, faction: e.faction, x: e.pos.x, z: e.pos.z, inv: this.progress.inv, rank: this.progress.rank, crew: null };
  }
  private crafter(): Crafter {
    return { entity: this.me, charId: this.charId, inv: this.progress.inv, arts: this.progress.arts.learned };
  }

  /** Tests: give materials, force the raid window. */
  devGive(items: Inventory): void {
    giveItems(this.progress.inv, sanitizeInv(items, 1e6));
  }
  devRaid(on: boolean | null): void {
    this.camps.forceRaid = on;
  }

  place(piece: string, x: number, z: number, rot: number): void {
    const r = this.camps.place(this.builder(), { piece, x, z, rot });
    if (typeof r === 'string') return void this.notices.push({ text: r, warn: true });
    this.notices.push({ text: `Built ${pieceById(r.piece)!.name}` });
    for (const a of milestoneXp(this.progress, this.camps, this.charId, r)) this.grant(a.amount, a.reason);
  }
  removeStruct(id: string): void {
    const r = this.camps.remove(this.builder(), id);
    this.notices.push(typeof r === 'string' ? { text: r, warn: true } : { text: `Took down ${pieceById(r.piece)!.name}` });
  }
  channel(): void {
    const r = this.crafts.channel(this.crafter(), [], this.sim.time);
    if (r.kind === 'waiting') return void this.notices.push({ text: r.text });
    if (r.kind === 'failed') return void this.notices.push({ text: r.reason, warn: true });
    const cr = r.crafted;
    this.sim.events.push({ t: 'craft', recipe: cr.recipe, name: cr.name, pos: cr.pos, members: [this.me.id] });
    const g = cr.gains[0];
    this.notices.push(Object.keys(g.items).length ? { text: `${cr.name}: +${itemsText(g.items)}` } : { text: 'Your bag is full', warn: true });
    this.grant(g.xp, `bent ${cr.name}`);
  }
  gather(nodeId: string | null): void {
    const r = this.crafts.gather(this.crafter(), nodeId, this.sim.time);
    this.notices.push(typeof r === 'string' ? { text: r, warn: true } : { text: r.text });
  }
  forge(recipe: string): void {
    const r = this.crafts.forge(this.crafter(), recipe, this.camps);
    this.notices.push(typeof r === 'string' ? { text: r, warn: true } : { text: r.text });
  }
  chest(id: string, items: Inventory, put: boolean): void {
    const c = this.camps.all.get(id);
    if (!c?.store || c.owner !== this.charId) return;
    if (Math.hypot(c.x - this.me.pos.x, c.z - this.me.pos.z) > 5) return void this.notices.push({ text: 'Get closer to the chest', warn: true });
    const err = moveItems(this.progress.inv, c.store, sanitizeInv(items, 1e6), put);
    if (err) this.notices.push({ text: err, warn: true });
    this.camps.upsert(c);
  }

  talkTo(npcId: string): void {
    const npc = this.sim.entities.get(npcId);
    if (npc?.role === 'beast') {
      const egg = npc.faction === this.me.faction ? hatchEggs(this.owner(), this.pets, Date.now()) : null;
      this.questLines.push({ art: '', npc: npcId, line: egg ?? this.pets.keeperTalk(this.owner()) });
      return;
    }
    // Envoys hand out faction orders.
    if (npc?.role === 'quest') {
      const r = this.orders.talk(this.owner(), npc.faction);
      this.questLines.push({ art: '', npc: npcId, line: r.line });
      if (r.reward) {
        this.grant(r.reward.xp, r.reward.reason);
        this.notices.push({ text: `+${r.reward.coins} coins, +${r.reward.points} rank points` });
      }
      if (r.rankUp) this.notices.push({ text: `Faction rank ${this.progress.rank}!` });
      return;
    }
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
    if (n.rankLoss) dropRanks(this.progress, n.rankLoss);
    if (n.learned) applyArtsToEntity(this.me, this.progress);
  }

  setMastery(alloc: Record<string, number>): void {
    if (!this.me.element) return;
    this.progress.mastery = sanitizeAlloc(this.me.element, this.progress.level, alloc);
    setMods(this.me, computeMods(this.me.element, this.progress.mastery));
  }

  respec(): void {
    const cost = respecCost(this.progress.level, pointsSpent(this.progress.mastery));
    if (!payCoins(this.progress.standing, cost)) return void this.notices.push({ text: `A respec costs ${cost} coins; you have ${this.progress.standing.coins}`, warn: true });
    this.setMastery({});
    this.notices.push({ text: cost ? `Mastery points refunded (${cost} coins)` : 'Mastery points refunded' });
  }

  // ---- pets -------------------------------------------------------------------

  private owner() {
    return { entity: this.me, progress: this.progress };
  }
  tame(): void {
    const r = this.pets.startTame(this.owner(), null);
    if (typeof r === 'string') this.notices.push({ text: r, warn: true });
    else this.trustGames.push(r);
  }
  trust(success: boolean): void {
    const r = this.pets.finishTame(this.owner(), success, Date.now());
    this.notices.push({ text: r.text, warn: r.warn });
  }
  setPet(uid: string | null): void {
    const err = this.pets.setActive(this.owner(), uid);
    if (err) this.notices.push({ text: err, warn: true });
  }
  feedPet(uid: string): void {
    this.notices.push({ text: this.pets.feed(this.owner(), uid, Date.now()) });
  }
  toggleMount(): void {
    const err = this.pets.toggleMount(this.owner(), Date.now());
    if (err) this.notices.push({ text: err, warn: true });
  }
  /** Tests: raise a boss now (near the player when `here`), force Bond Trial rolls. */
  devBoss(id: string, here = false, hp?: number): void {
    const e = this.wild.forceBoss(id, here ? { x: this.me.pos.x + 14, z: this.me.pos.z } : undefined);
    if (e && hp && hp > 0) {
      e.hp = Math.min(e.maxHp, Math.round(hp));
      e.lastCombat = this.sim.time; // or it heals straight back up at home
    }
  }
  devPet(kind: string): void {
    const def = petDef(kind);
    if (def && this.progress.pets.owned.length < PET_RULES.maxPets) this.pets.addPet(this.owner(), def, Date.now());
  }
  devBond(on: boolean | null): void {
    this.wild.forceBond = on;
  }

  private wildNews(list: WildNews[]): void {
    for (const n of list) {
      switch (n.t) {
        case 'xp':
          this.grant(n.amount, n.reason);
          break;
        case 'loot': {
          const got = giveItems(this.progress.inv, n.items);
          if (Object.keys(got).length) this.notices.push({ text: `+${itemsText(got)}` });
          break;
        }
        case 'notice':
          this.notices.push({ text: n.text, warn: n.warn });
          break;
        case 'announce':
          this.announcements.push(n.text);
          break;
        case 'bond': {
          const text = this.pets.startTrial(this.owner(), n.boss);
          if (text) this.announcements.push(text);
          break;
        }
        case 'rare': {
          const g = this.pets.offerRare(this.owner(), n.pet);
          if (g) this.trustGames.push(g);
          break;
        }
        case 'trial':
          this.notices.push({ text: this.pets.endTrial(this.owner(), n.pet, n.won, Date.now()), warn: !n.won });
          break;
        case 'boss':
          this.factionNews(bossRewards(this.owner(), n.tier, this.orders));
          break;
      }
    }
  }

  invite(): void {
    this.notices.push({ text: 'Parties need a shard server (you are offline)', warn: true });
  }
  answerInvite(): void {}
  leaveParty(): void {}
  kick(): void {}

  // ---- territory, standing, chat, shop (Phase 11) -------------------------------------

  private factionNews(list: FactionNews[]): void {
    for (const n of list) {
      if (n.t === 'xp') this.grant(n.amount, n.reason);
      else if (n.t === 'notice') this.notices.push({ text: n.text, warn: n.warn });
    }
  }

  private terrNews(list: TerrNews[]): void {
    let changed = false;
    for (const n of list) {
      switch (n.t) {
        case 'war':
          this.announcements.push(n.text);
          if (n.open) this.bands.raise((id) => this.territory.states.get(id)?.owner ?? '');
          else this.bands.disband();
          break;
        case 'captured':
          changed = true;
          this.announcements.push(n.text);
          if (n.by.some((b) => b.entityId === this.me.id)) this.factionNews(captureRewards(this.owner(), pointById(n.point)!, this.orders));
          break;
        case 'lost':
          changed = true;
          this.notices.push({ text: n.text, warn: true });
          break;
        case 'income':
          // Offline there are no crews: points your faction holds pay you.
          if (n.faction === this.me.faction) this.factionNews(incomeRewards(this.owner(), pointById(n.point)!, n.items, n.coins));
          break;
        case 'held':
          if (n.faction === this.me.faction) this.factionNews(heldRewards(this.owner(), n.points.length));
          break;
      }
    }
    if (!changed) return;
    try {
      localStorage.setItem(TERR_KEY, JSON.stringify(this.territory.save()));
    } catch {
      /* storage full or blocked */
    }
  }

  /** Once a second: the war, buffs, visit orders, pet stables. */
  private factionTick(now: number): void {
    const me = this.me;
    this.terrNews(this.territory.update(1, presenceAt([{ charId: this.charId, entity: me, crew: '' }], this.groundAt, this.sim.time), now));
    this.terr = this.terrMsg();
    me.boon = boonFor(me, this.territory);
    const note = this.orders.tick(this.owner());
    if (note) this.notices.push({ text: note });
    if (stableNear(this.camps, me)) for (const x of this.progress.pets.owned) Object.assign(x, { fed: 100, fedAt: now });
  }

  sendChat(m: ChatSend): void {
    const text = String(m.text ?? '').trim().slice(0, 200);
    if (!text) return;
    this.chat.push({ ch: m.ch, from: this.me.name, text, faction: this.me.faction, ...(m.ch === 'whisper' ? { to: m.to } : {}) });
    if (m.ch !== 'say' && m.ch !== 'shard') this.chat.push({ ch: 'system', from: '', text: 'You are offline: nobody else can hear you' });
  }

  crewAction(): void {
    this.notices.push({ text: 'Crews need a shard server (you are offline)', warn: true });
  }

  shop(a: ShopAction): void {
    const npc = this.sim.entities.get(a.npc);
    const p = this.owner();
    if (!npc || npc.role !== 'vendor' || npc.side !== this.me.side || npc.pos.distanceTo(this.me.pos) > SHOP.vendorRange) {
      return void this.notices.push({ text: 'Talk to a Quartermaster of your side', warn: true });
    }
    const now = Date.now();
    if (a.a === 'buy') this.notices.push({ text: buy(p, a.item, a.n) });
    else if (a.a === 'sell') this.notices.push({ text: sell(p, a.item, a.n) });
    else if (a.a === 'pardon') this.notices.push({ text: pardon(p, now) });
    else {
      const camp = this.camps.campfireOf(this.charId);
      const r = travel(p, travelSpots(this.me, camp ?? null, null).find((x) => x.id === a.dest), this.sim.time, now);
      if (typeof r === 'string') return void this.notices.push({ text: r, warn: true });
      this.warps.push([r.x, this.groundAt(r.x, r.z), r.z]);
      this.notices.push({ text: r.text });
    }
  }

  /** Tests: force the war open or shut, speed captures up, give coins or rank points. */
  devWar(on: boolean | null): void {
    this.territory.forceWar = on;
  }
  devWarRate(n: number): void {
    this.territory.rateScale = n;
  }
  devCoins(n: number): void {
    this.progress.standing.coins = Math.max(0, this.progress.standing.coins + n);
  }
  devPoints(n: number): void {
    if (n > 0) addPoints(this.progress, n);
  }

  private grant(amount: number, reason: string): void {
    amount = Math.round(amount * shrineBonus(this.camps, this.me) * xpScale(this.me, this.territory));
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
    this.bands.update(dt);
    const now = Date.now();
    this.wild.now = now;
    this.wild.night = nightAt(worldDays(now));
    const owner = this.owner();
    const pet = this.pets.petOf(this.me.id);
    // Deaths first: rewards need the creature's brain before the wildlife tidies up.
    for (const ev of this.sim.events) {
      if (ev.t !== 'death' || ev.target === this.me.id) continue;
      // Your pet's kills are yours.
      const mine = ev.source === this.me.id || (!!pet && ev.source === pet.id);
      const victim = this.sim.entities.get(ev.target);
      if (victim?.kind === 'creature') this.wildNews(this.wild.onDeath(ev.target, mine ? this.me.id : null, new Map([[this.me.id, owner]])));
      if (!victim || !mine) continue;
      const awards = this.xp.onKill(victim, this.self, new Map([[this.me.id, this.self]]), [this.me.id], this.sim.time);
      for (const a of awards) this.grant(a.amount, a.reason);
      this.factionNews(killRewards(victim, this.owner(), undefined, awards.some((a) => a.amount > 0), now, this.orders));
      for (const n of this.quests.onKill(this.questPlayer(), victim, this.me.ctx.night)) this.questNews(n);
    }
    this.wildNews(this.wild.update(dt, [owner]));
    this.pets.sync(owner, now);
    this.pets.update(dt, new Map([[this.me.id, owner]]), now);
    for (const a of this.pets.announcements.splice(0)) this.announcements.push(a.text);
    this.slowT += dt;
    if (this.slowT >= 1) {
      this.slowT = 0;
      const a = this.xp.discover(this.self);
      if (a) this.grant(a.amount, a.reason);
      this.still = this.me.pos.distanceTo(this.stillFrom) < 0.6 ? this.still + 1 : 0;
      this.stillFrom.copy(this.me.pos);
      for (const n of this.quests.tick(this.questPlayer(), this.me.ctx.night)) this.questNews(n);
      this.factionTick(now);
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
