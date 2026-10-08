// Phase 3 check: walk, sprint, jump, dodge, camera, settings menu (rename + rebind).
const st = (page) => page.evaluate(() => {
  const p = window.__fw.player;
  return { pos: p.renderPos.toArray().map((v) => +v.toFixed(2)), grounded: p.grounded, swim: p.swimming, vy: +p.velocity.y.toFixed(2), speed: +Math.hypot(p.velocity.x, p.velocity.z).toFixed(2), dodge: +p.dodgeProgress.toFixed(2), phys: window.__fw.physics.terrainColliderCount };
});
export default async function (page, { outDir }) {
  await page.evaluate(() => { window.__fw.dayNight.hour = 9.5; window.__fw.dayNight.timeScale = 0; });
  await page.waitForTimeout(1500);
  console.log('spawn', JSON.stringify(await st(page)));
  await page.screenshot({ path: `${outDir}/char-idle.png` });

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  console.log('walking', JSON.stringify(await st(page)));
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(1500);
  console.log('sprinting', JSON.stringify(await st(page)));
  await page.screenshot({ path: `${outDir}/char-run.png` });
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  console.log('jump', JSON.stringify(await st(page)));
  await page.screenshot({ path: `${outDir}/char-jump.png` });
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(1200);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(120);
  console.log('dodge', JSON.stringify(await st(page)));
  await page.screenshot({ path: `${outDir}/char-dodge.png` });
  await page.waitForTimeout(800);
  console.log('after dodge', JSON.stringify(await st(page)));

  // Rotate camera by dragging with right mouse.
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(900, 330, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/char-camera.png` });

  // Settings: open with Esc, rename, rebind jump to J.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.fill('#set-name', 'Aang Fan');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/settings-general.png` });
  await page.fill('#set-name', 'x');
  console.log('bad name error:', await page.textContent('#set-name-err'));
  await page.fill('#set-name', 'Zuko Jr');
  await page.click('[data-tab=controls]');
  await page.click('.bind[data-action=jump][data-slot="0"]');
  await page.waitForTimeout(100);
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(200);
  await page.click('.bind[data-action=dodge][data-slot="1"]');
  await page.waitForTimeout(100);
  await page.keyboard.press('KeyQ'); // conflicts with Heavy
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/settings-controls.png` });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fw.settings')));
  console.log('saved name', saved.name, 'jump', saved.bindings.jump, 'dodge', saved.bindings.dodge);
  await page.click('[data-close]');
  await page.waitForTimeout(800);
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(150);
  console.log('jump via J', JSON.stringify(await st(page)));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${outDir}/char-renamed.png` });
}
