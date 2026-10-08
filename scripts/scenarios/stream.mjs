// Flies the debug camera across the world and checks streaming + SW caching.
export default async function (page, { outDir }) {
  await page.evaluate(() => { window.__fw.dayNight.hour = 10; window.__fw.dayNight.timeScale = 0; });
  await page.screenshot({ path: `${outDir}/stream-start.png` });
  await page.mouse.move(640, 360);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2500);
    const s = await page.evaluate(() => ({ pos: window.__fw.camera.position.toArray().map(Math.round), c: window.__fw.streamer.counts }));
    console.log('flying', JSON.stringify(s));
  }
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${outDir}/stream-flown.png` });
  const before = await page.evaluate(() => window.__fw.streamer.store.stats);
  console.log('store stats before reload', JSON.stringify(before));
  await page.reload();
  await page.waitForSelector('#loading.done', { timeout: 120000 });
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({ sw: window.__fw.swActive, st: window.__fw.streamer.store.stats }));
  console.log('after reload', JSON.stringify(after));
}
