import './chat.css';
import type { ChatChannel, ChatMsg, ChatSend } from '@shared/net';
import { factionById } from '@shared/factions';
import type { CombatHost } from '../game/combat/host';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const MAX_LINES = 100;
/** lines stay on screen this long when you're not typing, fading out over the last FADE seconds */
const SHOW_SECONDS = 15;
const FADE_SECONDS = 3;
const MAX_LEN = 200;
const MAX_HISTORY = 30;
const MAX_NAMES = 200;

const CHANNELS: Record<ChatChannel | 'system', { label: string; color: string }> = {
  say: { label: 'Say', color: '#f4efe2' },
  shard: { label: 'Shard', color: '#ffcf8a' },
  faction: { label: 'Faction', color: '#9fe39a' },
  crew: { label: 'Crew', color: '#7fe0d0' },
  party: { label: 'Party', color: '#8fb8ff' },
  whisper: { label: 'Whisper', color: '#f0a0e8' },
  system: { label: 'System', color: '#a9b0c2' },
};

/** slash commands that pick a channel */
const CHANNEL_CMDS: Record<string, ChatChannel> = {
  s: 'say', say: 'say',
  g: 'shard', shard: 'shard',
  f: 'faction', faction: 'faction',
  c: 'crew', crew: 'crew',
  p: 'party', party: 'party',
};
const WHISPER_CMDS = new Set(['w', 'whisper', 't', 'tell']);
const REPLY_CMDS = new Set(['r', 'reply']);

const HELP =
  'Chat: /s say (nearby, 40 m) · /g shard (everyone here) · /f faction · /c crew · /p party · ' +
  '/w <name> <text> whisper ("quotes" for names with spaces) · /r <text> reply · ' +
  'a command on its own switches channel · ↑/↓ recall · Esc cancels';

/** Faction colours are made for banners; lighten them a little so names read on the dark log. */
const nameColors = new Map<string, string>();
function nameColor(faction: string | undefined): string {
  const c = factionById(faction)?.color;
  if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return CHANNELS.say.color;
  let out = nameColors.get(c);
  if (!out) {
    const n = parseInt(c.slice(1), 16);
    const mix = (v: number) => Math.round(v + (255 - v) * 0.3);
    out = `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
    nameColors.set(c, out);
  }
  return out;
}

interface Line {
  el: HTMLDivElement;
  t: number;
  old: boolean;
}

interface Sticky {
  ch: ChatChannel;
  /** whisper target */
  to?: string;
}

/**
 * Chat box (bottom-left). Enter or / opens it, Enter sends, Esc cancels.
 * Slash commands pick the channel; plain text goes to the sticky channel.
 * Lines fade after ~15 s unless you're typing, when the whole log scrolls.
 */
export class ChatBox {
  private root = document.createElement('div');
  private log = document.createElement('div');
  private chan = document.createElement('span');
  private input = document.createElement('input');
  private lines: Line[] = [];
  private clock = 0;
  private sticky: Sticky = { ch: 'say' };
  /** who last whispered you (for /r) */
  private lastFrom = '';
  /** names seen in chat, for /w with names that contain spaces */
  private names = new Set<string>();
  private history: string[] = [];
  private hIdx = 0;

  constructor(private host: () => CombatHost) {
    this.root.className = 'chat';
    this.log.className = 'c-log';
    const row = document.createElement('div');
    row.className = 'c-row';
    this.chan.className = 'c-chan';
    this.input.className = 'c-in';
    this.input.type = 'text';
    this.input.maxLength = MAX_LEN;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.placeholder = 'Message · /help for commands';
    this.input.setAttribute('aria-label', 'Chat message');
    row.append(this.chan, this.input);
    this.root.append(this.log, row);
    document.body.append(this.root);
    this.showChannel();

    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    // Keys typed here stay here (the game's own listeners sit on window, bubble phase).
    this.input.addEventListener('keydown', (e) => e.stopPropagation());
    this.input.addEventListener('focus', () => {
      this.root.classList.add('typing');
      this.hIdx = this.history.length;
      this.showChannel();
      this.toBottom();
    });
    this.input.addEventListener('blur', () => {
      this.root.classList.remove('typing');
      this.toBottom();
    });
    this.input.addEventListener('input', () => this.liveSwitch());
    // Capture phase: Escape must not also reach the settings menu, and Enter / '/' must not reach the game.
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  /** true while the text field has focus (main stops movement/abilities then) */
  get typing(): boolean {
    return document.activeElement === this.input;
  }

  /** focus the field, optionally prefilled (e.g. '/') */
  open(prefill?: string): void {
    if (prefill !== undefined) this.input.value = prefill;
    this.root.classList.add('typing');
    this.input.focus({ preventScroll: true });
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  /** call every frame: drains host().chat into the log, fades old lines */
  update(dt: number): void {
    this.clock += dt;
    const h = this.host();
    if (h.chat.length) for (const m of h.chat.splice(0)) this.add(m, h.me.name);
    if (this.typing) return;
    // Newest last: walk back until a line that already faded out.
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      if (l.old) break;
      const age = this.clock - l.t;
      if (age >= SHOW_SECONDS) {
        l.old = true;
        l.el.classList.add('old');
        l.el.style.opacity = '';
      } else if (age > SHOW_SECONDS - FADE_SECONDS) {
        l.el.style.opacity = ((SHOW_SECONDS - age) / FADE_SECONDS).toFixed(2);
      }
    }
  }

  /** add a local system line */
  system(text: string): void {
    this.add({ ch: 'system', from: '', text }, '');
  }

  // ---- log ------------------------------------------------------------------------

  private add(m: ChatMsg, myName: string): void {
    const c = CHANNELS[m.ch] ?? CHANNELS.say;
    const el = document.createElement('div');
    el.className = `c-line c-${m.ch in CHANNELS ? m.ch : 'say'}`;
    el.style.color = c.color;
    const text = esc(String(m.text ?? ''));
    if (m.ch === 'system') el.innerHTML = text;
    else {
      const tag = m.tag ? `<span class="c-tag">[${esc(m.tag)}]</span> ` : '';
      const who = `<b style="color:${nameColor(m.faction)}">${esc(m.from)}</b>`;
      if (m.ch === 'whisper') {
        // The server sends a whisper to both ends: from = sender, to = receiver.
        if (m.from === myName) el.innerHTML = `To <b>${esc(m.to ?? '?')}</b>: ${text}`;
        else {
          this.lastFrom = m.from;
          el.innerHTML = `From ${tag}${who}: ${text}`;
        }
      } else {
        const pre = m.ch === 'say' ? '' : `<span class="c-pre">[${c.label}]</span> `;
        el.innerHTML = `${pre}${tag}${who}: ${text}`;
      }
      this.remember(m.from);
      if (m.to) this.remember(m.to);
    }
    const stick = !this.typing || this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 8;
    this.log.append(el);
    this.lines.push({ el, t: this.clock, old: false });
    while (this.lines.length > MAX_LINES) this.lines.shift()!.el.remove();
    if (stick) this.toBottom();
  }

  private toBottom(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }

  private remember(name: string): void {
    if (!name) return;
    this.names.delete(name);
    this.names.add(name);
    if (this.names.size > MAX_NAMES) this.names.delete(this.names.values().next().value!);
  }

  // ---- input ----------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (this.typing) {
      if (e.isComposing) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.input.value = '';
        this.input.blur();
      } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const raw = this.input.value;
        this.input.value = '';
        if (!this.submit(raw)) this.input.blur();
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        this.recall(e.code === 'ArrowUp' ? -1 : 1);
      }
      return;
    }
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    const enter = e.code === 'Enter' || e.code === 'NumpadEnter';
    if (!enter && e.key !== '/') return;
    // Only when nothing else has the keyboard (a focused button, a settings field, a rebind).
    const a = document.activeElement;
    if (a && a !== document.body && a.tagName !== 'CANVAS') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.open(enter ? undefined : '/');
  }

  private recall(step: number): void {
    if (!this.history.length) return;
    this.hIdx = Math.max(0, Math.min(this.history.length, this.hIdx + step));
    this.input.value = this.history[this.hIdx] ?? '';
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  /** "/g " typed on its own switches channel right away. */
  private liveSwitch(): void {
    const m = /^\/(\w+) $/.exec(this.input.value);
    if (!m) return;
    const cmd = m[1].toLowerCase();
    if (CHANNEL_CMDS[cmd]) this.setSticky({ ch: CHANNEL_CMDS[cmd] });
    else if (REPLY_CMDS.has(cmd) && this.lastFrom) this.setSticky({ ch: 'whisper', to: this.lastFrom });
    else return;
    this.input.value = '';
  }

  /** Runs what was typed. Returns true to keep the field open (channel switch, help, mistakes). */
  private submit(raw: string): boolean {
    const text = raw.trim();
    if (!text || text === '/') return false;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.hIdx = this.history.length;
    if (text[0] !== '/') {
      this.send(this.sticky.ch, text, this.sticky.to);
      return false;
    }
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text)!;
    const cmd = m[1].toLowerCase();
    const rest = m[2].trim();
    if (cmd === 'help' || cmd === '?' || cmd === 'h') {
      this.system(HELP);
      return true;
    }
    const ch = CHANNEL_CMDS[cmd];
    if (ch) {
      if (!rest) return this.setSticky({ ch });
      this.send(ch, rest);
      return false;
    }
    if (WHISPER_CMDS.has(cmd)) {
      const w = this.splitName(rest);
      if (!w.name) {
        this.system('Usage: /w <name> <message>');
        return true;
      }
      if (!w.text) return this.setSticky({ ch: 'whisper', to: w.name });
      this.send('whisper', w.text, w.name);
      return false;
    }
    if (REPLY_CMDS.has(cmd)) {
      if (!this.lastFrom) {
        this.system('Nobody has whispered you yet');
        return true;
      }
      if (!rest) return this.setSticky({ ch: 'whisper', to: this.lastFrom });
      this.send('whisper', rest, this.lastFrom);
      return false;
    }
    this.system(`Unknown command /${cmd}. Type /help for the list`);
    return true;
  }

  private send(ch: ChatChannel, text: string, to?: string): void {
    const m: ChatSend = { ch, text: text.slice(0, MAX_LEN) };
    if (ch === 'whisper') m.to = to ?? '';
    this.host().sendChat(m);
  }

  private setSticky(s: Sticky): true {
    this.sticky = s;
    this.showChannel();
    return true;
  }

  private showChannel(): void {
    const s = this.sticky;
    this.chan.textContent = s.ch === 'whisper' ? `To ${s.to ?? '?'}` : CHANNELS[s.ch].label;
    this.chan.style.color = CHANNELS[s.ch].color;
  }

  /**
   * "/w Name text": names may contain spaces, so prefer "quoted names", then the
   * longest name we know (nearby players, party, crew, chat) the text starts with,
   * then the first word.
   */
  private splitName(rest: string): { name: string; text: string } {
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end > 1) return { name: rest.slice(1, end).trim(), text: rest.slice(end + 1).trim() };
    }
    const lower = rest.toLowerCase();
    let best = '';
    for (const n of this.knownNames()) {
      const l = n.toLowerCase();
      if (n.length > best.length && (lower === l || lower.startsWith(l + ' '))) best = n;
    }
    if (best) return { name: best, text: rest.slice(best.length).trim() };
    const sp = rest.indexOf(' ');
    return sp < 0 ? { name: rest, text: '' } : { name: rest.slice(0, sp), text: rest.slice(sp + 1).trim() };
  }

  private knownNames(): Set<string> {
    const out = new Set(this.names);
    const h = this.host();
    for (const e of h.entities.values()) if (e.kind === 'player' && e.name) out.add(e.name);
    for (const m of h.party?.members ?? []) out.add(m.name);
    for (const m of h.crew?.members ?? []) out.add(m.name);
    return out;
  }
}
