// Rules check for Phase 7 progression (no browser): XP curve, level factor,
// anti-griefing, party split, mastery validation and modifiers.
//   npx tsx scripts/progression-check.ts
import { Vector3 } from 'three';
import { createEntity, CombatSim, setMods, kitOf, KITS } from '../shared/sim/combatSim';
import {
  XpRules, addXp, computeMods, newProgress, sanitizeAlloc, xpToNext, levelFactor, cannotRaise, PROG, type XpPlayer,
} from '../shared/progression';

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failed++;
};

const player = (id: string, level: number, x = 0, z = 0): XpPlayer => {
  const entity = createEntity({ id, name: id, kind: 'player', team: 'players', element: 'fire', level, pos: new Vector3(x, 0, z), side: 'order' });
  return { entity, progress: newProgress({ level }), respawnedAt: -1e9 };
};

// Curve and level-ups.
ok(xpToNext(1) === 100 && xpToNext(4) === 800, `xpToNext(1)=${xpToNext(1)}, xpToNext(4)=${xpToNext(4)}`);
const p = newProgress();
const up = addXp(p, 100 + 283 + 10);
ok(up === 2 && p.level === 3 && p.xp === 10, `393 XP from level 1 -> level ${p.level} with ${p.xp} left (gained ${up})`);
const capped = newProgress({ level: PROG.maxLevel });
ok(addXp(capped, 1e6) === 0 && capped.xp === 0, 'no XP past the level cap');

// Level-difference factor.
ok(levelFactor(20, 10) === 0, 'victim 10 levels below gives 0 XP');
ok(levelFactor(5, 10) > 1 && levelFactor(10, 5) < 1, `tougher targets pay more (${levelFactor(5, 10).toFixed(2)} vs ${levelFactor(10, 5).toFixed(2)})`);

// PvP: repeats diminish, spawn kills give nothing.
const rules = new XpRules();
const killer = player('k', 10);
const victim = player('v', 10, 300, 300);
const all = new Map([['k', killer], ['v', victim]]);
const gains = [0, 1, 2, 3, 4].map((i) => rules.onKill(victim.entity, killer, all, ['k'], 1000 + i)[0]?.amount ?? 0);
ok(gains[0] > gains[1] && gains[1] > gains[2] && gains[4] === 0, `repeat kills diminish: ${gains.join(', ')}`);
victim.respawnedAt = 5000;
ok((rules.onKill(victim.entity, killer, all, ['k'], 5010)[0]?.amount ?? 0) === 0, 'killing a player right after respawn gives 0 XP');
const low = player('low', 1, 300, 300);
ok((rules.onKill(low.entity, player('high', 15), new Map(), ['high'], 0)[0]?.amount ?? 0) === 0, 'killing a player 10+ levels below gives 0 XP');

// Party split: members within range share (with a bonus), far members get nothing.
const npc = createEntity({ id: 'npc_x', name: 'Patrol', kind: 'npc', team: 'outlaw', role: 'fighter', level: 6, pos: new Vector3() });
const a = player('a', 6);
const b = player('b', 6, 10, 0);
const c = player('c', 6, 500, 0);
const party = new Map([['a', a], ['b', b], ['c', c]]);
const solo = rules.onKill(npc, a, party, ['a'], 0);
const shared = rules.onKill(npc, a, party, ['a', 'b', 'c'], 0);
ok(solo.length === 1 && solo[0].amount === PROG.kill.npc.fighter, `solo fighter kill: ${solo[0]?.amount} XP`);
ok(shared.length === 2 && shared.every((g) => g.amount === Math.round((PROG.kill.npc.fighter * (1 + PROG.party.bonusPerMember)) / 2)), `party of 3 with one far away: ${shared.map((g) => `${g.id}+${g.amount}`).join(' ')}`);

// Dummies stop teaching after dummyMaxLevel.
const dummy = createEntity({ id: 'dummy_c', name: 'Sparring dummy', kind: 'dummy', team: 'dummies', level: 1 });
ok((rules.onKill(dummy, player('n', 2), new Map(), ['n'], 0)[0]?.amount ?? 0) > 0, 'dummy gives XP at level 2');
ok(rules.onKill(dummy, player('v6', 6), new Map(), ['v6'], 0).length === 0, 'dummy gives nothing past level 5');

// Mastery validation.
ok(cannotRaise('fire', 1, {}, 'fire_p1') !== null, 'no points at level 1');
ok(cannotRaise('fire', 3, {}, 'fire_p1') === null, 'tier 0 open at level 3');
ok(cannotRaise('fire', 20, { fire_p1: 4 }, 'fire_p2')?.startsWith('Needs') === true, 'tier 1 locked with 4 points in branch');
ok(cannotRaise('fire', 20, { fire_p1: 5 }, 'fire_p2') === null, 'tier 1 opens with 5 points in branch');
const cheat = sanitizeAlloc('fire', 4, { fire_p1: 5, fire_p5: 1, bogus: 9 });
ok(JSON.stringify(cheat) === JSON.stringify({ fire_p1: 3 }), `sanitize trims an over-spent allocation to ${JSON.stringify(cheat)}`);

// Modifiers reach the sim.
const sim = new CombatSim(() => 0);
const f = createEntity({ id: 'f', name: 'f', kind: 'player', team: 'players', element: 'fire' });
sim.add(f);
setMods(f, computeMods('fire', { fire_b1: 5, fire_b3: 5, fire_p3: 5, fire_p1: 5 }));
const jab = kitOf(f).abilities.find((x) => x.slot === 'basic')!;
const baseJab = KITS.fire.abilities.find((x) => x.slot === 'basic')!;
ok(Math.abs(jab.damage - baseJab.damage * 1.25) < 1e-9, `Focused Jab 5/5: ${baseJab.damage} -> ${jab.damage} damage`);
ok(f.maxHp === Math.round(200 * 1.15), `Inner Fire 5/5: max health ${f.maxHp}`);
const blast = kitOf(f).abilities.find((x) => x.slot === 'heavy')!;
ok(blast.chiCost === Math.round(22 * 0.8), `Breath Control 5/5: Fire Blast chi ${blast.chiCost}`);

// Party combo: water then fire from two party members on one target -> steam.
const w = createEntity({ id: 'w', name: 'w', kind: 'player', team: 'players', element: 'water', party: 'p1', side: 'order', pos: new Vector3(0, 0, -3) });
const fi = createEntity({ id: 'fi', name: 'fi', kind: 'player', team: 'players', element: 'fire', party: 'p1', side: 'order', pos: new Vector3(3, 0, 0) });
const d = createEntity({ id: 'dummy_a', name: 'd', kind: 'dummy', team: 'dummies', hp: 999, maxHp: 999, pos: new Vector3(0, 0, 0) });
const sim2 = new CombatSim(() => 0);
[w, fi, d].forEach((e) => sim2.add(e));
sim2.hit(w, d, KITS.water.abilities[0], 'water', 1, new Vector3(0, 0, 1), null);
sim2.hit(fi, d, KITS.fire.abilities[0], 'fire', 1, new Vector3(-1, 0, 0), null);
const combo = sim2.drain().find((e) => e.t === 'combo');
ok(combo?.t === 'combo' && combo.combo === 'steam', `water + fire party hits -> ${combo?.t === 'combo' ? combo.name : 'no combo'}`);
for (let i = 0; i < 10; i++) sim2.update(0.1);
ok(d.statuses.has('blind') || sim2.drain().some((e) => e.t === 'status' && e.status === 'blind'), 'steam cloud blinds the target');

process.exit(failed ? 1 : 0);
