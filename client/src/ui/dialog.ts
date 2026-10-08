import { NPC_CFG, factionById } from '@shared/factions';
import type { SimEntity } from '@shared/sim/combatSim';

const ROLE_LABEL: Record<string, string> = { vendor: 'Vendor', trainer: 'Trainer', quest: 'Quests', guard: 'Guard', fighter: 'Patrol' };

/** "G to talk" prompt and a simple NPC speech box. */
export class NpcDialog {
  private hint = document.createElement('div');
  private box = document.createElement('div');
  private open: SimEntity | null = null;

  constructor() {
    this.hint.className = 'interact-hint hidden';
    this.box.className = 'dialog hidden';
    document.body.append(this.hint, this.box);
  }

  get isOpen(): boolean {
    return !!this.open;
  }

  /** Nearest living NPC within reach, if any. */
  nearest(entities: Iterable<SimEntity>, x: number, z: number, reach = 4): SimEntity | null {
    let best: SimEntity | null = null;
    let bd = reach;
    for (const e of entities) {
      if (e.kind !== 'npc' || e.dead) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.z - z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  update(near: SimEntity | null, interactPressed: boolean, keyLabel: string): void {
    if (this.open && (!near || near !== this.open)) this.close();
    this.hint.classList.toggle('hidden', !near || !!this.open);
    if (near && !this.open) this.hint.textContent = `${keyLabel} · Talk to ${near.name}`;
    if (interactPressed && near) {
      if (this.open) this.close();
      else this.show(near);
    }
  }

  private show(e: SimEntity): void {
    this.open = e;
    const lines = (NPC_CFG.lines as Record<string, string[]>)[e.role ?? ''] ?? ['…'];
    const f = factionById(e.faction);
    this.box.style.setProperty('--fc', f?.color ?? '');
    this.box.innerHTML = `<span class="who">${e.name}</span><span class="role">${e.title ?? ''} · ${ROLE_LABEL[e.role ?? ''] ?? ''} · ${f?.name ?? ''}</span>
      <p>${lines[Math.floor(Math.random() * lines.length)]}</p><div class="close-hint">Walk away or press interact again to close</div>`;
    this.box.classList.remove('hidden');
  }

  close(): void {
    this.open = null;
    this.box.classList.add('hidden');
  }
}
