// Phase 9 check: camps and bending crafting. Online with three characters:
// an earthbender gathers wood (interact key), builds a camp with the build
// panel and the placement ghost, stores items in a chest, makes refined ore at
// an ore vein (channel key) and mud with a waterbender ally; an outlaw
// firebender can't hurt the camp outside the raid window but can during it
// (forced with the dev-only `dev:raid`). The camp and bag survive a reload, and a dropped
// connection rejoins by itself.
// Offline: a camp saves in the browser and you respawn at your campfire.
// Needs `npm run server` and `npm run dev`.
//   node scripts/phase9-test.mjs [url]
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
// A dry, flat spot in the Wilds far from every hub (scripts/building-check.ts finds the same one).
const SITE = { x: -219, z: -773 };

async function open(label, query, ctx = null) {
  ctx ??= await browser.newContext({ viewport: { width: 1100, height: 680 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
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
    f.eventTaps.push((e) => f.__ev.push(e));
    const show = f.zoneHud.show.bind(f.zoneHud);
    f.zoneHud.show = (text, warn) => {
      f.__notes.push(text);
      return show(text, warn);
    };
  });
  return { ctx, page, errors, label };
}
const until = (p, fn, arg, timeout = 60000) => p.page.waitForFunction(fn, arg, { timeout, polling: 250 });
const inv = (p) => p.page.evaluate(() => ({ ...window.__fw.host.progress.inv }));
const notes = (p) => p.page.evaluate(() => window.__fw.__notes.slice());
async function goTo(p, x, z) {
  await p.page.evaluate(([a, b]) => window.__fw.tp(a, b), [x, z]);
  await until(p, ([a, b]) => Math.hypot(window.__fw.host.me.pos.x - a, window.__fw.host.me.pos.z - b) < 2, [x, z], 60000);
}
const waitSim = (p, seconds) => p.page.evaluate((s) => {
  const h = window.__fw.host;
  const end = h.time + s;
  return new Promise((r) => { const i = setInterval(() => { if (h.time >= end) { clearInterval(i); r(); } }, 100); });
}, seconds);
const myPieces = (p) => p.page.evaluate(() => window.__fw.host.camps.ofOwner(window.__fw.host.charId).map((s) => ({ ...s })));
/** A free camp site near (x0, z0): flat, and allowed by the placement rules (other runs' camps included). */
async function findSite(p, x0, z0) {
  await goTo(p, x0, z0);
  await waitSim(p, 2);
  return p.page.evaluate(([sx, sz]) => {
    const f = window.__fw;
    const h = f.host;
    const g = (x, z) => f.sampler.height(x, z);
    const b = { charId: 'probe', name: 'probe', side: h.me.side, faction: h.me.faction, x: 0, z: 0, inv: { wood: 999, stone: 999 } };
    for (let r = 0; r < 300; r += 20) {
      for (let a = 0; a < Math.PI * 2; a += r ? 20 / r : 7) {
        const x = Math.round(sx + Math.cos(a) * r);
        const z = Math.round(sz + Math.sin(a) * r);
        let rough = 0;
        for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6]]) rough = Math.max(rough, Math.abs(g(x + dx, z + dz) - g(x, z)));
        if (rough > 1.5) continue;
        b.x = x;
        b.z = z;
        if (!h.camps.check(b, { piece: 'campfire', x, z, rot: 0 }) && !h.camps.check(b, { piece: 'campfire', x: x + 8, z: z + 8, rot: 0 })) return { x, z };
      }
    }
    return null;
  }, [x0, z0]);
}
/** Open the build panel (B), pick a piece and place it with a click where the ghost stands. */
async function buildWithGhost(p, piece, rotate = 0) {
  const before = (await myPieces(p)).length;
  // Face -z so the ghost lands in a known spot (3-5 m ahead).
  await p.page.evaluate(() => (window.__fw.tpc.yaw = 0));
  await p.page.keyboard.press('KeyB');
  await p.page.waitForSelector('.camp:not(.hidden) [data-piece]', { timeout: 30000 });
  await p.page.click(`.camp [data-piece="${piece}"]`);
  for (let i = 0; i < rotate; i++) {
    await p.page.keyboard.press('KeyR');
    await waitSim(p, 0.2);
  }
  await until(p, () => window.__fw.build.placing && window.__fw.build.ghostAt.err === '', null, 20000).catch(() => {});
  const ghost = await p.page.evaluate(() => ({ ...window.__fw.build.ghostAt, rot: window.__fw.build.rot }));
  await p.page.mouse.click(550, 340);
  await until(p, (n) => window.__fw.host.camps.ofOwner(window.__fw.host.charId).length > n, before, 20000).catch(() => {});
  await p.page.evaluate(() => window.__fw.build.cancelPlacing());
  const after = await myPieces(p);
  return { ghost, placed: after.find((s) => s.piece === piece && Math.abs(s.x - ghost.x) < 0.01 && Math.abs(s.z - ghost.z) < 0.01) };
}

// ---------- Online ----------
const A = await open('A', `char=Mason${run}&el=earth&fac=sentinel`);
ok(await A.page.evaluate(() => window.__fw.host.online), 'A (earth, Sentinel) is online');

// Gather wood by hand at a starter timber outside the hub gate.
const timber = await A.page.evaluate(() => {
  const f = window.__fw;
  f.nodeView.update(f.host.me.pos.x + 100, f.host.me.pos.z);
  f.nodeView.update(f.host.me.pos.x, f.host.me.pos.z);
  return f.nodeView.shown.find((n) => n.type === 'timber' && n.id.startsWith('hub_'));
});
ok(!!timber, `starter timber outside the gate (${timber?.id})`);
await goTo(A, timber.x + 1.5, timber.z);
await until(A, () => /gather/.test(document.querySelector('.camp-prompt')?.textContent ?? ''), null, 20000).catch(() => {});
ok(/Fallen timber.*gather/.test(await A.page.evaluate(() => document.querySelector('.camp-prompt')?.textContent ?? '')), 'prompt: "Fallen timber · G gather"');
await A.page.keyboard.press('KeyG');
await until(A, () => (window.__fw.host.progress.inv.wood ?? 0) >= 3, null, 20000).catch(() => {});
ok((await inv(A)).wood === 3, 'G gathers 3 wood');
await A.page.keyboard.press('KeyG');
await until(A, () => window.__fw.__notes.some((n) => /spent/.test(n)), null, 20000).catch(() => {});
ok((await inv(A)).wood === 3 && (await notes(A)).some((n) => /spent/.test(n)), 'the node needs time to grow back');

// Environment crafting: earth at an ore vein makes refined ore.
const ore = await A.page.evaluate(() => window.__fw.nodeView.shown.find((n) => n.type === 'ore_node' && n.id.startsWith('hub_')));
await goTo(A, ore.x + 2, ore.z);
await A.page.keyboard.press('KeyC');
await until(A, () => (window.__fw.host.progress.inv.refined_ore ?? 0) >= 1, null, 20000).catch(() => {});
ok((await inv(A)).refined_ore === 1, 'C next to an ore vein: earth bends refined ore');
await until(A, () => window.__fw.__ev.some((e) => e.t === 'craft'), null, 20000).catch(() => {});
ok((await A.page.evaluate(() => window.__fw.__ev.filter((e) => e.t === 'craft').length)) >= 1, 'craft event for the VFX');

// Build a camp in the Wilds with the panel and the ghost.
await A.page.evaluate(() => window.__fw.host.devGive({ wood: 60, stone: 30 }));
await until(A, () => (window.__fw.host.progress.inv.wood ?? 0) >= 60, null, 20000);
const site = await findSite(A, SITE.x, SITE.z);
ok(!!site, `found a free camp site in the Wilds (${site?.x}, ${site?.z})`);
await goTo(A, site.x, site.z);
const xp0 = await A.page.evaluate(() => window.__fw.host.progress.xp + window.__fw.host.progress.level * 1e6);
const fire = await buildWithGhost(A, 'campfire');
ok(!!fire.placed, `campfire placed with the ghost at ${fire.ghost.x}, ${fire.ghost.z}`);
await until(A, () => window.__fw.host.progress.milestones.includes('firstCamp'), null, 20000).catch(() => {});
ok((await A.page.evaluate(() => window.__fw.host.progress.xp + window.__fw.host.progress.level * 1e6)) > xp0, 'first camp milestone XP');
// Build each piece from its own spot so the ghost never lands on an earlier one.
await goTo(A, site.x - 8, site.z);
const wood0 = (await inv(A)).wood;
const wall = await buildWithGhost(A, 'wood_wall', 1);
ok(!!wall.placed && wall.placed.rot === 1, `R rotates the ghost: wall placed turned (rot ${wall.placed?.rot})`);
ok((await inv(A)).wood === wood0 - 6, 'the wall cost 6 wood');
ok((await A.page.evaluate(() => window.__fw.structView.count)) >= 2, 'structures render (meshes + colliders)');
await goTo(A, site.x + 8, site.z);
const chest = await buildWithGhost(A, 'chest');
ok(!!chest.placed, `chest placed${chest.placed ? '' : ` (ghost: ${JSON.stringify(chest.ghost)})`}`);
await A.page.screenshot({ path: `${outDir}/p9-camp.png` });

// Chest: G opens it, store everything, take stone back.
await goTo(A, chest.placed.x + 1.5, chest.placed.z);
await A.page.keyboard.press('KeyG');
await A.page.waitForSelector('.camp:not(.hidden) [data-putall]', { timeout: 20000 }).catch(() => {});
await A.page.click('.camp [data-putall]').catch(() => {});
await until(A, () => Object.keys(window.__fw.host.progress.inv).length === 0, null, 20000).catch(() => {});
const stored = await A.page.evaluate((id) => ({ ...window.__fw.host.camps.all.get(id)?.store }), chest.placed.id);
ok(Object.keys(await inv(A)).length === 0 && stored.wood > 0, `chest holds the bag (${JSON.stringify(stored)})`);
await A.page.click('.camp [data-take="stone"]').catch(() => {});
await until(A, () => (window.__fw.host.progress.inv.stone ?? 0) > 0, null, 20000).catch(() => {});
ok((await inv(A)).stone === stored.stone, 'take stone back out');
await A.page.screenshot({ path: `${outDir}/p9-panel.png` });
await A.page.keyboard.press('KeyB');

// Party crafting: a waterbender ally channels with A.
const B = await open('B', `char=Brook${run}&el=water&fac=lantern`);
await goTo(B, site.x + 3, site.z + 3);
await goTo(A, site.x + 1, site.z + 3);
// Both press C; at 1-3 headless FPS the two presses can land further apart than the 1.5 s window, so retry.
for (let i = 0; i < 4 && !((await inv(A)).mud >= 3); i++) {
  await Promise.all([B.page.keyboard.press('KeyC'), A.page.keyboard.press('KeyC')]);
  await until(A, () => (window.__fw.host.progress.inv.mud ?? 0) >= 3, null, 8000).catch(() => {});
}
await until(B, () => (window.__fw.host.progress.inv.mud ?? 0) >= 3, null, 10000).catch(() => {});
ok((await inv(A)).mud === 3 && (await inv(B)).mud === 3, 'water + earth channelling together: 3 mud each');

// Raids: an outlaw firebender against the wall.
const C = await open('C', `char=Ember${run}&el=fire&fac=redfang`);
const W = wall.placed;
await goTo(C, W.x - 6, W.z);
await until(C, (id) => window.__fw.host.camps.all.has(id), W.id, 30000).catch(() => {});
// Stand 6 m from the wall with a clear line of fire: trunks and boulders stop bending,
// and other camp pieces would take the hits instead.
const stand = await C.page.evaluate((id) => {
  const f = window.__fw;
  const w = f.host.camps.all.get(id);
  const g = (x, z) => f.sampler.height(x, z);
  for (let k = 0; k < 16; k++) {
    const a = Math.PI + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
    const x = w.x + Math.cos(a) * 6;
    const z = w.z + Math.sin(a) * 6;
    let clear = Math.abs(g(x, z) - g(w.x, w.z)) < 2;
    for (let t = 0; t <= 1 && clear; t += 0.05) {
      const px = x + (w.x - x) * t;
      const pz = z + (w.z - z) * t;
      const py = g(x, z) + 1.4 + (w.y + 1.5 - g(x, z) - 1.4) * t;
      if (f.obstacles.hit(px, py, pz, 0.4)) clear = false;
      for (const s of f.host.camps.all.values()) if (s.id !== id && Math.hypot(s.x - px, s.z - pz) < 2.5) clear = false;
    }
    if (clear) return { x, z };
  }
  return { x: w.x - 6, z: w.z };
}, W.id).catch(() => ({ x: W.x - 6, z: W.z }));
await goTo(C, stand.x, stand.z);
ok(await C.page.evaluate((id) => window.__fw.host.camps.all.has(id), W.id), 'other players see the camp (streamed structures)');
const shoot = (n) => C.page.evaluate(async ([id, count]) => {
  const f = window.__fw;
  for (let i = 0; i < count; i++) {
    const s = f.host.camps.all.get(id);
    const me = f.host.me;
    const dir = { x: s.x - me.pos.x, y: s.y + 1.5 - (me.pos.y + 1.4), z: s.z - me.pos.z };
    const l = Math.hypot(dir.x, dir.y, dir.z);
    f.host.cast('basic', new f.player.renderPos.constructor(dir.x / l, dir.y / l, dir.z / l));
    const end = f.host.time + 0.7;
    await new Promise((r) => { const t = setInterval(() => { if (f.host.time >= end) { clearInterval(t); r(); } }, 100); });
  }
}, [W.id, n]);
await C.page.evaluate(() => window.__fw.host.devRaid(false));
await shoot(3);
await until(C, () => window.__fw.__notes.some((n) => /raid window/i.test(n)), null, 20000).catch(() => {});
ok((await notes(C)).some((n) => /raid window/i.test(n)), 'outside the raid window: "Camps can only be raided in the raid window"');
ok((await A.page.evaluate((id) => window.__fw.host.camps.all.get(id)?.hp, W.id)) === W.maxHp, 'the wall is untouched');
await C.page.evaluate(() => window.__fw.host.devRaid(true));
await shoot(3);
await until(A, ([id, max]) => (window.__fw.host.camps.all.get(id)?.hp ?? max) < max, [W.id, W.maxHp], 20000).catch(() => {});
const hpA = await A.page.evaluate((id) => window.__fw.host.camps.all.get(id)?.hp, W.id);
ok(hpA < W.maxHp, `raid window open: the wall takes damage (${hpA}/${W.maxHp}), the owner sees it`);
ok((await C.page.evaluate(() => window.__fw.__ev.filter((e) => e.t === 'struct').length)) > 0, 'struct hit events reach the attacker');
await C.page.evaluate(() => window.__fw.host.devRaid(null));
await C.page.screenshot({ path: `${outDir}/p9-raid.png` });

// Reload A: camp and bag persist.
const invBefore = await inv(A);
await A.page.evaluate(() => window.__fw.host.leave());
await waitSim(B, 3);
await A.page.close();
const A2 = await open('A2', `char=Mason${run}&el=earth&fac=sentinel`, A.ctx);
await until(A2, () => window.__fw.host.camps.campfireOf(window.__fw.host.charId), null, 30000).catch(() => {});
ok((await myPieces(A2)).length === 3, 'after a reload the camp is still there (3 pieces)');
const sorted = (o) => JSON.stringify(Object.entries(o).sort());
ok(sorted(await inv(A2)) === sorted(invBefore), `the bag is saved (${JSON.stringify(invBefore)})`);

// Take the wall down: it disappears for everyone, half the cost comes back.
await goTo(A2, W.x + 2, W.z + 1);
await A2.page.keyboard.press('KeyB');
await A2.page.waitForSelector(`.camp:not(.hidden) [data-remove="${W.id}"]`, { timeout: 20000 }).catch(() => {});
const w0 = (await inv(A2)).wood ?? 0;
await A2.page.click(`.camp [data-remove="${W.id}"]`).catch(() => {});
await until(C, (id) => !window.__fw.host.camps.all.has(id), W.id, 20000).catch(() => {});
ok(!(await C.page.evaluate((id) => window.__fw.host.camps.all.has(id), W.id)), 'taking a piece down removes it for everyone');
await until(A2, (n) => (window.__fw.host.progress.inv.wood ?? 0) === n + 3, w0, 10000).catch(() => {});
ok((await inv(A2)).wood === w0 + 3, 'half the cost is refunded');
// A dropped connection (closed under the client, not a leave) plays on offline and rejoins by itself.
const cId = await C.page.evaluate(() => window.__fw.host.me.id);
await C.page.evaluate(() => window.__fw.host.room.connection.close(4100, 'test drop'));
await until(C, (id) => window.__fw.host.online && window.__fw.host.me.id !== id, cId, 90000).catch(() => {});
ok(await C.page.evaluate((id) => window.__fw.host.online && window.__fw.host.me.id !== id, cId), 'a dropped connection rejoins the shard by itself');
// Leave the world as we found it so later runs find free sites.
await A2.page.evaluate(() => window.__fw.host.devClearCamp?.());
await until(C, () => !window.__fw.host.camps.all.size, null, 20000).catch(() => {});
for (const p of [A2, B, C]) ok(p.errors.length === 0, `${p.label}: no page errors${p.errors.length ? `: ${p.errors.slice(0, 3).join(' | ')}` : ''}`);
for (const ctx of new Set([A.ctx, B.ctx, C.ctx])) await ctx.close();

// ---------- Offline ----------
const O = await open('O', `char=Hermit${run}&el=fire&fac=ash&offline`);
ok(!(await O.page.evaluate(() => window.__fw.host.online)), 'O is offline');
const OS = await findSite(O, SITE.x, SITE.z);
await goTo(O, OS.x, OS.z);
await O.page.evaluate(() => window.__fw.host.devGive({ wood: 10, stone: 5 }));
const ofire = await buildWithGhost(O, 'campfire');
ok(!!ofire.placed, 'offline: campfire placed');
await O.page.evaluate(() => window.__fw.saveLocal());
await O.page.reload({ timeout: 120000 });
await O.page.waitForSelector('#loading.done', { timeout: 240000 });
ok(await O.page.evaluate(() => !!window.__fw.host.camps.campfireOf(window.__fw.host.charId)), 'offline camp is kept in this browser');
await goTo(O, OS.x + 40, OS.z + 30);
await O.page.evaluate(() => window.__fw.host.sim.kill(window.__fw.host.me, null));
await until(O, () => !window.__fw.host.me.dead, null, 30000).catch(() => {});
await waitSim(O, 1);
const back = await O.page.evaluate(([x, z]) => Math.hypot(window.__fw.player.renderPos.x - x, window.__fw.player.renderPos.z - z), [ofire.placed.x, ofire.placed.z]);
ok(back < 6, `respawn at your campfire (${back.toFixed(1)} m away)`);
ok(O.errors.length === 0, `O: no page errors${O.errors.length ? `: ${O.errors.slice(0, 3).join(' | ')}` : ''}`);

await browser.close();
