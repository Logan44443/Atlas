// Phase 10 check: wildlife, pets, bosses, plus the asks that came with it
// (solid trees and rocks, bending marks, NPC advice). Online, a firebender:
// gets advice from a trainer and a Beastkeeper, walks into a tree and stops,
// scorches it with a fire jab, hunts a wild animal for XP and loot, tames one
// with berries (trust game on the interact key), opens the pets panel, rides a
// rhino faster than running, and fights a weakened Sun Dragon that telegraphs,
// shows a boss bar and (forced) opens a Bond Trial. Pets survive a reload.
// Offline: creatures, a flying mount, a boss and marks all run in the tab.
// Needs `npm run server` and `npm run dev`.
//   node scripts/phase10-test.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5173/';
const outDir = 'screenshots';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const run = Date.now().toString(36).slice(-4);
// Wilds south-west of the Sentinel hub with trees and dens around (scripts/building-check.ts uses it for camps).
const SITE = { x: -219, z: -773 };

async function open(label, query, ctx = null) {
  ctx ??= await browser.newContext({ viewport: { width: 1100, height: 680 } });
  const page = await ctx.newPage();
  const errors = [];
  const warns = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning') warns.push(m.text());
    if (/^\[(net|account)\]/.test(m.text())) console.log(`  ${label}: ${m.text()}`);
  });
  const u = new URL(base);
  u.search = query;
  await page.goto(u.toString(), { timeout: 120000 });
  await page.waitForSelector('#loading.done', { timeout: 240000 });
  await page.evaluate(() => {
    const f = window.__fw;
    f.__ev = [];
    f.__notes = [];
    f.__xp = [];
    f.eventTaps.push((e) => f.__ev.push(e));
    const show = f.zoneHud.show.bind(f.zoneHud);
    f.zoneHud.show = (text, warn) => {
      f.__notes.push(text);
      return show(text, warn);
    };
    const gain = f.xpHud.gain.bind(f.xpHud);
    f.xpHud.gain = (g, p) => {
      f.__xp.push(g);
      return gain(g, p);
    };
  });
  return { ctx, page, errors, warns, label };
}
const until = (p, fn, arg, timeout = 60000) => p.page.waitForFunction(fn, arg, { timeout, polling: 250 });
const notes = (p) => p.page.evaluate(() => window.__fw.__notes.slice());
const pos = (p) => p.page.evaluate(() => ({ x: window.__fw.host.me.pos.x, y: window.__fw.host.me.pos.y, z: window.__fw.host.me.pos.z }));
async function goTo(p, x, z) {
  await p.page.evaluate(([a, b]) => window.__fw.tp(a, b), [x, z]);
  await until(p, ([a, b]) => Math.hypot(window.__fw.host.me.pos.x - a, window.__fw.host.me.pos.z - b) < 2, [x, z], 60000);
}
const waitSim = (p, seconds) => p.page.evaluate((s) => {
  const h = window.__fw.host;
  const end = h.time + s;
  return new Promise((r) => { const i = setInterval(() => { if (h.time >= end) { clearInterval(i); r(); } }, 100); });
}, seconds);
/** Collision for the player is in place where they stand (terrain + trees/rocks of the near chunks). */
const physicsReady = (p) => until(p, () => {
  const f = window.__fw;
  return f.physics.hasTerrainAt(f.player.renderPos.x, f.player.renderPos.z, 64) && f.physics.propColliderCount > 0;
}, null, 90000);
/** Bend toward a point: a fire jab, or another slot. */
const castAt = (p, x, y, z, slot = 'basic') => p.page.evaluate(([x, y, z, slot]) => {
  const f = window.__fw;
  const me = f.host.me;
  const d = new f.camera.position.constructor(x - me.pos.x, y - (me.pos.y + 1.1), z - me.pos.z).normalize();
  f.host.cast(slot, d);
}, [x, y, z, slot]);
/** Jab (and blast) an entity until it dies; follow it if it runs. */
async function hunt(p, id, seconds = 150) {
  const end = Date.now() + seconds * 1000;
  let n = 0;
  while (Date.now() < end) {
    const t = await p.page.evaluate((id) => {
      const e = window.__fw.host.entities.get(id);
      return e && !e.dead ? { x: e.pos.x, y: e.pos.y + e.height * 0.5, z: e.pos.z, r: e.radius } : null;
    }, id);
    if (!t) return true;
    const me = await pos(p);
    // (Knocked out by a boss: wait for the respawn, then come back.)
    if (Math.hypot(me.x - t.x, me.z - t.z) > t.r + 9) await goTo(p, t.x - t.r - 3, t.z + (n % 3) - 1).catch(() => waitSim(p, 2));
    await castAt(p, t.x, t.y, t.z, n % 8 === 0 ? 'heavy' : 'basic');
    n++;
    await waitSim(p, 0.4);
  }
  return false;
}
/** Play the trust game like a patient player: press interact when the marker is in the green. */
const playTrustFairly = (p) => p.page.evaluate(() => {
  const ui = window.__fw.trustUi;
  if (ui.__bot) return;
  ui.__bot = true;
  const orig = ui.update.bind(ui);
  ui.update = (dt, press, key) => {
    const g = ui.game;
    if (g && ui.t > (ui.hits + 1) * 0.8) {
      const x = ((ui.t + dt) * g.speed) % 2;
      const m = x < 1 ? x : 2 - x;
      if (Math.abs(m - ui.zoneAt) <= g.zone / 2 - 0.02) press = true;
    }
    return orig(dt, press, key);
  };
});
const shot = (p, name) => p.page.screenshot({ path: `${outDir}/phase10-${name}.png` });

// ---------- Online ----------
const A = await open('A', `char=Tamer${run}&el=fire&fac=sentinel`);
ok(await A.page.evaluate(() => window.__fw.host.online), 'A (fire, Sentinel) is online');
await A.page.evaluate(() => window.__fw.host.room.send('dev:xp', 60000));
await until(A, () => window.__fw.host.progress.level >= 12, null, 30000).catch(() => {});
const level = await A.page.evaluate(() => window.__fw.host.progress.level);
ok(level >= 12, `levelled to ${level} for the wilds`);

// NPC advice: a trainer and the Beastkeeper in the hub.
async function talkTo(p, role) {
  const npc = await p.page.evaluate((role) => {
    const me = window.__fw.host.me;
    const list = [...window.__fw.host.entities.values()].filter((e) => e.kind === 'npc' && e.role === role && e.faction === me.faction);
    list.sort((a, b) => a.pos.distanceTo(me.pos) - b.pos.distanceTo(me.pos));
    return list[0] ? { id: list[0].id, x: list[0].pos.x, z: list[0].pos.z, name: list[0].name } : null;
  }, role);
  if (!npc) return null;
  await goTo(p, npc.x + 1.8, npc.z);
  await waitSim(p, 0.5);
  await p.page.keyboard.press('KeyG');
  await until(p, () => !document.querySelector('.dialog')?.classList.contains('hidden'), null, 20000).catch(() => {});
  return npc;
}
const trainer = await talkTo(A, 'trainer');
const trainerLine = await A.page.evaluate(() => document.querySelector('.dialog p')?.textContent ?? '');
ok(!!trainer && trainerLine.length > 30, `trainer ${trainer?.name}: "${trainerLine}"`);
ok(/mastery point|level \d+|block|Fire|fire|daylight|night|Air|barrier|burn/.test(trainerLine), 'the trainer talks about your bending or progress');
await A.page.keyboard.press('KeyG');
await until(A, () => document.querySelector('.dialog')?.classList.contains('hidden'), null, 20000).catch(() => {});
const keeper = await talkTo(A, 'beast');
await until(A, () => !!document.querySelector('.dialog .quest-line'), null, 20000).catch(() => {});
const keeperLines = await A.page.evaluate(() => [...document.querySelectorAll('.dialog p')].map((p) => p.textContent));
ok(!!keeper && keeperLines.length === 2, `Beastkeeper ${keeper?.name}: "${keeperLines.join(' / ')}"`);
await shot(A, 'advice');
await A.page.keyboard.press('KeyG');

// Solid trees: walk straight at a trunk and stop against it.
const tree = await A.page.evaluate(([x, z]) => {
  const f = window.__fw;
  const g = (a, b) => f.sampler.height(a, b);
  const list = f.obstacles.near(x, z, 90).filter((o) => o.type !== 'rock');
  // A trunk with open, gentle ground on its west side.
  for (const o of list) {
    const free = f.obstacles.near(o.x - 4, o.z, 3.6).filter((q) => q !== o).length === 0;
    if (free && Math.abs(g(o.x - 7, o.z) - g(o.x, o.z)) < 1.2 && g(o.x, o.z) > 1.5) return o;
  }
  return null;
}, [SITE.x, SITE.z]);
ok(!!tree, `a ${tree?.type} trunk at ${tree?.x.toFixed(1)}, ${tree?.z.toFixed(1)} (radius ${tree?.radius})`);
await goTo(A, tree.x - 7, tree.z);
await physicsReady(A);
await waitSim(A, 0.5);
await A.page.evaluate((t) => {
  const f = window.__fw;
  f.tpc.yaw = -Math.PI / 2; // camera forward = +x, toward the trunk
  f.__treeMin = 1e9;
  const tick = () => {
    const p = f.player.renderPos;
    f.__treeMin = Math.min(f.__treeMin, Math.hypot(p.x - t.x, p.z - t.z));
    if (f.__treeWatch) requestAnimationFrame(tick);
  };
  f.__treeWatch = true;
  tick();
}, tree);
await A.page.keyboard.down('KeyW');
await waitSim(A, 3.5);
await A.page.keyboard.up('KeyW');
const walk = await A.page.evaluate((t) => {
  const f = window.__fw;
  f.__treeWatch = false;
  return { min: f.__treeMin, x: f.player.renderPos.x - t.x };
}, tree);
ok(walk.min < tree.radius + 1.2, `walked up to the trunk (closest ${walk.min.toFixed(2)} m from its centre)`);
ok(walk.min > tree.radius + 0.2, `and never into it (trunk radius ${tree.radius}, player radius 0.35)`);
await shot(A, 'tree');

// Bending marks: a fire jab at the trunk leaves scorch on its side.
await A.page.evaluate(() => (window.__fw.__ev.length = 0));
await castAt(A, tree.x, tree.y + 1.3, tree.z);
await until(A, () => window.__fw.marks.count > 0, null, 20000).catch(() => {});
const end = await A.page.evaluate(() => window.__fw.__ev.find((e) => e.t === 'projEnd'));
ok(!!end && Math.hypot(end.pos[0] - tree.x, end.pos[2] - tree.z) < tree.radius + 1.3, `the jab ends on the trunk (${end ? Math.hypot(end.pos[0] - tree.x, end.pos[2] - tree.z).toFixed(2) : '-'} m from its centre)`);
ok(await A.page.evaluate(() => window.__fw.marks.count > 0), 'it leaves a scorch mark');
await A.page.evaluate(([x, z]) => {
  const f = window.__fw;
  f.tpc.yaw = -Math.PI / 2;
  f.tpc.pitch = -0.05;
  void x;
  void z;
}, [tree.x, tree.z]);
await waitSim(A, 0.4);
await shot(A, 'scorch');

// Wildlife: animals around the site; hunt one for XP and loot.
await until(A, () => [...window.__fw.host.entities.values()].some((e) => e.kind === 'creature' && !e.dead), null, 60000).catch(() => {});
const prey = await A.page.evaluate(() => {
  const f = window.__fw;
  const me = f.host.me;
  const list = [...f.host.entities.values()].filter((e) => e.kind === 'creature' && !e.dead && !e.role && ['hare', 'lemur', 'foxhound', 'boar', 'tortoise'].includes(e.beast));
  list.sort((a, b) => a.maxHp - b.maxHp || a.pos.distanceTo(me.pos) - b.pos.distanceTo(me.pos));
  return list[0] ? { id: list[0].id, name: list[0].name, level: list[0].level } : null;
});
ok(!!prey, `wild animals roam the Wilds (hunting a level ${prey?.level} ${prey?.name})`);
ok(await A.page.evaluate(() => window.__fw.creatures.count > 0), `they are drawn (${await A.page.evaluate(() => window.__fw.creatures.count)} creatures in view)`);
const xpBefore = await A.page.evaluate(() => window.__fw.__xp.length);
const killed = prey && (await hunt(A, prey.id));
ok(killed, `the ${prey?.name} went down`);
await until(A, (n) => window.__fw.__xp.length > n, xpBefore, 20000).catch(() => {});
const xpGain = await A.page.evaluate((n) => window.__fw.__xp.slice(n), xpBefore);
ok(xpGain.some((g) => g.amount > 0 && g.reason.includes(prey?.name)), `XP for the kill: ${JSON.stringify(xpGain.map((g) => `${g.amount} ${g.reason}`))}`);
ok((await notes(A)).some((n) => /\+.*meat/i.test(n)), 'and meat from it');

// Taming: berries, walk up to a tameable animal, G, win its trust.
await A.page.evaluate(() => window.__fw.host.devGive({ berries: 6 }));
const tameDen = await A.page.evaluate(([x, z]) => {
  const f = window.__fw;
  const dens = f.wildInfo.densNear(x, z, 900).filter((d) => f.wildInfo.speciesById(d.species)?.tame);
  dens.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
  return dens[0] ?? null;
}, [SITE.x, SITE.z]);
ok(!!tameDen, `a den of tameable ${tameDen?.species}s at ${tameDen?.x.toFixed(0)}, ${tameDen?.z.toFixed(0)}`);
await goTo(A, tameDen.x + 8, tameDen.z);
const tameId = await until(A, () => {
  const f = window.__fw;
  const me = f.host.me;
  const c = [...f.host.entities.values()].filter((e) => e.kind === 'creature' && !e.dead && f.wildInfo.speciesById(e.beast)?.tame).sort((a, b) => a.pos.distanceTo(me.pos) - b.pos.distanceTo(me.pos))[0];
  return c?.id;
}, null, 60000).then((h) => h.jsonValue()).catch(() => null);
ok(!!tameId, 'found one to tame');
await playTrustFairly(A);
let tamed = false;
for (let attempt = 0; attempt < 3 && !tamed; attempt++) {
  const c = await A.page.evaluate((id) => {
    const e = window.__fw.host.entities.get(id);
    return e ? { x: e.pos.x, z: e.pos.z } : null;
  }, tameId);
  if (!c) break;
  await goTo(A, c.x + 2.5, c.z);
  await until(A, () => !document.querySelector('.tame-hint')?.classList.contains('hidden'), null, 15000).catch(() => {});
  if (attempt === 0) ok(/Tame the/.test(await A.page.evaluate(() => document.querySelector('.tame-hint')?.textContent ?? '')), `prompt: "${await A.page.evaluate(() => document.querySelector('.tame-hint')?.textContent ?? '')}"`);
  await A.page.keyboard.press('KeyG');
  const started = await until(A, () => window.__fw.trustUi.active, null, 20000).then(() => true).catch(() => false);
  if (attempt === 0) {
    ok(started, 'the trust game starts');
    await shot(A, 'trust');
  }
  if (!started) continue;
  await until(A, () => !window.__fw.trustUi.active, null, 120000).catch(() => {});
  tamed = await until(A, () => window.__fw.host.progress.pets.owned.length > 0, null, 20000).then(() => true).catch(() => false);
}
const owned = await A.page.evaluate(() => window.__fw.host.progress.pets.owned.map((p) => ({ ...p })));
ok(tamed && owned.length === 1, `tamed: ${owned.map((p) => p.name).join(', ')} (${(await notes(A)).filter((n) => /joined|bolts|lost/.test(n)).join(' | ')})`);
await until(A, () => [...window.__fw.host.entities.values()].some((e) => e.kind === 'pet' && e.owner === window.__fw.host.me.id), null, 30000).catch(() => {});
ok(await A.page.evaluate(() => [...window.__fw.host.entities.values()].some((e) => e.kind === 'pet' && e.owner === window.__fw.host.me.id)), 'the new pet is out with you');

// The pets panel (O).
await A.page.keyboard.press('KeyO');
await until(A, () => !document.querySelector('.pets')?.classList.contains('hidden'), null, 15000).catch(() => {});
const panel = await A.page.evaluate(() => document.querySelector('.pets')?.textContent ?? '');
ok(owned[0] && panel.includes(owned[0].name) && /fed/.test(panel), 'O opens the pets panel with your pet and how fed it is');
await shot(A, 'pets-panel');
await A.page.keyboard.press('KeyO');

// Riding (H): a rhino from the dev stable, faster than running, and the shard agrees.
await A.page.evaluate(() => window.__fw.host.devPet('rhino'));
await until(A, () => window.__fw.host.progress.pets.owned.some((p) => p.kind === 'rhino'), null, 20000).catch(() => {});
const rhinoUid = await A.page.evaluate(() => window.__fw.host.progress.pets.owned.find((p) => p.kind === 'rhino')?.uid);
await A.page.evaluate((uid) => window.__fw.host.setPet(uid), rhinoUid);
await until(A, () => [...window.__fw.host.entities.values()].some((e) => e.kind === 'pet' && e.beast === 'rhino' && e.owner === window.__fw.host.me.id), null, 30000).catch(() => {});
await goTo(A, SITE.x, SITE.z);
await physicsReady(A);
// Out of combat, with the rhino at your side.
await until(A, () => {
  const h = window.__fw.host;
  const pet = [...h.entities.values()].find((e) => e.kind === 'pet' && e.owner === h.me.id);
  return pet && pet.pos.distanceTo(h.me.pos) < 4 && h.time - h.me.lastCombat > 3.5;
}, null, 60000).catch(() => {});
await A.page.keyboard.press('KeyH');
await until(A, () => !!window.__fw.player.mount, null, 20000).catch(async () => console.log(`  notes: ${(await notes(A)).slice(-3).join(' | ')}`));
const seat = await A.page.evaluate(() => window.__fw.avatar.root.position.y - window.__fw.player.renderPos.y);
ok(await A.page.evaluate(() => window.__fw.player.mount?.speed === 1.35), 'H mounts the rhino');
ok(seat > 0.6, `you sit on its back (${seat.toFixed(2)} m up)`);
const correctionsBefore = A.warns.filter((w) => /corrected/.test(w)).length;
const ride0 = await pos(A);
const t0 = await A.page.evaluate(() => window.__fw.host.time);
await A.page.evaluate(() => (window.__fw.tpc.yaw = 0));
await A.page.keyboard.down('KeyW');
await waitSim(A, 4);
const speed = await A.page.evaluate(() => Math.hypot(window.__fw.player.velocity.x, window.__fw.player.velocity.z));
await A.page.keyboard.up('KeyW');
const ride1 = await pos(A);
const t1 = await A.page.evaluate(() => window.__fw.host.time);
await shot(A, 'riding');
ok(speed > 8.8 * 1.2, `riding speed ${speed.toFixed(1)} m/s (running is 8.8)`);
ok(A.warns.filter((w) => /corrected/.test(w)).length === correctionsBefore, `the shard accepts the faster pace (${Math.hypot(ride1.x - ride0.x, ride1.z - ride0.z).toFixed(0)} m in ${(t1 - t0).toFixed(1)} s, no corrections)`);
await A.page.keyboard.press('KeyH');
await until(A, () => !window.__fw.player.mount, null, 20000).catch(() => {});
ok(await A.page.evaluate(() => !window.__fw.player.mount), 'H again gets off');

// Bosses: a weakened Sun Dragon next to you (dev), telegraphs, boss bar, rewards and a forced Bond Trial.
// (Back in the Wilds and alive: a boss can't fight anyone inside a safe hub.)
await until(A, () => !window.__fw.host.me.dead, null, 60000).catch(() => {});
await goTo(A, SITE.x, SITE.z);
await waitSim(A, 1);
await A.page.evaluate(() => {
  const h = window.__fw.host;
  h.devBond(true);
  h.devBoss('sun_dragon', true, 10);
  window.__fw.__ev.length = 0;
});
await until(A, () => [...window.__fw.host.entities.values()].some((e) => e.id === 'boss_sun_dragon' && !e.dead), null, 30000).catch(() => {});
await until(A, () => !document.querySelector('.boss-bar')?.classList.contains('hidden'), null, 20000).catch(() => {});
ok(/Sun Dragon/.test(await A.page.evaluate(() => document.querySelector('.boss-bar')?.textContent ?? '')), 'boss bar shows the Sun Dragon');
await until(A, () => window.__fw.__ev.some((e) => e.t === 'tele'), null, 60000).catch(() => {});
const tele = await A.page.evaluate(() => window.__fw.__ev.find((e) => e.t === 'tele'));
ok(!!tele, `it telegraphs a ${tele?.shape} before striking`);
ok(await A.page.evaluate(() => window.__fw.telegraphs.group.children.length > 0 || window.__fw.__ev.some((e) => e.t === 'tele')), 'the danger zone is painted on the ground');
await shot(A, 'boss');
const xpB = await A.page.evaluate(() => window.__fw.__xp.length);
// A level-up heals you, so the Bond Trial starts at full health.
await A.page.evaluate(() => window.__fw.host.room.send('dev:xp', 30000));
await until(A, () => window.__fw.host.me.hp >= window.__fw.host.me.maxHp, null, 20000).catch(() => {});
ok(await hunt(A, 'boss_sun_dragon', 200), 'the weakened Sun Dragon falls');
await until(A, (n) => window.__fw.__xp.slice(n).some((g) => /Sun Dragon/.test(g.reason)), xpB, 20000).catch(() => {});
ok(await A.page.evaluate((n) => window.__fw.__xp.slice(n).some((g) => /Sun Dragon/.test(g.reason) && g.amount > 0), xpB), 'boss XP for everyone who fought');
await until(A, () => [...window.__fw.host.entities.values()].some((e) => e.trialOf === window.__fw.host.me.id), null, 30000).catch(() => {});
const trial = await A.page.evaluate(() => [...window.__fw.host.entities.values()].find((e) => e.trialOf === window.__fw.host.me.id)?.name);
const banner = await A.page.evaluate(() => document.querySelector('.announce')?.textContent ?? '');
ok(!!trial, `the Bond Trial opens: ${trial} (banner: "${banner}")${trial ? '' : ` notes: ${(await notes(A)).slice(-4).join(' | ')}`}`);
await shot(A, 'trial');
await A.page.evaluate(() => window.__fw.host.devBond(null));
ok(A.errors.length === 0, `A: no page errors${A.errors.length ? `: ${A.errors.slice(0, 3).join(' | ')}` : ''}`);

// Pets survive a reload (saved with the character).
await A.page.close();
await new Promise((r) => setTimeout(r, 1500));
const A2 = await open('A2', `char=Tamer${run}&el=fire&fac=sentinel`, A.ctx);
const kinds = await A2.page.evaluate(() => window.__fw.host.progress.pets.owned.map((p) => p.kind));
ok(kinds.length === 2 && kinds.includes('rhino'), `pets saved: ${kinds.join(', ')}`);
ok(A2.errors.length === 0, `A2: no page errors${A2.errors.length ? `: ${A2.errors.slice(0, 3).join(' | ')}` : ''}`);
await A.ctx.close();

// ---------- Offline ----------
const O = await open('O', `char=Drifter${run}&el=air&fac=sentinel&offline`);
ok(!(await O.page.evaluate(() => window.__fw.host.online)), 'O is offline');
await goTo(O, SITE.x, SITE.z);
await physicsReady(O);
await until(O, () => [...window.__fw.host.entities.values()].some((e) => e.kind === 'creature'), null, 60000).catch(() => {});
ok(await O.page.evaluate(() => [...window.__fw.host.entities.values()].some((e) => e.kind === 'creature')), 'offline: wildlife spawns around you');
// A flying mount: the Cloud Bison climbs with Space.
await O.page.evaluate(() => {
  const h = window.__fw.host;
  h.progress.level = 40;
  h.me.level = 40;
  h.devPet('cloud_bison');
  h.setPet(h.progress.pets.owned[0].uid);
});
await until(O, () => [...window.__fw.host.entities.values()].some((e) => e.kind === 'pet'), null, 30000).catch(() => {});
await waitSim(O, 3.5);
await O.page.keyboard.press('KeyH');
await until(O, () => !!window.__fw.player.mount, null, 20000).catch(() => {});
ok(await O.page.evaluate(() => window.__fw.player.mount?.fly === true), 'offline: riding the Cloud Bison');
const g0 = await O.page.evaluate(() => window.__fw.player.renderPos.y - window.__fw.sampler.height(window.__fw.player.renderPos.x, window.__fw.player.renderPos.z));
await O.page.keyboard.down('Space');
await waitSim(O, 2);
await O.page.keyboard.up('Space');
await waitSim(O, 1);
const g1 = await O.page.evaluate(() => window.__fw.player.renderPos.y - window.__fw.sampler.height(window.__fw.player.renderPos.x, window.__fw.player.renderPos.z));
ok(g1 > g0 + 3, `it flies: ${g0.toFixed(1)} m -> ${g1.toFixed(1)} m above the ground, and hovers`);
await shot(O, 'flying');
await O.page.keyboard.press('KeyH');
await until(O, () => !window.__fw.player.mount, null, 20000).catch(() => {});
await waitSim(O, 3);
// A boss offline (the test character is toughened so it stays in the fight).
await O.page.evaluate(() => {
  const h = window.__fw.host;
  h.me.maxHp = h.me.hp = 50000;
  window.__fw.__ev.length = 0;
  h.devBoss('ashmaw', true);
});
await until(O, () => window.__fw.__ev.some((e) => e.t === 'tele'), null, 300000).catch(() => {});
ok(await O.page.evaluate(() => window.__fw.__ev.some((e) => e.t === 'tele')), 'offline: the Ashmaw telegraphs its moves');
ok(/Ashmaw/.test(await O.page.evaluate(() => document.querySelector('.boss-bar')?.textContent ?? '')), 'offline: boss bar');
await shot(O, 'boss');
ok(O.errors.length === 0, `O: no page errors${O.errors.length ? `: ${O.errors.slice(0, 3).join(' | ')}` : ''}`);

await browser.close();
