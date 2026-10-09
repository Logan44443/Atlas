// Crews (Phase 11, DESIGN section 9): guilds of one faction with roles, a
// shared bank, crew XP/levels and a base with its own raid window. Pure
// bookkeeping and rules; the shard server keeps one Crews for the process and
// persists it (server/crews.ts).
import crewsJson from '../data/crews.json';
import { factionById, sideOf } from './factions';
import { giveItems, hasItems, invTotal, sanitizeInv, takeItems, type Inventory } from './building';

export const CREW = crewsJson;
export type CrewRole = 'leader' | 'officer' | 'member';
const ROLE_RANK: Record<CrewRole, number> = { member: 0, officer: 1, leader: 2 };
export const roleAtLeast = (r: CrewRole, min: CrewRole): boolean => ROLE_RANK[r] >= ROLE_RANK[min];

export interface CrewMember {
  charId: string;
  name: string;
  role: CrewRole;
  joined: number;
  level: number;
  element: string;
}

export interface Crew {
  id: string;
  name: string;
  tag: string;
  faction: string;
  xp: number;
  bank: Inventory;
  coins: number;
  /** UTC hour the daily raid window opens, and when it was last changed (wall ms) */
  raidStart: number;
  raidChangedAt: number;
  motd: string;
  created: number;
  members: CrewMember[];
}

/** What a member's client sees (plus who is online). */
export interface CrewView extends Omit<Crew, 'members'> {
  level: number;
  /** crew XP at which the next level starts, or 0 at the top */
  nextXp: number;
  bankCap: number;
  maxPieces: number;
  members: Array<CrewMember & { online: boolean }>;
}

/** The parts of a crew saved as jsonb (name/tag/faction/members live in their own columns). */
export interface CrewData {
  xp: number;
  bank: Inventory;
  coins: number;
  raidStart: number;
  raidChangedAt: number;
  motd: string;
}

export const crewLevelOf = (xp: number): number => {
  let l = 1;
  for (let i = 1; i < CREW.levelXp.length; i++) if (xp >= CREW.levelXp[i]) l = i + 1;
  return l;
};
export const bankCap = (level: number): number => CREW.bank.base + CREW.bank.perLevel * (level - 1);
export const basePieces = (level: number): number => CREW.base.pieces + CREW.base.piecesPerLevel * (level - 1);

export function validCrewName(name: string): string | null {
  const n = name.trim();
  if (n.length < CREW.name.min || n.length > CREW.name.max) return `Crew names are ${CREW.name.min}-${CREW.name.max} characters`;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u.test(n)) return 'Letters, numbers, spaces, apostrophes and dashes only';
  return null;
}
export function validTag(tag: string): string | null {
  if (tag.length < CREW.tag.min || tag.length > CREW.tag.max) return `Tags are ${CREW.tag.min}-${CREW.tag.max} letters or digits`;
  if (!/^[A-Z0-9]+$/.test(tag)) return 'Tags are capital letters and digits';
  return null;
}
export const cleanTag = (raw: unknown): string => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CREW.tag.max);

/** Is the raid window of a crew starting at `start` (UTC hour) open at `ms`? */
export function crewRaidOpen(start: number, ms: number): boolean {
  const h = (ms / 3_600_000) % 24;
  return (h - start + 24) % 24 < CREW.raid.hours;
}

export function crewRaidText(start: number, ms: number): string {
  const h = (ms / 3_600_000) % 24;
  const into = (h - start + 24) % 24;
  const fmt = (hours: number) => `${Math.floor(hours)} h ${Math.floor((hours % 1) * 60)} m`;
  const hh = `${String(start).padStart(2, '0')}:00-${String((start + CREW.raid.hours) % 24).padStart(2, '0')}:00 UTC`;
  return into < CREW.raid.hours ? `Raid window open (${hh}, ${fmt(CREW.raid.hours - into)} left)` : `Raid window ${hh} (opens in ${fmt((start - h + 24) % 24)})`;
}

/** Someone joining or founding a crew. */
export interface CrewJoiner {
  charId: string;
  name: string;
  faction: string;
  level: number;
  element: string;
}

export interface CrewInvite {
  crew: string;
  from: string;
  fromName: string;
  expires: number;
}

let seq = 0;
const newId = () => {
  // A UUID so the crew can be a PostgreSQL row.
  const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  seq = (seq + 1) % 0xffff;
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(8)}${seq.toString(16).padStart(4, '0')}`;
};

export class Crews {
  readonly byId = new Map<string, Crew>();
  private byChar = new Map<string, Crew>();
  readonly invites = new Map<string, CrewInvite>();

  load(list: Crew[]): void {
    for (const c of list) this.put(c);
  }

  private put(c: Crew): void {
    this.byId.set(c.id, c);
    for (const m of c.members) this.byChar.set(m.charId, c);
  }

  of(charId: string): Crew | null {
    return this.byChar.get(charId) ?? null;
  }
  memberOf(charId: string): CrewMember | null {
    return this.byChar.get(charId)?.members.find((m) => m.charId === charId) ?? null;
  }
  levelOf(c: Crew): number {
    return crewLevelOf(c.xp);
  }

  view(c: Crew, online: (charId: string) => boolean): CrewView {
    const level = crewLevelOf(c.xp);
    return {
      ...c, level, nextXp: CREW.levelXp[level] ?? 0, bankCap: bankCap(level), maxPieces: basePieces(level),
      bank: { ...c.bank }, members: c.members.map((m) => ({ ...m, online: online(m.charId) })),
    };
  }

  /** Found a crew (the caller has checked level, rank and coins). Returns the crew or why not. */
  create(f: CrewJoiner, rawName: string, rawTag: string, now: number): Crew | string {
    const name = rawName.trim().replace(/\s+/g, ' ');
    const tag = cleanTag(rawTag);
    const err = validCrewName(name) ?? validTag(tag);
    if (err) return err;
    if (this.of(f.charId)) return 'Leave your crew first';
    if (!factionById(f.faction)) return 'No faction';
    for (const c of this.byId.values()) {
      if (c.name.toLowerCase() === name.toLowerCase()) return 'That crew name is taken';
      if (c.tag === tag) return 'That tag is taken';
    }
    const c: Crew = {
      id: newId(), name, tag, faction: f.faction, xp: 0, bank: {}, coins: 0, raidStart: CREW.raid.defaultStart, raidChangedAt: 0, motd: '', created: now,
      members: [{ charId: f.charId, name: f.name, role: 'leader', joined: now, level: f.level, element: f.element }],
    };
    this.invites.delete(f.charId);
    this.put(c);
    return c;
  }

  invite(fromChar: string, to: CrewJoiner, now: number): string | null {
    const c = this.of(fromChar);
    const me = this.memberOf(fromChar);
    if (!c || !me) return 'You are not in a crew';
    if (!roleAtLeast(me.role, 'officer')) return 'Only officers and the leader can invite';
    if (to.charId === fromChar) return "You can't invite yourself";
    if (this.of(to.charId)) return this.of(to.charId) === c ? 'Already in your crew' : 'They are already in a crew';
    if (to.faction !== c.faction) return `Crews are for one faction: ${factionById(c.faction)?.name ?? c.faction}`;
    if (c.members.length >= CREW.maxMembers) return `Crews hold ${CREW.maxMembers} members`;
    const pending = this.invites.get(to.charId);
    if (pending && pending.expires > now && pending.crew !== c.id) return 'They already have an invite pending';
    this.invites.set(to.charId, { crew: c.id, from: fromChar, fromName: me.name, expires: now + CREW.inviteSeconds * 1000 });
    return null;
  }

  pendingInvite(charId: string, now: number): CrewInvite | null {
    const inv = this.invites.get(charId);
    if (!inv || inv.expires < now || !this.byId.has(inv.crew)) return null;
    return inv;
  }

  accept(j: CrewJoiner, now: number): Crew | string {
    const inv = this.pendingInvite(j.charId, now);
    this.invites.delete(j.charId);
    if (!inv) return 'That invite has expired';
    if (this.of(j.charId)) return 'You are already in a crew';
    const c = this.byId.get(inv.crew)!;
    if (c.members.length >= CREW.maxMembers) return 'That crew is full';
    if (c.faction !== j.faction) return 'That crew is of another faction';
    c.members.push({ charId: j.charId, name: j.name, role: 'member', joined: now, level: j.level, element: j.element });
    this.byChar.set(j.charId, c);
    return c;
  }

  decline(charId: string): CrewInvite | null {
    const inv = this.invites.get(charId) ?? null;
    this.invites.delete(charId);
    return inv;
  }

  /** Leave (or be removed). The leader's crown passes on; the last one out disbands it. */
  remove(charId: string): { crew: Crew; disbanded: boolean } | null {
    const c = this.of(charId);
    if (!c) return null;
    const leaving = c.members.find((m) => m.charId === charId)!;
    c.members = c.members.filter((m) => m.charId !== charId);
    this.byChar.delete(charId);
    if (!c.members.length) {
      this.byId.delete(c.id);
      for (const [k, inv] of this.invites) if (inv.crew === c.id) this.invites.delete(k);
      return { crew: c, disbanded: true };
    }
    if (leaving.role === 'leader') {
      // The longest-serving officer, else the longest-serving member, takes over.
      const next = [...c.members].sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.joined - b.joined)[0];
      next.role = 'leader';
    }
    return { crew: c, disbanded: false };
  }

  kick(byChar: string, target: string): Crew | string {
    const c = this.of(byChar);
    const me = this.memberOf(byChar);
    const them = this.memberOf(target);
    if (!c || !me || !them || this.of(target) !== c) return 'They are not in your crew';
    if (target === byChar) return 'Use Leave to leave your crew';
    if (!roleAtLeast(me.role, 'officer') || ROLE_RANK[them.role] >= ROLE_RANK[me.role]) return "You can't remove them";
    this.remove(target);
    return c;
  }

  /** Change a member's role. Making someone leader hands over the crown. */
  setRole(byChar: string, target: string, role: CrewRole): string | null {
    const c = this.of(byChar);
    const me = this.memberOf(byChar);
    const them = this.memberOf(target);
    if (!c || !me || !them || this.of(target) !== c) return 'They are not in your crew';
    if (me.role !== 'leader') return 'Only the leader changes roles';
    if (target === byChar) return 'Pick someone else';
    if (!(role in ROLE_RANK)) return 'Unknown role';
    if (role === 'leader') me.role = 'officer';
    them.role = role;
    return null;
  }

  /** Crew XP from members' XP gains. Returns the new level when it went up. */
  addXp(c: Crew, amount: number): number | null {
    if (amount <= 0) return null;
    const before = crewLevelOf(c.xp);
    c.xp += Math.round(amount);
    const after = crewLevelOf(c.xp);
    return after > before ? after : null;
  }

  /** Move items between a member's bag and the bank (put = deposit). */
  bankMove(charId: string, bag: Inventory, items: Inventory, put: boolean): string | null {
    const c = this.of(charId);
    const me = this.memberOf(charId);
    if (!c || !me) return 'You are not in a crew';
    const want = sanitizeInv(items, 1e6);
    if (!invTotal(want)) return 'Nothing to move';
    if (!put && !roleAtLeast(me.role, CREW.withdraw as CrewRole)) return `Only ${CREW.withdraw}s and the leader can take from the bank`;
    const [from, to, cap] = put ? [bag, c.bank, bankCap(crewLevelOf(c.xp))] : [c.bank, bag, Infinity];
    if (!hasItems(from, want)) return put ? "You don't carry that much" : "The bank doesn't hold that much";
    takeItems(from, want);
    const moved = put ? giveItems(to, want, cap) : giveItems(to, want);
    const back: Inventory = {};
    for (const [k, n] of Object.entries(want)) if (n - (moved[k] ?? 0) > 0) back[k] = n - (moved[k] ?? 0);
    giveItems(from, back, 1e9);
    return invTotal(back) ? (put ? 'The bank is full' : 'Your bag is full') : null;
  }

  /** The leader moves the daily raid window (not while it is open, at most once per cooldown). */
  setRaid(charId: string, start: number, now: number): string | null {
    const c = this.of(charId);
    if (!c || this.memberOf(charId)?.role !== 'leader') return 'Only the crew leader sets the raid window';
    const h = Math.floor(start);
    if (!(h >= 0 && h < 24)) return 'Pick an hour from 0 to 23 (UTC)';
    if (h === c.raidStart) return null;
    if (crewRaidOpen(c.raidStart, now)) return 'Not while the raid window is open';
    const wait = c.raidChangedAt + CREW.raid.changeCooldownHours * 3_600_000 - now;
    if (wait > 0) return `You can move it again in ${Math.ceil(wait / 3_600_000)} h`;
    c.raidStart = h;
    c.raidChangedAt = now;
    return null;
  }

  /** A member's name or level changed. */
  touchMember(charId: string, patch: Partial<Pick<CrewMember, 'name' | 'level'>>): void {
    const m = this.memberOf(charId);
    if (m) Object.assign(m, patch);
  }

  side(c: Crew): string {
    return sideOf(c.faction) ?? '';
  }
}

export function crewData(c: Crew): CrewData {
  return { xp: c.xp, bank: c.bank, coins: c.coins, raidStart: c.raidStart, raidChangedAt: c.raidChangedAt, motd: c.motd };
}
