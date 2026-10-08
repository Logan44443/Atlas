export default async function (page) {
  await page.evaluate(() => window.__fw.player.teleport(0, -6));
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(1500);
    console.log(await page.evaluate(() => {
      const d = window.__fw.dummies[2]; const c = window.__fw.combat;
      return JSON.stringify({ t: d.attackT, dead: d.dead, st: [...d.statuses.keys()], pos: d.feet.toArray().map(Math.round), me: window.__fw.me.feet.toArray().map(Math.round), proj: c.projectiles.map((p) => p.pos.toArray().map((v) => v.toFixed(1))), time: c.time.toFixed(1) });
    }));
  }
}
