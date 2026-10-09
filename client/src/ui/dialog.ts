import { NPC_CFG, factionById } from '@shared/factions';
import type { SimEntity } from '@shared/sim/combatSim';

const ROLE_LABEL: Record<string, string> = { vendor: 'Vendor', trainer: 'Trainer', quest: 'Quests', beast: 'Pets', guard: 'Guard', fighter: 'Patrol', master: 'Master' };

/** "G to talk" prompt and a simple NPC speech box. */
export class NpcDialog {
  private hint = document.createElement('div');
  private box = document.createElement('div');
  private open: SimEntity | null = null;
  /** Called when the player opens a conversation with a master or Beastkeeper (quests). */
  onTalk: ((e: SimEntity) => void) | null = null;
  /** Advice that fits the player (shared/advice.ts); falls back to the NPC's stock lines. */
  advise: ((e: SimEntity) => string) | null = null;

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
    // Keep talking to whoever you're talking to while they're in reach, even if a patrol walks past closer.
    const o = this.open;
    if (o && !o.dead && Math.hypot(o.pos.x - x, o.pos.z - z) < reach) return o;
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
    const master = e.role === 'master';
    const stock = (NPC_CFG.lines as Record<string, string[]>)[e.role ?? ''] ?? ['…'];
    const lines = master ? ['…'] : [this.advise?.(e) ?? stock[Math.floor(Math.random() * stock.length)]];
    const f = factionById(e.faction);
    this.box.style.setProperty('--fc', master ? '#ffb35a' : f?.color ?? '');
    const sub = [e.title, ROLE_LABEL[e.role ?? ''], f?.name].filter(Boolean).join(' · ');
    this.box.innerHTML = `<span class="who">${e.name}</span><span class="role">${sub}</span>
      <p>${lines[Math.floor(Math.random() * lines.length)]}</p><div class="close-hint">Walk away or press interact again to close</div>`;
    if (master || e.role === 'beast') this.onTalk?.(e);
    this.box.classList.remove('hidden');
  }

  /** A master's or Beastkeeper's answer arrived (from the shard or the offline host). */
  say(npcId: string, line: string): void {
    if (this.open?.id !== npcId || !line) return;
    const p = this.box.querySelector('p');
    if (!p) return;
    // Beastkeepers keep their advice and add the quest news.
    if (this.open.role === 'beast') {
      const q = document.createElement('p');
      q.className = 'quest-line';
      q.textContent = line;
      p.after(q);
    } else p.textContent = line;
  }

  close(): void {
    this.open = null;
    this.box.classList.add('hidden');
  }
}
