// Special Arts (DESIGN section 8): which arts exist, how a character unlocks
// them (level + a master's quest), and the quest bookkeeping. Shared so the
// shard server and offline play run the same rules. No DOM.
import artsData from '../data/arts.json';
import type { AbilityDef, ElementId } from './combat';
import { zoneAt } from './factions';
import type { SimEntity } from './sim/combatSim';
import type { Progress } from './progression';

export interface QuestPoint {
  label: string;
  x: number;
  z: number;
}
export interface QuestStep {
  type: 'talk' | 'visit' | 'kill' | 'meditate';
  text?: string;
  night?: boolean;
  radius?: number;
  points?: QuestPoint[];
  count?: number;
  filter?: 'enemy' | 'fighter' | 'player';
  zone?: 'contested' | 'wilds';
  seconds?: number;
}
export interface ArtDef {
  id: string;
  name: string;
  element: ElementId | 'any';
  level: number;
  passive?: boolean;
  nightOnly?: boolean;
  text: string;
  limits: string;
  master: { name: string; title: string; x: number; z: number; hint: string } | null;
  lines?: { offer: string; progress: string; done: string; day?: string };
  penalty?: { side: string; exempt: string[]; rank: number; bounty: boolean };
  steps: QuestStep[];
  ability: AbilityDef | null;
}

export const ARTS = artsData.arts as unknown as ArtDef[];
export const ARTS_CFG = { pvpHealScale: artsData.pvpHealScale, pvpCombatSeconds: artsData.pvpCombatSeconds, glider: artsData.glider, flight: artsData.flight };
export const artById = (id: string | null | undefined): ArtDef | undefined => ARTS.find((a) => a.id === id);
export const artsFor = (el: ElementId | null): ArtDef[] => ARTS.filter((a) => a.element === 'any' || a.element === el);
export const masterId = (artId: string) => `master_${artId}`;
export const NIGHT_THRESHOLD = 0.5;

export interface QuestState {
  step: number;
  /** kills or seconds for the current step */
  count: number;
  /** labels of points done in the current step */
  done: string[];
}
export interface ArtsState {
  learned: string[];
  equipped: string | null;
  quests: Record<string, QuestState>;
  /** Order player who learned a forbidden art */
  bounty: boolean;
}

export const newArtsState = (s: Partial<ArtsState> = {}): ArtsState => ({ learned: [], equipped: null, quests: {}, bounty: false, ...s });

/** Clean up whatever was saved (unknown arts, wrong element, bad step numbers). */
export function sanitizeArts(el: ElementId | null, raw: unknown): ArtsState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ArtsState>;
  const mine = new Set(artsFor(el).map((a) => a.id));
  const learned = Array.isArray(r.learned) ? r.learned.filter((id) => mine.has(id)) : [];
  const quests: Record<string, QuestState> = {};
  for (const [id, q] of Object.entries(r.quests ?? {})) {
    const art = artById(id);
    if (!art || !mine.has(id) || learned.includes(id)) continue;
    const step = Math.max(0, Math.min(art.steps.length - 1, Math.floor(Number(q?.step) || 0)));
    quests[id] = { step, count: Math.max(0, Number(q?.count) || 0), done: Array.isArray(q?.done) ? q.done.map(String) : [] };
  }
  const equipped = r.equipped && learned.includes(r.equipped) && artById(r.equipped)?.ability ? r.equipped : null;
  return { learned, equipped, quests, bounty: !!r.bounty };
}

/** The equipped art's ability, if any. */
export function equippedAbility(arts: ArtsState): AbilityDef | null {
  return artById(arts.equipped)?.ability ?? null;
}

export function hasGlider(arts: ArtsState): boolean {
  return arts.learned.includes('glider');
}

/** What the player and the authority need to know after a quest event. */
export interface QuestNews {
  /** the master's spoken line (talk) */
  line?: string;
  /** a short note for the HUD */
  notice?: string;
  learned?: string;
  /** faction rank lost (forbidden art) */
  rankLoss?: number;
}

export interface QuestPlayer {
  entity: SimEntity;
  progress: Progress;
  /** seconds this player has stood still */
  still: number;
}

/**
 * Quest progress for the Special Arts. The host calls talk() when a player
 * speaks to a master, onKill() for their kills and tick() once a second.
 */
export class QuestRules {
  /** Passive arts (Glider) unlock at their level with no quest. */
  checkPassive(p: QuestPlayer): QuestNews | null {
    for (const art of artsFor(p.entity.element)) {
      if (!art.passive || p.progress.arts.learned.includes(art.id) || p.progress.level < art.level) continue;
      p.progress.arts.learned.push(art.id);
      return { notice: `You can now use ${art.name}: ${art.text}`, learned: art.id };
    }
    return null;
  }

  talk(p: QuestPlayer, artId: string, night: number): QuestNews {
    const art = artById(artId);
    const a = p.progress.arts;
    if (!art || !art.master) return { line: '…' };
    const L = art.lines!;
    if (art.element !== 'any' && art.element !== p.entity.element) return { line: `You are no ${art.element}bender. My art is not for you.` };
    if (a.learned.includes(art.id)) return { line: L.done };
    if (p.progress.level < art.level) return { line: `${L.offer} Return when you have reached level ${art.level}.` };
    const q = a.quests[art.id];
    if (!q) {
      if (art.steps[0]?.night && night < NIGHT_THRESHOLD) return { line: L.day ?? 'Come back at night.' };
      a.quests[art.id] = { step: 1, count: 0, done: [] };
      return { line: `${L.offer} ${L.progress}`, notice: `Quest started: ${art.name}. ${art.steps[1]?.text ?? ''}` };
    }
    const step = art.steps[q.step];
    if (step?.type !== 'talk') return { line: L.progress };
    if (step.night && night < NIGHT_THRESHOLD) return { line: L.day ?? 'Come back at night.' };
    return this.advance(p, art, q);
  }

  onKill(p: QuestPlayer, victim: SimEntity, night: number): QuestNews[] {
    const out: QuestNews[] = [];
    for (const [id, q] of Object.entries(p.progress.arts.quests)) {
      const art = artById(id);
      const step = art?.steps[q.step];
      if (!art || step?.type !== 'kill') continue;
      if (step.night && night < NIGHT_THRESHOLD) continue;
      if (step.zone && zoneAt(victim.pos.x, victim.pos.z).kind !== step.zone) continue;
      const f = step.filter ?? 'enemy';
      if (victim.kind === 'dummy') continue;
      if (f === 'fighter' && !(victim.kind === 'npc' && victim.role === 'fighter')) continue;
      if (f === 'player' && victim.kind !== 'player') continue;
      q.count++;
      if (q.count >= (step.count ?? 1)) out.push(this.advance(p, art, q));
      else out.push({ notice: `${art.name}: ${step.text} (${q.count}/${step.count})` });
    }
    return out;
  }

  /** Once a second: visits and meditation. */
  tick(p: QuestPlayer, night: number): QuestNews[] {
    const out: QuestNews[] = [];
    const e = p.entity;
    for (const [id, q] of Object.entries(p.progress.arts.quests)) {
      const art = artById(id);
      const step = art?.steps[q.step];
      if (!art || !step || (step.type !== 'visit' && step.type !== 'meditate')) continue;
      if (step.night && night < NIGHT_THRESHOLD) continue;
      const here = step.points?.find((pt) => !q.done.includes(pt.label) && Math.hypot(e.pos.x - pt.x, e.pos.z - pt.z) <= (step.radius ?? 10));
      if (!here) {
        if (step.type === 'meditate') q.count = 0;
        continue;
      }
      if (step.type === 'meditate') {
        if (p.still < 1) {
          q.count = 0;
          continue;
        }
        q.count++;
        if (q.count < (step.seconds ?? 10)) {
          if (q.count === 1 || q.count % 5 === 0) out.push({ notice: `Meditating at ${here.label}… ${q.count}/${step.seconds} s (stand still)` });
          continue;
        }
        q.count = 0;
      }
      q.done.push(here.label);
      const total = step.points?.length ?? 1;
      if (q.done.length >= total) out.push(this.advance(p, art, q));
      else out.push({ notice: `${art.name}: ${here.label} (${q.done.length}/${total})` });
    }
    return out;
  }

  private advance(p: QuestPlayer, art: ArtDef, q: QuestState): QuestNews {
    q.step++;
    q.count = 0;
    q.done = [];
    if (q.step < art.steps.length) return { notice: `${art.name}: ${art.steps[q.step].text ?? 'Next step'}` };
    // Quest complete: learn the art.
    const a = p.progress.arts;
    delete a.quests[art.id];
    a.learned.push(art.id);
    if (!a.equipped && art.ability) a.equipped = art.id;
    const news: QuestNews = { line: art.lines?.done, notice: `You learned ${art.name}! Press T to use it (J for your arts).`, learned: art.id };
    const pen = art.penalty;
    if (pen && p.entity.side === pen.side && !pen.exempt.includes(p.entity.faction)) {
      news.rankLoss = pen.rank;
      if (pen.bounty) a.bounty = true;
      news.notice += ` Your faction frowns on it: -${pen.rank} faction rank${pen.bounty ? ', and there is a bounty on you' : ''}.`;
    }
    return news;
  }
}

/** Quest text for the arts panel: current step and its progress. */
export function questStatus(art: ArtDef, arts: ArtsState, level: number): string {
  if (arts.learned.includes(art.id)) return 'Learned';
  if (art.passive) return level >= art.level ? 'Learned' : `Unlocks at level ${art.level}`;
  const q = arts.quests[art.id];
  if (!q) return level >= art.level ? `Find ${art.master?.name}` : `Requires level ${art.level}`;
  const step = art.steps[q.step];
  if (!step) return '';
  if (step.type === 'kill') return `${step.text} (${q.count}/${step.count})`;
  if (step.type === 'visit' || step.type === 'meditate') {
    const left = step.points?.filter((pt) => !q.done.includes(pt.label)).map((pt) => pt.label).join(', ');
    return `${step.text} (${q.done.length}/${step.points?.length}) · left: ${left}`;
  }
  return step.text ?? `Talk to ${art.master?.name}`;
}

/** Next place to go for this quest (for the compass), if any. */
export function questTarget(art: ArtDef, arts: ArtsState): QuestPoint | null {
  const q = arts.quests[art.id];
  if (!art.master) return null;
  if (!q) return { label: art.master.name, x: art.master.x, z: art.master.z };
  const step = art.steps[q.step];
  if (!step || step.type === 'talk') return { label: art.master.name, x: art.master.x, z: art.master.z };
  if (step.points) return step.points.find((pt) => !q.done.includes(pt.label)) ?? null;
  return null;
}

