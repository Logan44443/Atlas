// Phase 9 rules without a browser: placement, inventories, raid damage,
// abandoned camps, gathering, environment/party crafting and the forge.
// Run: npx tsx scripts/building-check.ts
import { Vector3 } from 'three';
import { TerrainSampler } from '../shared/terrain';
import { FACTIONS, terrainConfig, zoneAt } from '../shared/factions';
import worldData from '../data/world.json';
import { BUILD, Camps, giveItems, invTotal, raidOpen, raidText, sanitizeInv, BAG_CAP, type Builder } from '../shared/building';
import { CraftRules, type Crafter } from '../shared/crafting';
import { nodesInChunk, nodesNear, nodeById } from '../shared/resources';
import { CombatSim, createEntity } from '../shared/sim/combatSim';

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};

const t = new TerrainSampler(terrainConfig());
const groundAt = (x: number, z: number) => t.height(x, z);

// A flat-ish dry spot in the Wilds, far from hubs.
function findSite(): { x: number; z: number } {
  const hub = FACTIONS[0].hub;
  for (let r = 260; r < 900; r += 16) {
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      const x = Math.round(hub.x + Math.cos(a) * r);
      const z = Math.round(hub.z + Math.sin(a) * r);
      if (zoneAt(x, z).kind !== 'wilds') continue;
      if (FACTIONS.some((f) => Math.hypot(x - f.hub.x, z - f.hub.z) < BUILD.minHubDistance + f.hub.safeRadius + 40)) continue;
      const h = groundAt(x, z);
      if (h < worldData.seaLevel + 1.5) continue;
      if (Math.abs(groundAt(x + 20, z) - h) + Math.abs(groundAt(x, z + 20) - h) > 4) continue;
      return { x, z };
    }
  }
  throw new Error('no site');
}

const site = findSite();
console.log(`site ${site.x}, ${site.z}`);
const camps = new Camps(groundAt);
const alice: Builder = { charId: 'c-alice', name: 'Alice', side: 'order', faction: 'sentinel', x: site.x, z: site.z, inv: {} };
const bob: Builder = { charId: 'c-bob', name: 'Bob', side: 'outlaw', faction: 'redfang', x: site.x + 80, z: site.z, inv: {} };

// Inventories
ok(invTotal(sanitizeInv({ wood: 5, bogus: 3, stone: -2, glass: 2.7 })) === 7, 'sanitizeInv keeps known materials and whole counts');
const full = {};
const added = giveItems(full, { wood: BAG_CAP + 30 });
ok(added.wood === BAG_CAP, `bag capacity caps at ${BAG_CAP}`);

// Placement rules
const hub = FACTIONS[0].hub;
alice.x = hub.x;
alice.z = hub.z + 10;
alice.inv = { wood: 200 };
const inHub = camps.place(alice, { piece: 'campfire', x: hub.x, z: hub.z + 10, rot: 0 });
ok(typeof inHub === 'string' && /Wilds/.test(inHub), `no camps in a hub: "${inHub}"`);
alice.x = site.x;
alice.z = site.z;
alice.inv = { wood: 20 };
const noFire = camps.place(alice, { piece: 'wood_wall', x: site.x + 3, z: site.z, rot: 0 });
ok(typeof noFire === 'string' && /campfire/.test(noFire), `campfire first: "${noFire}"`);
const poor = camps.place(alice, { piece: 'campfire', x: site.x, z: site.z, rot: 0 });
ok(typeof poor === 'string' && /Stone/.test(poor), `cost is checked: "${poor}"`);
alice.inv = { wood: 40, stone: 10 };
const fire = camps.place(alice, { piece: 'campfire', x: site.x + 0.3, z: site.z - 0.2, rot: 0 });
ok(typeof fire === 'object' && fire.x === site.x && fire.z === site.z, 'campfire placed and snapped to the grid');
ok(alice.inv.wood === 35 && alice.inv.stone === 7, 'campfire cost taken from the bag');
const second = camps.place(alice, { piece: 'campfire', x: site.x + 6, z: site.z, rot: 0 });
ok(typeof second === 'string' && /already/.test(second), 'one camp per character');
const wall = camps.place(alice, { piece: 'wood_wall', x: site.x + 4, z: site.z + 4, rot: 0 });
ok(typeof wall === 'object', 'wall inside the camp radius');
const wall2 = camps.place(alice, { piece: 'wood_wall', x: site.x + 8, z: site.z + 4, rot: 0 });
ok(typeof wall2 === 'object', 'walls can sit end to end');
const overlap = camps.place(alice, { piece: 'stone_wall', x: site.x + 5, z: site.z + 4, rot: 0 });
ok(typeof overlap === 'string' && /already/.test(overlap), 'no overlapping pieces');
const rotated = camps.place(alice, { piece: 'wood_wall', x: site.x - 4, z: site.z, rot: 1 });
ok(typeof rotated === 'object' && camps.solids.get(rotated.id)!.hx < 0.5, 'quarter-turn rotation swaps the footprint');
alice.x = site.x + 20;
const far = camps.place(alice, { piece: 'wood_wall', x: site.x + 30, z: site.z, rot: 0 });
ok(typeof far === 'string' && /within/.test(far), `pieces stay within ${BUILD.campRadius} m of the campfire`);
alice.x = site.x;
bob.x = site.x + 20;
bob.inv = { wood: 20, stone: 20 };
const crowd = camps.place(bob, { piece: 'campfire', x: site.x + 20, z: site.z, rot: 0 });
ok(typeof crowd === 'string' && /Alice/.test(crowd), `camps keep their distance: "${crowd}"`);

// Removal
const before = alice.inv.wood;
const rm = camps.remove(alice, (wall2 as { id: string }).id);
ok(typeof rm === 'object' && alice.inv.wood === before + 3, 'taking a piece down refunds half');
const rmFire = camps.remove(alice, (fire as { id: string }).id);
ok(typeof rmFire === 'string', 'the campfire goes last');

// Raids
const at = (h: number) => Date.UTC(2026, 9, 8, h, 30);
ok(raidOpen(at(20)) && !raidOpen(at(12)), 'raid window 19-22 UTC');
console.log('  ', raidText(at(12)), '|', raidText(at(20)));
const w = wall as { id: string; hp: number };
const hp0 = w.hp;
ok(camps.damage(w.id, 50, { side: 'order', element: 'fire' }, at(20)) === null, 'your own side cannot damage it');
const shut = camps.damage(w.id, 50, { side: 'outlaw', element: 'fire' }, at(12));
ok(shut?.kind === 'refused', 'outside the raid window: refused');
const hit = camps.damage(w.id, 50, { side: 'outlaw', element: 'fire' }, at(20));
ok(hit?.kind === 'hit' && w.hp === hp0 - 50, 'raid hit during the window');
const hitE = camps.damage(w.id, 50, { side: 'outlaw', element: 'earth' }, at(20));
ok(hitE?.kind === 'hit' && hitE.amount === 75, 'earth hits structures 1.5x');
const brk = camps.damage(w.id, 10000, { side: 'outlaw', element: 'fire' }, at(20));
ok(brk?.kind === 'broke' && !camps.all.has(w.id) && !camps.solids.has(w.id), 'structures break at 0 hp');

const core = camps.damage((fire as { id: string }).id, 1e6, { side: 'outlaw', element: 'earth' }, at(20));
ok(core?.kind === 'hit' && core.s.hp === 1 && camps.all.has(core.s.id), 'the campfire can be beaten down but never destroyed');

// The sim: solid structures stop projectiles and report hits.
const sim = new CombatSim(groundAt);
sim.solids = camps.solids;
const rot = rotated as { id: string; x: number; y: number; z: number };
const shooter = createEntity({ id: 'p1', name: 'Bob', kind: 'player', team: 'players', element: 'fire', side: 'outlaw', faction: 'redfang', pos: new Vector3(rot.x - 6, rot.y + 0.3, rot.z) });
sim.add(shooter);
sim.cast(shooter, 'basic', new Vector3(1, 0, 0));
const evs = [];
for (let i = 0; i < 60; i++) {
  sim.update(1 / 20);
  evs.push(...sim.drain());
}
const sh = evs.find((e) => e.t === 'structHit');
ok(sh && sh.t === 'structHit' && sh.id === rot.id, 'a fire blast hits the wall in its path');
const ended = evs.find((e) => e.t === 'projEnd');
ok(ended && ended.t === 'projEnd' && Math.abs(ended.pos[0] - rot.x) < 1.5, 'and stops there');

// Abandoned camps burn down.
const now = Date.now();
camps.touch(alice.charId, now - (BUILD.burnOfflineHours + 1) * 3_600_000);
ok(camps.burnAbandoned(() => true, now).length === 0, 'online owners keep their camp');
const burnt = camps.burnAbandoned(() => false, now);
ok(burnt.length >= 2 && camps.ofOwner(alice.charId).length === 0, `offline ${BUILD.burnOfflineHours} h: camp burns down (${burnt.length} pieces)`);

// Resources are deterministic.
const a1 = JSON.stringify(nodesInChunk(3, -4));
const a2 = JSON.stringify(nodesInChunk(3, -4));
ok(a1 === a2, 'nodes are a pure function of the chunk');
let counts: Record<string, number> = {};
for (let cx = -20; cx < 20; cx++) for (let cz = -20; cz < 20; cz++) for (const n of nodesInChunk(cx, cz)) counts[n.type] = (counts[n.type] ?? 0) + 1;
console.log('  ', counts);
ok(Object.keys(counts).length === 6, 'all six node types appear in the world');
const starters = nodesNear(hub.x, hub.z + hub.radius + 20, 60);
ok(new Set(starters.map((n) => n.type)).size >= 5, `starter nodes outside ${hub.name}'s gate (${starters.length})`);

// Gathering and crafting.
const rules = new CraftRules();
const mk = (id: string, el: 'fire' | 'water' | 'earth' | 'air', side: string, x: number, z: number): Crafter => {
  const e = createEntity({ id, name: id, kind: 'player', team: 'players', element: el, side, pos: new Vector3(x, groundAt(x, z), z) });
  e.chi = e.maxChi;
  return { entity: e, charId: `c-${id}`, inv: {}, arts: [] };
};
const timber = starters.find((n) => n.type === 'timber')!;
const g = mk('g', 'fire', 'order', timber.x + 1, timber.z);
const got = rules.gather(g, null, 0);
ok(typeof got === 'object' && got.items.wood === 3, `gather timber: ${typeof got === 'object' ? got.text : got}`);
const again = rules.gather(g, null, 1);
ok(typeof again === 'string' && /spent/.test(again), 'node cooldown per player');
ok(nodeById(timber.id)?.type === 'timber', 'nodes can be looked up by id');
const sand = starters.find((n) => n.type === 'sand')!;
const f = mk('f', 'fire', 'order', sand.x + 1, sand.z);
const glass = rules.channel(f, [], 0);
ok(glass.kind === 'crafted' && f.inv.glass === 1, 'fire + sand bank = glass');
const w1 = mk('w', 'water', 'order', site.x, site.z);
const e1 = mk('e', 'earth', 'order', site.x + 2, site.z);
const wait = rules.channel(w1, [e1], 10);
ok(wait.kind === 'waiting', 'channelling alone waits for a partner');
const mud = rules.channel(e1, [w1], 10.8);
ok(mud.kind === 'crafted' && w1.inv.mud === 3 && e1.inv.mud === 3, 'water + earth channelling together = mud for both');
const e2 = mk('e2', 'earth', 'outlaw', site.x + 2, site.z);
rules.channel(w1, [e2], 30);
ok(rules.channel(e2, [w1], 30.5).kind === 'waiting', 'no crafting with the other side');
const fi = mk('fi', 'fire', 'order', site.x, site.z + 3);
const ea = mk('ea', 'earth', 'order', site.x + 1, site.z + 3);
ea.arts.push('lava');
rules.channel(fi, [ea], 50);
const ob = rules.channel(ea, [fi], 50.5);
ok(ob.kind === 'crafted' && fi.inv.obsidian === 2, 'Lava art upgrades magma brick to obsidian');

// Forge
const camps2 = new Camps(groundAt);
const smith: Builder = { charId: fi.charId, name: 'Smith', side: 'order', faction: 'sentinel', x: site.x, z: site.z, inv: { wood: 10, stone: 30, magma_brick: 4 } };
camps2.place(smith, { piece: 'campfire', x: site.x, z: site.z, rot: 0 });
const forge = camps2.place(smith, { piece: 'forge', x: site.x + 4, z: site.z, rot: 0 });
ok(typeof forge === 'object', 'forge placed');
fi.entity.pos.set(site.x + 2, 0, site.z);
fi.inv = { refined_ore: 2, charcoal: 1 };
const plate = rules.forge(fi, 'metal_plate', camps2);
ok(typeof plate === 'object' && fi.inv.metal_plate === 1 && !fi.inv.refined_ore, 'forge: refined ore + charcoal = metal plate');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
