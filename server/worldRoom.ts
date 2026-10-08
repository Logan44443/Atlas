// One world shard: up to NET.maxClients players sharing a combat sim.
// Authoritative for combat (casts, hits, statuses, deaths); clients only
// predict their own movement, which is checked here.
import { Room, type Client } from '@colyseus/core';
import { StateView } from '@colyseus/schema';
import { Vector3 } from 'three';
import worldData from '../data/world.json';
import characterData from '../data/character.json';
import { TerrainSampler } from '../shared/terrain';
import { terrainConfig } from '../shared/factions';
import { CombatSim, CFG, createEntity, setMods, type SimEntity, type SimEvent } from '../shared/sim/combatSim';
import { spawnDummies, updateDummy, type DummyBrain } from '../shared/sim/dummies';
import { spawnNpcs, spawnMasters, updateNpc, type NpcBrain } from '../shared/sim/npcs';
import { elementContextAt, worldDays, nightAt } from '../shared/clock';
import { QuestRules, sanitizeArts, equippedAbility, artById, ARTS, masterId, type QuestNews } from '../shared/arts';
import { NET, type CastMsg, type JoinOptions, type MoveMsg, type WelcomeMsg, type CorrectMsg, type V3, type XpMsg, type PartyInfo, type InviteMsg } from '../shared/net';
import { XpRules, addXp, computeMods, newProgress, sanitizeAlloc, PROG, type Progress, type XpAward } from '../shared/progression';
import { Parties } from './parties';
import { SLOTS, type Slot } from '../shared/combat';
import { EntityState, WorldState } from './schema';
import { factionById, hubSpawn, PVP } from '../shared/factions';
import { validateName } from '../shared/names';
import accountData from '../data/accounts.json';
import timeData from '../data/time.json';
import type { Account, CharacterRow, Store } from './db/store';
import { camps, onlineChars } from './camps';
import { BUILD, giveItems, itemsText, moveItems, pieceById, sanitizeInv, type Builder, type Inventory, type Structure } from '../shared/building';
import { CraftRules, type Crafter, type Crafted } from '../shared/crafting';
import { campRespawn, milestoneXp, shrineBonus, ventTick } from '../shared/campRules';

interface AuthResult {
  account: Account;
  character: CharacterRow;
}

/** Characters currently in any shard (one session per character). */
const online = new Map<string, string>();

const CAP = characterData.capsule;
const PLAYER_SHAPE = { radius: CAP.radius + 0.1, height: (CAP.halfHeight + CAP.radius) * 2 };
const CHUNK = worldData.chunkSize;
const HALF_WORLD = (worldData.worldChunks * CHUNK) / 2;
const DEV = process.env.NODE_ENV !== 'production';
const sampler = new TerrainSampler(terrainConfig());
const groundAt = (x: number, z: number) => sampler.height(x, z);

interface PlayerData {
  entity: SimEntity;
  last: Vector3;
  lastT: number;
  /** extra metres of movement the server has granted (dash, knockback, dodge) */
  allowance: number;
  lastDodge: number;
  invSince: number;
  swimming: boolean;
  aim: Vector3;
  seq: number;
  deadT: number;
  characterId: string;
  pvpToggleT: number;
  progress: Progress;
  /** sim time of the last respawn (no XP for spawn kills) */
  respawnedAt: number;
  /** seconds standing still (meditation) */
  still: number;
  stillFrom: Vector3;
  /** structures this client has been sent */
  knownStructs: Set<string>;
  raidNoticeT: number;
}

/** Structures within this many metres are streamed to a client. */
const STRUCT_RADIUS = 320;

export function cleanName(raw: unknown): string {
  const s = String(raw ?? '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, characterData.nameMaxLength);
  return s.length >= characterData.nameMinLength ? s : `Bender${Math.floor(Math.random() * 9000 + 1000)}`;
}

const arr = (v: { x: number; y: number; z: number }): V3 => [v.x, v.y, v.z];
const finite = (a: unknown, n = 3): a is number[] => Array.isArray(a) && a.length === n && a.every((x) => Number.isFinite(x));

export class WorldRoom extends Room<WorldState> {
  static store: Store;
  maxClients = NET.maxClients;
  private sim = new CombatSim(groundAt);
  private brains: DummyBrain[] = [];
  private npcs: NpcBrain[] = [];
  private players = new Map<string, PlayerData>();
  private spawn = new Vector3(worldData.spawn.x, 0, worldData.spawn.z);
  private xp = new XpRules();
  private quests = new QuestRules();
  private parties = new Parties();
  private slowT = 0;
  /** dev builds: shift this shard's world clock (tests for night-only arts) */
  private clockShiftMs = 0;
  private crafts = new CraftRules();
  private unlisten: (() => void) | null = null;
  private ventT = 0;

  onCreate(): void {
    const state = new WorldState();
    state.shard = this.roomId;
    this.setState(state);
    this.setPatchRate(1000 / NET.patchRate);
    this.spawn.y = Math.max(groundAt(this.spawn.x, this.spawn.z), worldData.seaLevel);
    this.brains = spawnDummies(this.sim, this.spawn, groundAt);
    this.npcs = [...spawnNpcs(this.sim, groundAt), ...spawnMasters(this.sim, groundAt)];
    for (const e of this.sim.entities.values()) this.state.entities.set(e.id, this.newState(e));
    // Camps are shared by every shard in the process.
    this.sim.solids = camps.solids;
    this.unlisten = camps.listen((st, change) => this.onStructChange(st, change));
    this.onBuildMessages();

    this.onMessage('move', (c, m: MoveMsg) => this.onMove(c, m));
    this.onMessage('cast', (c, m: CastMsg) => this.onCast(c, m));
    // Display name changes from the settings menu. Element and faction are permanent per character.
    this.onMessage('profile', async (c, m: { name?: string }) => {
      const p = this.players.get(c.sessionId);
      if (!p || typeof m?.name !== 'string') return;
      const name = m.name.trim();
      const err = validateName(name);
      if (err) return c.send('notice', { text: err, warn: true });
      try {
        await WorldRoom.store.renameCharacter(p.characterId, name);
        p.entity.name = name;
      } catch (e) {
        c.send('notice', { text: (e as Error).message, warn: true });
      }
    });
    this.onMessage('pvp', (c, on: boolean) => {
      const p = this.players.get(c.sessionId);
      if (!p) return;
      const nowS = Date.now() / 1000;
      if (on && p.entity.level < PVP.flagMinLevel) return c.send('notice', { text: `PvP flag unlocks at level ${PVP.flagMinLevel}`, warn: true });
      if (nowS - p.pvpToggleT < PVP.flagToggleCooldown) return c.send('notice', { text: 'You changed your PvP flag too recently', warn: true });
      p.pvpToggleT = nowS;
      p.entity.pvp = !!on;
      c.send('notice', { text: on ? 'PvP flag raised: flagged players can attack you in the Wilds' : 'PvP flag lowered' });
    });
    // Dev builds let tests and the free camera move players anywhere.
    if (DEV) {
      // Tests: grant XP, shift the shard clock by hours.
      this.onMessage('dev:xp', (c, amount: number) => {
        if (Number.isFinite(amount) && amount > 0) this.grant({ id: c.sessionId, amount: Math.min(1e7, amount), reason: 'dev' });
      });
      this.onMessage('dev:raid', (_c, on: boolean | null) => {
        camps.forceRaid = on === null ? null : !!on;
      });
      // Tests clean up after themselves: drop your whole camp.
      this.onMessage('dev:clearCamp', (c) => {
        const p = this.players.get(c.sessionId);
        if (p) for (const st of camps.ofOwner(p.characterId)) camps.delete(st.id);
      });
      this.onMessage('dev:give', (c, items: Inventory) => {
        const p = this.players.get(c.sessionId);
        if (!p) return;
        giveItems(p.progress.inv, sanitizeInv(items, 1e6));
        c.send('progress', p.progress);
      });
      this.onMessage('dev:clock', (_c, hours: number) => {
        if (Number.isFinite(hours)) this.clockShiftMs = hours * (timeData.dayLengthMinutes * 60_000) / 24;
      });
      this.onMessage('tp', (c, pos: V3) => {
        const p = this.players.get(c.sessionId);
        if (!p || !finite(pos)) return;
        p.entity.pos.set(pos[0], pos[1], pos[2]);
        p.last.copy(p.entity.pos);
        p.lastT = Date.now();
      });
    }
    this.onMessage('ping', (c, t: number) => c.send('pong', { t, s: this.now() }));

    // Special Arts: talk to a master (quests), equip a learned art.
    this.onMessage('quest:talk', (c, npcId: string) => {
      const p = this.players.get(c.sessionId);
      const art = ARTS.find((a) => masterId(a.id) === npcId);
      const npc = this.sim.entities.get(String(npcId));
      if (!p || !art || !npc || npc.pos.distanceTo(p.entity.pos) > 8) return;
      const news = this.quests.talk(p, art.id, this.night());
      c.send('quest', { art: art.id, npc: npc.id, line: news.line ?? '' });
      this.applyQuestNews(p, news);
    });
    this.onMessage('art:equip', (c, id: string | null) => {
      const p = this.players.get(c.sessionId);
      if (!p) return;
      const a = p.progress.arts;
      if (id !== null && (!a.learned.includes(String(id)) || !artById(String(id))?.ability)) return;
      a.equipped = id === null ? null : String(id);
      this.applyArts(p);
      c.send('progress', p.progress);
    });

    // Mastery: the client sends its whole allocation; the server keeps what the rules allow.
    this.onMessage('mastery', (c, alloc: unknown) => {
      const p = this.players.get(c.sessionId);
      if (!p?.entity.element) return;
      p.progress.mastery = sanitizeAlloc(p.entity.element, p.progress.level, alloc);
      setMods(p.entity, computeMods(p.entity.element, p.progress.mastery));
      c.send('progress', p.progress);
    });
    this.onMessage('respec', (c) => {
      const p = this.players.get(c.sessionId);
      if (!p) return;
      p.progress.mastery = {};
      setMods(p.entity, computeMods(p.entity.element, {}));
      c.send('progress', p.progress);
      c.send('notice', { text: 'Mastery points refunded' });
    });

    // Parties: same side only; invites need the target to be close.
    this.onMessage('party:invite', (c, targetId: string) => {
      const p = this.players.get(c.sessionId);
      const t = this.players.get(String(targetId));
      if (!p || !t) return c.send('notice', { text: 'No one to invite', warn: true });
      if (t.entity.side !== p.entity.side) return c.send('notice', { text: 'Parties are for your own side', warn: true });
      if (t.entity.pos.distanceTo(p.entity.pos) > PROG.party.inviteRange) return c.send('notice', { text: 'Get closer to invite them', warn: true });
      const err = this.parties.invite(p.entity.id, t.entity.id, this.sim.time);
      if (err) return c.send('notice', { text: err, warn: true });
      const inv: InviteMsg = { from: p.entity.id, name: p.entity.name, expires: PROG.party.inviteSeconds };
      this.clientOf(t.entity.id)?.send('invite', inv);
      c.send('notice', { text: `Invited ${t.entity.name}` });
    });
    this.onMessage('party:accept', (c) => {
      const r = this.parties.accept(c.sessionId, this.sim.time);
      if (typeof r === 'string') return c.send('notice', { text: r, warn: true });
      this.syncParty(r.members);
      const me = this.players.get(c.sessionId);
      for (const id of r.members) if (id !== c.sessionId) this.clientOf(id)?.send('notice', { text: `${me?.entity.name} joined the party` });
    });
    this.onMessage('party:decline', (c) => {
      const from = this.parties.decline(c.sessionId);
      const me = this.players.get(c.sessionId);
      if (from) this.clientOf(from)?.send('notice', { text: `${me?.entity.name} declined`, warn: true });
    });
    this.onMessage('party:leave', (c) => this.leaveParty(c.sessionId, 'left'));
    this.onMessage('party:kick', (c, targetId: string) => {
      const party = this.parties.of(c.sessionId);
      if (!party || party.leader !== c.sessionId || !party.members.includes(String(targetId))) return;
      this.clientOf(String(targetId))?.send('notice', { text: 'You were removed from the party', warn: true });
      this.leaveParty(String(targetId), 'was removed');
    });
    this.setSimulationInterval((ms) => this.tick(Math.min(ms, 250) / 1000), 1000 / NET.tickRate);
    this.clock.setInterval(() => {
      for (const p of this.players.values()) void this.save(p);
    }, accountData.saveEverySeconds * 1000);
  }

  async onAuth(_client: Client, options: JoinOptions): Promise<AuthResult> {
    const store = WorldRoom.store;
    const account = options?.token ? await store.accountForToken(String(options.token)) : null;
    if (!account) throw new Error('Please sign in again');
    const character = options?.characterId ? await store.getCharacter(String(options.characterId)) : null;
    if (!character || character.accountId !== account.id) throw new Error('No such character');
    if (online.has(character.id)) throw new Error(`${character.name} is already in the world`);
    return { account, character };
  }

  onJoin(client: Client, _options: JoinOptions, auth: AuthResult): void {
    const c = auth.character;
    online.set(c.id, client.sessionId);
    const faction = factionById(c.faction);
    // Returning characters come back where they logged out; new ones start at their hub.
    let pos: Vector3;
    if (c.pos && Math.abs(c.pos[0]) < HALF_WORLD && Math.abs(c.pos[2]) < HALF_WORLD) pos = new Vector3(c.pos[0], 0, c.pos[2]);
    else {
      const sp = hubSpawn(c.faction);
      pos = new Vector3(sp.x, 0, sp.z);
    }
    pos.y = Math.max(groundAt(pos.x, pos.z), worldData.seaLevel);
    const progress = newProgress({
      level: c.level, xp: c.xp, discovered: [...(c.discovered ?? [])], rank: c.rank, arts: sanitizeArts(c.element, c.arts),
      inv: sanitizeInv(c.inv), milestones: Array.isArray(c.milestones) ? c.milestones.map(String) : [],
    });
    progress.mastery = sanitizeAlloc(c.element, progress.level, c.mastery);
    const entity = createEntity({
      id: client.sessionId, name: c.name, kind: 'player', team: 'players', element: c.element, pos, level: c.level,
      faction: c.faction, side: faction?.side ?? '', ...PLAYER_SHAPE,
    });
    setMods(entity, computeMods(c.element, progress.mastery));
    entity.hp = entity.maxHp;
    entity.art = equippedAbility(progress.arts);
    entity.canRedirect = progress.arts.learned.includes('lightning');
    entity.protectedUntil = this.sim.time + PVP.spawnProtectionSeconds;
    this.sim.add(entity);
    this.players.set(client.sessionId, {
      entity, last: pos.clone(), lastT: Date.now(), allowance: 0, lastDodge: -1e9, invSince: -1, swimming: false, aim: new Vector3(0, 0, 1), seq: 0, deadT: 0,
      characterId: c.id, pvpToggleT: -1e9, progress, respawnedAt: this.sim.time, still: 0, stillFrom: pos.clone(),
      knownStructs: new Set(), raidNoticeT: -1e9,
    });
    onlineChars.add(c.id);
    camps.touch(c.id);
    const st = this.newState(entity);
    this.state.entities.set(entity.id, st);
    client.view = new StateView();
    client.view.add(st);
    const welcome: WelcomeMsg = { id: client.sessionId, shard: this.roomId, spawn: arr(pos), serverTime: this.now(), tickRate: NET.tickRate, characterId: c.id, faction: c.faction, level: c.level, progress };
    client.send('welcome', welcome);
    this.syncStructs(client, this.players.get(client.sessionId)!);
    console.log(`[${this.roomId}] ${entity.name} (${c.faction} ${c.element}) joined (${this.clients.length}/${this.maxClients})`);
  }

  private save(p: PlayerData): Promise<void> {
    const e = p.entity;
    const pr = p.progress;
    return WorldRoom.store
      .saveCharacter(p.characterId, {
        pos: [+e.pos.x.toFixed(2), +e.pos.y.toFixed(2), +e.pos.z.toFixed(2)], level: pr.level, xp: pr.xp, mastery: pr.mastery, discovered: pr.discovered,
        arts: pr.arts, rank: pr.rank, inv: pr.inv, milestones: pr.milestones,
      })
      .catch((err) => console.error('[db] save failed', err));
  }

  /** Wall time as this shard's world clock sees it. */
  private now(): number {
    return Date.now() + this.clockShiftMs;
  }

  private night(): number {
    return nightAt(worldDays(this.now()));
  }

  private applyArts(p: PlayerData): void {
    p.entity.art = equippedAbility(p.progress.arts);
    p.entity.canRedirect = p.progress.arts.learned.includes('lightning');
  }

  private applyQuestNews(p: PlayerData, news: QuestNews): void {
    const c = this.clientOf(p.entity.id);
    if (news.notice) c?.send('notice', { text: news.notice });
    if (news.rankLoss) p.progress.rank = Math.max(1, p.progress.rank - news.rankLoss);
    if (news.learned) this.applyArts(p);
    c?.send('progress', p.progress);
  }

  private clientOf(id: string): Client | undefined {
    return this.clients.find((c) => c.sessionId === id);
  }

  // ---- progression ---------------------------------------------------------

  private grant(a: XpAward): void {
    const p = this.players.get(a.id);
    if (!p) return;
    // An element shrine at a nearby camp of your side adds a little XP.
    if (a.amount > 0) a = { ...a, amount: Math.round(a.amount * shrineBonus(camps, p.entity)) };
    const levelUp = addXp(p.progress, a.amount);
    if (levelUp) {
      const e = p.entity;
      e.level = p.progress.level;
      const passive = this.quests.checkPassive(p);
      if (passive) this.applyQuestNews(p, passive);
      // Level-ups refill health and chi.
      if (!e.dead) {
        e.hp = e.maxHp;
        e.chi = e.maxChi;
      }
      this.sim.events.push({ t: 'level', target: e.id, level: e.level });
    }
    const msg: XpMsg = { amount: a.amount, reason: a.reason, levelUp, progress: p.progress };
    this.clientOf(a.id)?.send('xp', msg);
  }

  private onDeath(victimId: string, sourceId: string | null): void {
    const victim = this.sim.entities.get(victimId);
    const killer = sourceId ? this.players.get(sourceId) : undefined;
    if (!victim || !killer || victim === killer.entity) return;
    for (const a of this.xp.onKill(victim, killer, this.players, this.parties.membersOf(killer.entity.id), this.sim.time)) this.grant(a);
    const night = this.night();
    for (const n of this.quests.onKill(killer, victim, night)) this.applyQuestNews(killer, n);
  }

  // ---- camps and crafting (Phase 9) ------------------------------------------

  private builder(p: PlayerData): Builder {
    const e = p.entity;
    return { charId: p.characterId, name: e.name, side: e.side, faction: e.faction, x: e.pos.x, z: e.pos.z, inv: p.progress.inv };
  }

  private crafter(p: PlayerData): Crafter {
    return { entity: p.entity, charId: p.characterId, inv: p.progress.inv, arts: p.progress.arts.learned };
  }

  private onBuildMessages(): void {
    const say = (c: Client, text: string, warn = false) => c.send('notice', warn ? { text, warn } : { text });
    this.onMessage('build:place', (c, m: { piece?: string; x?: number; z?: number; rot?: number }) => {
      const p = this.players.get(c.sessionId);
      if (!p || p.entity.dead || !m || !Number.isFinite(m.x) || !Number.isFinite(m.z)) return;
      const r = camps.place(this.builder(p), { piece: String(m.piece), x: m.x!, z: m.z!, rot: Number(m.rot) || 0 });
      if (typeof r === 'string') return say(c, r, true);
      say(c, `Built ${pieceById(r.piece)!.name}`);
      for (const a of milestoneXp(p.progress, camps, p.characterId, r)) this.grant({ id: p.entity.id, ...a });
      c.send('progress', p.progress);
    });
    this.onMessage('build:remove', (c, id: string) => {
      const p = this.players.get(c.sessionId);
      if (!p) return;
      const r = camps.remove(this.builder(p), String(id));
      if (typeof r === 'string') return say(c, r, true);
      say(c, `Took down ${pieceById(r.piece)!.name}`);
      c.send('progress', p.progress);
    });
    this.onMessage('craft:channel', (c) => {
      const p = this.players.get(c.sessionId);
      if (!p) return;
      const others = [...this.players.values()].filter((o) => o !== p).map((o) => this.crafter(o));
      const r = this.crafts.channel(this.crafter(p), others, this.sim.time);
      if (r.kind === 'waiting') return say(c, r.text);
      if (r.kind === 'failed') return say(c, r.reason, true);
      this.applyCraft(r.crafted);
    });
    this.onMessage('gather', (c, nodeId: string | null) => {
      const p = this.players.get(c.sessionId);
      if (!p || p.entity.dead) return;
      const r = this.crafts.gather(this.crafter(p), typeof nodeId === 'string' ? nodeId : null, this.sim.time);
      if (typeof r === 'string') return say(c, r, true);
      say(c, r.text);
      c.send('progress', p.progress);
    });
    this.onMessage('forge', (c, recipe: string) => {
      const p = this.players.get(c.sessionId);
      if (!p) return;
      const r = this.crafts.forge(this.crafter(p), String(recipe), camps);
      if (typeof r === 'string') return say(c, r, true);
      say(c, r.text);
      c.send('progress', p.progress);
    });
    // Chest: move items between your bag and your own chest.
    this.onMessage('chest', (c, m: { id?: string; items?: Inventory; put?: boolean }) => {
      const p = this.players.get(c.sessionId);
      const chest = m?.id ? camps.all.get(String(m.id)) : undefined;
      if (!p || !chest?.store || chest.owner !== p.characterId) return;
      if (Math.hypot(chest.x - p.entity.pos.x, chest.z - p.entity.pos.z) > 5) return say(c, 'Get closer to the chest', true);
      const r = moveItems(p.progress.inv, chest.store, sanitizeInv(m.items, 1e6), !!m.put);
      if (r) say(c, r, true);
      camps.touch(p.characterId);
      this.onStructChange(chest, 'hp');
      c.send('progress', p.progress);
    });
  }

  private applyCraft(cr: Crafted): void {
    this.sim.events.push({ t: 'craft', recipe: cr.recipe, name: cr.name, pos: cr.pos, members: cr.gains.map((g) => g.crafter.entity.id) });
    for (const g of cr.gains) {
      const id = g.crafter.entity.id;
      const c = this.clientOf(id);
      c?.send('notice', Object.keys(g.items).length ? { text: `${cr.name}: +${itemsText(g.items)}` } : { text: 'Your bag is full', warn: true });
      this.grant({ id, amount: g.xp, reason: `bent ${cr.name}` });
      c?.send('progress', this.players.get(id)?.progress);
    }
  }

  /** Bending reached a structure: raid rules decide. */
  private onStructHit(ev: Extract<SimEvent, { t: 'structHit' }>, out: SimEvent[]): void {
    const p = this.players.get(ev.source);
    if (!p) return;
    const r = camps.damage(ev.id, ev.amount, { side: p.entity.side, element: p.entity.element }, this.now());
    if (!r) return;
    if (r.kind === 'refused') {
      if (this.sim.time - p.raidNoticeT > 8) {
        p.raidNoticeT = this.sim.time;
        this.clientOf(p.entity.id)?.send('notice', { text: r.reason, warn: true });
      }
      return;
    }
    out.push({ t: 'struct', id: r.s.id, hp: r.s.hp, maxHp: r.s.maxHp, pos: [r.s.x, r.s.y + 1, r.s.z], broke: r.kind === 'broke', source: p.entity.id });
  }

  /** A structure changed somewhere in the world: tell the clients that can see it. */
  private onStructChange(st: Structure, change: 'add' | 'hp' | 'del'): void {
    for (const c of this.clients) {
      const p = this.players.get(c.sessionId);
      if (!p) continue;
      if (change === 'del') {
        if (p.knownStructs.delete(st.id)) c.send('structDel', [st.id]);
        continue;
      }
      const near = Math.hypot(st.x - p.entity.pos.x, st.z - p.entity.pos.z) <= STRUCT_RADIUS;
      if (!near && !p.knownStructs.has(st.id)) continue;
      p.knownStructs.add(st.id);
      c.send('structs', [this.structFor(st, p)]);
    }
  }

  /** Chest contents are private to their owner. */
  private structFor(st: Structure, p: PlayerData): Structure {
    return st.store && st.owner !== p.characterId ? { ...st, store: undefined } : st;
  }

  /** Stream structures in and out of a client's range. */
  private syncStructs(c: Client, p: PlayerData): void {
    const add: Structure[] = [];
    const del: string[] = [];
    for (const st of camps.all.values()) {
      const near = Math.hypot(st.x - p.entity.pos.x, st.z - p.entity.pos.z) <= STRUCT_RADIUS;
      if (near && !p.knownStructs.has(st.id)) {
        p.knownStructs.add(st.id);
        add.push(this.structFor(st, p));
      }
    }
    for (const id of p.knownStructs) {
      const st = camps.all.get(id);
      if (!st || Math.hypot(st.x - p.entity.pos.x, st.z - p.entity.pos.z) > STRUCT_RADIUS + 40) {
        p.knownStructs.delete(id);
        del.push(id);
      }
    }
    if (add.length) c.send('structs', add);
    if (del.length) c.send('structDel', del);
  }

  onDispose(): void {
    this.unlisten?.();
  }

  // ---- parties -------------------------------------------------------------

  private partyInfo(id: string): PartyInfo | null {
    const party = this.parties.of(id);
    if (!party) return null;
    return {
      id: party.id,
      leader: party.leader,
      members: party.members.flatMap((m) => {
        const e = this.players.get(m)?.entity;
        return e ? [{ id: e.id, name: e.name, element: e.element ?? '', level: e.level, hp: Math.ceil(e.hp), maxHp: e.maxHp, x: Math.round(e.pos.x), z: Math.round(e.pos.z), dead: e.dead }] : [];
      }),
    };
  }

  /** Push party membership into the sim (combos) and to each member's client. */
  private syncParty(ids: string[]): void {
    for (const id of ids) {
      const p = this.players.get(id);
      if (!p) continue;
      p.entity.party = this.parties.of(id)?.id ?? '';
      this.clientOf(id)?.send('party', this.partyInfo(id));
    }
  }

  private leaveParty(id: string, verb: string): void {
    const before = this.parties.membersOf(id);
    if (before.length < 2) return;
    this.parties.leave(id);
    this.syncParty(before);
    const name = this.players.get(id)?.entity.name ?? 'Someone';
    for (const m of before) if (m !== id) this.clientOf(m)?.send('notice', { text: `${name} ${verb} the party` });
  }

  async onLeave(client: Client): Promise<void> {
    const p = this.players.get(client.sessionId);
    if (p) {
      online.delete(p.characterId);
      onlineChars.delete(p.characterId);
      camps.touch(p.characterId);
      this.leaveParty(client.sessionId, 'left');
      this.parties.decline(client.sessionId);
      await this.save(p);
    }
    this.players.delete(client.sessionId);
    this.sim.remove(client.sessionId);
    this.state.entities.delete(client.sessionId);
    if (p) console.log(`[${this.roomId}] ${p.entity.name} left`);
  }

  // ---- input ---------------------------------------------------------------

  private onMove(client: Client, m: MoveMsg): void {
    const p = this.players.get(client.sessionId);
    if (!p || !m || !finite(m.p) || !Number.isFinite(m.yaw)) return;
    const e = p.entity;
    if (finite(m.aim) && Math.hypot(...m.aim) > 0.1) p.aim.set(m.aim[0], m.aim[1], m.aim[2]).normalize();
    e.yaw = m.yaw;
    p.seq = m.seq | 0;
    const now = Date.now();
    if (e.dead) return;

    const to = new Vector3(m.p[0], m.p[1], m.p[2]);
    const dt = Math.min(1, Math.max(0.001, (now - p.lastT) / 1000));
    const dist = Math.hypot(to.x - p.last.x, to.z - p.last.z);
    const mv = NET.movement;
    const budget = characterData.runSpeed * mv.speedTolerance * dt + mv.slackMeters + p.allowance;
    const ground = groundAt(to.x, to.z);
    let reject = '';
    if (Math.abs(to.x) > HALF_WORLD || Math.abs(to.z) > HALF_WORLD) reject = 'edge of the world';
    else if (dist > budget) reject = 'too fast';
    else if (to.y < Math.min(ground, worldData.seaLevel - characterData.swim.depth - 1) - mv.maxBelowGround) reject = 'under ground';
    else if (to.y > ground + mv.maxAboveGround && e.flyUntil + 4 < this.sim.time) reject = 'too high';
    else if (e.spiritUntil > this.sim.time && dist > mv.slackMeters + p.allowance) reject = 'spirit projecting';
    else if ((e.statuses.has('root') || e.statuses.has('stagger')) && dist > mv.slackMeters + p.allowance) reject = 'rooted';
    if (reject) {
      const msg: CorrectMsg = { seq: p.seq, p: arr(p.last), reason: reject };
      client.send('correct', msg);
      p.lastT = now;
      return;
    }
    p.allowance = Math.max(0, p.allowance - Math.max(0, dist - characterData.runSpeed * dt));
    p.last.copy(to);
    p.lastT = now;
    e.pos.copy(to);
    e.grounded = !!m.gr;
    p.swimming = !!m.sw;

    // Blocking: the server stamps the start so perfect-block timing is authoritative.
    const blk = !!m.blk && !p.swimming;
    if (blk && !e.blocking) e.blockStart = this.sim.time;
    e.blocking = blk;

    // Dodge i-frames: accept only on the dodge cooldown and for the window's length.
    const nowS = now / 1000;
    if (m.inv && !e.invulnerable && nowS - p.lastDodge >= characterData.dodge.cooldown * 0.9) {
      p.lastDodge = nowS;
      p.invSince = nowS;
      p.allowance += characterData.dodge.distance;
    }
    const window = CFG.dodgeInvulnerable[1] - CFG.dodgeInvulnerable[0] + 0.08;
    e.invulnerable = !!m.inv && p.invSince > 0 && nowS - p.invSince <= window;
    if (!m.inv) p.invSince = -1;
  }

  private onCast(client: Client, m: CastMsg): void {
    const p = this.players.get(client.sessionId);
    if (!p || !m || !SLOTS.includes(m.slot as Slot) || !finite(m.dir)) return;
    const dir = new Vector3(m.dir[0], m.dir[1], m.dir[2]);
    if (dir.lengthSq() < 1e-4) return;
    const e = p.entity;
    e.ctx = elementContextAt(sampler, worldData, CFG.elements.water.nearWaterMeters, e.pos, worldDays(this.now()), p.swimming, e.grounded);
    this.sim.cast(e, m.slot, dir);
  }

  // ---- tick ----------------------------------------------------------------

  private tick(dt: number): void {
    for (const p of this.players.values()) this.sim.updateAim(p.entity, p.aim);
    this.sim.update(dt);
    for (const b of this.brains) updateDummy(b, dt, this.sim, groundAt);
    for (const b of this.npcs) updateNpc(b, dt, this.sim, groundAt);
    const events = this.sim.drain();

    for (const p of this.players.values()) {
      const e = p.entity;
      // Respawn after a short delay at the shard's spawn point.
      if (e.dead) {
        p.deadT += dt;
        if (p.deadT > 3) {
          p.deadT = 0;
          const sp = campRespawn(camps, p.characterId) ?? hubSpawn(e.faction);
          e.pos.set(sp.x, Math.max(groundAt(sp.x, sp.z), worldData.seaLevel), sp.z);
          p.last.copy(e.pos);
          this.sim.revive(e);
          e.protectedUntil = this.sim.time + PVP.spawnProtectionSeconds;
          p.respawnedAt = this.sim.time;
          events.push(...this.sim.drain());
        }
      }
    }
    for (const ev of events) {
      if (ev.t === 'dash') {
        const p = this.players.get(ev.owner);
        if (p) p.allowance += ev.distance + ev.lift;
      } else if (ev.t === 'death') this.onDeath(ev.target, ev.source);
      else if (ev.t === 'structHit') this.onStructHit(ev, events);
    }
    // Steam vents.
    this.ventT += dt;
    if (this.ventT >= BUILD.vent.every) {
      this.ventT = 0;
      ventTick(camps, this.sim);
      events.push(...this.sim.drain());
    }
    // Once a second: landmark discovery and party frames.
    this.slowT += dt;
    if (this.slowT >= 1) {
      this.slowT = 0;
      const night = this.night();
      for (const p of this.players.values()) {
        const a = this.xp.discover(p);
        if (a) this.grant(a);
        // Meditation needs you to stand still.
        p.still = p.entity.pos.distanceTo(p.stillFrom) < 0.6 ? p.still + 1 : 0;
        p.stillFrom.copy(p.entity.pos);
        for (const n of this.quests.tick(p, night)) this.applyQuestNews(p, n);
        if (this.parties.of(p.entity.id)) this.clientOf(p.entity.id)?.send('party', this.partyInfo(p.entity.id));
      }
      for (const c of this.clients) {
        const p = this.players.get(c.sessionId);
        if (p) this.syncStructs(c, p);
      }
    }
    // Level-up events raised by grant() above.
    events.push(...this.sim.drain());

    for (const e of this.sim.entities.values()) {
      const st = this.state.entities.get(e.id);
      if (st) this.writeState(st, e);
    }

    for (const client of this.clients) {
      const p = this.players.get(client.sessionId);
      if (!p) continue;
      this.updateInterest(client, p.entity);
      const near = events.filter((ev) => this.relevant(ev, p.entity));
      if (near.length) client.send('ev', near);
      // Knockback and pulls are applied by the owner's movement controller.
      const imp = p.entity.pendingImpulse;
      if (imp.lengthSq() > 1e-6) {
        client.send('imp', arr(imp));
        p.allowance += imp.length() * 0.6;
        imp.set(0, 0, 0);
      }
    }
  }

  /** Add entities within interestAddChunks, drop beyond interestRemoveChunks (hysteresis). */
  private updateInterest(client: Client, me: SimEntity): void {
    const view = client.view!;
    const add = NET.interestAddChunks * CHUNK;
    const remove = NET.interestRemoveChunks * CHUNK;
    for (const [id, st] of this.state.entities) {
      if (id === me.id) continue;
      const e = this.sim.entities.get(id);
      if (!e) continue;
      const d = Math.max(Math.abs(e.pos.x - me.pos.x), Math.abs(e.pos.z - me.pos.z));
      const has = view.has(st);
      if (!has && d <= add) view.add(st);
      else if (has && d > remove) view.remove(st);
    }
  }

  private relevant(ev: SimEvent, me: SimEntity): boolean {
    const r = NET.eventRadiusMeters;
    const near = (x: number, z: number) => Math.abs(x - me.pos.x) <= r && Math.abs(z - me.pos.z) <= r;
    const nearId = (id: string | null) => {
      if (!id) return false;
      if (id === me.id) return true;
      const e = this.sim.entities.get(id);
      return !!e && near(e.pos.x, e.pos.z);
    };
    switch (ev.t) {
      case 'cast':
        return nearId(ev.caster);
      case 'castFail':
        return ev.caster === me.id;
      case 'proj':
      case 'projEnd':
      case 'reflect':
      case 'melee':
      case 'area':
        return near(ev.pos[0], ev.pos[2]);
      case 'hit':
        return nearId(ev.target) || ev.source === me.id;
      case 'impulse':
      case 'status':
      case 'shield':
      case 'shieldEnd':
      case 'death':
      case 'respawn':
        return nearId(ev.target);
      case 'dash':
        return nearId(ev.owner);
      case 'combo':
        return near(ev.pos[0], ev.pos[2]);
      case 'level':
      case 'heal':
      case 'fly':
      case 'spirit':
        return nearId(ev.target);
      case 'charge':
        return nearId(ev.caster);
      case 'beam':
        return near(ev.from[0], ev.from[2]) || near(ev.to[0], ev.to[2]);
      case 'wall':
        return near(ev.pos[0], ev.pos[2]);
      case 'wallEnd':
        return true;
      case 'grab':
        return nearId(ev.target) || nearId(ev.owner);
      case 'structHit':
        return false;
      case 'struct':
      case 'craft':
        return near(ev.pos[0], ev.pos[2]);
    }
  }

  private newState(e: SimEntity): EntityState {
    const st = new EntityState();
    st.id = e.id;
    st.kind = e.kind;
    st.role = e.role ?? '';
    st.title = e.title ?? '';
    this.writeState(st, e);
    return st;
  }

  private writeState(st: EntityState, e: SimEntity): void {
    const r = (v: number, k = 100) => Math.round(v * k) / k;
    st.name = e.name;
    st.team = e.team;
    st.el = e.element ?? '';
    st.lv = e.level;
    st.x = r(e.pos.x);
    st.y = r(e.pos.y);
    st.z = r(e.pos.z);
    st.yaw = r(e.yaw);
    st.hp = Math.ceil(e.hp);
    st.maxHp = e.maxHp;
    st.chi = Math.floor(e.chi);
    st.maxChi = e.maxChi;
    st.dead = e.dead;
    st.blk = e.blocking;
    st.st = [...e.statuses.keys()].join(',');
    st.slow = r(e.statuses.get('slow')?.amount ?? 0);
    st.sh = !!e.shield;
    st.wu = r(e.windup);
    st.pvp = e.pvp;
    st.fac = e.faction;
  }
}
