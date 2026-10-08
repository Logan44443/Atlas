// Phase 4 check: every element's six abilities against the dummies, normal + perfect block.
export default async function (page, { outDir }) {
  const events = [];
  await page.exposeFunction('__log', (e) => events.push(e));
  await page.evaluate(() => {
    const f = window.__fw;
    f.dayNight.hour = 11; f.dayNight.timeScale = 0;
    f.tpc.yaw = 0; f.tpc.pitch = -0.12;
    f.eventTaps.push((e) => {
      if (e.t !== 'hit' && e.t !== 'status' && e.t !== 'death') return;
      const kind = e.t === 'hit' ? (e.result === 'hit' ? 'damage' : e.result) : e.t;
      window.__log({ kind, src: e.source ?? null, target: e.target, amount: e.amount ?? 0, text: e.t === 'status' ? e.status : e.dot ? 'burn' : '', blocking: f.me.blocking, since: +(f.host.time - f.me.blockStart).toFixed(2) });
    });
  });
  await page.waitForTimeout(1000);
  const hp = () => page.evaluate(() => window.__fw.dummies.map((d) => `${d.id}:${d.hp}${d.dead ? '(down)' : ''}`).join(' '));
  // Perfect block: press right mouse just before the sparring dummy's bolt arrives.
    events.length = 0;
  await page.evaluate(() => {
    const f = window.__fw;
    f.host.sim.areas.length = 0;
    window.__blockStartT = f.host.time;
    f.player.teleport(0, -6);
    const canvas = f.renderer.domElement;
    let armed = true;
    const triggers = [1.4, 3.5, 1.0, 1.4];
    let attempt = 0;
    const tick = () => {
      const projs = f.host.sim.projectiles.filter((p) => p.owner.id === 'dummy_c');
      for (const p of projs) {
        if (armed && p.pos.distanceTo(f.me.pos.clone().setY(f.me.pos.y + 1.08)) < triggers[attempt % triggers.length]) {
          attempt++;
          armed = false;
          canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
          setTimeout(() => { window.dispatchEvent(new MouseEvent('mouseup', { button: 2 })); armed = true; }, 600);
        }
      }
      if (!window.__stopBlock) requestAnimationFrame(tick);
    };
    tick();
  });
  // Wait on simulated time: headless frames are slow.
  await page.waitForFunction(() => window.__fw.host.time > window.__blockStartT + 14, null, { timeout: 240000, polling: 500 });
  await page.evaluate(() => { window.__stopBlock = true; });
  console.log('block test events:', events.filter((e) => e.target === 'player' || e.src === 'player').map((e) => e.kind + (e.text ? ':' + e.text : '') + '@' + e.target + '<' + e.src + ':' + e.amount + (e.target === 'player' ? `(blk ${e.blocking} ${e.since})` : '')).join(', '));
  await page.screenshot({ path: `${outDir}/combat-block.png` });
  await page.evaluate(() => { window.__fw.player.teleport(0, 0); window.__fw.me.hp = 200; });

  for (const el of ['fire', 'water', 'earth', 'air']) {
    await page.evaluate((el) => { const s = window.__fw.settings; s.data.element = el; s.save(); window.__fw.me.chi = 100; window.__fw.dummies.forEach((d) => { d.hp = d.maxHp; d.dead = false; }); }, el);
    await page.waitForTimeout(300);
    events.length = 0;
    // Basic x3 (hold left mouse), then each ability.
    await page.mouse.move(640, 300);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    // Step in close for the area abilities.
    await page.evaluate(() => window.__fw.player.teleport(0, -7));
    await page.waitForTimeout(300);
    for (const k of ['KeyQ', 'KeyE', 'KeyX', 'KeyR']) {
      await page.evaluate(() => { window.__fw.me.chi = 100; });
      await page.keyboard.press(k);
      await page.waitForTimeout(k === 'KeyX' ? 1200 : 700);
      if (k === 'KeyQ' || k === 'KeyX') await page.screenshot({ path: `${outDir}/combat-${el}-${k.slice(3).toLowerCase()}.png` });
    }
    await page.keyboard.press('KeyF');
    await page.waitForTimeout(800);
    const dmg = events.filter((e) => e.kind === 'damage' && e.target !== 'player').reduce((a, e) => a + e.amount, 0);
    const kinds = [...new Set(events.map((e) => e.kind + (e.text ? ':' + e.text : '')))].join(',');
    console.log(`${el}: dealt ${dmg}, events [${kinds}], dummies ${await hp()}`);
    await page.evaluate(() => window.__fw.player.teleport(0, 0));
    await page.evaluate(() => { window.__fw.tpc.yaw = 0; });
  }

}
