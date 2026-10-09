// Who is online in any shard of this process, so crew updates, faction and
// crew chat and whispers can reach players in other shards.
export interface OnlineEntry {
  charId: string;
  name: string;
  faction: string;
  side: string;
  room: string;
  /** deliver a message to this player's client */
  send: (type: string, msg: unknown) => void;
}

export const directory = new Map<string, OnlineEntry>();

export function sendTo(charId: string, type: string, msg: unknown): boolean {
  const e = directory.get(charId);
  e?.send(type, msg);
  return !!e;
}

export function byName(name: string): OnlineEntry | undefined {
  const n = name.trim().toLowerCase();
  for (const e of directory.values()) if (e.name.toLowerCase() === n) return e;
  return undefined;
}
