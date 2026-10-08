// Pretty screenshots of bending at dusk with bloom.
export default async function (page, { outDir }) {
  await page.evaluate(() => { const f = window.__fw; f.dayNight.hour = 18.6; f.dayNight.timeScale = 0; f.tpc.yaw = 0.35; f.tpc.pitch = -0.15; f.tpc.distance = 7; f.settings.data.element = 'fire'; f.settings.save(); });
  await page.waitForTimeout(2500);
  await page.keyboard.press('KeyE'); // flame ring
  await page.waitForFunction(() => window.__fw.host.time > 0, null, { polling: 200 });
  const t0 = await page.evaluate(() => window.__fw.host.time);
  await page.waitForFunction((t) => window.__fw.host.time > t + 0.6, t0, { polling: 100 });
  await page.keyboard.press('KeyQ'); // fire blast
  const t1 = await page.evaluate(() => window.__fw.host.time);
  await page.waitForFunction((t) => window.__fw.host.time > t + 0.45, t1, { polling: 100 });
  await page.screenshot({ path: `${outDir}/showcase-fire.png` });
  await page.evaluate(() => { const f = window.__fw; f.settings.data.element = 'water'; f.settings.save(); f.dayNight.hour = 22; f.me.chi = 100; });
  await page.waitForTimeout(1500);
  await page.keyboard.press('KeyX');
  const t2 = await page.evaluate(() => window.__fw.host.time);
  await page.waitForFunction((t) => window.__fw.host.time > t + 0.35, t2, { polling: 100 });
  await page.screenshot({ path: `${outDir}/showcase-water-night.png` });
}
