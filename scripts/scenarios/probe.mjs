export default async function (page) {
  const r = await page.evaluate(() => {
    const s = window.__fw.scene.getObjectByName('Sky');
    return { visible: s.visible, pos: s.position.toArray(), far: window.__fw.camera.far, children: window.__fw.scene.children.map((c) => c.name || c.type) };
  });
  console.log(JSON.stringify(r));
}
