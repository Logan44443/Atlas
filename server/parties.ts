// Parties of up to PROG.party.maxSize players on one shard (DESIGN section 9).
// Pure bookkeeping keyed by entity id; the room checks sides and range.
import { randomUUID } from 'node:crypto';
import { PROG } from '../shared/progression';

export interface Party {
  id: string;
  leader: string;
  members: string[];
}

export class Parties {
  private byMember = new Map<string, Party>();
  /** invitee -> pending invite */
  private invites = new Map<string, { from: string; expires: number }>();

  of(id: string): Party | null {
    return this.byMember.get(id) ?? null;
  }

  /** Party members including `id`, or just `id`. */
  membersOf(id: string): string[] {
    return this.byMember.get(id)?.members ?? [id];
  }

  pendingInvite(to: string, now: number): { from: string; expires: number } | null {
    const inv = this.invites.get(to);
    if (!inv || inv.expires < now) return null;
    return inv;
  }

  /** Returns an error message, or null when the invite was sent. */
  invite(from: string, to: string, now: number): string | null {
    if (from === to) return "You can't invite yourself";
    const mine = this.byMember.get(from);
    const theirs = this.byMember.get(to);
    if (theirs) return theirs === mine ? 'Already in your party' : 'They are already in a party';
    if (mine && mine.leader !== from) return 'Only the party leader can invite';
    if (mine && mine.members.length >= PROG.party.maxSize) return `Parties hold ${PROG.party.maxSize} players`;
    if (this.pendingInvite(to, now)) return 'They already have an invite pending';
    this.invites.set(to, { from, expires: now + PROG.party.inviteSeconds });
    return null;
  }

  decline(to: string): string | null {
    const inv = this.invites.get(to);
    this.invites.delete(to);
    return inv?.from ?? null;
  }

  /** Accept the pending invite. Returns the joined party or an error message. */
  accept(to: string, now: number): Party | string {
    const inv = this.pendingInvite(to, now);
    this.invites.delete(to);
    if (!inv) return 'That invite has expired';
    if (this.byMember.has(to)) return 'You are already in a party';
    let p = this.byMember.get(inv.from);
    if (!p) {
      p = { id: randomUUID().slice(0, 8), leader: inv.from, members: [inv.from] };
      this.byMember.set(inv.from, p);
    }
    if (p.members.length >= PROG.party.maxSize) return 'That party is full';
    p.members.push(to);
    this.byMember.set(to, p);
    return p;
  }

  /** Remove a member (leave, kick or disconnect). Returns the party as it is afterwards (members may be empty). */
  leave(id: string): Party | null {
    this.invites.delete(id);
    const p = this.byMember.get(id);
    if (!p) return null;
    this.byMember.delete(id);
    p.members = p.members.filter((m) => m !== id);
    if (p.leader === id && p.members.length) p.leader = p.members[0];
    // A party of one is no party.
    if (p.members.length === 1) {
      this.byMember.delete(p.members[0]);
      p.members = [];
    }
    return p;
  }
}
