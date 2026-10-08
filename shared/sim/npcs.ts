// Faction NPC members: vendors, trainers and envoys stand at their stalls,
// guards hold the gate, patrols walk the hub outskirts and fight the other side.
// Shared so the server and the offline client run the same behaviour.
import { Vector3 } from 'three';
import { mulberry32 } from '../noise';
import { FACTIONS, NPC_CFG, type Faction } from '../factions';
import { CombatSim, createEntity, center, canHarm, KITS, type SimEntity } from './combatSim';
import type { ElementId, Slot } from '../combat';

export type NpcRole = 'vendor' | 'trainer' | 'quest' | 'guard' | 'fighter';

export interface NpcBrain {
  entity: SimEntity;
  role: NpcRole;
  home: Vector3;
  patrolRadius: number;
  waypoint: Vector3;
  target: string | null;
  thinkT: number;
  respawnT: number;
  vel: Vector3;
  /** players who hit this NPC recently -> seconds left */
  grudges: Map<string, number>;
}

const ELEMENTS: ElementId[] = ['fire', 'water', 'earth', 'air'];
const CAPSULE = { radius: 0.45, height: 1.8 };

export function spawnNpcs(sim: CombatSim, groundAt: (x: number, z: number) => number, factions: Faction[] = FACTIONS): NpcBrain[] {
  const brains: NpcBrain[] = [];
  const rand = mulberry32(4242);
  for (const f of factions) {
    const names = [...NPC_CFG.names[f.side]];
    NPC_CFG.roster.forEach((r, i) => {
      const role = r.role as NpcRole;
      const home = new Vector3(f.hub.x + r.offset[0], 0, f.hub.z + r.offset[1]);
      home.y = groundAt(home.x, home.z);
      const name = names.splice(Math.floor(rand() * names.length), 1)[0] ?? 'Nameless';
      const hp = NPC_CFG.health[role];
      const e = createEntity({
        id: `npc_${f.id}_${i}`, name, kind: 'npc', team: f.side, faction: f.id, side: f.side, role, title: r.title,
        element: ELEMENTS[Math.floor(rand() * 4)], level: NPC_CFG.level[role], hp, maxHp: hp, pos: home.clone(), ...CAPSULE,
      });
      // Face the plaza centre.
      e.yaw = Math.atan2(f.hub.x - home.x, f.hub.z - home.z);
      sim.add(e);
      brains.push({
        entity: e, role, home, patrolRadius: (r as { patrolRadius?: number }).patrolRadius ?? 0, waypoint: home.clone(),
        target: null, thinkT: rand() * NPC_CFG.thinkEvery, respawnT: 0, vel: new Vector3(), grudges: new Map(),
      });
    });
  }
  return brains;
}

const tmp = new Vector3();

export function updateNpc(b: NpcBrain, dt: number, sim: CombatSim, groundAt: (x: number, z: number) => number): void {
  const e = b.entity;
  if (e.dead) {
    b.respawnT += dt;
    b.target = null;
    if (b.respawnT >= NPC_CFG.respawnSeconds) {
      b.respawnT = 0;
      e.pos.copy(b.home);
      sim.revive(e);
    }
    return;
  }
  // Remember who hit us (the events for this tick are still queued on the sim).
  for (const ev of sim.events) if (ev.t === 'hit' && ev.target === e.id && ev.source && ev.result !== 'dodged') b.grudges.set(ev.source, 20);
  for (const [k, v] of b.grudges) v - dt <= 0 ? b.grudges.delete(k) : b.grudges.set(k, v - dt);

  // Knockback.
  b.vel.addScaledVector(e.pendingImpulse.setY(0), 0.6);
  e.pendingImpulse.set(0, 0, 0);
  b.vel.multiplyScalar(Math.exp(-dt * 4));
  if (!e.statuses.has('root')) e.pos.addScaledVector(b.vel, dt);

  b.thinkT -= dt;
  if (b.thinkT <= 0) {
    b.thinkT = NPC_CFG.thinkEvery;
    think(b, sim);
  }

  const target = b.target ? sim.entities.get(b.target) : undefined;
  let moveTo: Vector3 | null = null;
  let speed = NPC_CFG.walkSpeed;
  if (target && !target.dead) {
    const d = target.pos.distanceTo(e.pos);
    e.yaw = Math.atan2(target.pos.x - e.pos.x, target.pos.z - e.pos.z);
    if (d > NPC_CFG.attackRange * 0.75) {
      moveTo = target.pos;
      speed = NPC_CFG.runSpeed;
    } else attack(b, target, sim);
  } else if (b.role === 'fighter') {
    if (Math.hypot(b.waypoint.x - e.pos.x, b.waypoint.z - e.pos.z) < 1.5) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * b.patrolRadius;
      b.waypoint.set(b.home.x + Math.cos(a) * r, 0, b.home.z + Math.sin(a) * r);
    }
    moveTo = b.waypoint;
  } else if (e.pos.distanceTo(b.home) > 1) moveTo = b.home;
  else {
    // Idle: turn toward a nearby player, otherwise keep our post's facing.
    let near: SimEntity | null = null;
    let best = 7;
    for (const o of sim.entities.values()) {
      if (o.kind !== 'player' || o.dead) continue;
      const d = o.pos.distanceTo(e.pos);
      if (d < best) {
        best = d;
        near = o;
      }
    }
    if (near) e.yaw = turn(e.yaw, Math.atan2(near.pos.x - e.pos.x, near.pos.z - e.pos.z), dt * 4);
  }

  if (moveTo && !e.statuses.has('root') && !e.statuses.has('stagger')) {
    tmp.set(moveTo.x - e.pos.x, 0, moveTo.z - e.pos.z);
    const d = tmp.length();
    if (d > 0.3) {
      const slow = e.statuses.get('slow');
      const step = Math.min(d, speed * (slow ? 1 - slow.amount : 1) * dt);
      e.pos.addScaledVector(tmp.normalize(), step);
      if (!target) e.yaw = turn(e.yaw, Math.atan2(tmp.x, tmp.z), dt * 8);
    }
  }
  e.pos.y = groundAt(e.pos.x, e.pos.z);
}

function turn(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, k);
}

function think(b: NpcBrain, sim: CombatSim): void {
  const e = b.entity;
  // Leash: give up and walk home if pulled too far from the post.
  if (e.pos.distanceTo(b.home) > NPC_CFG.leashRange + b.patrolRadius) {
    b.target = null;
    b.waypoint.copy(b.home);
    return;
  }
  const cur = b.target ? sim.entities.get(b.target) : undefined;
  if (cur && !cur.dead && canHarm(e, cur, sim.time) && cur.pos.distanceTo(e.pos) < NPC_CFG.leashRange) return;
  b.target = null;
  if (b.role === 'vendor' || b.role === 'trainer' || b.role === 'quest') return;
  let best = Infinity;
  for (const o of sim.entities.values()) {
    if (o.dead || o.kind === 'dummy' || !canHarm(e, o, sim.time)) continue;
    const d = o.pos.distanceTo(e.pos);
    // Patrols pick fights with the other side; guards only answer people who attack them.
    const wants = b.grudges.has(o.id) || (b.role === 'fighter' && o.kind === 'player' && o.side !== e.side && d < NPC_CFG.aggroRange);
    if (wants && d < best) {
      best = d;
      b.target = o.id;
    }
  }
}

function attack(b: NpcBrain, target: SimEntity, sim: CombatSim): void {
  const e = b.entity;
  if (!e.element || e.statuses.has('stagger')) return;
  const kit = KITS[e.element];
  // Prefer the heavy when it's ready, otherwise basic attacks.
  const order: Slot[] = ['heavy', 'control', 'basic'];
  const from = center(e);
  const dir = center(target).sub(from).normalize();
  for (const slot of order) {
    const def = kit.abilities.find((a) => a.slot === slot);
    if (!def || (e.cooldowns.get(slot) ?? 0) > 0 || e.chi < def.chiCost) continue;
    if (def.kind === 'melee' && target.pos.distanceTo(e.pos) > (def.range ?? 4)) continue;
    if ((def.kind === 'ring' || def.kind === 'cone') && target.pos.distanceTo(e.pos) > (def.radius ?? def.range ?? 6)) continue;
    // Small pause between NPC casts so they read as people, not turrets.
    if (sim.time - e.lastCombat < 0.9 && slot === 'basic') return;
    sim.cast(e, slot, dir);
    return;
  }
}
