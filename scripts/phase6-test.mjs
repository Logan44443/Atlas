// Phase 6 check: title screen + character creation, faction hub spawn, NPC talk,
// zone PvP rules (safe hub vs contested shrine), patrol aggression, and saved
// position on rejoin. Needs `npm run server` and `npm run dev`.
//   node scripts/phase6-test.mjs [url]
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

async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 680 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (/^\[(net|account)\]/.test(m.text())) console.log(`  ${label}: ${m.text()}`);
  });
  return { ctx, page, errors, label };
}
const ready = (p) => p.page.waitForSelector('#loading.done', { timeout: 240000 }).then(() => p.page.evaluate(() => window.__fw.netReady));
const simWait = (p, seconds) =>
  p.page.evaluate(async (s) => {
    const f = window.__fw;
    const t = f.host.time;
    while (f.host.time < t + s) await new Promise((r) => setTimeout(r, 100));
  }, seconds);

// 1) Title screen and character creation through the real UI.
const a = await newPage('A');
await a.page.goto(base);
await a.page.waitForSelector('.charscreen', { timeout: 120000 });
const acct = await a.page.textContent('.cs-account');
ok(/guest/i.test(acct), `title screen signed in as a guest ("${acct.trim().slice(0, 40)}…")`);
const name = `Tenzin${run}`;
await a.page.fill('#cs-name', name);
await a.page.click('[data-el="water"]');
await a.page.click('[data-fac="lantern"]');
await a.page.screenshot({ path: `${outDir}/p6-create.png` });
await a.page.click('[data-create]');
await a.page.waitForSelector('[data-play]');
await a.page.screenshot({ path: `${outDir}/p6-characters.png` });
ok((await a.page.textContent('.slots')).includes(name), 'created character is listed');
await a.page.click('[data-play]');
await ready(a);
const sa = await a.page.evaluate(() => ({ net: window.__fw.netStatus, zone: document.querySelector('.zone-tag')?.textContent, pos: window.__fw.player.renderPos.toArray().map((v) => +v.toFixed(1)), el: window.__fw.host.me.element, side: window.__fw.host.me.side }));
ok(sa.net.startsWith('shard'), `joined ${sa.net}`);
ok(sa.zone === 'Lantern Monastery', `spawned in own hub: zone "${sa.zone}" at ${sa.pos}`);
ok(sa.el === 'water' && sa.side === 'order', `element ${sa.el}, side ${sa.side}`);
await simWait(a, 2);
await a.page.evaluate(() => { const f = window.__fw; f.tpc.yaw = Math.PI; f.tpc.pitch = -0.2; });
await a.page.waitForTimeout(2500);
await a.page.screenshot({ path: `${outDir}/p6-hub.png` });

// 2) NPCs at the hub: walk up to the Quartermaster and talk.
const npcs = await a.page.evaluate(() => [...window.__fw.host.entities.values()].filter((e) => e.kind === 'npc').map((e) => `${e.name}/${e.role}`));
ok(npcs.length >= 5, `sees ${npcs.length} NPC members nearby (${npcs.slice(0, 4).join(', ')}…)`);
await a.page.evaluate(() => window.__fw.tp(-1090 - 10, -490 + 3));
await simWait(a, 1.5);
await a.page.keyboard.press('KeyG');
await a.page.waitForSelector('.dialog:not(.hidden)', { timeout: 30000 }).catch(() => {});
const dlg = await a.page.evaluate(() => document.querySelector('.dialog:not(.hidden)')?.textContent ?? '');
ok(/Quartermaster/.test(dlg), `talked to the vendor: "${dlg.slice(0, 70)}…"`);
await a.page.evaluate(() => { window.__fw.tpc.yaw = 0; });
await a.page.waitForTimeout(1500);
await a.page.screenshot({ path: `${outDir}/p6-npc.png` });

// 3) Zone rules with an Outlaw: no damage in the safe hub, damage at a contested shrine.
const b = await newPage('B');
await b.page.goto(`${base}?char=Raider${run}&el=fire&fac=redfang`);
await ready(b);
const bId = await b.page.evaluate(() => window.__fw.host.me.id);
const castAt = (p, id) =>
  p.page.evaluate(async (tid) => {
    const f = window.__fw;
    for (let i = 0; i < 4; i++) {
      const t = f.host.entities.get(tid);
      if (!t) return 'not visible';
      const me = f.host.me;
      f.host.cast('basic', t.pos.clone().setY(t.pos.y + 1.1).sub(me.pos.clone().setY(me.pos.y + 1.4)).normalize());
      await new Promise((r) => setTimeout(r, 700));
    }
    return 'cast';
  }, id);
const hpOf = (p) => p.page.evaluate(() => window.__fw.host.me.hp);

await b.page.evaluate(() => window.__fw.tp(-1090, -490 + 14));
await a.page.evaluate(() => window.__fw.tp(-1090, -490 + 8));
await simWait(a, 2);
await a.page.waitForFunction((id) => window.__fw.host.entities.has(id), bId, { timeout: 60000 });
let h0 = await hpOf(b);
await castAt(a, bId);
await simWait(b, 1.5);
let h1 = await hpOf(b);
ok(h1 === h0, `safe zone: A's attacks did nothing to B (${h0} -> ${h1})`);

// Stone Shrine (contested).
await b.page.evaluate(() => window.__fw.tp(180, 500 + 6));
await a.page.evaluate(() => window.__fw.tp(180, 500 - 1));
await simWait(a, 2);
await a.page.waitForFunction((id) => window.__fw.host.entities.has(id), bId, { timeout: 60000 });
const zoneB = await b.page.evaluate(() => document.querySelector('.zone-tag')?.textContent);
h0 = await hpOf(b);
await castAt(a, bId);
await b.page.waitForFunction((h) => window.__fw.host.me.hp < h, h0, { timeout: 20000 }).catch(() => {});
h1 = await hpOf(b);
ok(h1 < h0, `contested (${zoneB}): A hit B (${h0} -> ${h1})`);
await b.page.screenshot({ path: `${outDir}/p6-shrine.png` });

// 4) Sentinel patrols attack an Outlaw who wanders close.
await b.page.evaluate(() => {
  const f = window.__fw;
  f.__npcHits = 0;
  f.eventTaps.push((e) => { if (e.t === 'hit' && e.target === f.host.me.id && e.source?.startsWith('npc_')) f.__npcHits++; });
  f.tp(-400, -960 + 118 + 6);
});
await b.page.waitForFunction(() => window.__fw.__npcHits > 0, null, { timeout: 90000 }).catch(() => {});
const npcHits = await b.page.evaluate(() => window.__fw.__npcHits);
ok(npcHits > 0, `Sentinel patrol attacked the Red Fang player (${npcHits} hits)`);
await b.page.screenshot({ path: `${outDir}/p6-patrol.png` });

// 5) Persistence: A leaves and rejoins at the saved spot, not the hub.
await a.page.evaluate(() => window.__fw.tp(-1000, -400));
await simWait(a, 1.5);
const before = await a.page.evaluate(() => window.__fw.player.renderPos.toArray());
await a.page.goto(base);
await a.page.waitForSelector('[data-play]', { timeout: 120000 });
await a.page.click('[data-play]');
await ready(a);
const after = await a.page.evaluate(() => window.__fw.player.renderPos.toArray());
const dist = Math.hypot(after[0] - before[0], after[2] - before[2]);
ok(dist < 6, `rejoined where A logged out (${dist.toFixed(1)} m away)`);

for (const p of [a, b]) ok(p.errors.length === 0, `${p.label} console errors: ${p.errors.slice(0, 3).join(' | ') || 'none'}`);
await browser.close();
