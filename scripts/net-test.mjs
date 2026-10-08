// Phase 5 check: two browsers join the same shard, see each other move, and
// server-authoritative hits land (on a dummy, then PvP at a contested shrine).
// Needs `npm run server` and `npm run dev` running. Usage: node scripts/net-test.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5173/';
const outDir = 'screenshots';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

const run = Date.now().toString(36).slice(-4);
async function open(name, element, faction) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.text().startsWith('[net]')) console.log(`  ${name}: ${m.text()}`);
  });
  // ?char= skips the title screen (guest account, character created on first use).
  const u = new URL(url);
  u.search = `char=${name}${run}&el=${element}&fac=${faction}`;
  await page.goto(u.toString());
  await page.waitForSelector('#loading.done', { timeout: 240000 });
  await page.evaluate(() => window.__fw.netReady);
  return { page, errors, name };
}

const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const state = (p) =>
  p.page.evaluate(() => {
    const f = window.__fw;
    const ents = [...f.host.entities.values()].map((e) => ({ id: e.id, name: e.name, kind: e.kind, hp: e.hp, x: +e.pos.x.toFixed(2), z: +e.pos.z.toFixed(2), dead: e.dead }));
    return { net: f.netStatus, online: f.host.online, me: f.host.me.id, ents };
  });
const until = async (p, fn, arg, timeout = 60000) => p.page.waitForFunction(fn, arg, { timeout, polling: 250 });

const a = await open('Aang', 'air', 'freeisles');
const b = await open('Zuko', 'fire', 'redfang');
let sa = await state(a);
let sb = await state(b);
ok(sa.online && sb.online, `both online (${sa.net} / ${sb.net})`);
ok(sa.net === sb.net, 'same shard');

// Each spawns in their own faction hub; meet in the open near the training dummies.
await a.page.evaluate(() => window.__fw.tp(0, -1));
await b.page.evaluate(() => window.__fw.tp(3, 4));
await until(a, (id) => window.__fw.host.entities.has(id), sb.me);
await until(b, (id) => window.__fw.host.entities.has(id), sa.me);
ok(true, 'each sees the other player');

// Movement: A walks forward; B should see A's position change (interpolated).
// The teleport lands on A's next frame; wait for it before measuring the walk.
await until(a, () => Math.hypot(window.__fw.player.renderPos.x, window.__fw.player.renderPos.z + 1) < 1);
const before = (await state(b)).ents.find((e) => e.id === sa.me);
const start = await a.page.evaluate(() => ({ x: window.__fw.player.renderPos.x, z: window.__fw.player.renderPos.z }));
await a.page.keyboard.down('KeyW');
// Headless frames are slow (software GL), so walk until A has covered 4 m rather than for a fixed time.
await until(a, (s0) => Math.hypot(window.__fw.player.renderPos.x - s0.x, window.__fw.player.renderPos.z - s0.z) > 4, start, 90000);
await a.page.keyboard.up('KeyW');
await a.page.waitForTimeout(3000);
const after = (await state(b)).ents.find((e) => e.id === sa.me);
const aSelf = await a.page.evaluate(() => ({ x: window.__fw.player.renderPos.x, z: window.__fw.player.renderPos.z }));
const moved = Math.hypot(after.x - before.x, after.z - before.z);
const lag = Math.hypot(after.x - aSelf.x, after.z - aSelf.z);
ok(moved > 2, `B saw A move ${moved.toFixed(1)} m (B's view is ${lag.toFixed(2)} m from A's own position)`);

// Server-authoritative hit on a dummy, seen by both.
await a.page.evaluate(() => window.__fw.tp(0, -1));
await a.page.waitForTimeout(800);
const dummyHp = async (p) => (await state(p)).ents.find((e) => e.id === 'dummy_a')?.hp;
const hp0 = await dummyHp(b);
await a.page.evaluate(() => {
  const f = window.__fw;
  const d = f.host.entities.get('dummy_a');
  const me = f.host.me;
  const dir = d.pos.clone().setY(d.pos.y + 1.3).sub(me.pos.clone().setY(me.pos.y + 1.4)).normalize();
  f.host.cast('heavy', dir);
});
await until(b, (h) => window.__fw.host.entities.get('dummy_a')?.hp < h, hp0, 20000).catch(() => {});
const hp1 = await dummyHp(b);
ok(hp1 < hp0, `A's air heavy hit dummy_a: B sees hp ${hp0} -> ${hp1}`);

// PvP: opposite sides at the Stone Shrine (contested, no flag needed).
await b.page.evaluate(() => window.__fw.tp(175, 505));
await a.page.evaluate(() => window.__fw.tp(175, 500));
await a.page.waitForTimeout(1500);
const bHp0 = await b.page.evaluate(() => window.__fw.host.me.hp);
// Air basic, re-cast a few times (it has a short cooldown and B may still be interpolating in).
await a.page.evaluate(async (bid) => {
  const f = window.__fw;
  for (let i = 0; i < 4; i++) {
    const t = f.host.entities.get(bid);
    const me = f.host.me;
    const dir = t.pos.clone().setY(t.pos.y + 1.1).sub(me.pos.clone().setY(me.pos.y + 1.4)).normalize();
    f.host.cast('basic', dir);
    await new Promise((r) => setTimeout(r, 700));
  }
}, sb.me);
await until(b, (h) => window.__fw.host.me.hp < h, bHp0, 20000).catch(() => {});
const bHp1 = await b.page.evaluate(() => window.__fw.host.me.hp);
ok(bHp1 < bHp0, `PvP: A hit B, B's own hp ${bHp0} -> ${bHp1}`);

// Speed hack: a client-side teleport without the dev 'tp' message gets corrected.
await b.page.evaluate(() => window.__fw.player.teleport(120, 120));
await until(b, () => Math.hypot(window.__fw.player.renderPos.x - 175, window.__fw.player.renderPos.z - 505) < 20, null, 30000).catch(() => {});
const bOff = await b.page.evaluate(() => Math.hypot(window.__fw.player.renderPos.x - 175, window.__fw.player.renderPos.z - 505));
ok(bOff < 20, `server rejected a 400 m jump and snapped B back (${bOff.toFixed(1)} m from where B was)`);

await b.page.evaluate(() => { window.__fw.tpc.yaw = Math.PI; });
await b.page.waitForTimeout(1500);
await b.page.screenshot({ path: `${outDir}/net-b-sees-a.png` });
await a.page.screenshot({ path: `${outDir}/net-a.png` });

for (const p of [a, b]) ok(p.errors.length === 0, `${p.name} console errors: ${p.errors.slice(0, 3).join(' | ') || 'none'}`);
await browser.close();
