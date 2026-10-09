// Phase 11 check: territory wars, faction standing, the Quartermaster, crews,
// chat and the world map. Online, a Red Fang firebender (A) captures a point in
// a forced war (with the war HUD showing the meter), gets a faction order from
// the Envoy, buys from the Quartermaster, founds a crew, invites a second Red
// Fang player (C) who accepts with Y, fills the crew bank, raises a crew hall on
// a base plot and moves the raid window, chats on several channels with C and a
// Sentinel (B), opens the world map and the faction panel, and fast travels.
// The crew is disbanded and its hall taken down at the end. Offline, a Free
// Isles player wins a war point and fast travels at half price.
// Needs `npm run server` and `npm run dev`.
//   node scripts/phase11-test.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5173/';
const outDir = 'screenshots';
mkdirSync(outDir, { recursive: true });
const json = (p) => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));
const TERR = json('territory.json');
const ZONES = json('zones.json');
const FACTIONS = json('factions.json').factions;
const POINTS = [
  ...ZONES.contested.map((c) => ({ ...c, kind: 'shrine', r: TERR.kinds.shrine.captureRadius })),
  ...TERR.outposts.map((c) => ({ ...c, kind: 'outpost', r: TERR.kinds.outpost.captureRadius })),
];
const PLOTS = TERR.plots.map(([x, z], i) => ({ id: `plot${i + 1}`, x, z }));
const hubOf = (id) => FACTIONS.find((f) => f.id === id).hub;
const sideOf = (id) => FACTIONS.find((f) => f.id === id)?.side ?? '';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const run = Date.now().toString(36).slice(-4);
const TAG = run.toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 4);

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
    f.__notes = [];
    f.__ann = [];
    const show = f.zoneHud.show.bind(f.zoneHud);
    f.zoneHud.show = (text, warn) => {
      f.__notes.push(text);
      return show(text, warn);
    };
    const ann = f.announcer.show.bind(f.announcer);
    f.announcer.show = (text) => {
      f.__ann.push(text);
      return ann(text);
    };
  });
  return { ctx, page, errors, label };
}
const until = (p, fn, arg, timeout = 60000) => p.page.waitForFunction(fn, arg, { timeout, polling: 250 });
const notes = (p) => p.page.evaluate(() => window.__fw.__notes.slice());
const waitSim = (p, seconds) => p.page.evaluate((s) => {
  const h = window.__fw.host;
  const end = h.time + s;
  return new Promise((r) => { const i = setInterval(() => { if (h.time >= end) { clearInterval(i); r(); } }, 100); });
}, seconds);
async function goTo(p, x, z) {
  await p.page.evaluate(([a, b]) => window.__fw.tp(a, b), [x, z]);
  await until(p, ([a, b]) => Math.hypot(window.__fw.host.me.pos.x - a, window.__fw.host.me.pos.z - b) < 2, [x, z], 60000);
}
const connected = (p) => until(p, () => window.__fw.host.online && window.__fw.host.connected !== false, null, 120000);
const shot = (p, name) => p.page.screenshot({ path: `${outDir}/phase11-${name}.png` });
const progress = (p) => p.page.evaluate(() => JSON.parse(JSON.stringify(window.__fw.host.progress)));
const send = (p, type, msg) => p.page.evaluate(([t, m]) => window.__fw.host.room.send(t, m), [type, msg]);
const crewAction = (p, a) => p.page.evaluate((a) => window.__fw.host.crewAction(a), a);
const chatLog = (p) => p.page.evaluate(() => document.querySelector('.chat .c-log')?.textContent ?? '');

/** Walk up to one of your faction's NPCs with this role and talk to them (interact key). */
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
async function closeDialog(p) {
  if (await p.page.evaluate(() => window.__fw.dialog.isOpen)) await p.page.keyboard.press('KeyG');
  await p.page.evaluate(() => window.__fw.shop.isOpen && window.__fw.shop.toggle(false));
}

// ---------- Online ----------
const A = await open('A', `char=Fang${run}&el=fire&fac=redfang`);
ok(await A.page.evaluate(() => window.__fw.host.online), 'A (fire, Red Fang) is online');
await send(A, 'dev:xp', 60000);
await until(A, () => window.__fw.host.progress.level >= 12, null, 30000).catch(() => {});
await until(A, () => window.__fw.host.terr.points.length > 0, null, 20000).catch(() => {});
const terr0 = await A.page.evaluate(() => window.__fw.host.terr);
ok(terr0.points.length === POINTS.length && terr0.text.length > 10, `the shard reports ${terr0.points.length} war points: "${terr0.text}"`);
ok((await A.page.evaluate(() => document.querySelector('.war-hud')?.textContent ?? '')).includes('war'), 'the war HUD shows the war schedule');

// A war, forced and sped up: take a point the Order (or nobody) holds.
const target = POINTS.map((pt) => ({ pt, st: terr0.points.find((s) => s.id === pt.id) }))
  .filter(({ st }) => sideOf(st?.owner) !== 'outlaw')
  .sort((a, b) => Math.hypot(a.pt.x - hubOf('redfang').x, a.pt.z - hubOf('redfang').z) - Math.hypot(b.pt.x - hubOf('redfang').x, b.pt.z - hubOf('redfang').z))[0]?.pt;
ok(!!target, `a point to take: ${target?.name} (held by ${terr0.points.find((s) => s.id === target?.id)?.owner || 'nobody'})`);
const before = await progress(A);
await send(A, 'dev:war', true);
await send(A, 'dev:warRate', 50);
await goTo(A, target.x + 3, target.z + 2);
await until(A, (id) => window.__fw.host.terr.open && (window.__fw.host.terr.points.find((s) => s.id === id)?.progress ?? 0) > 0.05, target.id, 60000).catch(() => {});
const hudText = await A.page.evaluate(() => document.querySelector('.war-hud')?.textContent ?? '');
ok(hudText.includes(target.name), `the war HUD shows the capture meter: "${hudText.replace(/\s+/g, ' ').trim()}"`);
await shot(A, 'capture');
await until(A, (id) => window.__fw.host.terr.points.find((s) => s.id === id)?.owner === 'redfang', target.id, 120000).catch(() => {});
const owner = await A.page.evaluate((id) => window.__fw.host.terr.points.find((s) => s.id === id)?.owner, target.id);
ok(owner === 'redfang', `Red Fang captured ${target.name}`);
await until(A, (pts) => window.__fw.host.progress.standing.points >= pts, before.standing.points + 10, 20000).catch(() => {});
const afterCap = await progress(A);
ok(afterCap.standing.points > before.standing.points && afterCap.standing.coins > before.standing.coins, `capture rewards: rank points ${before.standing.points} -> ${afterCap.standing.points}, coins ${before.standing.coins} -> ${afterCap.standing.coins}`);
ok((await A.page.evaluate(() => window.__fw.__ann.join(' | '))).includes('captured'), 'everyone hears about the capture');
await A.page.evaluate(() => (window.__fw.__notes.length = 0));
await send(A, 'dev:war', false);
await until(A, () => window.__fw.__notes.some((n) => /held \d+ point/.test(n)), null, 20000).catch(() => {});
ok((await notes(A)).some((n) => /held \d+ point/.test(n)), 'the war ends: rank points for every point Red Fang holds');
await send(A, 'dev:war', null);
await send(A, 'dev:warRate', 1);

// The Envoy hands out a faction order.
const envoy = await talkTo(A, 'quest');
await until(A, () => !!document.querySelector('.dialog .quest-line'), null, 20000).catch(() => {});
const orderLine = await A.page.evaluate(() => document.querySelector('.dialog .quest-line')?.textContent ?? '');
ok(!!envoy && (await progress(A)).standing.order !== null && orderLine.length > 20, `Envoy ${envoy?.name}: "${orderLine}"`);
await shot(A, 'envoy');
await closeDialog(A);

// The Quartermaster: the shop opens with the dialog; buy with the panel's button.
await send(A, 'dev:coins', 2000);
await until(A, () => window.__fw.host.progress.standing.coins >= 2000, null, 20000).catch(() => {});
const qm = await talkTo(A, 'vendor');
await until(A, () => window.__fw.shop.isOpen, null, 20000).catch(() => {});
ok(!!qm && (await A.page.evaluate(() => window.__fw.shop.isOpen)), `talking to ${qm?.name} opens the shop`);
const p0 = await progress(A);
await A.page.click('.shop [data-buy="wood"][data-n="10"]');
await until(A, (w) => (window.__fw.host.progress.inv.wood ?? 0) >= w + 10, p0.inv.wood ?? 0, 20000).catch(() => {});
const p1 = await progress(A);
ok((p1.inv.wood ?? 0) === (p0.inv.wood ?? 0) + 10 && p1.standing.coins === p0.standing.coins - 30, `bought 10 wood: coins ${p0.standing.coins} -> ${p1.standing.coins}`);
ok(await A.page.evaluate(() => [...document.querySelectorAll('.shop [data-buy]')].some((b) => b.dataset.buy === 'obsidian')), 'Red Fang sees the black market');
await shot(A, 'shop');
await closeDialog(A);

// Rank and a crew.
await send(A, 'dev:points', 300);
await until(A, () => window.__fw.host.progress.rank >= 3, null, 20000).catch(() => {});
ok((await progress(A)).rank >= 3, `rank points raise the faction rank (rank ${(await progress(A)).rank})`);
await crewAction(A, { a: 'create', name: `Fangs ${run}`, tag: TAG });
await until(A, () => !!window.__fw.host.crew, null, 20000).catch(() => {});
const crew = await A.page.evaluate(() => window.__fw.host.crew);
ok(crew?.tag === TAG && crew.members.length === 1, `founded [${crew?.tag}] ${crew?.name}${crew ? '' : ` (notes: ${(await notes(A)).slice(-3).join(' | ')})`}`);
await until(A, (t) => window.__fw.host.me.tag === t, TAG, 10000).catch(() => {});

const C = await open('C', `char=Claw${run}&el=earth&fac=redfang`);
await connected(C);
const aPos = await A.page.evaluate(() => ({ x: window.__fw.host.me.pos.x, z: window.__fw.host.me.pos.z }));
await goTo(C, aPos.x + 3, aPos.z + 1);
const cName = await C.page.evaluate(() => window.__fw.host.me.name);
await crewAction(A, { a: 'invite', target: cName });
await until(C, () => window.__fw.crewPrompt.pending, null, 30000).catch(() => {});
ok(await C.page.evaluate(() => window.__fw.crewPrompt.pending && !document.querySelector('.crew-invite')?.classList.contains('hidden')), 'C sees the crew invite');
await shot(C, 'invite');
await C.page.keyboard.press('KeyY');
await until(C, () => window.__fw.host.crew?.members.length === 2, null, 30000).catch(() => {});
ok((await C.page.evaluate(() => window.__fw.host.crew?.members.length)) === 2, 'C accepts with Y and joins the crew');
await until(C, ([id, t]) => window.__fw.host.entities.get(id)?.tag === t, [await A.page.evaluate(() => window.__fw.host.me.id), TAG], 20000).catch(() => {});
ok(await C.page.evaluate(([id, t]) => window.__fw.host.entities.get(id)?.tag === t, [await A.page.evaluate(() => window.__fw.host.me.id), TAG]), 'C sees A wearing the crew tag');

// The crew bank (in the faction hub): members deposit, only officers take.
await crewAction(A, { a: 'bank', items: { wood: 10 }, put: true });
await until(A, () => window.__fw.host.crew?.bank?.wood === 10, null, 20000).catch(() => {});
ok((await A.page.evaluate(() => window.__fw.host.crew?.bank?.wood)) === 10, 'A deposits 10 wood in the crew bank');
await C.page.evaluate(() => (window.__fw.__notes.length = 0));
await crewAction(C, { a: 'bank', items: { wood: 5 }, put: false });
await until(C, () => window.__fw.__notes.some((n) => /officer/i.test(n)), null, 20000).catch(() => {});
ok((await notes(C)).some((n) => /officer/i.test(n)), 'a member cannot take from the bank');
const cId = await C.page.evaluate(() => window.__fw.host.charId);
await crewAction(A, { a: 'role', charId: cId, role: 'officer' });
await until(C, () => window.__fw.host.crew?.members.find((m) => m.charId === window.__fw.host.charId)?.role === 'officer', null, 20000).catch(() => {});
await crewAction(C, { a: 'bank', items: { wood: 5 }, put: false });
await until(C, () => (window.__fw.host.progress.inv.wood ?? 0) >= 5, null, 20000).catch(() => {});
ok((await progress(C)).inv.wood >= 5, 'promoted to officer, C takes 5 wood');

// Chat: say (nearby), faction, crew and a whisper to a Sentinel.
const B = await open('B', `char=Ward${run}&el=water&fac=sentinel`);
await connected(B);
const bName = await B.page.evaluate(() => window.__fw.host.me.name);
await goTo(B, aPos.x - 3, aPos.z - 2);
await waitSim(A, 1);
await A.page.keyboard.press('Enter');
await A.page.keyboard.type(`hello from ${run}`);
await A.page.keyboard.press('Enter');
await until(B, (r) => document.querySelector('.chat .c-log')?.textContent.includes(`hello from ${r}`), run, 20000).catch(() => {});
ok((await chatLog(B)).includes(`hello from ${run}`), 'say: B nearby reads what A typed in the chat box');
await A.page.keyboard.press('Enter');
await A.page.keyboard.type(`/f fangs only ${run}`);
await A.page.keyboard.press('Enter');
await A.page.keyboard.press('Enter');
await A.page.keyboard.type(`/c crew only ${run}`);
await A.page.keyboard.press('Enter');
await A.page.keyboard.press('Enter');
await A.page.keyboard.type(`/w ${bName} psst ${run}`);
await A.page.keyboard.press('Enter');
await until(C, (r) => document.querySelector('.chat .c-log')?.textContent.includes(`crew only ${r}`), run, 20000).catch(() => {});
await until(B, (r) => document.querySelector('.chat .c-log')?.textContent.includes(`psst ${r}`), run, 20000).catch(() => {});
const logC = await chatLog(C);
const logB = await chatLog(B);
ok(logC.includes(`fangs only ${run}`) && !logB.includes(`fangs only ${run}`), 'faction chat reaches Red Fang, not the Sentinel');
ok(logC.includes(`crew only ${run}`), 'crew chat reaches the crew');
ok(logB.includes(`psst ${run}`) && /From/.test(logB), 'the whisper reaches B');
await shot(B, 'chat');
await B.page.close();

// The crew hall on a free base plot, then the raid window.
const taken = new Set((await A.page.evaluate(() => window.__fw.host.terr.halls)).map((h) => h.plot));
const nearOutlaws = (pl) => Math.min(...['redfang', 'ash', 'hollowmoon'].map((f) => Math.hypot(pl.x - hubOf(f).x, pl.z - hubOf(f).z)));
const plot = PLOTS.filter((pl) => !taken.has(pl.id)).sort((a, b) => nearOutlaws(a) - nearOutlaws(b))[0];
await goTo(A, plot.x + 7, plot.z + 7);
await send(A, 'dev:give', { wood: 40, stone: 40, refined_ore: 6 });
await until(A, () => (window.__fw.host.progress.inv.refined_ore ?? 0) >= 6, null, 20000).catch(() => {});
await A.page.evaluate(([x, z]) => window.__fw.host.place('crew_hall', x, z, 0), [plot.x, plot.z]);
await until(A, () => !!window.__fw.host.camps.hallOf(window.__fw.host.crew?.id ?? ''), null, 30000).catch(() => {});
const hall = await A.page.evaluate(() => {
  const s = window.__fw.host.camps.hallOf(window.__fw.host.crew.id);
  return s && { id: s.id, x: s.x, z: s.z, tag: s.tag };
});
ok(hall?.tag === TAG && hall.x === plot.x && hall.z === plot.z, `crew hall raised on ${plot.id}${hall ? '' : ` (notes: ${(await notes(A)).slice(-3).join(' | ')})`}`);
await until(A, (t) => window.__fw.host.terr.halls.some((h) => h.tag === t), TAG, 20000).catch(() => {});
ok(await A.page.evaluate((t) => window.__fw.host.terr.halls.some((h) => h.tag === t), TAG), 'the world map knows the plot is taken');
await waitSim(A, 2);
await shot(A, 'hall');
const hour = (new Date().getUTCHours() + 6) % 24;
await crewAction(A, { a: 'raid', hour });
await until(A, (h) => window.__fw.host.crew?.raidStart === h, hour, 20000).catch(() => {});
ok((await A.page.evaluate(() => window.__fw.host.crew?.raidStart)) === hour, `the leader moves the raid window to ${hour}:00 UTC`);
await until(A, () => window.__fw.__notes.some((n) => n.includes('Raid window moved')), null, 20000).catch(() => {});
ok((await notes(A)).some((n) => n.includes('Raid window moved')), 'and is told so');

// The faction panel (U) and the world map (M).
await A.page.keyboard.press('KeyU');
await until(A, () => window.__fw.factionPanel.isOpen, null, 10000).catch(() => {});
const panel = await A.page.evaluate(() => document.querySelector('.faction-panel')?.textContent ?? '');
ok(/Red Fang/.test(panel) && /rank/i.test(panel), 'the faction panel shows faction and rank');
await shot(A, 'faction-panel');
const crewTab = await A.page.$('.faction-panel [data-tab="crew"]');
if (crewTab) {
  await crewTab.click();
  await waitSim(A, 0.5);
  ok((await A.page.evaluate(() => document.querySelector('.faction-panel')?.textContent ?? '')).includes(TAG), 'the crew tab lists the crew');
  await shot(A, 'crew-panel');
}
await A.page.keyboard.press('Escape');
await until(A, () => !window.__fw.factionPanel.isOpen, null, 10000).catch(() => {});
ok(!(await A.page.evaluate(() => window.__fw.factionPanel.isOpen)) && !(await A.page.evaluate(() => window.__fw.menu.isOpen)), 'Escape closes the panel (not the settings menu)');
await A.page.keyboard.press('KeyM');
await until(A, () => window.__fw.worldMap.isOpen, null, 10000).catch(() => {});
ok(await A.page.evaluate(() => window.__fw.worldMap.isOpen), 'M opens the world map');
await waitSim(A, 2);
await shot(A, 'map');
await A.page.keyboard.press('Escape');

// Clean up the base and the crew so plots don't fill up over test runs.
await A.page.evaluate((id) => window.__fw.host.removeStruct(id), hall.id);
await until(A, (id) => !window.__fw.host.camps.all.has(id), hall.id, 20000).catch(() => {});
ok(!(await A.page.evaluate((id) => window.__fw.host.camps.all.has(id), hall.id)), 'the hall comes down');
await crewAction(C, { a: 'leave' });
await crewAction(A, { a: 'leave' });
await until(A, () => !window.__fw.host.crew, null, 20000).catch(() => {});
ok(!(await A.page.evaluate(() => window.__fw.host.crew)) && !(await A.page.evaluate(() => window.__fw.host.me.tag)), 'the crew disbands when the last member leaves');

// Fast travel from the hub to the Ash Syndicate's (same side).
const home = hubOf('redfang');
await goTo(A, home.x + 4, home.z + 4);
await talkTo(A, 'vendor');
await until(A, () => window.__fw.shop.isOpen, null, 20000).catch(() => {});
await A.page.click('.shop [data-tab="travel"]');
await waitSim(A, 0.5);
await A.page.click('.shop [data-travel="hub:ash"]');
const ash = hubOf('ash');
await until(A, ([x, z]) => Math.hypot(window.__fw.host.me.pos.x - x, window.__fw.host.me.pos.z - z) < 40, [ash.x, ash.z], 30000).catch(() => {});
const there = await A.page.evaluate(() => ({ x: window.__fw.host.me.pos.x, z: window.__fw.host.me.pos.z }));
ok(Math.hypot(there.x - ash.x, there.z - ash.z) < 40, `fast travel to ${ash.name}: now at ${there.x.toFixed(0)}, ${there.z.toFixed(0)}`);
ok(A.errors.length === 0, `A: no page errors${A.errors.length ? `: ${A.errors.slice(0, 3).join(' | ')}` : ''}`);
ok(C.errors.length === 0, `C: no page errors${C.errors.length ? `: ${C.errors.slice(0, 3).join(' | ')}` : ''}`);
ok(B.errors.length === 0, `B: no page errors${B.errors.length ? `: ${B.errors.slice(0, 3).join(' | ')}` : ''}`);
await A.ctx.close();
await C.ctx.close();
await B.ctx.close();

// ---------- Offline ----------
const O = await open('O', `char=Isle${run}&el=air&fac=freeisles&offline`);
ok(!(await O.page.evaluate(() => window.__fw.host.online)), 'O (Free Isles) is offline');
const offTerr = await O.page.evaluate(() => window.__fw.host.terr);
const isles = hubOf('freeisles');
const offTarget = POINTS.filter((pt) => sideOf(offTerr.points.find((s) => s.id === pt.id)?.owner) !== 'order')
  .sort((a, b) => Math.hypot(a.x - isles.x, a.z - isles.z) - Math.hypot(b.x - isles.x, b.z - isles.z))[0];
// A war band holds every point: like A online, O needs levels to survive it.
await O.page.evaluate(() => {
  window.__fw.host.grant(60000, 'test');
  window.__fw.host.devWar(true);
  window.__fw.host.devWarRate(50);
});
await goTo(O, offTarget.x + 3, offTarget.z);
await until(O, (id) => window.__fw.host.terr.points.find((s) => s.id === id)?.owner === 'freeisles', offTarget.id, 180000).catch(() => {});
ok((await O.page.evaluate((id) => window.__fw.host.terr.points.find((s) => s.id === id)?.owner, offTarget.id)) === 'freeisles', `offline: Free Isles takes ${offTarget.name}${await O.page.evaluate(() => (window.__fw.host.me.dead ? ' (O died)' : ''))}`);
await shot(O, 'offline-capture');
await O.page.evaluate(() => window.__fw.host.devWar(null));
await goTo(O, isles.x + 4, isles.z + 4);
await O.page.evaluate(() => window.__fw.host.devCoins(500));
await talkTo(O, 'vendor');
await until(O, () => window.__fw.shop.isOpen, null, 20000).catch(() => {});
await O.page.click('.shop [data-tab="travel"]');
await waitSim(O, 0.5);
await shot(O, 'offline-travel');
const coins0 = (await progress(O)).standing.coins;
await O.page.click('.shop [data-travel="hub:sentinel"]');
const sent = hubOf('sentinel');
await until(O, ([x, z]) => Math.hypot(window.__fw.host.me.pos.x - x, window.__fw.host.me.pos.z - z) < 40, [sent.x, sent.z], 30000).catch(() => {});
const paid = coins0 - (await progress(O)).standing.coins;
const full = Math.round(25 + (30 * Math.hypot(sent.x - isles.x, sent.z - isles.z)) / 1000);
ok(paid > 0 && paid < full, `offline: fast travel to ${sent.name} at the Free Isles discount (${paid} of ${full} coins)`);
ok(O.errors.length === 0, `O: no page errors${O.errors.length ? `: ${O.errors.slice(0, 3).join(' | ')}` : ''}`);

await browser.close();
