import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() !== 'debug') console.log('console', m.type(), m.text().slice(0, 200)); });
const t0 = Date.now();
await page.goto(process.argv[2] ?? 'http://localhost:5173/?quality=high');
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const f = window.__fw;
    if (!f) return 'no __fw';
    return JSON.stringify({ c: f.streamer.counts, st: f.streamer.store.stats, done: document.querySelector('#loading').className, frame: f.renderer.info.render.frame });
  }).catch((e) => 'err ' + e.message);
  console.log(((Date.now() - t0) / 1000).toFixed(1), s);
  if (s.includes('"done":"done"')) break;
}
await browser.close();
