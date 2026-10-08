// Phase 8 check: Special Arts. Online: a waterbender learns Healing from Mother
// Senna (talk with the interact key, visit three springs, return), keeps it
// after a reload, and the Pale Lady only teaches Bloodbending at night (shard
// clock shifted with the dev-only `dev:clock`). Offline: every other art does
// what it says (heal, lightning, metal cable, lava pool + wall, glider, flight,
// spirit projection). Needs `npm run server` and `npm run dev`.
//   node scripts/phase8-test.mjs [url]
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
const xpFor = (level) => {
  let s = 0;
  for (let l = 1; l < level; l++) s += Math.round(100 * l ** 1.5);
  return s;
};

async function open(label, query) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 680 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (/^\[(net|account)\]/.test(m.text())) console.log(`  ${label}: ${m.text()}`);
  });
  const u = new URL(base);
  u.search = query;
  await page.goto(u.toString());
  await page.waitForSelector('#loading.done', { timeout: 240000 });
  await page.evaluate(() => {
    const f = window.__fw;
    f.__ev = [];
    f.eventTaps.push((e) => f.__ev.push(e));
  });
  return { ctx, page, errors, label };
}
const until = (p, fn, arg, timeout = 60000) => p.page.waitForFunction(fn, arg, { timeout, polling: 250 });
const arts = (p) => p.page.evaluate(() => JSON.parse(JSON.stringify(window.__fw.host.progress.arts)));
const events = (p, t) => p.page.evaluate((tt) => window.__fw.__ev.filter((e) => e.t === tt), t);
/** Teleport next to a spot and wait until the player is there. */
async function goTo(p, x, z) {
  await p.page.evaluate(([a, b]) => window.__fw.tp(a, b), [x, z]);
  await until(p, ([a, b]) => Math.hypot(window.__fw.host.me.pos.x - a, window.__fw.host.me.pos.z - b) < 2, [x, z], 60000);
}
/** Offline: give the local character a level and learned arts. */
const grantOffline = (p, level, learned, equip) =>
  p.page.evaluate(
    ([lv, ids, eq]) => {
      const h = window.__fw.host;
      h.progress.level = lv;
      h.me.level = lv;
      for (const id of ids) if (!h.progress.arts.learned.includes(id)) h.progress.arts.learned.push(id);
      if (eq) h.equipArt(eq);
    },
    [level, learned, equip],
  );
/** Cast the Art slot, aimed at an entity (or along the camera aim). */
const castArt = (p, targetId) =>
  p.page.evaluate((id) => {
    const f = window.__fw;
    const me = f.host.me;
    const t = id ? f.host.entities.get(id) : null;
    const dir = t ? t.pos.clone().setY(t.pos.y + 1.1).sub(me.pos.clone().setY(me.pos.y + 1.4)).normalize() : f.abilities.aim.clone();
    f.host.cast('art', dir);
  }, targetId);
const waitSim = (p, seconds) => p.page.evaluate((s) => {
  const h = window.__fw.host;
  const end = h.time + s;
  return new Promise((r) => { const i = setInterval(() => { if (h.time >= end) { clearInterval(i); r(); } }, 100); });
}, seconds);

// ---------- Online: Healing quest ----------
const w = await open('W', `char=Senna${run}&el=water&fac=lantern`);
ok(await w.page.evaluate(() => window.__fw.host.online), 'W is online');
await w.page.evaluate((xp) => window.__fw.host.devXp(xp), xpFor(40) + 10);
await until(w, () => window.__fw.host.progress.level >= 40, null, 30000).catch(() => {});
ok((await w.page.evaluate(() => window.__fw.host.progress.level)) >= 40, `dev XP raised W to level ${await w.page.evaluate(() => window.__fw.host.progress.level)}`);

// Talk to Mother Senna with the interact key (pointer lock isn't needed for keys).
await goTo(w, -1297, -260);
await until(w, () => window.__fw.host.entities.has('master_healing'), null, 30000);
await w.page.waitForSelector('.interact-hint:not(.hidden)', { timeout: 30000 }).catch(() => {});
await w.page.keyboard.press('KeyG');
await until(w, () => /listen/.test(document.querySelector('.dialog:not(.hidden) p')?.textContent ?? ''), null, 20000).catch(() => {});
const line1 = await w.page.evaluate(() => document.querySelector('.dialog:not(.hidden) p')?.textContent ?? '');
ok(/Water remembers/.test(line1), `Mother Senna offers the quest: "${line1.slice(0, 60)}…"`);
await until(w, () => window.__fw.host.progress.arts.quests.healing?.step === 1, null, 15000).catch(() => {});
ok((await arts(w)).quests.healing?.step === 1, 'Healing quest started (step: visit the springs)');
await w.page.keyboard.press('KeyJ');
await w.page.waitForSelector('.arts:not(.hidden) .a-art', { timeout: 10000 });
const panel = await w.page.evaluate(() => [...document.querySelectorAll('.a-art')].map((e) => e.querySelector('b').textContent + ': ' + e.querySelector('.a-status').textContent));
ok(panel.some((t) => /Healing: Visit the three spirit springs \(0\/3\)/.test(t)) && panel.some((t) => /^Bloodbending/.test(t)), `arts panel lists water arts (${panel.length}): ${panel[0]}`);
await w.page.screenshot({ path: `${outDir}/p8-arts-panel.png` });
await w.page.keyboard.press('KeyJ');
const compass = await w.page.evaluate(() => document.querySelector('.quest-compass:not(.hidden)')?.textContent ?? '');
ok(/Healing · North spring/.test(compass), `quest compass points the way: "${compass}"`);

for (const [x, z, n] of [[-1180, -620, 1], [-1480, -420, 2], [-1200, -80, 3]]) {
  await goTo(w, x, z);
  await until(w, (k) => (window.__fw.host.progress.arts.quests.healing?.done.length ?? 0) >= k || window.__fw.host.progress.arts.quests.healing?.step === 2, n, 20000).catch(() => {});
}
ok((await arts(w)).quests.healing?.step === 2, 'visited all three springs: back to Mother Senna');
await goTo(w, -1297, -260);
await w.page.evaluate(() => window.__fw.host.talkTo('master_healing'));
await until(w, () => window.__fw.host.progress.arts.learned.includes('healing'), null, 15000).catch(() => {});
const wa = await arts(w);
ok(wa.learned.includes('healing') && wa.equipped === 'healing', `learned Healing and it went in the Art slot (${wa.equipped})`);
ok(await w.page.evaluate(() => window.__fw.abilities.kit.abilities.some((a) => a.slot === 'art' && a.id === 'healing')), 'Art slot ability is Healing Waters');
await castArt(w, null);
await until(w, () => window.__fw.__ev.some((e) => e.t === 'area' && e.ability === 'healing'), null, 15000).catch(() => {});
ok((await events(w, 'area')).some((e) => e.ability === 'healing'), 'shard ran the healing circle');
await w.page.screenshot({ path: `${outDir}/p8-healing.png` });

// Bloodbending: the Pale Lady refuses by day and teaches at night.
await goTo(w, 1189, 1736);
await until(w, () => window.__fw.host.entities.has('master_blood'), null, 30000);
const night = () => w.page.evaluate(() => window.__fw.dayNight.nightFactor);
// Find an hour shift that makes it day, then night.
for (const shift of [0, 6, 12, 18]) {
  await w.page.evaluate((h) => window.__fw.host.devClock(h), shift);
  await w.page.waitForTimeout(2500);
  if ((await night()) < 0.2) break;
}
await w.page.evaluate(() => window.__fw.host.talkTo('master_blood'));
await until(w, () => window.__fw.host.questLines.length > 0 || /moon/.test(document.querySelector('.dialog p')?.textContent ?? ''), null, 10000).catch(() => {});
await w.page.waitForTimeout(1500);
ok(!(await arts(w)).quests.blood, `by day (night ${(await night()).toFixed(2)}) the Pale Lady sends W away`);
for (const shift of [12, 6, 18, 0]) {
  await w.page.evaluate((h) => window.__fw.host.devClock(h), shift);
  await w.page.waitForTimeout(2500);
  if ((await night()) > 0.7) break;
}
await w.page.evaluate(() => window.__fw.host.talkTo('master_blood'));
await until(w, () => !!window.__fw.host.progress.arts.quests.blood, null, 15000).catch(() => {});
ok((await arts(w)).quests.blood?.step === 1, `at night (night ${(await night()).toFixed(2)}) she starts the Bloodbending quest`);
await w.page.evaluate(() => window.__fw.host.devClock(0));

// Persistence.
await w.page.evaluate(() => window.__fw.host.leave());
await w.page.waitForTimeout(1500);
await w.page.reload();
await w.page.waitForSelector('#loading.done', { timeout: 240000 });
const wa2 = await arts(w);
ok(wa2.learned.includes('healing') && wa2.equipped === 'healing' && wa2.quests.blood?.step === 1, 'after reload: Healing learned + equipped, Bloodbending quest kept');

// ---------- Offline: the other arts ----------
// Fire: Lightning strikes a dummy in a line after charging.
const f = await open('F', `offline&char=Kazan${run}&el=fire&fac=redfang`);
await goTo(f, 0, -12);
await grantOffline(f, 20, ['lightning'], 'lightning');
const hp0 = await f.page.evaluate(() => window.__fw.host.entities.get('dummy_a').hp);
await castArt(f, 'dummy_a');
await until(f, () => window.__fw.__ev.some((e) => e.t === 'beam'), null, 60000).catch(() => {});
const beams = await events(f, 'beam');
const charges = await events(f, 'charge');
const hp1 = await f.page.evaluate(() => window.__fw.host.entities.get('dummy_a').hp);
ok(charges.length > 0 && beams.length > 0 && hp1 < hp0, `Lightning: charge ${charges[0]?.duration}s then beam, dummy ${hp0} -> ${hp1}`);
await f.page.screenshot({ path: `${outDir}/p8-lightning.png` });

// Water: Healing restores health and cleanses burn.
const h = await open('H', `offline&char=Kya${run}&el=water&fac=sentinel`);
await grantOffline(h, 15, ['healing'], 'healing');
await h.page.evaluate(() => {
  const me = window.__fw.host.me;
  me.hp = 60;
  me.statuses.set('burn', { type: 'burn', remaining: 5, source: null, dps: 4, amount: 0, tickAcc: 0 });
});
await castArt(h, null);
await waitSim(h, 3.2);
const hh = await h.page.evaluate(() => ({ hp: window.__fw.host.me.hp, burn: window.__fw.host.me.statuses.has('burn') }));
ok(hh.hp > 100 && !hh.burn, `Healing: 60 -> ${hh.hp} hp, burn cleansed: ${!hh.burn}`);

// Earth: Metal cable drags a dummy; lava pool burns and cools into a wall.
const e = await open('E', `offline&char=Toph${run}&el=earth&fac=sentinel`);
// Stand 8 m from the dummy so the cable has a clear line (no terrain in between).
const da = await e.page.evaluate(() => window.__fw.host.entities.get('dummy_a').pos.clone());
await goTo(e, da.x, da.z - 8);
await grantOffline(e, 35, ['metal', 'lava'], 'metal');
await castArt(e, 'dummy_a');
await until(e, () => window.__fw.__ev.some((x) => x.t === 'hit' && x.target === 'dummy_a'), null, 30000).catch(() => {});
const pulled = await e.page.evaluate(() => window.__fw.__ev.filter((x) => x.t === 'impulse' && x.target === 'dummy_a').map((x) => x.v));
ok(pulled.length > 0 && pulled[0][2] < 0, `Metal cable hit dummy_a and pulled it toward the caster (impulse z ${pulled[0]?.[2]?.toFixed(1)})`);
await e.page.evaluate(() => window.__fw.host.equipArt('lava'));
await waitSim(e, 0.5);
await castArt(e, 'dummy_b');
await until(e, () => window.__fw.__ev.some((x) => x.t === 'area' && x.ability === 'lava'), null, 30000).catch(() => {});
ok((await events(e, 'area')).some((x) => x.ability === 'lava'), 'Lava pool placed');
await until(e, () => window.__fw.__ev.some((x) => x.t === 'status' && x.status === 'burn' && x.target.startsWith('dummy')), null, 60000).catch(() => {});
ok(await e.page.evaluate(() => window.__fw.__ev.some((x) => x.t === 'status' && x.status === 'burn')), 'lava burns the dummy');
await e.page.screenshot({ path: `${outDir}/p8-lava.png` });
await until(e, () => window.__fw.__ev.some((x) => x.t === 'wall'), null, 120000).catch(() => {});
ok((await events(e, 'wall')).length > 0, 'lava cooled into a rock wall');
await e.page.screenshot({ path: `${outDir}/p8-wall.png` });

// Air: glider at level 10, then flight and spirit projection.
const a = await open('A', `offline&char=Aang${run}&el=air&fac=freeisles`);
await goTo(a, 30, 40);
await grantOffline(a, 45, ['flight', 'spirit'], 'flight');
await until(a, () => window.__fw.player.canGlide, null, 10000).catch(() => {});
ok(await a.page.evaluate(() => window.__fw.player.canGlide), 'airbender at level 10+ has the glider');
await castArt(a, null);
await until(a, () => window.__fw.player.flying, null, 20000).catch(() => {});
ok(await a.page.evaluate(() => window.__fw.player.flying), 'Flight: the player is flying');
const y0 = await a.page.evaluate(() => window.__fw.player.renderPos.y);
await a.page.keyboard.down('Space');
await waitSim(a, 1.5);
await a.page.keyboard.up('Space');
const y1 = await a.page.evaluate(() => window.__fw.player.renderPos.y);
ok(y1 > y0 + 3, `holding jump climbs: y ${y0.toFixed(1)} -> ${y1.toFixed(1)}`);
await a.page.screenshot({ path: `${outDir}/p8-flight.png` });
// Land by recasting, then open the glider in the fall.
await castArt(a, null);
await until(a, () => !window.__fw.player.flying, null, 20000).catch(() => {});
await a.page.keyboard.press('Space');
await until(a, () => window.__fw.player.gliding || window.__fw.player.grounded, null, 20000).catch(() => {});
const glide = await a.page.evaluate(() => ({ g: window.__fw.player.gliding, vy: window.__fw.player.velocity.y }));
ok(glide.g && glide.vy > -3.5, `recast ends flight; jump in the air opens the glider (fall ${glide.vy.toFixed(1)} m/s)`);
await until(a, () => window.__fw.player.grounded, null, 60000).catch(() => {});
await a.page.evaluate(() => window.__fw.host.equipArt('spirit'));
await waitSim(a, 0.5);
const body = await a.page.evaluate(() => window.__fw.player.renderPos.clone());
await castArt(a, null);
await until(a, () => window.__fw.spirit.t > 0, null, 20000).catch(() => {});
await a.page.keyboard.down('KeyW');
await waitSim(a, 1.5);
await a.page.keyboard.up('KeyW');
const sp = await a.page.evaluate((b) => ({ t: window.__fw.spirit.t, frozen: window.__fw.player.frozen, moved: window.__fw.player.renderPos.distanceTo(b), cam: window.__fw.camera.position.distanceTo(b) }), body);
ok(sp.t > 0 && sp.frozen && sp.moved < 0.5 && sp.cam > 5, `Spirit projection: body stays (${sp.moved.toFixed(2)} m), spirit camera roams (${sp.cam.toFixed(1)} m away)`);
await a.page.screenshot({ path: `${outDir}/p8-spirit.png` });
await castArt(a, null);
await until(a, () => window.__fw.spirit.t <= 0, null, 20000).catch(() => {});
ok(await a.page.evaluate(() => window.__fw.spirit.t <= 0 && !window.__fw.player.frozen), 'recasting returns to the body');

// Offline arts survive a reload.
await a.page.evaluate(() => window.__fw.saveLocal());
await a.page.reload();
await a.page.waitForSelector('#loading.done', { timeout: 240000 });
const aa = await arts(a);
ok(aa.learned.includes('spirit') && aa.equipped === 'spirit', `offline arts kept after reload (${aa.learned.join(', ')}; equipped ${aa.equipped})`);

for (const p of [w, f, h, e, a]) ok(p.errors.length === 0, `${p.label} console errors: ${p.errors.slice(0, 3).join(' | ') || 'none'}`);
await browser.close();
