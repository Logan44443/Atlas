// Phase 7 check: two same-side players form a party, land a Water + Fire combo
// (steam cloud), share kill XP, level up from discovering a shrine, spend a
// mastery point through the panel, and keep it all after a reload. Then an
// offline character earns XP and keeps it. Needs `npm run server` and `npm run dev`.
//   node scripts/phase7-test.mjs [url]
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
  await page.evaluate(() => window.__fw.netReady);
  return { ctx, page, errors, label };
}
const until = (p, fn, arg, timeout = 60000) => p.page.waitForFunction(fn, arg, { timeout, polling: 250 });
const progress = (p) => p.page.evaluate(() => JSON.parse(JSON.stringify(window.__fw.host.progress)));
/** Cast `slot` at entity `id` n times, `gap` ms apart. */
const castAt = (p, id, slot, n, gap) =>
  p.page.evaluate(
    async ([tid, s, count, ms]) => {
      const f = window.__fw;
      for (let i = 0; i < count; i++) {
        const t = f.host.entities.get(tid);
        if (!t || t.dead) return i;
        const me = f.host.me;
        f.host.cast(s, t.pos.clone().setY(t.pos.y + 1.1).sub(me.pos.clone().setY(me.pos.y + 1.4)).normalize());
        await new Promise((r) => setTimeout(r, ms));
      }
      return count;
    },
    [id, slot, n, gap],
  );

// Two Order players: a waterbender (Sentinel) and a firebender (Lantern).
const a = await open('A', `char=Kya${run}&el=water&fac=sentinel`);
const b = await open('B', `char=Iroh${run}&el=fire&fac=lantern`);
const aId = await a.page.evaluate(() => window.__fw.host.me.id);
const bId = await b.page.evaluate(() => window.__fw.host.me.id);
// Arriving in your own hub counts as discovering it.
await until(a, () => window.__fw.host.progress.discovered.length > 0, null, 30000).catch(() => {});
const p0 = await progress(a);
ok(p0.discovered.includes('hub_sentinel') && p0.level <= 2, `new character discovers its hub on arrival: level ${p0.level}, ${p0.xp} XP`);

// 1) Party: meet by the training dummies, A invites B, B accepts with Y.
await a.page.evaluate(() => window.__fw.tp(0, -3));
await b.page.evaluate(() => window.__fw.tp(3, 0));
await until(a, (id) => window.__fw.host.entities.has(id), bId);
await a.page.waitForTimeout(1000);
await a.page.evaluate((id) => window.__fw.host.invite(id), bId);
await b.page.waitForSelector('.invite:not(.hidden)', { timeout: 30000 }).catch(() => {});
const inviteText = await b.page.evaluate(() => document.querySelector('.invite:not(.hidden)')?.textContent ?? '');
ok(/invites you/.test(inviteText), `B sees the invite: "${inviteText.trim().slice(0, 50)}…"`);
await b.page.keyboard.press('KeyY');
await until(a, () => window.__fw.host.party?.members.length === 2, null, 30000).catch(() => {});
await until(b, () => window.__fw.host.party?.members.length === 2, null, 30000).catch(() => {});
const partyA = await a.page.evaluate(() => window.__fw.host.party);
ok(partyA?.members.length === 2 && partyA.leader === aId, `party formed: ${partyA?.members.map((m) => m.name).join(' + ')}, leader A`);
ok(await b.page.evaluate(() => !document.querySelector('.party').classList.contains('hidden')), 'party frame shows for B');

// Record combos and XP gains on both clients.
await a.page.evaluate(() => {
  const f = window.__fw;
  f.__combos = [];
  f.__xp = [];
  f.eventTaps.push((e) => { if (e.t === 'combo') f.__combos.push(e.name); });
});
await b.page.evaluate(() => {
  const f = window.__fw;
  f.__combos = [];
  f.__gains = [];
  f.eventTaps.push((e) => { if (e.t === 'combo') f.__combos.push(e.name); });
  // Toasts fade after 3 s; record every gain shown.
  const gain = f.xpHud.gain.bind(f.xpHud);
  f.xpHud.gain = (g, p) => (f.__gains.push(`+${g.amount} ${g.reason}`), gain(g, p));
});
// 2) Shared kill XP: both party members hit a dummy until it falls; both get XP.
const target = 'dummy_a';
const xp0 = { a: (await progress(a)).xp, b: (await progress(b)).xp };
for (let i = 0; i < 12; i++) {
  const d = await a.page.evaluate((id) => { const e = window.__fw.host.entities.get(id); return e ? { hp: e.hp, dead: e.dead } : null; }, target);
  if (!d || d.dead) break;
  await Promise.all([castAt(a, target, 'basic', 6, 450), castAt(b, target, 'basic', 8, 360)]);
}
await until(b, (x) => window.__fw.host.progress.xp > x, xp0.b, 20000).catch(() => {});
const xp1 = { a: (await progress(a)).xp, b: (await progress(b)).xp };
ok(xp1.a > xp0.a && xp1.b > xp0.b, `both earned kill XP: A ${xp0.a} -> ${xp1.a}, B ${xp0.b} -> ${xp1.b}`);
await until(b, () => window.__fw.__gains.length > 0, null, 15000).catch(() => {});
const toastB = await b.page.evaluate(() => window.__fw.__gains.join(' | '));
ok(/\+\d+ (party: )?Training Dummy/.test(toastB), `B was shown kill XP ("${toastB.slice(0, 60)}")`);

// 3) Combo: A's water whip then B's fire jab on the same dummy -> Steam Cloud.
const comboTarget = 'dummy_b';
for (let i = 0; i < 4; i++) {
  await castAt(a, comboTarget, 'basic', 1, 0);
  await a.page.waitForTimeout(400);
  await castAt(b, comboTarget, 'basic', 2, 350);
  const seen = await a.page.evaluate(() => window.__fw.__combos.length);
  if (seen) break;
  await a.page.waitForTimeout(1500);
}
await until(b, () => window.__fw.__combos.length > 0, null, 15000).catch(() => {});
const combosA = await a.page.evaluate(() => window.__fw.__combos);
const combosB = await b.page.evaluate(() => window.__fw.__combos);
ok(combosA.includes('Steam Cloud') && combosB.includes('Steam Cloud'), `both see the combo: A ${JSON.stringify(combosA)} B ${JSON.stringify(combosB)}`);
await a.page.evaluate(() => { const f = window.__fw; f.tpc.yaw = Math.atan2(-(0 - f.me.pos.x), -(0 - f.me.pos.z)); f.tpc.pitch = -0.25; });
await a.page.waitForTimeout(1200);
await a.page.screenshot({ path: `${outDir}/p7-combo.png` });
await b.page.screenshot({ path: `${outDir}/p7-party.png` });

// 4) Discovery: A visits two shrines (+250 XP each) -> level 3 + banner.
const lv0 = (await progress(a)).level;
await a.page.evaluate(() => window.__fw.tp(175, 500));
await until(a, () => window.__fw.host.progress.discovered.includes('stone_shrine'), null, 30000).catch(() => {});
await a.page.evaluate(() => window.__fw.tp(795, -140));
await until(a, () => window.__fw.host.progress.discovered.includes('tide_shrine'), null, 60000).catch(() => {});
await until(a, () => !!document.querySelector('.levelup:not(.hidden)'), null, 10000).catch(() => {});
const pa = await progress(a);
ok(pa.level > lv0 && pa.discovered.includes('stone_shrine') && pa.discovered.includes('tide_shrine'), `discovered two shrines: level ${lv0} -> ${pa.level}, landmarks ${pa.discovered.join(',')}`);
const banner = await a.page.evaluate(() => document.querySelector('.levelup:not(.hidden)')?.textContent ?? '');
ok(/Level/.test(banner), `level-up banner: "${banner.slice(0, 50)}"`);
await a.page.screenshot({ path: `${outDir}/p7-levelup.png` });

// 5) Mastery: open with K, click a tier-0 node (accepted) and a tier-1 node (locked).
await a.page.keyboard.press('KeyK');
await a.page.waitForSelector('.mastery:not(.hidden) .m-node', { timeout: 10000 });
await a.page.click('[data-node="water_t1"]');
await until(a, () => (window.__fw.host.progress.mastery.water_t1 ?? 0) === 1, null, 15000).catch(() => {});
await a.page.click('[data-node="water_t2"]');
await a.page.waitForTimeout(1500);
const m = (await progress(a)).mastery;
ok(m.water_t1 === 1 && !m.water_t2, `mastery: Quick Whip ${m.water_t1 ?? 0}/5, Long Whip locked (${m.water_t2 ?? 0})`);
const whip = await a.page.evaluate(() => window.__fw.abilities.kit.abilities.find((x) => x.slot === 'basic').damage);
ok(Math.abs(whip / 1.05 - Math.round(whip / 1.05)) < 1e-6, `Water Whip damage now ${whip.toFixed(2)} (+5%)`);
await a.page.screenshot({ path: `${outDir}/p7-mastery.png` });
await a.page.keyboard.press('KeyK');

// 6) Persistence: A reloads and keeps level, XP and mastery.
const before = await progress(a);
await a.page.evaluate(() => window.__fw.host.leave());
await a.page.waitForTimeout(1500);
await a.page.reload();
await a.page.waitForSelector('#loading.done', { timeout: 240000 });
const after = await progress(a);
ok(after.level === before.level && after.xp === before.xp && after.mastery.water_t1 === 1, `after reload: level ${after.level}, ${after.xp} XP, Quick Whip ${after.mastery.water_t1}`);
const partyB = await b.page.evaluate(() => window.__fw.host.party);
ok(!partyB, 'B is out of the party once A left');

// 7) Offline: kill a dummy in the local sim, earn XP, keep it after reload.
const c = await open('C', `offline&char=Solo${run}&el=air&fac=freeisles`);
await c.page.evaluate(() => window.__fw.tp(0, -4));
await until(c, () => Math.hypot(window.__fw.host.me.pos.x, window.__fw.host.me.pos.z + 4) < 1.5, null, 60000);
await c.page.evaluate(() => {
  const d = window.__fw.host.entities.get('dummy_a');
  d.hp = 1;
});
await castAt(c, 'dummy_a', 'basic', 5, 600);
await until(c, () => /Dummy/.test(document.querySelector('.xp-toasts').textContent), null, 30000).catch(() => {});
const pc = await progress(c);
const toastC = await c.page.evaluate(() => document.querySelector('.xp-toasts').textContent);
ok(/XP Training Dummy/.test(toastC), `offline kill XP: "${toastC.slice(0, 60)}" (total ${pc.xp} XP, level ${pc.level})`);
await c.page.evaluate(() => window.__fw.saveLocal());
await c.page.reload();
await c.page.waitForSelector('#loading.done', { timeout: 240000 });
const pc2 = await progress(c);
ok(pc2.xp === pc.xp && pc2.level === pc.level, `offline progress kept after reload (${pc2.xp} XP)`);

for (const p of [a, b, c]) ok(p.errors.length === 0, `${p.label} console errors: ${p.errors.slice(0, 3).join(' | ') || 'none'}`);
await browser.close();
