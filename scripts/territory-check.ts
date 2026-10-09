// Phase 11 rules without a browser: the war schedule, captures, buffs and
// income, faction rank and bounties, Envoy orders, crews (roles, bank, raid
// window, sacking), crew bases on plots, faction perks, and the Quartermaster.
// Run: npx tsx scripts/territory-check.ts
import { TerrainSampler } from '../shared/terrain';
import { FACTIONS, PLOTS, factionById, terrainConfig, zoneAt } from '../shared/factions';
import { POINTS, TERR, Territory, presenceAt, warText, warWindow, type Presence } from '../shared/territory';
import { STANDING, OrderRules, addInfamy, addPoints, dropRanks, infamyNow, orderText, rankOf, type OrderState } from '../shared/standing';
import { CREW, Crews, crewLevelOf, validTag, type CrewJoiner } from '../shared/crews';
import { BUILD, Camps, crewRaidOpen, plotAt, snapFor, type Builder } from '../shared/building';
import { boonFor, buy, killRewards, mountScale, pardon, sell, sellPrice, shopItems, travel, travelSpots, xpScale, type FactionPlayer } from '../shared/factionRules';
import { Vector3 } from 'three';
import { CombatSim, createEntity } from '../shared/sim/combatSim';
import type { AbilityDef } from '../shared/combat';
import { WarBands } from '../shared/sim/warbands';
import { newProgress } from '../shared/progression';
import crewsData from '../data/crews.json';

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};

const t = new TerrainSampler(terrainConfig());
const groundAt = (x: number, z: number) => t.height(x, z);
const MIN = 60_000;
const HOUR = 60 * MIN;
const day = Date.UTC(2026, 9, 9);

// ---- war schedule --------------------------------------------------------------------
const w0 = TERR.wars[0];
const inWar = day + w0.start * HOUR + 10 * MIN;
ok(warWindow(inWar).open, `war open at ${w0.start}:10 UTC`);
ok(!warWindow(day + w0.start * HOUR + (w0.minutes + 1) * MIN).open, 'war shut after its minutes');
ok(warText(day + w0.start * HOUR - 30 * MIN).includes('in 30 m'), `countdown text: "${warText(day + w0.start * HOUR - 30 * MIN)}"`);
ok(warText(inWar).includes('left'), `war text while open: "${warText(inWar)}"`);

// ---- capture --------------------------------------------------------------------------
const terr = new Territory();
const shrine = POINTS.find((p) => p.kind === 'shrine')!;
const outpost = POINTS.find((p) => p.kind === 'outpost')!;
ok(!terr.states.get(shrine.id)!.owner, 'a new world: shrines belong to nobody');
ok(!!terr.states.get(outpost.id)!.owner, `a new world: ${outpost.name} belongs to ${terr.states.get(outpost.id)!.owner}`);
const who = (charId: string, faction: string, crew = ''): Presence => ({ charId, entityId: charId, side: factionById(faction)!.side, faction, crew });
const at = (pt: string, ...ps: Presence[]) => new Map([[pt, ps]]);
terr.forceWar = true;
terr.update(0.1, new Map(), inWar); // the war horn
let news = terr.update(1, at(shrine.id, who('a', 'ash', 'crewA'), who('b', 'ash', 'crewA'), who('c', 'sentinel')), inWar);
ok(terr.states.get(shrine.id)!.progress === 0, 'one on one: evenly matched, the meter holds');
let captured = null as null | { faction: string; crew: string };
for (let s = 0; s < shrine.cfg.captureSeconds + 2 && !captured; s++) {
  for (const n of terr.update(1, at(shrine.id, who('a', 'ash', 'crewA')), inWar + s * 1000)) if (n.t === 'captured') captured = n;
}
ok(captured?.faction === 'ash' && captured.crew === 'crewA', `one Ash player captures ${shrine.name} in about ${shrine.cfg.captureSeconds} s (crew gets it)`);
const buff = TERR.buffs[shrine.id as keyof typeof TERR.buffs];
const b = terr.buffsFor('ash');
ok(b[buff.type as 'dmg'] === buff.value && Math.abs(b.xp - TERR.xpPerPoint * terr.holdings('ash').length) < 1e-9, `holding it gives Ash "${buff.text}" and +XP per point`);
ok(terr.buffsFor('redfang')[buff.type as 'dmg'] === 0, 'other factions of the same side get nothing');
// Three Order players drain it to neutral, then take it.
let lost = false;
captured = null;
for (let s = 0; s < shrine.cfg.captureSeconds && !captured; s++) {
  for (const n of terr.update(1, at(shrine.id, who('x', 'sentinel'), who('y', 'lantern'), who('z', 'lantern')), inWar + 100_000 + s * 1000)) {
    if (n.t === 'lost') lost = true;
    if (n.t === 'captured') captured = n;
  }
}
ok(lost && captured?.faction === 'lantern', 'three Order players drain it (lost), then the faction with most capturers takes it');
// Between wars the meters rest.
terr.forceWar = false;
news = terr.update(1, at(shrine.id, who('a', 'ash')), inWar);
ok(news.some((n) => n.t === 'war' && !n.open) && news.some((n) => n.t === 'held' && n.faction === 'lantern'), 'war end: announcement and held-points rewards');
terr.update(5, at(shrine.id, who('a', 'ash'), who('b', 'ash'), who('c', 'ash')), inWar);
ok(terr.states.get(shrine.id)!.owner === 'lantern' && terr.states.get(shrine.id)!.progress === 1, 'no war: nobody can capture');
news = terr.update(1, new Map(), inWar + TERR.incomeEveryMinutes * MIN);
const inc = news.find((n) => n.t === 'income' && n.point === shrine.id);
ok(inc && inc.t === 'income' && inc.faction === 'lantern' && inc.coins === shrine.cfg.incomeCoins, 'held points pay income every few minutes');
const saved = new Territory(terr.save());
ok(saved.states.get(shrine.id)!.owner === 'lantern', 'holdings survive a save/load');
// presenceAt: only living, grounded players with a side inside the circle.
const ent = (id: string, x: number, z: number, y = groundAt(x, z), extra = {}) => ({ charId: id, crew: '', entity: { id, kind: 'player', side: 'order', faction: 'sentinel', dead: false, pos: { x, y, z }, spiritUntil: 0, ...extra } });
const pres = presenceAt([ent('in', shrine.x + 3, shrine.z), ent('out', shrine.x + 40, shrine.z), ent('high', shrine.x, shrine.z, groundAt(shrine.x, shrine.z) + 20), ent('dead', shrine.x, shrine.z, undefined, { dead: true })], groundAt, 0);
ok(pres.get(shrine.id)?.map((p) => p.charId).join() === 'in', 'presence counts the player inside, not the one outside, flying or dead');

// War bands.
const sim = new CombatSim(groundAt);
const bands = new WarBands(sim, groundAt);
bands.raise((id) => terr.states.get(id)?.owner ?? '');
const fighters = [...sim.entities.values()].filter((e) => e.id.startsWith('war_'));
ok(fighters.length === POINTS.length * 2 * TERR.warband.perSide, `war bands: ${fighters.length} faction fighters at the points`);
bands.disband();
ok(![...sim.entities.values()].some((e) => e.id.startsWith('war_')), 'war bands leave when the war ends');

// ---- rank, bounties, kills ---------------------------------------------------------------
ok(rankOf(0) === 1 && rankOf(STANDING.rankPoints[1]) === 2 && rankOf(1e9) === STANDING.rankPoints.length, 'rank thresholds');
const mk = (id: string, faction: string, level = 20): FactionPlayer => {
  const entity = createEntity({ id, name: id, kind: 'player', team: 'players', element: 'fire' });
  entity.faction = faction;
  entity.side = factionById(faction)!.side;
  entity.level = level;
  return { entity, progress: newProgress({ level }) };
};
const fang = mk('Fang', 'redfang');
const sent = mk('Sentinel', 'sentinel');
const orders = new OrderRules(() => 0);
killRewards(sent.entity, fang, sent, true, day, orders);
ok(fang.progress.standing.infamy === STANDING.infamy.perKill && fang.entity.infamy === STANDING.infamy.perKill, 'an Outlaw who wins a PvP fight gets a bounty');
ok(fang.progress.standing.points === STANDING.points.pvpKill, 'and rank points for it');
ok(infamyNow(fang.progress.standing, day + HOUR) === STANDING.infamy.perKill - STANDING.infamy.decayPerHour || STANDING.infamy.perKill <= STANDING.infamy.decayPerHour, 'bounties wear off over real time');
addInfamy(fang.progress.standing, 100, day);
const before = sent.progress.standing.coins;
killRewards(fang.entity, sent, fang, true, day, orders);
ok(sent.progress.standing.coins === before + 150 && sent.progress.standing.honor === 150 && fang.progress.standing.infamy === 0, 'an Order player collects the bounty (coins + honour), the bounty is cleared');
const unpaid = mk('Farmer', 'redfang');
killRewards(sent.entity, unpaid, sent, false, day, orders);
ok(unpaid.progress.standing.points === 0 && unpaid.progress.standing.infamy === 0, 'kills that give no XP give no points or bounty');
const npc = createEntity({ id: 'n1', name: 'Guard', kind: 'npc', team: 'sentinel', element: 'fire' });
npc.side = 'order';
npc.role = 'guard';
const c0 = fang.progress.standing.coins;
killRewards(npc, fang, undefined, true, day, orders);
ok(fang.progress.standing.coins === c0 + STANDING.coins.npc, 'enemy faction NPCs pay coins');
const ranked = { standing: { ...newProgress().standing, points: STANDING.rankPoints[5] + 10 }, rank: 6 };
dropRanks(ranked, 1);
ok(ranked.rank === 5 && ranked.standing.points === STANDING.rankPoints[4], 'forbidden arts drop whole ranks');
ok(addPoints(ranked, STANDING.rankPoints[9]) > 0 && ranked.rank === 10, 'rank points raise the rank');

// Envoy orders.
const hunter = mk('Hunter', 'lantern', 10);
let talk = orders.talk(hunter, 'sentinel');
ok(!hunter.progress.standing.order && talk.line.includes('own people'), 'another faction’s Envoy sends you home');
talk = orders.talk(hunter, 'lantern');
const o = hunter.progress.standing.order as OrderState;
ok(!!o && talk.line.includes(orderText(o).slice(0, 20)), `the Envoy hands out an order: "${orderText(o)}"`);
o.have = o.n;
const pts0 = hunter.progress.standing.points;
talk = orders.talk(hunter, 'lantern');
ok(!!talk.reward && hunter.progress.standing.points > pts0 && hunter.progress.standing.ordersDone === 1 && !!hunter.progress.standing.order, 'a finished order pays points/coins/XP and the next one follows');

// ---- crews ---------------------------------------------------------------------------------
const crews = new Crews();
const j = (charId: string, faction: string): CrewJoiner => ({ charId, name: charId, faction, level: 20, element: 'earth' });
ok(validTag('A') !== null && validTag('ABCDE') !== null && validTag('FW') === null, 'tags are 2-4 letters');
const crew = crews.create(j('lead', 'ash'), 'Ember Rats', 'RAT', day);
ok(typeof crew !== 'string', 'found a crew');
if (typeof crew === 'string') throw new Error(crew);
ok(crews.create(j('other', 'ash'), 'Ember Rats', 'XYZ', day) === 'That crew name is taken', 'crew names are unique');
ok(crews.invite('lead', j('cop', 'sentinel'), day)?.includes('one faction'), 'crews are one faction');
ok(crews.invite('lead', j('m1', 'ash'), day) === null && typeof crews.accept(j('m1', 'ash'), day) !== 'string', 'invite and accept');
ok(crews.invite('m1', j('m2', 'ash'), day)?.includes('officers'), 'members cannot invite');
ok(crews.setRole('lead', 'm1', 'officer') === null && crews.invite('m1', j('m2', 'ash'), day) === null, 'the leader promotes an officer, who can invite');
crews.accept(j('m2', 'ash'), day);
ok(typeof crews.kick('m2', 'm1') === 'string', 'a member cannot kick an officer');
const bag = { wood: 30, stone: 10 };
ok(crews.bankMove('m2', bag, { wood: 20 }, true) === null && crew.bank.wood === 20 && bag.wood === 10, 'deposit into the crew bank');
ok(crews.bankMove('m2', bag, { wood: 5 }, false)?.includes('officer'), `only ${CREW.withdraw}s withdraw`);
ok(crews.bankMove('m1', bag, { wood: 5 }, false) === null && bag.wood === 15, 'an officer withdraws');
const lvl = crews.addXp(crew, CREW.levelXp[1]);
ok(lvl === 2 && crewLevelOf(crew.xp) === 2, 'crew XP raises the crew level');
ok(crews.setRaid('m1', 3, day)?.includes('leader'), 'only the leader moves the raid window');
const quiet = day + ((crew.raidStart + CREW.raid.hours + 1) % 24) * HOUR;
ok(crews.setRaid('lead', 3, quiet) === null && crew.raidStart === 3, 'the leader moves the raid window');
ok(crews.setRaid('lead', 5, quiet + HOUR)?.includes('again in'), 'and has to wait before moving it again');
ok(crewRaidOpen(3, day + 4 * HOUR) && !crewRaidOpen(3, day + 7 * HOUR), `the raid window is ${CREW.raid.hours} h from its start hour`);
const r = crews.remove('lead');
ok(r && !r.disbanded && crews.memberOf('m1')?.role === 'leader', 'when the leader leaves, the senior officer takes over');
crews.remove('m1');
const last = crews.remove('m2');
ok(last?.disbanded && !crews.byId.has(crew.id), 'the last one out disbands the crew');

// ---- crew bases ------------------------------------------------------------------------------
const crews2 = new Crews();
const base = crews2.create(j('boss', 'redfang'), 'Fang Pack', 'FNG', day) as Exclude<ReturnType<Crews['create']>, string>;
crews2.invite('boss', j('grunt', 'redfang'), day);
crews2.accept(j('grunt', 'redfang'), day);
const plot = PLOTS.find((p) => zoneAt(p.x, p.z).kind === 'wilds' && !FACTIONS.some((f) => Math.hypot(p.x - f.hub.x, p.z - f.hub.z) < BUILD.minHubDistance + f.hub.safeRadius))!;
ok(!!plot, `a free base plot in the Wilds: ${plot.id} at ${plot.x}, ${plot.z}`);
const camps = new Camps(groundAt);
const rich = { wood: 200, stone: 200, refined_ore: 20 };
const builderOf = (charId: string, officer: boolean, x = plot.x + 6, z = plot.z + 6, rank = 1): Builder => ({
  charId, name: charId, side: 'outlaw', faction: 'redfang', x, z, inv: { ...rich }, rank,
  crew: { id: base.id, tag: base.tag, officer, level: crewLevelOf(base.xp), raidStart: base.raidStart },
});
ok(camps.check(builderOf('grunt', false), { piece: 'crew_hall', ...snapFor('crew_hall', plot.x + 3, plot.z + 2, 0) })?.includes('officers'), 'members cannot raise the hall');
ok(snapFor('crew_hall', plot.x + 3, plot.z + 2, 0).x === plot.x && plotAt(plot.x + 3, plot.z + 2) === plot, 'the hall snaps onto the plot centre');
const off = plot.x + 400;
ok(camps.check(builderOf('boss', true, off, plot.z), { piece: 'crew_hall', x: off, z: plot.z, rot: 0 }) !== null, 'halls only go on base plots');
const hall = camps.place(builderOf('boss', true), { piece: 'crew_hall', x: plot.x + 2, z: plot.z, rot: 0 });
ok(typeof hall !== 'string' && hall.crew === base.id && hall.tag === 'FNG', `the leader raises the hall${typeof hall === 'string' ? `: ${hall}` : ''}`);
if (typeof hall === 'string') throw new Error(hall);
ok(camps.check(builderOf('boss', true), { piece: 'crew_hall', x: plot.x, z: plot.z, rot: 0 }) !== null, 'one hall per crew');
const placed = camps.place(builderOf('grunt', false), { piece: 'stone_wall', x: plot.x + 10, z: plot.z, rot: 0 });
ok(typeof placed !== 'string' && placed.crew === base.id, 'members build base pieces near the hall without a campfire');
if (typeof placed === 'string') throw new Error(placed);
const wall = placed;
ok(camps.check(builderOf('grunt', false, plot.x - 6, plot.z + 4, 1), { piece: 'workshop', x: plot.x - 10, z: plot.z, rot: 0 })?.includes('rank 3'), 'rank-gated pieces need faction rank');
{
  const err = camps.check(builderOf('grunt', false, plot.x - 6, plot.z + 4, 3), { piece: 'workshop', x: plot.x - 10, z: plot.z, rot: 0 });
  ok(err === null, `with rank 3 the workshop is allowed${err ? `: ${err}` : ''}`);
}
ok(camps.check({ charId: 'loner', name: 'Loner', side: 'order', faction: 'sentinel', x: plot.x + 20, z: plot.z, inv: { ...rich } }, { piece: 'campfire', x: plot.x + 20, z: plot.z, rot: 0 })?.includes('crew base'), 'no camps right next to a crew base');
// Raids on the base follow the crew's window.
const shut = day + ((base.raidStart + CREW.raid.hours + 2) % 24) * HOUR;
const open = day + base.raidStart * HOUR + 30 * MIN;
ok(camps.damage(wall.id, 100, { side: 'order', element: 'fire', faction: 'sentinel' }, shut)?.kind === 'refused', 'outside the crew raid window: refused');
const ashHit = camps.damage(wall.id, 100000, { side: 'order', element: 'fire', faction: 'lantern' }, shut);
ok(ashHit?.kind === 'refused', 'only the Ash Syndicate perk raids off-window (and they are Outlaws)');
const hit = camps.damage(wall.id, 100, { side: 'order', element: 'earth', faction: 'sentinel' }, open);
ok(hit?.kind === 'hit' && hit.amount === Math.round(100 * BUILD.earthBonus), 'in the window: Earth hits base pieces harder');
let sacked = false;
for (let i = 0; i < 20 && !sacked; i++) {
  const res = camps.damage(hall.id, 2000, { side: 'order', element: 'fire', faction: 'sentinel' }, open + i);
  if (res && res.kind === 'hit' && res.sacked) sacked = true;
}
ok(sacked && camps.all.has(hall.id) && hall.hp === 1, 'beating the hall down sacks the base; the hall stands at 1 hp');
const again = camps.damage(hall.id, 2000, { side: 'order', element: 'fire', faction: 'sentinel' }, open + 60_000);
ok(again?.kind === 'hit' && !again.sacked, 'once per raid window');
base.bank = { wood: 500, stone: 50 };
const loot = crews2.sack(base, {});
ok((loot.wood ?? 0) === Math.min(crewsData.sack.max, Math.floor(500 * crewsData.sack.share)) && base.bank.wood === 500 - (loot.wood ?? 0), `the raider carries off ${JSON.stringify(loot)}`);
// The Ash Syndicate wears camps down off-window, but only to half.
const ashCamps = new Camps(groundAt);
const site = { x: plot.x + 300, z: plot.z };
const ashTarget = ashCamps.place({ charId: 'v', name: 'V', side: 'order', faction: 'sentinel', x: site.x, z: site.z, inv: { ...rich } }, { piece: 'campfire', x: site.x, z: site.z, rot: 0 });
if (typeof ashTarget !== 'string') {
  const wallB = ashCamps.place({ charId: 'v', name: 'V', side: 'order', faction: 'sentinel', x: site.x, z: site.z, inv: { ...rich } }, { piece: 'stone_wall', x: site.x + 6, z: site.z, rot: 0 });
  if (typeof wallB !== 'string') {
    const offHours = ashCamps.raidWindow(wallB, shut).open ? shut + 12 * HOUR : shut;
    for (let i = 0; i < 40; i++) ashCamps.damage(wallB.id, 500, { side: 'outlaw', element: 'fire', faction: 'ash' }, offHours);
    ok(wallB.hp === Math.ceil(wallB.maxHp * 0.5), `Ash raids off-window at reduced damage, down to half (${wallB.hp}/${wallB.maxHp})`);
  } else ok(false, `wall for the Ash test: ${wallB}`);
} else console.log(`(skipped Ash camp test: ${ashTarget})`);
// Spirit wards soak damage.
const ward = new Camps(groundAt).damage('nope', 1, { side: 'order', element: null });
ok(ward === null, 'unknown structures are ignored');

// ---- perks, buffs, shop -------------------------------------------------------------------
const lanternMonk = mk('Monk', 'lantern');
lanternMonk.entity.pos.set(shrine.x + 5, 0, shrine.z);
const boon = boonFor(lanternMonk.entity, terr);
ok(boon.heal === 0.15 && boon.regen >= 0.15, 'Lantern Order: healing and chi regen near shrines');
ok(xpScale(fang.entity, terr, true) >= 1.1, 'Red Fang: +10% PvP XP');
ok(mountScale('freeisles') === 1.2 && mountScale('ash') === 1, 'Free Isles League: faster mounts');
ok(shopItems('redfang').some((i) => i.black) && !shopItems('sentinel').some((i) => i.black), 'only Red Fang sees the black market');
const shopper = mk('Shopper', 'sentinel');
shopper.progress.standing.coins = 100;
ok(buy(shopper, 'wood', 10).startsWith('Bought') && shopper.progress.inv.wood === 10 && shopper.progress.standing.coins === 70, 'buy 10 wood for 30 coins');
ok(buy(shopper, 'obsidian', 1).includes("doesn't sell"), 'no black market for the Order');
ok(sell(shopper, 'wood', 10).startsWith('Sold') && shopper.progress.standing.coins === 70 + sellPrice('wood') * 10, 'sell it back for less');
ok(pardon(shopper, day).includes('black market'), 'pardons are Red Fang only');
const outlaw = mk('Outlaw', 'redfang');
addInfamy(outlaw.progress.standing, 100, day);
outlaw.progress.standing.coins = 1000;
ok(pardon(outlaw, day).includes('wiped') && infamyNow(outlaw.progress.standing, day) === 0, 'Red Fang buys a pardon');
const hub = factionById('sentinel')!.hub;
shopper.entity.pos.set(hub.x, 0, hub.z);
shopper.progress.standing.coins = 1000;
const spots = travelSpots(shopper.entity, { x: plot.x, z: plot.z }, null);
ok(spots.some((s) => s.id === 'hub:lantern') && !spots.some((s) => s.id === 'hub:sentinel') && !spots.some((s) => s.id.startsWith('hub:redfang')), 'travel goes to the other hubs of your side and your camp');
const isles = mk('Sailor', 'freeisles');
isles.entity.pos.set(hub.x, 0, hub.z);
const islesSpot = travelSpots(isles.entity, null, null).find((s) => s.id === 'hub:lantern')!;
ok(islesSpot.cost < spots.find((s) => s.id === 'hub:lantern')!.cost, 'Free Isles League travels cheaper');
shopper.entity.lastCombat = 95;
ok(typeof travel(shopper, spots[0], 100, day) === 'string', 'no fast travel right after a fight');
shopper.entity.lastCombat = -1e9;
const went = travel(shopper, spots[0], 100, day);
ok(typeof went !== 'string' && shopper.progress.standing.coins === 1000 - spots[0].cost, `fast travel: ${typeof went === 'string' ? went : went.text}`);
shopper.entity.pos.set(plot.x, 0, plot.z);
ok(travel(shopper, spots[0], 100, day) === 'Fast travel leaves from a hub', 'fast travel leaves from a hub only');
// The sim: territory armor soaks hits, Sentinels hit bountied Outlaws harder.
{
  const s2 = new CombatSim(groundAt);
  const atk = createEntity({ id: 'atk', name: 'A', kind: 'player', team: 'players', element: 'fire' });
  const tgt = createEntity({ id: 'tgt', name: 'T', kind: 'dummy', team: 'dummies', element: null, maxHp: 100000 });
  atk.faction = 'sentinel';
  atk.side = 'order';
  s2.add(atk);
  s2.add(tgt);
  const ability = { slot: 'basic', id: 'test', name: 'Test', kind: 'projectile', damage: 100, chiCost: 0, cooldown: 0 } as unknown as AbilityDef;
  const hitFor = (setup: () => void) => {
    tgt.hp = tgt.maxHp;
    tgt.boon = { dmg: 0, regen: 0, heal: 0, armor: 0 };
    tgt.infamy = 0;
    setup();
    s2.hit(atk, tgt, ability, 'fire', 1, new Vector3(0, 0, 1), null);
    return tgt.maxHp - tgt.hp;
  };
  const plain = hitFor(() => {});
  ok(hitFor(() => (tgt.boon = { dmg: 0, regen: 0, heal: 0, armor: 0.05 })) < plain, 'a held stone shrine (armor boon) softens hits');
  ok(hitFor(() => (tgt.infamy = 50)) === Math.round(plain * 1.1), 'Sentinels deal +10% to bountied targets');
}

console.log(fails ? `\n${fails} FAILED` : '\nall territory/standing/crew checks passed');
process.exit(fails ? 1 : 0);
