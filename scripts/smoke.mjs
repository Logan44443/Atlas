// Headless browser smoke test: loads the game, waits for the first frame,
// collects console errors and saves screenshots. Usage:
//   node scripts/smoke.mjs [url] [--webgpu] [--shots=noon,dusk,night]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http')) ?? 'http://localhost:5173/';
const webgpu = args.includes('--webgpu');
const outDir = 'screenshots';
mkdirSync(outDir, { recursive: true });

const launchArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
if (webgpu) launchArgs.push('--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: launchArgs });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const logs = [];
page.on('console', (m) => {
  const t = `[${m.type()}] ${m.text()}`;
  logs.push(t);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('#loading.done', { timeout: 180000 });
console.log(`first frame after ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const scenario = process.env.SCENARIO;
if (scenario) {
  const mod = await import(new URL(`./scenarios/${scenario}.mjs`, import.meta.url));
  await mod.default(page, { outDir });
} else {
  for (const [name, hour] of [['noon', 12], ['dusk', 18.3], ['night', 23]]) {
    await page.evaluate((h) => { window.__fw.dayNight.hour = h; }, hour);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${outDir}/${name}.png` });
  }
}
const stats = await page.evaluate(() => {
  const r = window.__fw.renderer.info.render;
  return { drawCalls: r.drawCalls, triangles: r.triangles, preset: window.__fw.preset, backend: window.__fw.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2' };
});
console.log('stats', JSON.stringify(stats));
console.log('debug panel:', (await page.textContent('.debug'))?.slice(0, 400));
if (errors.length) {
  console.log('ERRORS:\n' + errors.slice(0, 30).join('\n'));
} else console.log('no console errors');
if (process.env.VERBOSE) console.log(logs.join('\n'));
await browser.close();
process.exit(errors.length ? 1 : 0);
