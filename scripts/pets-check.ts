// Phase 10 rules without a browser: solid trees and rocks, wildlife dens and
// XP, taming, feeding, mounts, bosses (telegraphs, shared rewards), the Bond
// Trial with its pity timer, Beastkeeper quests and hub NPC advice.
// Run: npx tsx scripts/pets-check.ts
import { Vector3 } from 'three';
import { TerrainSampler } from '../shared/terrain';
import { FACTIONS, terrainConfig, zoneAt } from '../shared/factions';
import worldData from '../data/world.json';
import { CombatSim, canHarm, createEntity, type SimEntity, type SimEvent } from '../shared/sim/combatSim';
import { Obstacles, chunkProps } from '../shared/props';
import { WILD, BOSSES, BOSS_CFG, Wildlife, bondChance, densNear, hubDistance, speciesById, type WildNews, type WildPlayer } from '../shared/sim/wildlife';
import { PET_RULES, PetRules, fedNow, petDef, sanitizePets, type PetOwner } from '../shared/pets';
import { XpRules, newProgress, pointsEarned } from '../shared/progression';
import { adviceFor } from '../shared/advice';

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};

const t = new TerrainSampler(terrainConfig());
const groundAt = (x: number, z: number) => t.height(x, z);
const obstacles = new Obstacles(t);
const hub = FACTIONS[0].hub;

function player(id: string, x: number, z: number, element: SimEntity['element'] = 'fire', level = 10): SimEntity {
  return createEntity({ id, name: id, kind: 'player', team: 'players', element, level, pos: new Vector3(x, groundAt(x, z), z), radius: 0.55, height: 1.8, side: 'order', faction: 'sentinel', hp: 500, maxHp: 500 });
}
function step(sim: CombatSim, seconds: number, each?: (events: SimEvent[]) => void): SimEvent[] {
  const all: SimEvent[] = [];
  for (let s = 0; s < seconds; s += 0.05) {
    sim.update(0.05);
    const ev = sim.drain();
    each?.(ev);
    all.push(...ev);
  }
  return all;
}

// ---- solid trees and rocks -------------------------------------------------------
{
  const a = JSON.stringify(chunkProps(t, 3, -2));
  ok(a === JSON.stringify(chunkProps(t, 3, -2)), 'props are a pure function of the seed (client, server and build agree)');
  let tree = null;
  for (let r = 150; r < 900 && !tree; r += 20) tree = obstacles.near(hub.x + r, hub.z + 40, 12).find((o) => o.type !== 'rock') ?? null;
  ok(!!tree, `found a tree trunk near ${tree?.x.toFixed(0)}, ${tree?.z.toFixed(0)}`);
  if (tree) {
    ok(!!obstacles.hit(tree.x, tree.y + 1.2, tree.z, 0.3), 'a point inside the trunk hits it');
    ok(!obstacles.hit(tree.x + tree.radius + 2, tree.y + 1.2, tree.z, 0.3), 'two metres beside it is clear');
    // A fireball thrown at the trunk stops there instead of flying through.
    const sim = new CombatSim(groundAt);
    sim.obstacleAt = (x, y, z, r) => obstacles.hit(x, y, z, r);
    const me = player('p1', tree.x - 8, tree.z);
    sim.add(me);
    me.pos.y = groundAt(me.pos.x, me.pos.z);
    sim.cast(me, 'basic', new Vector3(1, 0, 0));
    const ev = step(sim, 2);
    const end = ev.find((e): e is Extract<SimEvent, { t: 'projEnd' }> => e.t === 'projEnd');
    ok(!!end && Math.abs(end.pos[0] - tree.x) < tree.radius + 1.2, `projectile ends at the trunk (x ${end?.pos[0].toFixed(1)} vs tree ${tree.x.toFixed(1)})`);
  }
}

// ---- dens and creatures ---------------------------------------------------------------
const dens = densNear(hub.x, hub.z, 900);
ok(dens.length > 5, `${dens.length} dens within 900 m of the first hub`);
ok(JSON.stringify(dens) === JSON.stringify(densNear(hub.x, hub.z, 900)), 'dens are deterministic');
ok(dens.every((d) => hubDistance(d.x, d.z) >= WILD.minHubDistance), 'no den inside a hub');
const far = [...dens].sort((a, b) => hubDistance(b.x, b.z) - hubDistance(a.x, a.z))[0];
const near = [...dens].sort((a, b) => hubDistance(a.x, a.z) - hubDistance(b.x, b.z))[0];
ok(far.level >= near.level, `creatures get tougher away from hubs (L${near.level} near, L${far.level} far)`);

{
  const sim = new CombatSim(groundAt);
  const wild = new Wildlife(sim, groundAt);
  const d = dens.find((x) => zoneAt(x.x, x.z).kind === 'wilds')!;
  const me = player('p1', d.x + 30, d.z, 'fire', Math.max(1, d.level));
  sim.add(me);
  const wp: WildPlayer = { entity: me, progress: newProgress({ level: me.level }) };
  wild.update(1.1, [wp]);
  const mine = [...sim.entities.values()].filter((e) => e.kind === 'creature' && (wild.brains.get(e.id) as { den?: { id: string } } | undefined)?.den?.id === d.id);
  ok(mine.length === d.count, `walking near a den fills it (${mine.length} ${speciesById(d.species)?.name})`);
  const c = mine[0];
  ok(c.level === d.level && c.bounty > 0, `creature level ${c.level}, bounty ${c.bounty} XP`);
  const other = mine.find((x) => x !== c) ?? c;
  ok(canHarm(me, c) && canHarm(c, me), 'players and wild creatures can fight in the Wilds');
  if (other !== c) ok(!canHarm(c, other), 'creatures never fight each other');
  const safe = player('p2', hub.x, hub.z);
  const lurker = createEntity({ id: 'w', name: 'w', kind: 'creature', team: 'wild', pos: new Vector3(hub.x + 2, 0, hub.z) });
  ok(!canHarm(lurker, safe) && !canHarm(safe, lurker), 'nothing fights inside a safe hub');
  // Kill it: XP from its bounty, loot from the wildlife.
  const xp = new XpRules().onKill(c, { entity: me, progress: wp.progress, respawnedAt: -99 }, new Map(), [me.id], sim.time);
  ok(xp.length === 1 && xp[0].amount > 0, `killing a ${c.name} gives ${xp[0]?.amount} XP`);
  const loot = wild.onDeath(c.id, me.id, new Map([[me.id, wp]]));
  ok(loot.some((n) => n.t === 'loot' && (n.items.meat ?? 0) > 0), `and loot: ${JSON.stringify(loot.find((n) => n.t === 'loot'))}`);
  // Leaving empties the den.
  me.pos.set(d.x + 2000, 0, d.z);
  for (const e of mine) e.lastCombat = -100;
  wild.update(1.1, [wp]);
  ok(mine.every((e) => !sim.entities.has(e.id)), 'dens empty when nobody is around');
}

// ---- taming, feeding, pets and mounts ---------------------------------------------
{
  const sim = new CombatSim(groundAt);
  const wild = new Wildlife(sim, groundAt);
  const pets = new PetRules(sim, wild, groundAt);
  const d = dens.find((x) => speciesById(x.species)?.tame === 'foxhound') ?? dens.find((x) => speciesById(x.species)?.tame)!;
  const me = player('p1', d.x + 4, d.z, 'fire', 12);
  sim.add(me);
  const o: PetOwner = { entity: me, progress: newProgress({ level: 12 }) };
  wild.update(1.1, [o]);
  ok(typeof pets.startTame(o, null) === 'string' && /food/.test(pets.startTame(o, null) as string), 'taming needs food');
  o.progress.inv.berries = 2;
  // Walk right up to one.
  const animal = [...sim.entities.values()].find((e) => e.kind === 'creature' && speciesById(e.beast)?.tame)!;
  me.pos.copy(animal.pos).add(new Vector3(2, 0, 0));
  const game = pets.startTame(o, null);
  ok(typeof game === 'object' && game.hits > 0, `feeding a ${animal.name} starts the trust game (${typeof game === 'object' ? `${game.hits} hits, ${game.misses} misses` : game})`);
  ok(o.progress.inv.berries === 1, 'it ate one berry');
  ok(pets.finishTame(o, true, Date.now()).warn, 'finishing instantly is rejected (minimum time)');
  me.pos.copy(animal.pos).add(new Vector3(2, 0, 0));
  pets.startTame(o, null);
  step(sim, PET_RULES.trust.common.minSeconds + 0.2);
  const won = pets.finishTame(o, true, Date.now());
  ok(!won.warn && o.progress.pets.owned.length === 1 && o.progress.pets.active, `won: "${won.text}"`);
  ok(!sim.entities.has(animal.id), 'the wild animal left the world to join you');
  // Out with you: a pet entity at your level.
  const now = Date.now();
  pets.sync(o, now);
  const pet = pets.petOf(me.id)!;
  ok(pet && pet.kind === 'pet' && pet.level === me.level && pet.owner === me.id, `pet ${pet?.name} is out at level ${pet?.level}`);
  ok(!canHarm(pet, me) && !canHarm(me, pet), 'your pet and you never hurt each other');
  // It follows you.
  me.pos.x += 12;
  for (let i = 0; i < 60; i++) {
    sim.update(0.05);
    sim.drain();
    pets.update(0.05, new Map([[me.id, o]]), now);
  }
  ok(Math.hypot(pet.pos.x - me.pos.x, pet.pos.z - me.pos.z) < 5, `it follows (${Math.hypot(pet.pos.x - me.pos.x, pet.pos.z - me.pos.z).toFixed(1)} m behind)`);
  // Hunger runs on wall time.
  const p = o.progress.pets.owned[0];
  const later = now + 10 * 3_600_000;
  ok(fedNow(p, later) < fedNow(p, now), `hunger: ${fedNow(p, now).toFixed(0)}% now, ${fedNow(p, later).toFixed(0)}% in 10 h`);
  o.progress.inv.meat = 1;
  const before = fedNow(p, later);
  const fedMsg = pets.feed(o, p.uid, later);
  ok(Math.round(fedNow(p, later) - before) === PET_RULES.food.meat, `feeding meat: "${fedMsg}"`);
  ok(!!pets.toggleMount(o, now), 'a fox-hound is not a mount');
  ok(sanitizePets(JSON.parse(JSON.stringify(o.progress.pets))).owned.length === 1, 'pets survive a save/load');
  ok(sanitizePets({ owned: [{ uid: 'x', kind: 'dragon_of_doom' }] }).owned.length === 0, 'unknown pets are dropped on load');
  // A mount: give the rare rhino straight away.
  const rhino = petDef('rhino')!;
  const r = pets.addPet(o, rhino, now);
  pets.setActive(o, r.uid);
  pets.sync(o, now);
  me.lastCombat = -100;
  const err = pets.toggleMount(o, now);
  ok(!err && pets.mountOf(me.id)?.speed === rhino.mount!.speed, `riding the ${rhino.name}: x${pets.mountOf(me.id)?.speed} speed${err ? ` (${err})` : ''}`);
  // A big hit throws you off.
  sim.events.push({ t: 'hit', target: me.id, source: 'x', amount: me.maxHp * 0.3, element: 'fire', result: 'hit' });
  pets.update(0.05, new Map([[me.id, o]]), now);
  ok(!pets.isMounted(me.id), 'a heavy hit knocks you off your mount');
}

// ---- bosses ------------------------------------------------------------------------------
ok(BOSSES.length >= 10, `${BOSSES.length} bosses (${BOSSES.filter((b) => b.tier === 'mini').length} rare beasts, ${BOSSES.filter((b) => b.tier === 'world').length} world, ${BOSSES.filter((b) => b.tier === 'legendary').length} legendary)`);
{
  const sim = new CombatSim(groundAt);
  const wild = new Wildlife(sim, groundAt);
  const def = BOSSES.find((b) => b.tier === 'world')!;
  const a = player('a', def.x + 10, def.z, 'fire', def.level);
  const b = player('b', def.x - 10, def.z, 'water', def.level);
  const c = player('c', def.x + 2000, def.z, 'earth', def.level);
  for (const e of [a, b, c]) sim.add(e);
  const ps = new Map<string, WildPlayer>([a, b, c].map((e) => [e.id, { entity: e, progress: newProgress({ level: def.level }) }]));
  const boss = wild.forceBoss(def.id)!;
  ok(!!boss && boss.role === 'boss', `raised the ${def.name}`);
  // It telegraphs before its big moves.
  const teles: SimEvent[] = [];
  for (let i = 0; i < 1600 && !teles.length; i++) {
    sim.update(0.05);
    wild.update(0.05, [...ps.values()]);
    teles.push(...sim.drain().filter((e) => e.t === 'tele'));
  }
  ok(teles.length > 0, `it telegraphs its moves (${teles[0]?.t === 'tele' ? teles[0].shape : 'none'})`);
  ok(boss.maxHp >= def.minHp, `HP ${boss.maxHp} for 2 challengers (min ${def.minHp}, +${def.hpPerPlayer}/player)`);
  // Shared rewards: a's big share, b's tiny one, c far away.
  boss.damagers!.set('a', boss.maxHp * 0.6);
  boss.damagers!.set('b', boss.maxHp * BOSS_CFG.contributionMin * 0.5);
  boss.damagers!.set('c', boss.maxHp * 0.4);
  boss.dead = true;
  const news = wild.onDeath(boss.id, 'a', ps);
  const got = (id: string) => news.filter((n): n is Extract<WildNews, { t: 'xp' }> => n.t === 'xp' && n.id === id);
  ok(got('a').length === 1 && got('a')[0].amount > 0, `a top damager gets ${got('a')[0]?.amount} XP and loot`);
  ok(got('b').length === 0, `under ${BOSS_CFG.contributionMin * 100}% contribution gets nothing`);
  ok(got('c').length === 0, `out of the ${BOSS_CFG.rewardRadius} m reward radius gets nothing`);
  ok(news.some((n) => n.t === 'announce'), 'the kill is announced');
}

// ---- legendary: bond chance with pity, then the Bond Trial ---------------------------
ok(bondChance(0) === BOSS_CFG.bond.baseChance && bondChance(3) > bondChance(0) && bondChance(1000) === BOSS_CFG.bond.maxChance, `bond chance ${bondChance(0)} -> ${bondChance(3).toFixed(2)} after 3 misses, capped at ${BOSS_CFG.bond.maxChance}`);
{
  const sim = new CombatSim(groundAt);
  const wild = new Wildlife(sim, groundAt);
  const pets = new PetRules(sim, wild, groundAt);
  const def = BOSSES.find((b) => b.tier === 'legendary')!;
  const me = player('me', def.x + 10, def.z, def.element, def.level);
  const other = player('other', def.x - 10, def.z, def.element === 'fire' ? 'water' : 'fire', def.level);
  sim.add(me);
  sim.add(other);
  const o = { entity: me, progress: newProgress({ level: def.level }) };
  const ps = new Map<string, WildPlayer>([[me.id, o], [other.id, { entity: other, progress: newProgress({ level: def.level }) }]]);
  wild.forceBond = false;
  let boss = wild.forceBoss(def.id)!;
  boss.damagers!.set(me.id, boss.maxHp * 0.5);
  boss.damagers!.set(other.id, boss.maxHp * 0.5);
  let news = wild.onDeath(boss.id, me.id, ps);
  ok(o.progress.pets.pity[def.id] === 1, `a failed roll raises the pity counter (${o.progress.pets.pity[def.id]})`);
  ok(!news.some((n) => n.t === 'bond' && n.id === other.id) && !ps.get(other.id)!.progress.pets.pity[def.id], 'other elements never roll for the bond');
  wild.forceBond = true;
  boss = wild.forceBoss(def.id)!;
  boss.damagers!.set(me.id, boss.maxHp);
  news = wild.onDeath(boss.id, me.id, ps);
  const bond = news.find((n): n is Extract<WildNews, { t: 'bond' }> => n.t === 'bond');
  ok(!!bond && o.progress.pets.pity[def.id] === 0, `the bond answers (${bond?.pet}); pity resets`);
  const msg = pets.startTrial(o, def.id);
  const spirit = [...sim.entities.values()].find((e) => e.trialOf === me.id)!;
  ok(!!msg && !!spirit, `"${msg}"`);
  ok(canHarm(me, spirit) && !canHarm(other, spirit) && !canHarm(spirit, other), 'the trial is a duel: nobody else can join');
  spirit.dead = true;
  news = wild.onDeath(spirit.id, me.id, ps);
  const trial = news.find((n): n is Extract<WildNews, { t: 'trial' }> => n.t === 'trial')!;
  ok(trial?.won, 'beating the spirit wins the trial');
  const text = pets.endTrial(o, trial.pet, trial.won, Date.now());
  const legend = o.progress.pets.owned.find((p) => p.kind === trial.pet);
  ok(!!legend && petDef(legend.kind)?.tier === 'legendary', `"${text}"`);
  pets.sync(o, Date.now());
  ok(me.aura > 1, `the legendary aura raises ${me.element} power x${me.aura.toFixed(2)} while it is out`);
}

// ---- Beastkeeper quest -> rare beast -> young one's trust ------------------------------
{
  const sim = new CombatSim(groundAt);
  const wild = new Wildlife(sim, groundAt);
  const pets = new PetRules(sim, wild, groundAt);
  const low = player('low', hub.x, hub.z, 'earth', 2);
  ok(/level/.test(pets.keeperTalk({ entity: low, progress: newProgress({ level: 2 }) })), 'Beastkeepers send low levels to tame common animals first');
  const me = player('me', hub.x, hub.z, 'earth', 30);
  const o = { entity: me, progress: newProgress({ level: 30 }) };
  const line = pets.keeperTalk(o);
  const quest = Object.keys(o.progress.pets.quests)[0];
  ok(!!quest, `quest started: "${line}"`);
  const guard = BOSSES.find((b) => b.pet === quest)!;
  me.pos.set(guard.x + 5, groundAt(guard.x + 5, guard.z), guard.z);
  sim.add(me);
  const boss = wild.forceBoss(guard.id)!;
  boss.damagers!.set(me.id, boss.maxHp);
  const news = wild.onDeath(boss.id, me.id, new Map([[me.id, o]]));
  const rare = news.find((n): n is Extract<WildNews, { t: 'rare' }> => n.t === 'rare');
  const game = rare && pets.offerRare(o, rare.pet);
  ok(!!game && game.hits >= PET_RULES.trust.rare.hits, `the ${guard.name} leaves a young ${petDef(quest)?.name} (trust game: ${game?.hits} hits)`);
}

// ---- hub NPC advice ---------------------------------------------------------------------
{
  const me = player('me', hub.x, hub.z, 'fire', 6);
  const progress = newProgress({ level: 6 });
  const now = Date.now();
  const seen = new Set<string>();
  for (const role of ['trainer', 'quest', 'vendor', 'guard', 'fighter', 'beast']) {
    const lines = new Set<string>();
    for (let seed = 0; seed < 8; seed++) lines.add(adviceFor({ role, me, progress, now, night: 0, seed }));
    for (const l of lines) seen.add(l);
    ok([...lines].every((l) => l.length > 20), `${role}: ${lines.size} lines, e.g. "${[...lines][0]}"`);
  }
  const trainerLines = new Set<string>();
  for (let seed = 0; seed < 8; seed++) trainerLines.add(adviceFor({ role: 'trainer', me, progress, now, night: 0, seed }));
  ok([...trainerLines].some((l) => l.includes(`${pointsEarned(6)} unspent mastery points`)), 'trainers point out unspent mastery points');
  const questLines = new Set<string>();
  for (let seed = 0; seed < 8; seed++) questLines.add(adviceFor({ role: 'quest', me, progress, now, night: 0, seed }));
  ok([...questLines].some((l) => /roam (to the )?(north|south|east|west)/.test(l) || /around level/.test(l)), 'quest givers point to hunting grounds at your level');
  progress.pets.owned.push({ uid: 'u', kind: 'foxhound', name: 'Ember', fed: 10, fedAt: now });
  progress.pets.active = 'u';
  const beast = new Set<string>();
  for (let seed = 0; seed < 8; seed++) beast.add(adviceFor({ role: 'beast', me, progress, now, night: 0, seed }));
  ok([...beast].some((l) => /Ember is starving/.test(l)), 'Beastkeepers notice a hungry pet');
}

void worldData;
console.log(fails ? `\n${fails} FAILED` : '\nall pets/wildlife checks passed');
process.exit(fails ? 1 : 0);
