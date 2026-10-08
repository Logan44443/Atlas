// One world shard: up to NET.maxClients players sharing a combat sim.
// Authoritative for combat (casts, hits, statuses, deaths); clients only
// predict their own movement, which is checked here.
import { Room, type Client } from '@colyseus/core';
import { StateView } from '@colyseus/schema';
import { Vector3 } from 'three';
import worldData from '../data/world.json';
import characterData from '../data/character.json';
import { TerrainSampler, type TerrainConfig } from '../shared/terrain';
import { CombatSim, CFG, createEntity, type SimEntity, type SimEvent } from '../shared/sim/combatSim';
import { spawnDummies, updateDummy, type DummyBrain } from '../shared/sim/dummies';
import { elementContextAt, worldDays } from '../shared/clock';
import { NET, type CastMsg, type JoinOptions, type MoveMsg, type WelcomeMsg, type CorrectMsg, type V3 } from '../shared/net';
import { SLOTS, type ElementId, type Slot } from '../shared/combat';
import { EntityState, WorldState } from './schema';

const ELEMENTS: ElementId[] = ['fire', 'water', 'earth', 'air'];
const CAP = characterData.capsule;
const PLAYER_SHAPE = { radius: CAP.radius + 0.1, height: (CAP.halfHeight + CAP.radius) * 2 };
const CHUNK = worldData.chunkSize;
const HALF_WORLD = (worldData.worldChunks * CHUNK) / 2;
const DEV = process.env.NODE_ENV !== 'production';
const sampler = new TerrainSampler(worldData as unknown as TerrainConfig);
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
}

export function cleanName(raw: unknown): string {
  const s = String(raw ?? '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, characterData.nameMaxLength);
  return s.length >= characterData.nameMinLength ? s : `Bender${Math.floor(Math.random() * 9000 + 1000)}`;
}

const arr = (v: { x: number; y: number; z: number }): V3 => [v.x, v.y, v.z];
const finite = (a: unknown, n = 3): a is number[] => Array.isArray(a) && a.length === n && a.every((x) => Number.isFinite(x));

export class WorldRoom extends Room<WorldState> {
  maxClients = NET.maxClients;
  private sim = new CombatSim(groundAt);
  private brains: DummyBrain[] = [];
  private players = new Map<string, PlayerData>();
  private spawn = new Vector3(worldData.spawn.x, 0, worldData.spawn.z);

  onCreate(): void {
    const state = new WorldState();
    state.shard = this.roomId;
    this.setState(state);
    this.setPatchRate(1000 / NET.patchRate);
    this.spawn.y = Math.max(groundAt(this.spawn.x, this.spawn.z), worldData.seaLevel);
    this.brains = spawnDummies(this.sim, this.spawn, groundAt);
    for (const b of this.brains) this.state.entities.set(b.entity.id, this.newState(b.entity));

    this.onMessage('move', (c, m: MoveMsg) => this.onMove(c, m));
    this.onMessage('cast', (c, m: CastMsg) => this.onCast(c, m));
    this.onMessage('profile', (c, m: Partial<JoinOptions>) => {
      const p = this.players.get(c.sessionId);
      if (!p || !m) return;
      if (m.name !== undefined) p.entity.name = cleanName(m.name);
      if (m.element && ELEMENTS.includes(m.element) && m.element !== p.entity.element) {
        p.entity.element = m.element;
        p.entity.cooldowns.clear();
      }
    });
    this.onMessage('pvp', (c, on: boolean) => {
      const p = this.players.get(c.sessionId);
      if (p) p.entity.pvp = !!on;
    });
    // Dev builds let tests and the free camera move players anywhere.
    if (DEV) {
      this.onMessage('tp', (c, pos: V3) => {
        const p = this.players.get(c.sessionId);
        if (!p || !finite(pos)) return;
        p.entity.pos.set(pos[0], pos[1], pos[2]);
        p.last.copy(p.entity.pos);
        p.lastT = Date.now();
      });
    }
    this.onMessage('ping', (c, t: number) => c.send('pong', { t, s: Date.now() }));
    this.setSimulationInterval((ms) => this.tick(Math.min(ms, 250) / 1000), 1000 / NET.tickRate);
  }

  onJoin(client: Client, options: JoinOptions): void {
    const element = ELEMENTS.includes(options?.element) ? options.element : 'fire';
    // Spread arrivals around the spawn so people don't stack.
    const a = Math.random() * Math.PI * 2;
    const r = 2 + Math.random() * 3;
    const pos = new Vector3(this.spawn.x + Math.cos(a) * r, 0, this.spawn.z + 4 + Math.sin(a) * r);
    pos.y = Math.max(groundAt(pos.x, pos.z), worldData.seaLevel);
    const entity = createEntity({ id: client.sessionId, name: cleanName(options?.name), kind: 'player', team: 'players', element, pos, ...PLAYER_SHAPE });
    this.sim.add(entity);
    this.players.set(client.sessionId, {
      entity, last: pos.clone(), lastT: Date.now(), allowance: 0, lastDodge: -1e9, invSince: -1, swimming: false, aim: new Vector3(0, 0, 1), seq: 0, deadT: 0,
    });
    const st = this.newState(entity);
    this.state.entities.set(entity.id, st);
    client.view = new StateView();
    client.view.add(st);
    const welcome: WelcomeMsg = { id: client.sessionId, shard: this.roomId, spawn: arr(pos), serverTime: Date.now(), tickRate: NET.tickRate };
    client.send('welcome', welcome);
    console.log(`[${this.roomId}] ${entity.name} joined as ${element} (${this.clients.length}/${this.maxClients})`);
  }

  onLeave(client: Client): void {
    const p = this.players.get(client.sessionId);
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
    else if (to.y > ground + mv.maxAboveGround) reject = 'too high';
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
    e.ctx = elementContextAt(sampler, worldData, CFG.elements.water.nearWaterMeters, e.pos, worldDays(Date.now()), p.swimming, e.grounded);
    this.sim.cast(e, m.slot, dir);
  }

  // ---- tick ----------------------------------------------------------------

  private tick(dt: number): void {
    for (const p of this.players.values()) this.sim.updateAim(p.entity, p.aim);
    this.sim.update(dt);
    for (const b of this.brains) updateDummy(b, dt, this.sim, groundAt);
    const events = this.sim.drain();

    for (const p of this.players.values()) {
      const e = p.entity;
      // Respawn after a short delay at the shard's spawn point.
      if (e.dead) {
        p.deadT += dt;
        if (p.deadT > 3) {
          p.deadT = 0;
          e.pos.copy(this.spawn);
          p.last.copy(this.spawn);
          this.sim.revive(e);
          events.push(...this.sim.drain());
        }
      }
    }
    for (const ev of events) {
      if (ev.t === 'dash') {
        const p = this.players.get(ev.owner);
        if (p) p.allowance += ev.distance + ev.lift;
      }
    }

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
    }
  }

  private newState(e: SimEntity): EntityState {
    const st = new EntityState();
    st.id = e.id;
    st.kind = e.kind;
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
  }
}
