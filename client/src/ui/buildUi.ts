import * as THREE from 'three/webgpu';
import {
  BAG_CAP, BUILD, CHEST_CAP, MATERIALS, PIECES, halfExtents, invTotal, materialName, pieceById, raidText, restHeight, shortfall, snapPlacement,
  type Builder, type Inventory, type Structure,
} from '@shared/building';
import { ENV_RECIPES, FORGE_RANGE, FORGE_RECIPES, GATHER_RANGE, SOURCE_RANGE } from '@shared/crafting';
import { NODE_DEFS, nearestNode } from '@shared/resources';
import type { CombatHost } from '../game/combat/host';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const icon = (id: string) => MATERIALS.find((m) => m.id === id)?.icon ?? '•';
const costText = (cost: Inventory, inv: Inventory) =>
  Object.entries(cost)
    .map(([k, n]) => `<span class="${(inv[k] ?? 0) >= n ? '' : 'short'}">${icon(k)} ${n} ${esc(materialName(k))}</span>`)
    .join(' ');

export interface BuildKeys {
  build: string;
  interact: string;
  channel: string;
  place: string;
  rotate: string;
}

/**
 * Camp panel (B): your bag, the pieces you can build (with a ghost to place
 * them), your chest and the forge when you stand next to them, and your own
 * pieces nearby to take down. Also shows gather/channel prompts in the world.
 */
export class BuildPanel {
  private el = document.createElement('div');
  private prompt = document.createElement('div');
  private placeBar = document.createElement('div');
  private key = '';
  isOpen = false;
  /** piece being placed with the ghost */
  placing: string | null = null;
  rot = 0;
  private ghost: THREE.Mesh;
  private ghostMat = new THREE.MeshBasicNodeMaterial({ color: 0x55ff88, transparent: true, opacity: 0.35, depthWrite: false });
  /** last placement the ghost showed and why it can't be built ('' = it can) */
  ghostAt = { x: 0, z: 0, err: 'not placing' };

  constructor(
    private host: () => CombatHost,
    scene: THREE.Scene,
    private groundAt: (x: number, z: number) => number,
    private keys: () => BuildKeys,
    private onOpenChange: (open: boolean) => void,
    private lock: () => void,
  ) {
    this.el.className = 'mastery camp hidden';
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.prompt.className = 'camp-prompt hidden';
    this.placeBar.className = 'camp-place hidden';
    document.body.append(this.el, this.prompt, this.placeBar);
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.ghostMat);
    this.ghost.visible = false;
    this.ghost.name = 'build-ghost';
    scene.add(this.ghost);
  }

  /** Placing or browsing: bending input is off. */
  get busy(): boolean {
    return this.isOpen || this.placing !== null;
  }

  toggle(open = !this.isOpen): void {
    if (open) this.cancelPlacing();
    this.isOpen = open;
    this.el.classList.toggle('hidden', !open);
    this.key = '';
    if (open && document.pointerLockElement) document.exitPointerLock();
    this.onOpenChange(open);
  }

  startPlacing(piece: string): void {
    if (!pieceById(piece)) return;
    this.toggle(false);
    this.placing = piece;
    this.ghostAt = { x: 0, z: 0, err: 'not placed yet' };
    this.lock();
  }

  cancelPlacing(): void {
    this.placing = null;
    this.ghost.visible = false;
    this.placeBar.classList.add('hidden');
  }

  private builder(): Builder {
    const h = this.host();
    const e = h.me;
    return { charId: h.charId, name: e.name, side: e.side, faction: e.faction, x: e.pos.x, z: e.pos.z, inv: h.progress.inv };
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-piece],[data-close],[data-remove],[data-put],[data-take],[data-forge],[data-putall]');
    if (!t) {
      if (e.target === this.el) this.toggle(false);
      return;
    }
    const h = this.host();
    const d = t.dataset;
    if (d.close !== undefined) return this.toggle(false);
    if (d.piece) return this.startPlacing(d.piece);
    if (d.remove) h.removeStruct(d.remove);
    if (d.forge) h.forge(d.forge);
    const chest = this.chestNear();
    if (chest && d.put) h.chest(chest.id, { [d.put]: h.progress.inv[d.put] ?? 0 }, true);
    if (chest && d.take) h.chest(chest.id, { [d.take]: chest.store?.[d.take] ?? 0 }, false);
    if (chest && d.putall !== undefined) h.chest(chest.id, { ...h.progress.inv }, true);
    this.key = '';
  }

  private chestNear(): Structure | null {
    const h = this.host();
    return this.nearestStruct(5, (s) => !!s.store && s.owner === h.charId);
  }
  private forgeNear(): Structure | null {
    const h = this.host();
    return this.nearestStruct(FORGE_RANGE, (s) => pieceById(s.piece)?.effect === 'forge' && s.side === h.me.side);
  }
  private nearestStruct(r: number, filter: (s: Structure) => boolean): Structure | null {
    const e = this.host().me;
    let best: Structure | null = null;
    let bd = r;
    for (const s of this.host().camps.all.values()) {
      const d = Math.hypot(s.x - e.pos.x, s.z - e.pos.z);
      if (d <= bd && filter(s)) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  /** G with no NPC around: gather from a node, or open the panel at a chest/forge. Returns whether it did something. */
  interact(): boolean {
    const e = this.host().me;
    const n = nearestNode(e.pos.x, e.pos.z, GATHER_RANGE);
    if (n) {
      this.host().gather(n.id);
      return true;
    }
    if (this.chestNear() || this.forgeNear()) {
      this.toggle(true);
      return true;
    }
    return false;
  }

  /** Per frame: ghost placement, world prompts and the panel contents. */
  update(cameraYaw: number, pressed: { place: boolean; rotate: boolean; cancel: boolean }): void {
    const h = this.host();
    const e = h.me;
    if (this.placing) this.updateGhost(cameraYaw, pressed);
    this.updatePrompt();
    if (!this.isOpen) return;
    const p = h.progress;
    const chest = this.chestNear();
    const forge = this.forgeNear();
    const mine = h.camps.ofOwner(h.charId);
    const nearMine = mine
      .map((s) => ({ s, d: Math.hypot(s.x - e.pos.x, s.z - e.pos.z) }))
      .filter((x) => x.d <= BUILD.placeRange)
      .sort((a, b) => a.d - b.d)
      .slice(0, 8);
    const key = JSON.stringify([p.inv, chest?.store, !!forge, nearMine.map((x) => [x.s.id, x.s.hp]), mine.length, Math.floor(Date.now() / 30000)]);
    if (key === this.key) return;
    this.key = key;
    const fire = h.camps.campfireOf(h.charId);
    const camp = fire
      ? `Your camp: ${mine.length}/${BUILD.maxPieces} pieces at ${Math.round(fire.x)}, ${Math.round(fire.z)}`
      : 'No camp yet: place a campfire in the Wilds (not near a hub) to start one';
    const bag = Object.entries(p.inv)
      .map(([k, n]) => `<div class="c-item">${icon(k)} <b>${n}</b> ${esc(materialName(k))}${chest ? ` <button class="secondary tiny" data-put="${k}" title="Store in chest">→</button>` : ''}</div>`)
      .join('');
    const pieces = PIECES.map((pc) => {
      const short = shortfall(p.inv, pc.cost);
      return `<div class="c-piece m-node ${short ? '' : 'some'}">
        <div class="a-top"><b>${esc(pc.name)}</b><span class="m-rank">${pc.hp} hp${pc.effect ? ` · ${esc(pc.effect)}` : ''}</span></div>
        <small class="c-cost">${costText(pc.cost, p.inv)}</small>
        <button class="${short ? 'secondary' : ''}" data-piece="${pc.id}">Build</button></div>`;
    }).join('');
    const chestHtml = chest
      ? `<h4>Chest (${invTotal(chest.store ?? {})}/${CHEST_CAP}) <button class="secondary tiny" data-putall>Store everything</button></h4><div class="c-bag">${
          Object.entries(chest.store ?? {})
            .map(([k, n]) => `<div class="c-item">${icon(k)} <b>${n}</b> ${esc(materialName(k))} <button class="secondary tiny" data-take="${k}" title="Take">←</button></div>`)
            .join('') || '<small>Empty</small>'
        }</div>`
      : '';
    const forgeHtml = forge
      ? `<h4>Forge</h4><div class="c-bag">${FORGE_RECIPES.map((r) => `<div class="c-item"><b>${esc(r.name)}</b> <small>${costText(r.inputs, p.inv)}</small> <button class="${shortfall(p.inv, r.inputs) ? 'secondary' : ''}" data-forge="${r.id}">Forge</button></div>`).join('')}</div>`
      : '';
    const removeHtml = nearMine.length
      ? `<h4>Your pieces nearby</h4><div class="c-bag">${nearMine.map(({ s }) => `<div class="c-item">${esc(pieceById(s.piece)!.name)} <small>${s.hp}/${s.maxHp}</small> <button class="secondary tiny" data-remove="${s.id}">Take down</button></div>`).join('')}</div>`
      : '';
    const k = this.keys();
    this.el.innerHTML = `<div class="m-panel">
      <div class="m-head"><div><b>Camp</b><span>${esc(camp)} · ${esc(raidText())}</span></div>
        <div class="m-btns"><button class="secondary" data-close>Close</button></div></div>
      <h4>Bag (${invTotal(p.inv)}/${BAG_CAP})</h4><div class="c-bag">${bag || '<small>Empty: gather from timber, boulders, sand and ore (G), or bend-craft (C)</small>'}</div>
      ${chestHtml}${forgeHtml}
      <h4>Build</h4><div class="c-pieces">${pieces}</div>
      ${removeHtml}
      <div class="m-foot">${esc(k.interact)} gathers from a resource node. ${esc(k.channel)} channels: next to sand, a hot spring, ore or an ash pile with the right element, or together with an ally of another element (water+earth = mud, fire+earth = magma brick…). Camps can be raided by the other side during the raid window only.</div>
    </div>`;
  }

  private updateGhost(cameraYaw: number, pressed: { place: boolean; rotate: boolean; cancel: boolean }): void {
    const h = this.host();
    const def = pieceById(this.placing!)!;
    if (pressed.cancel) return this.cancelPlacing();
    if (pressed.rotate) this.rot = (this.rot + 1) % 4;
    const e = h.me;
    const [hx, hy, hz] = halfExtents(def.id, this.rot);
    const ahead = Math.max(hx, hz) + 2.5;
    // Forward is where the camera looks (yaw 0 = -z, matching the third-person camera).
    const s = snapPlacement(e.pos.x - Math.sin(cameraYaw) * ahead, e.pos.z - Math.cos(cameraYaw) * ahead, this.rot);
    const y = restHeight(def.id, s.x, s.z, s.rot, this.groundAt);
    const err = h.camps.check(this.builder(), { piece: def.id, ...s }) ?? '';
    this.ghostAt = { x: s.x, z: s.z, err };
    this.ghost.visible = true;
    this.ghost.scale.set(hx * 2, hy * 2, hz * 2);
    this.ghost.position.set(s.x, y + hy, s.z);
    this.ghostMat.color.set(err ? 0xff5544 : 0x55ff88);
    const k = this.keys();
    this.placeBar.classList.remove('hidden');
    this.placeBar.innerHTML = `<b>${esc(def.name)}</b> · ${esc(k.place)} place · ${esc(k.rotate)} rotate · ${esc(k.build)} cancel${err ? `<br><span class="warn">${esc(err)}</span>` : ''}`;
    if (pressed.place) {
      if (err) return;
      h.place(def.id, s.x, s.z, s.rot);
      // Keep placing walls while you can afford them.
      if (shortfall(h.progress.inv, def.cost) || def.effect === 'respawn') this.cancelPlacing();
    }
  }

  private updatePrompt(): void {
    const h = this.host();
    const e = h.me;
    const k = this.keys();
    let text = '';
    if (!this.placing && !e.dead) {
      const n = nearestNode(e.pos.x, e.pos.z, Math.max(GATHER_RANGE, SOURCE_RANGE));
      if (n) {
        const def = NODE_DEFS[n.type];
        const env = ENV_RECIPES.find((r) => r.source === n.type && r.element === e.element);
        const parts = [`<b>${esc(def.name)}</b>`];
        if (def.gather && Math.hypot(n.x - e.pos.x, n.z - e.pos.z) <= GATHER_RANGE) parts.push(`${esc(k.interact)} gather`);
        if (env) parts.push(`${esc(k.channel)} bend ${esc(env.name)}`);
        else if (!def.gather) parts.push(`needs a ${esc(ENV_RECIPES.find((r) => r.source === n.type)?.element ?? '')}bender`);
        text = parts.join(' · ');
      } else if (this.chestNear()) text = `<b>Chest</b> · ${esc(k.interact)} open`;
      else if (this.forgeNear()) text = `<b>Forge</b> · ${esc(k.interact)} use`;
    }
    this.prompt.classList.toggle('hidden', !text);
    if (text && this.prompt.innerHTML !== text) this.prompt.innerHTML = text;
  }
}
