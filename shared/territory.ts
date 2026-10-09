// Territory wars (Phase 11, DESIGN section 5): the contested shrines and the
// outposts, the war schedule, and the capture meter of every point. Pure rules
// shared by the shard server (one Territory for the whole process, fed by every
// shard's players) and offline play (one per tab).
import territoryData from '../data/territory.json';
import { CONTESTED, OUTPOSTS, FACTIONS, factionById, sideOf } from './factions';
import type { Inventory } from './building';

export const TERR = territoryData;
export type PointKind = 'shrine' | 'outpost';
interface KindCfg {
  captureRadius: number;
  captureSeconds: number;
  xpPerLevel: number;
  rankPoints: number;
  coins: number;
  income: Record<string, number>;
  incomeCoins: number;
}

export interface WarPoint {
  id: string;
  name: string;
  kind: PointKind;
  x: number;
  z: number;
  /** contested zone radius */
  radius: number;
  captureRadius: number;
  cfg: KindCfg;
  buff: { type: 'dmg' | 'regen' | 'armor'; value: number; text: string } | null;
}

const BUFFS = TERR.buffs as Record<string, WarPoint['buff']>;
export const POINTS: WarPoint[] = [
  ...CONTESTED.map((c) => ({ id: c.id, name: c.name, kind: 'shrine' as const, x: c.x, z: c.z, radius: c.radius, captureRadius: TERR.kinds.shrine.captureRadius, cfg: TERR.kinds.shrine, buff: BUFFS[c.id] ?? null })),
  ...OUTPOSTS.map((c) => ({ id: c.id, name: c.name, kind: 'outpost' as const, x: c.x, z: c.z, radius: c.radius, captureRadius: TERR.kinds.outpost.captureRadius, cfg: TERR.kinds.outpost, buff: BUFFS[c.id] ?? null })),
];
export const pointById = (id: string): WarPoint | undefined => POINTS.find((p) => p.id === id);

export interface PointState {
  id: string;
  /** holding faction id ('' = nobody) */
  owner: string;
  /** crew that led the capture (gets the income), '' for none */
  crew: string;
  /** which side the meter is filling toward ('' = empty) */
  capSide: string;
  /** 0..1 */
  progress: number;
  /** players of each side inside the capture circle (for the HUD) */
  order: number;
  outlaw: number;
  /** wall ms when the holder took it */
  heldSince: number;
}

/** What gets saved: who holds what. */
export interface PointSave {
  id: string;
  owner: string;
  crew: string;
  heldSince: number;
}

// ---- war schedule --------------------------------------------------------------------

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The war window around wall time `ms`: open now, or the next one. */
export function warWindow(ms: number): { open: boolean; start: number; end: number } {
  const day = Math.floor(ms / DAY) * DAY;
  let next: { start: number; end: number } | null = null;
  for (const d of [day - DAY, day, day + DAY]) {
    for (const w of TERR.wars) {
      const start = d + w.start * 60 * MIN;
      const end = start + w.minutes * MIN;
      if (ms >= start && ms < end) return { open: true, start, end };
      if (start > ms && (!next || start < next.start)) next = { start, end };
    }
  }
  return { open: false, ...next! };
}

const fmt = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / MIN));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`;
};
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/** "Territory war: 32 m left" / "Next territory war at 17:00 UTC (in 3 h 12 m)". */
export function warText(ms: number, forced: boolean | null = null): string {
  if (forced === true) return 'Territory war under way';
  if (forced === false) return 'No territory war right now';
  const w = warWindow(ms);
  return w.open ? `Territory war: ${fmt(w.end - ms)} left` : `Next territory war at ${hhmm(w.start)} UTC (in ${fmt(w.start - ms)})`;
}

// ---- capture -------------------------------------------------------------------------

/** A living player inside a capture circle. */
export interface Presence {
  charId: string;
  /** entity id in their shard (rewards are routed by charId) */
  entityId: string;
  side: string;
  faction: string;
  crew: string;
}

export type TerrNews =
  | { t: 'war'; open: boolean; text: string }
  | { t: 'captured'; point: string; faction: string; crew: string; by: Presence[]; text: string }
  | { t: 'lost'; point: string; faction: string; text: string }
  | { t: 'income'; point: string; faction: string; crew: string; items: Inventory; coins: number }
  | { t: 'held'; faction: string; points: string[] };

/** Who counts toward a capture: living players with a side, inside the circle, on (or near) the ground. */
export function presenceAt(
  players: Iterable<{ charId: string; entity: { id: string; kind: string; side: string; faction: string; dead: boolean; pos: { x: number; y: number; z: number }; spiritUntil: number }; crew: string }>,
  groundAt: (x: number, z: number) => number,
  time: number,
): Map<string, Presence[]> {
  const out = new Map<string, Presence[]>();
  for (const p of players) {
    const e = p.entity;
    if (e.dead || e.kind !== 'player' || !e.side || e.spiritUntil > time) continue;
    for (const pt of POINTS) {
      if (Math.hypot(e.pos.x - pt.x, e.pos.z - pt.z) > pt.captureRadius) continue;
      // Flying high over a point doesn't hold it.
      if (e.pos.y - groundAt(e.pos.x, e.pos.z) > 6) continue;
      let list = out.get(pt.id);
      if (!list) out.set(pt.id, (list = []));
      list.push({ charId: p.charId, entityId: e.id, side: e.side, faction: e.faction, crew: p.crew });
    }
  }
  return out;
}

/** The faction (and its crew) that did most of a capture. */
function leaders(by: Presence[]): { faction: string; crew: string } {
  const count = (key: (p: Presence) => string, list: Presence[]) => {
    const m = new Map<string, number>();
    for (const p of list) if (key(p)) m.set(key(p), (m.get(key(p)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
  };
  const faction = count((p) => p.faction, by);
  return { faction, crew: count((p) => p.crew, by.filter((p) => p.faction === faction)) };
}

/** The faction whose hub is nearest: who holds an outpost in a brand-new world. */
function nearestFaction(x: number, z: number): string {
  return [...FACTIONS].sort((a, b) => Math.hypot(a.hub.x - x, a.hub.z - z) - Math.hypot(b.hub.x - x, b.hub.z - z))[0].id;
}

export class Territory {
  readonly states = new Map<string, PointState>();
  /** dev/tests: force a war open (true) or shut (false) */
  forceWar: boolean | null = null;
  /** dev/tests: capture speed multiplier */
  rateScale = 1;
  private wasOpen: boolean | null = null;
  private incomeSlot = -1;

  constructor(saved: PointSave[] = []) {
    for (const p of POINTS) {
      // A new world: every outpost belongs to the nearest hub's faction, shrines to nobody.
      const owner = p.kind === 'outpost' ? nearestFaction(p.x, p.z) : '';
      this.states.set(p.id, { id: p.id, owner, crew: '', capSide: sideOf(owner) ?? '', progress: owner ? 1 : 0, order: 0, outlaw: 0, heldSince: 0 });
    }
    this.load(saved);
  }

  load(saved: PointSave[]): void {
    for (const s of saved) {
      const st = this.states.get(s.id);
      if (!st) continue;
      const owner = factionById(s.owner) ? s.owner : '';
      Object.assign(st, { owner, crew: owner ? String(s.crew ?? '') : '', heldSince: Number(s.heldSince) || 0, capSide: sideOf(owner) ?? '', progress: owner ? 1 : 0 });
    }
  }

  save(): PointSave[] {
    return [...this.states.values()].map((s) => ({ id: s.id, owner: s.owner, crew: s.crew, heldSince: s.heldSince }));
  }

  /** Copies for the wire. */
  snapshot(): PointState[] {
    return [...this.states.values()].map((s) => ({ ...s, progress: Math.round(s.progress * 1000) / 1000 }));
  }

  isOpen(now: number): boolean {
    return this.forceWar ?? warWindow(now).open;
  }

  text(now: number): string {
    return warText(now, this.forceWar);
  }

  /** Points a faction holds. */
  holdings(faction: string): WarPoint[] {
    return POINTS.filter((p) => this.states.get(p.id)?.owner === faction);
  }

  /** Bonuses a faction's members get from what it holds. */
  buffsFor(faction: string): { dmg: number; regen: number; armor: number; xp: number } {
    const b = { dmg: 0, regen: 0, armor: 0, xp: 0 };
    if (!faction) return b;
    for (const p of this.holdings(faction)) {
      b.xp += TERR.xpPerPoint;
      if (p.buff) b[p.buff.type] += p.buff.value;
    }
    return b;
  }

  /** A crew disbanded: it stops collecting income. */
  dropCrew(crew: string): void {
    for (const s of this.states.values()) if (s.crew === crew) s.crew = '';
  }

  /**
   * Advance every capture meter by dt seconds. `presence` = who stands inside
   * each point's circle right now. Returns what happened (captures, war start
   * and end, income).
   */
  update(dt: number, presence: Map<string, Presence[]>, now: number): TerrNews[] {
    const news: TerrNews[] = [];
    const open = this.isOpen(now);
    if (this.wasOpen !== null && open !== this.wasOpen) {
      news.push({ t: 'war', open, text: open ? 'The war horn sounds! Shrines and outposts can be captured.' : 'The territory war is over. Holdings are locked until the next one.' });
      if (!open) {
        for (const f of FACTIONS) {
          const pts = this.holdings(f.id).map((p) => p.id);
          if (pts.length) news.push({ t: 'held', faction: f.id, points: pts });
        }
        // Between wars every meter rests with its holder.
        for (const s of this.states.values()) {
          s.capSide = sideOf(s.owner) ?? '';
          s.progress = s.owner ? 1 : 0;
          s.order = s.outlaw = 0;
        }
      }
    }
    this.wasOpen = open;
    this.income(now, news);
    if (!open) return news;

    for (const pt of POINTS) {
      const st = this.states.get(pt.id)!;
      const here = presence.get(pt.id) ?? [];
      const o = here.filter((p) => p.side === 'order').length;
      const x = here.filter((p) => p.side === 'outlaw').length;
      st.order = o;
      st.outlaw = x;
      const holder = sideOf(st.owner) ?? '';
      const rate = (this.rateScale / pt.cfg.captureSeconds) * dt;
      if (!o && !x) {
        // Nobody here: a half-taken meter drifts back to the holder.
        const d = rate * TERR.decayScale;
        if (st.capSide === holder) st.progress = holder ? Math.min(1, st.progress + d) : 0;
        else if ((st.progress -= d) <= 0) {
          st.capSide = holder;
          st.progress = 0;
        }
        continue;
      }
      if (o === x) continue; // evenly matched: nobody moves the meter
      const side = o > x ? 'order' : 'outlaw';
      const push = rate * Math.min(TERR.maxStrength, Math.abs(o - x));
      if (st.capSide === side) {
        st.progress = Math.min(1, st.progress + push);
        if (st.progress >= 1 && holder !== side) {
          const by = here.filter((p) => p.side === side);
          const lead = leaders(by);
          const f = factionById(lead.faction);
          Object.assign(st, { owner: lead.faction, crew: lead.crew, heldSince: now });
          news.push({ t: 'captured', point: pt.id, faction: lead.faction, crew: lead.crew, by, text: `${f?.emblem ?? ''} ${f?.name ?? 'Someone'} captured ${pt.name}!`.trim() });
        }
      } else {
        st.progress -= push;
        if (st.progress <= 0) {
          if (st.owner && holder !== side) {
            const f = factionById(st.owner);
            news.push({ t: 'lost', point: pt.id, faction: st.owner, text: `${f?.name ?? 'Its holders'} lost ${pt.name}` });
            st.owner = '';
            st.crew = '';
          }
          st.capSide = side;
          st.progress = 0;
        }
      }
    }
    return news;
  }

  /** Every incomeEveryMinutes of wall time, each held point pays its holder. */
  private income(now: number, news: TerrNews[]): void {
    const slot = Math.floor(now / (TERR.incomeEveryMinutes * MIN));
    if (this.incomeSlot < 0) this.incomeSlot = slot;
    if (slot === this.incomeSlot) return;
    this.incomeSlot = slot;
    for (const pt of POINTS) {
      const st = this.states.get(pt.id)!;
      if (!st.owner) continue;
      news.push({ t: 'income', point: pt.id, faction: st.owner, crew: st.crew, items: { ...pt.cfg.income }, coins: pt.cfg.incomeCoins });
    }
  }
}
