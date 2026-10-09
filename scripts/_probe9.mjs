import { chromium } from 'playwright';
const base = 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const run = Date.now().toString(36).slice(-4);
async function open(label, query, ctx = null) {
  ctx ??= await browser.newContext({ viewport: { width: 900, height: 560 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  ${label} PAGEERROR: ${e.message}\n${e.stack}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || /^\[(net|account)\]/.test(m.text())) console.log(`  ${label} ${m.type()}: ${m.text()}`); });
  page.on('websocket', (ws) => { ws.on('close', () => console.log(`  ${label} ws closed ${ws.url()}`)); ws.on('socketerror', (e) => console.log(`  ${label} ws error ${e}`)); });
  const u = new URL(base); u.search = query;
  await page.goto(u.toString(), { timeout: 120000 });
  await page.waitForSelector('#loading.done', { timeout: 240000 });
  await page.evaluate(() => { const f = window.__fw; f.__ev = []; f.eventTaps.push((e) => f.__ev.push(e)); });
  return { ctx, page, label };
}
const until = (p, fn, arg, timeout = 60000) => p.page.waitForFunction(fn, arg, { timeout, polling: 250 });
async function goTo(p, x, z) {
  await p.page.evaluate(([a, b]) => window.__fw.tp(a, b), [x, z]);
  await until(p, ([a, b]) => Math.hypot(window.__fw.host.me.pos.x - a, window.__fw.host.me.pos.z - b) < 2, [x, z], 60000);
}
const waitSim = (p, s) => p.page.evaluate((s) => { const h = window.__fw.host; const end = h.time + s; return new Promise((r) => { const i = setInterval(() => { if (h.time >= end) { clearInterval(i); r(); } }, 100); }); }, s);

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

const A = await open('A', `char=Mason${run}&el=earth&fac=sentinel`);
const site = await findSite(A, -219, -773);
console.log('site', site);
await goTo(A, site.x, site.z);
await A.page.evaluate(() => window.__fw.host.devGive({ wood: 40, stone: 20 }));
await waitSim(A, 1);
await A.page.evaluate(([x, z]) => { window.__fw.host.place('campfire', x, z, 0); }, [site.x, site.z]);
await waitSim(A, 1);
for (const [dx, dz] of [[6, 0], [0, 6], [-6, 0], [0, -6], [5, 5]]) {
  const err = await A.page.evaluate(([x, z]) => { const h = window.__fw.host; const b = { charId: h.charId, name: 'x', side: h.me.side, faction: h.me.faction, x: h.me.pos.x, z: h.me.pos.z, inv: h.progress.inv }; return h.camps.check(b, { piece: 'wood_wall', x, z, rot: 1 }); }, [site.x + dx, site.z + dz]);
  console.log('wall check', dx, dz, err);
  if (err) continue;
  await A.page.evaluate(([x, z]) => { window.__fw.host.place('wood_wall', x, z, 1); }, [site.x + dx, site.z + dz]);
  await waitSim(A, 2);
  break;
}
const mine = await A.page.evaluate(() => window.__fw.host.camps.ofOwner(window.__fw.host.charId).map((s) => ({ ...s })));
console.log('pieces', JSON.stringify(mine.map((s) => [s.piece, s.x, s.z, s.hp])));
const W = mine.find((s) => s.piece === 'wood_wall');
const C = await open('C', `char=Ember${run}&el=fire&fac=redfang`);
await goTo(C, W.x - 6, W.z);
await until(C, (id) => window.__fw.host.camps.all.has(id), W.id, 30000).catch(() => console.log('C never saw wall'));
const diag = await C.page.evaluate((id) => {
  const f = window.__fw; const s = f.host.camps.all.get(id); const me = f.host.me;
  const obs = [];
  for (let t = 0; t <= 1; t += 0.05) { const x = me.pos.x + (s.x - me.pos.x) * t, z = me.pos.z + (s.z - me.pos.z) * t, y = me.pos.y + 1.4 + (s.y + 1.5 - me.pos.y - 1.4) * t; const o = f.obstacles.hit(x, y, z, 0.2); if (o) obs.push([t.toFixed(2), o.type, o.x.toFixed(1), o.z.toFixed(1)]); }
  const near = [...f.host.entities.values()].filter((e) => e.id !== me.id && Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z) < 30).map((e) => [e.id, e.kind, e.name, e.pos.x.toFixed(1), e.pos.z.toFixed(1)]);
  return { me: [me.pos.x, me.pos.y, me.pos.z], wall: [s.x, s.y, s.z, s.hp], obs, near };
}, W.id);
console.log('diag', JSON.stringify(diag));
await C.page.evaluate(() => window.__fw.host.devRaid(true));
await C.page.evaluate(async (id) => {
  const f = window.__fw;
  for (let i = 0; i < 3; i++) {
    const s = f.host.camps.all.get(id); const me = f.host.me;
    const dir = { x: s.x - me.pos.x, y: s.y + 1.5 - (me.pos.y + 1.4), z: s.z - me.pos.z };
    const l = Math.hypot(dir.x, dir.y, dir.z);
    f.host.cast('basic', new f.player.renderPos.constructor(dir.x / l, dir.y / l, dir.z / l));
    const end = f.host.time + 0.7;
    await new Promise((r) => { const t = setInterval(() => { if (f.host.time >= end) { clearInterval(t); r(); } }, 100); });
  }
}, W.id);
await waitSim(C, 2);
console.log('C events', JSON.stringify(await C.page.evaluate(() => window.__fw.__ev.filter((e) => /proj|struct|cast|hit/.test(e.t)).slice(0, 20))));
console.log('wall hp at A', await A.page.evaluate((id) => window.__fw.host.camps.all.get(id)?.hp, W.id));
await C.page.evaluate(() => window.__fw.host.devRaid(null));
// Rejoin A
await A.page.evaluate(() => window.__fw.host.leave());
await waitSim(C, 3);
await A.page.close();
const A2 = await open('A2', `char=Mason${run}&el=earth&fac=sentinel`, A.ctx);
await waitSim(A2, 8).catch((e) => console.log('wait err', e.message));
console.log('A2 online', await A2.page.evaluate(() => window.__fw.host.online), 'pieces', await A2.page.evaluate(() => window.__fw.host.camps.ofOwner(window.__fw.host.charId).length));
await A2.page.evaluate(() => window.__fw.host.devClearCamp?.());
await waitSim(C, 2);
await browser.close();
