// Pets and mounts (Phase 10, DESIGN section 11): owned pets live in Progress,
// the active one is a sim entity that follows its owner and fights what they
// fight. Taming, feeding, mounting and the Bond Trial rules live here so the
// shard server and offline play share them.
import { Vector3 } from 'three';
import rules from '../data/pets/rules.json';
import bossData from '../data/bosses.json';
import commonData from '../data/pets/common.json';
import rareData from '../data/pets/rare.json';
import legendaryData from '../data/pets/legendary.json';
import { CombatSim, createEntity, center, canHarm, handOf, type SimEntity } from './sim/combatSim';
import { attackAbility, speciesById, bossById, theName, type CreatureAttack, type Wildlife, type BossDef } from './sim/wildlife';
import { levelPower, type ElementId } from './combat';
import { takeItems, type Inventory } from './building';
import type { Progress } from './progression';
import { newPetsState, type OwnedPet, type PetsState } from './petsState';

export const PET_RULES = rules;

export interface PetDef {
  id: string;
  name: string;
  tier: 'common' | 'rare' | 'legendary';
  /** species (common), mini boss (rare) or world boss (legendary) it comes from */
  from: string;
  shape: string;
  color: string;
  accent: string;
  scale: number;
  element: ElementId | null;
  hp: number;
  hpPerLevel: number;
  speed: number;
  attack: CreatureAttack & { duration?: number; tick?: number; angle?: number };
  mount?: { speed: number; fly?: boolean; swim?: number };
  aura?: number;
  lightningCharge?: number;
  perk: string;
}
export const PET_DEFS = [...commonData.pets, ...rareData.pets, ...legendaryData.pets] as unknown as PetDef[];
export const petDef = (id: string) => PET_DEFS.find((p) => p.id === id);

export { newPetsState, type OwnedPet, type PetsState };

/** Rebuild a stored pets state, dropping anything unknown. */
export function sanitizePets(raw: unknown): PetsState {
  const s = newPetsState();
  const r = raw && typeof raw === 'object' ? (raw as Partial<PetsState>) : {};
  if (Array.isArray(r.owned)) {
    for (const p of r.owned.slice(0, rules.maxPets)) {
      if (!p || typeof p !== 'object' || !petDef(String(p.kind))) continue;
      s.owned.push({
        uid: String(p.uid).slice(0, 24), kind: String(p.kind), name: String(p.name ?? petDef(String(p.kind))!.name).slice(0, 24),
        fed: Math.max(0, Math.min(100, Number(p.fed) || 0)), fedAt: Number(p.fedAt) || 0,
      });
    }
  }
  if (typeof r.active === 'string' && s.owned.some((p) => p.uid === r.active)) s.active = r.active;
  if (r.quests && typeof r.quests === 'object') for (const [k, v] of Object.entries(r.quests)) if (petDef(k)?.tier === 'rare') s.quests[k] = String(v);
  if (r.pity && typeof r.pity === 'object') for (const [k, v] of Object.entries(r.pity)) if (bossById(k)) s.pity[k] = Math.max(0, Math.floor(Number(v) || 0));
  return s;
}

/** How full a pet is right now (hunger runs on wall time). */
export function fedNow(p: OwnedPet, now: number): number {
  return Math.max(0, Math.min(100, p.fed - (rules.hungerPerHour * Math.max(0, now - p.fedAt)) / 3_600_000));
}

/** The plainest food in the bag (berries before meat before spirit shards). */
export function bestFood(inv: Inventory): string | null {
  const foods = Object.entries(rules.food as Record<string, number>).sort((a, b) => a[1] - b[1]);
  for (const [id] of foods) if ((inv[id] ?? 0) > 0) return id;
  return null;
}

export function petMaxHp(def: PetDef, level: number): number {
  return Math.round(def.hp + def.hpPerLevel * (level - 1));
}

// ---- runtime --------------------------------------------------------------------

/** A player as the pet rules see them. */
export interface PetOwner {
  entity: SimEntity;
  progress: Progress;
  /** wall clock ms */
}

interface PetBrain {
  owner: string;
  uid: string;
  def: PetDef;
  entity: SimEntity;
  target: string | null;
  attackT: number;
  windT: number;
  release: (() => void) | null;
  downUntil: number;
  mounted: boolean;
  lungeT: number;
  lungeDir: Vector3;
}

export interface TameOffer {
  pet: string;
  tier: 'common' | 'rare';
  /** the wild creature being tamed ('' for rare young) */
  creature: string;
  startedAt: number;
  until: number;
}

/** Trust game difficulty for the client. */
export interface TrustGame {
  pet: string;
  name: string;
  hits: number;
  misses: number;
  zone: number;
  speed: number;
}

const tmp = new Vector3();

export class PetRules {
  private brains = new Map<string, PetBrain>();
  private offers = new Map<string, TameOffer>();
  private trials = new Map<string, string>();
  /** owner id -> the boss whose Bond Trial waits for them to get back up (sim time it lapses) */
  private pendingTrials = new Map<string, { boss: string; until: number }>();
  /** Lines for one player's banner the host should deliver (a trial that started late). */
  readonly announcements: Array<{ id: string; text: string }> = [];
  /** owner id -> wall time their knocked-out pet is back */
  private downUntil = new Map<string, number>();
  constructor(private sim: CombatSim, private wild: Wildlife, private groundAt: (x: number, z: number) => number) {}

  /** The pet entity out with this player (if any). */
  petOf(ownerId: string): SimEntity | null {
    return this.brains.get(ownerId)?.entity ?? null;
  }
  mountOf(ownerId: string): PetDef['mount'] | null {
    const b = this.brains.get(ownerId);
    return b?.mounted ? (b.def.mount ?? null) : null;
  }
  isMounted(ownerId: string): boolean {
    return !!this.brains.get(ownerId)?.mounted;
  }

  /** Keep the sim in step with each player's active pet (spawn, swap, level). */
  sync(o: PetOwner, now: number): void {
    const st = o.progress.pets;
    const owned = st.owned.find((p) => p.uid === st.active);
    const cur = this.brains.get(o.entity.id);
    if (cur && (!owned || cur.uid !== owned.uid)) this.despawn(o.entity.id);
    // Aura and lightning perks only while the pet is out.
    const def = owned ? petDef(owned.kind) : undefined;
    o.entity.aura = def?.aura && def.element === o.entity.element ? 1 + def.aura : 1;
    o.entity.chargeScale = def?.lightningCharge ?? 1;
    if (!owned || !def) return;
    let b = this.brains.get(o.entity.id);
    if (!b) {
      if (now < (this.downUntil.get(o.entity.id) ?? 0)) return;
      const hp = petMaxHp(def, o.entity.level);
      const e = createEntity({
        id: `pet_${o.entity.id}`, name: owned.name, kind: 'pet', team: o.entity.team, element: def.element, level: o.entity.level, hp, maxHp: hp,
        pos: o.entity.pos.clone().add(tmp.set(-1.5, 0, -1.5)), radius: 0.45 * def.scale + 0.15, height: 1.2 * def.scale + 0.2, beast: def.id, scale: def.scale,
        owner: o.entity.id, title: `${o.entity.name}'s pet`,
      });
      this.sim.add(e);
      b = { owner: o.entity.id, uid: owned.uid, def, entity: e, target: null, attackT: 1, windT: -1, release: null, downUntil: 0, mounted: false, lungeT: 0, lungeDir: new Vector3() };
      this.brains.set(o.entity.id, b);
    }
    // Pets share their owner's side, flags and protection.
    const e = b.entity;
    e.side = o.entity.side;
    e.faction = o.entity.faction;
    e.pvp = o.entity.pvp;
    e.party = o.entity.party;
    e.protectedUntil = o.entity.protectedUntil;
    e.name = owned.name;
    if (e.level !== o.entity.level) {
      e.level = o.entity.level;
      const hp = petMaxHp(def, e.level);
      e.hp = Math.round((e.hp / e.maxHp) * hp);
      e.maxHp = hp;
    }
    if (b.mounted && fedNow(owned, now) < rules.hungry) b.mounted = false;
  }

  despawn(ownerId: string): void {
    const b = this.brains.get(ownerId);
    if (!b) return;
    // Sent home (or swapped) mid-ride: the rider lands.
    if (b.mounted) this.sim.events.push({ t: 'mount', owner: ownerId, pet: b.entity.id, on: false });
    this.sim.remove(b.entity.id);
    this.brains.delete(ownerId);
  }

  /** A player left: their pet goes home. */
  forget(ownerId: string): void {
    this.despawn(ownerId);
    this.offers.delete(ownerId);
    const t = this.trials.get(ownerId);
    if (t) this.wild.remove(t);
    this.trials.delete(ownerId);
    this.pendingTrials.delete(ownerId);
  }

  /** Pet AI: follow, guard, fight with the owner. */
  update(dt: number, owners: Map<string, PetOwner>, now: number): void {
    // A Bond Trial won while you were down starts once you're back on your feet.
    for (const [ownerId, w] of [...this.pendingTrials]) {
      const o = owners.get(ownerId);
      if (!o || this.sim.time > w.until) this.pendingTrials.delete(ownerId);
      else if (!o.entity.dead) {
        this.pendingTrials.delete(ownerId);
        const text = this.startTrial(o, w.boss);
        if (text) this.announcements.push({ id: ownerId, text });
      }
    }
    for (const [ownerId, b] of [...this.brains]) {
      const o = owners.get(ownerId);
      const e = b.entity;
      if (!o) {
        this.despawn(ownerId);
        continue;
      }
      if (e.dead) {
        // Knocked out: it limps home and comes back later.
        this.despawn(ownerId);
        this.downUntil.set(ownerId, now + rules.reviveSeconds * 1000);
        continue;
      }
      const me = o.entity;
      const owned = o.progress.pets.owned.find((p) => p.uid === b.uid);
      const hungry = !owned || fedNow(owned, now) < rules.hungry;
      // Dying or a heavy hit throws the rider off.
      if (me.dead || this.sim.events.some((ev) => ev.t === 'hit' && ev.target === ownerId && ev.amount > me.maxHp * 0.15)) this.dismount(ownerId);
      if (b.mounted) {
        e.pos.copy(me.pos);
        e.yaw = me.yaw;
        e.windup = 0;
        b.target = null;
        continue;
      }
      // Who to fight: what the owner hits, or whoever hits the owner or the pet.
      for (const ev of this.sim.events) {
        if (ev.t !== 'hit' || ev.result === 'dodged' || !ev.source) continue;
        if (ev.source === ownerId && ev.target !== e.id) b.target = ev.target;
        else if ((ev.target === ownerId || ev.target === e.id) && ev.source !== e.id) b.target = ev.source;
      }
      let t = b.target ? this.sim.entities.get(b.target) : undefined;
      if (t && (t.dead || !canHarm(e, t, this.sim.time) || t.pos.distanceTo(me.pos) > rules.assistRange)) {
        b.target = null;
        t = undefined;
      }
      // Too far behind: catch up.
      if (e.pos.distanceTo(me.pos) > rules.teleportDistance) {
        e.pos.copy(me.pos).add(tmp.set(-1.5, 0, -1.5));
        b.target = null;
        t = undefined;
      }
      const slow = 1 - (e.statuses.get('slow')?.amount ?? 0);
      const speed = b.def.speed * slow;
      let moveTo: Vector3 | null = null;
      let moveSpeed = speed;
      b.attackT -= dt;
      if (b.lungeT > 0) {
        b.lungeT -= dt;
        e.pos.addScaledVector(b.lungeDir, dt * 18);
      } else if (b.windT >= 0) {
        b.windT -= dt;
        e.windup = Math.min(1, 1 - b.windT / Math.max(0.05, b.def.attack.windup));
        if (b.windT < 0) {
          e.windup = 0;
          const r = b.release;
          b.release = null;
          if (!e.statuses.has('stagger')) r?.();
        }
      } else if (t) {
        const a = b.def.attack;
        const d = Math.hypot(t.pos.x - e.pos.x, t.pos.z - e.pos.z) - t.radius - e.radius;
        e.yaw = Math.atan2(t.pos.x - e.pos.x, t.pos.z - e.pos.z);
        if (d > a.range * 0.85) moveTo = t.pos;
        else if (b.attackT <= 0 && !e.statuses.has('stagger')) this.attack(b, t, hungry, o.entity.element);
      } else {
        // Heel: a little behind and to the side of the owner.
        const back = tmp.set(-Math.sin(me.yaw) - Math.cos(me.yaw) * 0.6, 0, -Math.cos(me.yaw) + Math.sin(me.yaw) * 0.6).normalize().multiplyScalar(rules.followDistance).add(me.pos);
        if (Math.hypot(back.x - e.pos.x, back.z - e.pos.z) > 1.2) {
          moveTo = back.clone();
          moveSpeed = Math.min(speed, Math.max(4.5, e.pos.distanceTo(me.pos) * 2));
        }
      }
      if (moveTo && !e.statuses.has('root') && !e.statuses.has('stagger')) {
        tmp.set(moveTo.x - e.pos.x, 0, moveTo.z - e.pos.z);
        const d = tmp.length();
        if (d > 0.3) {
          e.pos.addScaledVector(tmp.normalize(), Math.min(d, moveSpeed * dt));
          if (!t) e.yaw = Math.atan2(tmp.x, tmp.z);
        }
      }
      e.pos.y = Math.max(this.groundAt(e.pos.x, e.pos.z), -0.6);
      // Out of combat pets mend.
      if (this.sim.time - e.lastCombat > 6) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.05 * dt);
    }
  }

  private attack(b: PetBrain, t: SimEntity, hungry: boolean, ownerElement: ElementId | null): void {
    const a = b.def.attack;
    const e = b.entity;
    b.attackT = a.every;
    b.windT = a.windup;
    const el: ElementId = b.def.element ?? (a.status?.type === 'burn' ? 'fire' : a.status?.type === 'slow' ? 'water' : 'earth');
    // Hungry pets hit softly; rare/legendary pets of your element hit harder.
    const scale = (hungry ? rules.hungryDamage : 1) * (b.def.element && b.def.element === ownerElement ? 1 + rules.matchBonus : 1);
    const def = { ...attackAbility(a), damage: a.damage * scale };
    b.release = () => {
      const tt = this.sim.entities.get(t.id);
      if (!tt || tt.dead) return;
      const dir = center(tt).sub(center(e)).normalize();
      if (a.kind === 'charge') {
        b.lungeDir.copy(dir).setY(0).normalize();
        b.lungeT = Math.min(a.distance ?? 6, Math.max(1, e.pos.distanceTo(tt.pos) - 1)) / 18;
        this.sim.later(b.lungeT, () => this.sim.perform(e, { ...def, kind: 'melee', angle: 120 }, b.lungeDir, null, el));
      } else if (a.kind === 'spit') this.sim.spawnProjectile(e, def, el, handOf(e, dir), dir, levelPower(e.level));
      else this.sim.perform(e, def, dir, null, el);
    };
  }

  // ---- stable -----------------------------------------------------------------

  setActive(o: PetOwner, uid: string | null): string | null {
    const st = o.progress.pets;
    if (uid !== null && !st.owned.some((p) => p.uid === uid)) return 'No such pet';
    if (uid !== null && Date.now() < (this.downUntil.get(o.entity.id) ?? 0) && st.active === uid) return 'Your pet is still recovering';
    st.active = uid;
    if (uid === null) this.despawn(o.entity.id);
    return null;
  }

  feed(o: PetOwner, uid: string, now: number): string {
    const p = o.progress.pets.owned.find((x) => x.uid === uid);
    if (!p) return 'No such pet';
    const food = bestFood(o.progress.inv);
    if (!food) return 'You have no pet food (berries from timber, meat from wild animals)';
    const cur = fedNow(p, now);
    if (cur >= 99) return `${p.name} is full`;
    takeItems(o.progress.inv, { [food]: 1 });
    p.fed = Math.min(100, cur + (rules.food as Record<string, number>)[food]);
    p.fedAt = now;
    return `${p.name} ate the ${food.replace('_', ' ')} (${Math.round(p.fed)}% fed)`;
  }

  /** Ride the active pet (mounts only). Returns an error or null. */
  toggleMount(o: PetOwner, now: number): string | null {
    const b = this.brains.get(o.entity.id);
    if (!b) return 'Call out a pet first (pets panel)';
    if (!b.def.mount) return `${b.def.name} can't carry you`;
    if (!b.mounted) {
      const owned = o.progress.pets.owned.find((p) => p.uid === b.uid);
      if (!owned || fedNow(owned, now) < rules.hungry) return `${b.entity.name} is too hungry to carry you`;
      if (b.entity.pos.distanceTo(o.entity.pos) > 6) return 'Get closer to your pet';
      if (this.sim.time - o.entity.lastCombat < 3) return "Can't mount in the middle of a fight";
    }
    b.mounted = !b.mounted;
    this.sim.events.push({ t: 'mount', owner: o.entity.id, pet: b.entity.id, on: b.mounted });
    return null;
  }

  /** Taking a big hit or dying throws you off. */
  dismount(ownerId: string): void {
    const b = this.brains.get(ownerId);
    if (!b?.mounted) return;
    b.mounted = false;
    this.sim.events.push({ t: 'mount', owner: ownerId, pet: b.entity.id, on: false });
  }

  // ---- taming -----------------------------------------------------------------

  /** Feed a tameable creature to start the trust game. */
  startTame(o: PetOwner, creatureId: string | null): TrustGame | string {
    const me = o.entity;
    if (o.progress.pets.owned.length >= rules.maxPets) return `Your stable is full (${rules.maxPets} pets)`;
    let best: SimEntity | null = null;
    let bd = rules.tameRange;
    for (const e of this.sim.entities.values()) {
      if (e.kind !== 'creature' || e.dead || !speciesById(e.beast)?.tame) continue;
      if (creatureId && e.id !== creatureId) continue;
      const d = e.pos.distanceTo(me.pos);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (!best) return 'No animal you can tame close by';
    const sp = speciesById(best.beast)!;
    const def = petDef(sp.tame!)!;
    if (this.sim.time - best.lastCombat < 5) return `The ${sp.name} is too wild after the fight`;
    const food = bestFood(o.progress.inv);
    if (!food) return `You need food to tame a ${sp.name}: berries (timber) or meat (hunting)`;
    takeItems(o.progress.inv, { [food]: 1 });
    const c = rules.trust.common;
    this.offers.set(me.id, { pet: def.id, tier: 'common', creature: best.id, startedAt: this.sim.time, until: this.sim.time + rules.trust.offerSeconds });
    this.wild.calm(best.id, rules.trust.offerSeconds);
    this.sim.events.push({ t: 'tame', target: best.id, owner: me.id, pos: [best.pos.x, best.pos.y, best.pos.z] });
    return { pet: def.id, name: sp.name, hits: c.hits, misses: c.misses, zone: c.zone, speed: c.speed };
  }

  /** A beaten mini boss leaves a young one for a player on its quest. */
  offerRare(o: PetOwner, petId: string): TrustGame | null {
    const def = petDef(petId);
    if (!def || o.progress.pets.quests[petId] !== 'started') return null;
    if (o.progress.pets.owned.length >= rules.maxPets) return null;
    const c = rules.trust.rare;
    this.offers.set(o.entity.id, { pet: petId, tier: 'rare', creature: '', startedAt: this.sim.time, until: this.sim.time + rules.trust.offerSeconds });
    return { pet: petId, name: `young ${def.name}`, hits: c.hits, misses: c.misses, zone: c.zone, speed: c.speed };
  }

  /** The client finished the trust game. */
  finishTame(o: PetOwner, success: boolean, now: number): { text: string; warn?: boolean; pet?: OwnedPet } {
    const offer = this.offers.get(o.entity.id);
    this.offers.delete(o.entity.id);
    if (!offer || this.sim.time > offer.until) return { text: 'The animal lost interest', warn: true };
    const c = offer.tier === 'rare' ? rules.trust.rare : rules.trust.common;
    const def = petDef(offer.pet)!;
    const creature = offer.creature ? this.sim.entities.get(offer.creature) : null;
    if (offer.creature && (!creature || creature.dead)) return { text: 'The animal is gone', warn: true };
    if (!success || this.sim.time - offer.startedAt < c.minSeconds) {
      if (creature) this.wild.calm(creature.id, 0);
      return { text: offer.tier === 'rare' ? `The young ${def.name} doesn't trust you yet. Beat its guardian again to retry.` : `The ${def.name} bolts away. Try again with more food.`, warn: true };
    }
    if (creature) this.wild.remove(creature.id);
    if (offer.tier === 'rare') delete o.progress.pets.quests[def.id];
    const pet = this.addPet(o, def, now);
    return { text: `${def.name} joined you! Open the pets panel to call it out.`, pet };
  }

  addPet(o: PetOwner, def: PetDef, now: number): OwnedPet {
    const st = o.progress.pets;
    const pet: OwnedPet = { uid: `${def.id}_${Math.floor(now / 1000).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, kind: def.id, name: def.name, fed: 80, fedAt: now };
    st.owned.push(pet);
    if (!st.active) st.active = pet.uid;
    return pet;
  }

  // ---- Bond Trial ---------------------------------------------------------------

  startTrial(o: PetOwner, bossId: string): string | null {
    const boss = bossById(bossId) as BossDef | undefined;
    if (!boss?.pet) return null;
    if (this.trials.has(o.entity.id)) return null;
    if (o.entity.dead) {
      // Fell in the last exchange: the spirit waits until you're back up.
      this.pendingTrials.set(o.entity.id, { boss: boss.id, until: this.sim.time + bossData.bond.trialWaitSeconds });
      return `${theName(boss, true)} chose you! Its spirit will find you for a Bond Trial once you're back on your feet.`;
    }
    const e = this.wild.spawnTrial(boss, o.entity, boss.pet);
    this.trials.set(o.entity.id, e.id);
    return `Bond Trial: defeat the Spirit of ${theName(boss)} alone to bond with it!`;
  }

  endTrial(o: PetOwner, petId: string, won: boolean, now: number): string {
    this.trials.delete(o.entity.id);
    const def = petDef(petId);
    if (!def) return '';
    if (!won) return `The spirit fades. The ${def.name} did not bond with you this time.`;
    if (o.progress.pets.owned.some((p) => p.kind === def.id)) return `The ${def.name} honours you, but it is already your companion.`;
    this.addPet(o, def, now);
    return `The ${def.name} has bonded with you! Legendary companion gained.`;
  }

  // ---- rare quests (Beastkeepers) ----------------------------------------------

  /** Talk to a Beastkeeper: start or explain the next rare pet quest. */
  keeperTalk(o: PetOwner): string {
    const st = o.progress.pets;
    const rares = PET_DEFS.filter((p) => p.tier === 'rare');
    const active = rares.find((p) => st.quests[p.id] === 'started');
    const guard = (p: PetDef) => bossById(p.from);
    if (active) {
      const g = guard(active)!;
      return `${theName(g, true)} guards a young ${active.name}. Beat it (friends welcome), then earn the young one's trust. ${dirText(o.entity, g.x, g.z)}`;
    }
    const next = rares.find((p) => !st.owned.some((x) => x.kind === p.id));
    if (!next) return "You've raised every rare beast I know of. Only the legends remain: the four great spirits rise as world bosses.";
    const g = guard(next)!;
    if (o.entity.level < g.level - 4) return `Come back at level ${g.level - 4}. Until then, tame a Fox-hound, Shellback Tortoise or Glider Lemur: feed it berries or meat (G), then win its trust.`;
    st.quests[next.id] = 'started';
    return `A young ${next.name} needs a keeper. Its mother, ${g.name}, won't give it up without a fight. ${dirText(o.entity, g.x, g.z)}`;
  }
}

function dirText(from: SimEntity, x: number, z: number): string {
  const d = Math.hypot(x - from.pos.x, z - from.pos.z);
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const a = Math.atan2(x - from.pos.x, -(z - from.pos.z));
  const i = Math.round((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return `Head ${names[i]}, about ${d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`}.`;
}


