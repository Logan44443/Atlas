// What the authority runs next to the sim for factions and territory (Phase 11):
// kill rewards (coins, rank points, bounties, faction orders), capture and
// war-end rewards, territory buffs and faction perks as entity boons, pet eggs
// for faction rank, and the Quartermaster's shop and fast travel. Shared by the
// shard server and offline play, so both hand out exactly the same things.
import shopData from '../data/shop.json';
import { CONTESTED, FACTIONS, factionById, perkOf, zoneAt } from './factions';
import { NO_BOON, type Boon, type SimEntity } from './sim/combatSim';
import type { Progress } from './progression';
import { giveItems, materialName, BAG_CAP, invTotal, takeItems, hasItems, type Inventory } from './building';
import {
  STANDING, addInfamy, addPoints, bossCoins, clearInfamy, creatureCoins, eggsOwed, infamyNow, payCoins, rankTitle, type OrderRules,
} from './standing';
import { TERR, type Territory, type WarPoint } from './territory';
import { PET_DEFS, PET_RULES, type PetRules } from './pets';

export const SHOP = shopData;

/** A player as these rules see them. */
export interface FactionPlayer {
  entity: SimEntity;
  progress: Progress;
}

/** What the host turns into XP, messages and progress updates. Coins and rank points are already applied. */
export type FactionNews =
  | { t: 'xp'; id: string; amount: number; reason: string }
  | { t: 'notice'; id: string; text: string; warn?: boolean }
  | { t: 'rank'; id: string; rank: number }
  | { t: 'progress'; id: string };

/** Rank points with a rank-up notice. */
function points(p: FactionPlayer, n: number, out: FactionNews[]): void {
  const up = addPoints(p.progress, n);
  if (up > 0) {
    out.push({ t: 'rank', id: p.entity.id, rank: p.progress.rank });
    out.push({ t: 'notice', id: p.entity.id, text: `Faction rank ${p.progress.rank}: ${rankTitle(p.progress.rank)}! Your faction panel (U) shows what it unlocks.` });
  }
}

const coins = (p: FactionPlayer, n: number): void => {
  p.progress.standing.coins += Math.max(0, Math.round(n));
};

/**
 * Someone was defeated by a player. `victimPlayer` is set for player kills,
 * `paid` = the kill gave the killer XP (repeat kills and spawn kills don't count).
 */
export function killRewards(victim: SimEntity, killer: FactionPlayer, victimPlayer: FactionPlayer | undefined, paid: boolean, now: number, orders: OrderRules): FactionNews[] {
  const out: FactionNews[] = [];
  const id = killer.entity.id;
  const enemy = !!victim.side && victim.side !== killer.entity.side;
  if (victim.kind === 'creature' && !victim.damagers) {
    const c = creatureCoins(victim.level);
    coins(killer, c);
    out.push({ t: 'notice', id, text: `+${c} coins` });
  } else if (victim.kind === 'npc' && enemy && victim.role !== 'master') {
    coins(killer, STANDING.coins.npc);
    points(killer, STANDING.points.npcKill, out);
    out.push({ t: 'notice', id, text: `+${STANDING.coins.npc} coins, +${STANDING.points.npcKill} rank points` });
  } else if (victim.kind === 'player' && enemy && paid) {
    points(killer, STANDING.points.pvpKill, out);
    // Outlaws who win fights earn a bounty on their own heads.
    if (killer.entity.side === 'outlaw') {
      const b = addInfamy(killer.progress.standing, STANDING.infamy.perKill, now);
      killer.entity.infamy = b;
      out.push({ t: 'notice', id, text: `Bounty on your head: ${b}`, warn: true });
    }
    // Order players collect an Outlaw's bounty.
    if (killer.entity.side === 'order' && victimPlayer) {
      const bounty = clearInfamy(victimPlayer.progress.standing, now);
      victimPlayer.entity.infamy = 0;
      if (bounty > 0) {
        coins(killer, bounty);
        killer.progress.standing.honor += bounty;
        points(killer, bounty * STANDING.points.bountyShare, out);
        out.push({ t: 'xp', id, amount: bounty * STANDING.infamy.xpPerBounty, reason: `collected ${victim.name}'s bounty` });
        out.push({ t: 'notice', id, text: `Bounty collected: +${bounty} coins` });
        out.push({ t: 'notice', id: victimPlayer.entity.id, text: `${killer.entity.name} collected your bounty of ${bounty}`, warn: true });
        out.push({ t: 'progress', id: victimPlayer.entity.id });
      }
    }
  }
  const note = orders.onKill(killer, { kind: victim.kind, side: victim.side, role: victim.role }, paid);
  if (note) out.push({ t: 'notice', id, text: note });
  out.push({ t: 'progress', id });
  return out;
}

/** Helped beat a boss: coins by tier and the faction order. */
export function bossRewards(p: FactionPlayer, tier: string, orders: OrderRules): FactionNews[] {
  const out: FactionNews[] = [];
  const c = bossCoins(tier);
  if (c > 0) {
    coins(p, c);
    out.push({ t: 'notice', id: p.entity.id, text: `+${c} coins` });
  }
  const note = orders.onBoss(p);
  if (note) out.push({ t: 'notice', id: p.entity.id, text: note });
  out.push({ t: 'progress', id: p.entity.id });
  return out;
}

/** Took part in capturing a point. */
export function captureRewards(p: FactionPlayer, pt: WarPoint, orders: OrderRules): FactionNews[] {
  const out: FactionNews[] = [];
  const id = p.entity.id;
  coins(p, pt.cfg.coins);
  points(p, pt.cfg.rankPoints, out);
  out.push({ t: 'xp', id, amount: pt.cfg.xpPerLevel * p.progress.level, reason: `captured ${pt.name}` });
  out.push({ t: 'notice', id, text: `+${pt.cfg.coins} coins, +${pt.cfg.rankPoints} rank points` });
  const note = orders.onCapture(p);
  if (note) out.push({ t: 'notice', id, text: note });
  out.push({ t: 'progress', id });
  return out;
}

/** The war ended: every member of a faction gets rank points for each point it still holds. */
export function heldRewards(p: FactionPlayer, held: number): FactionNews[] {
  if (held <= 0) return [];
  const out: FactionNews[] = [];
  const n = held * TERR.heldAtWarEndPoints;
  points(p, n, out);
  out.push({ t: 'notice', id: p.entity.id, text: `Your faction held ${held} point${held > 1 ? 's' : ''} through the war: +${n} rank points` });
  out.push({ t: 'progress', id: p.entity.id });
  return out;
}

/** Income from a held point paid straight to a player (no crew took it, or offline play). */
export function incomeRewards(p: FactionPlayer, pt: WarPoint, items: Inventory, coinsIn: number): FactionNews[] {
  coins(p, coinsIn);
  const got = giveItems(p.progress.inv, items);
  const what = [`${coinsIn} coins`, ...Object.entries(got).map(([k, n]) => `${n} ${materialName(k)}`)].join(', ');
  return [{ t: 'notice', id: p.entity.id, text: `${pt.name} pays its holders: ${what}` }, { t: 'progress', id: p.entity.id }];
}

// ---- buffs and perks ------------------------------------------------------------------

/** Spirit shrines a Lantern monk draws strength from. */
const nearShrine = (e: SimEntity, r: number) => CONTESTED.some((c) => Math.hypot(e.pos.x - c.x, e.pos.z - c.z) <= r);

/** The entity's boon: its faction's territory buffs plus the Lantern Order's shrine perk. */
export function boonFor(e: SimEntity, terr: Territory): Boon {
  if (e.kind !== 'player' || !e.faction) return NO_BOON;
  const b = terr.buffsFor(e.faction);
  const lantern = factionById(e.faction)?.perk;
  const sustain = lantern?.type === 'shrineSustain' && nearShrine(e, lantern.radius ?? 90) ? lantern.value : 0;
  if (!b.dmg && !b.regen && !b.armor && !sustain) return NO_BOON;
  return { dmg: b.dmg, regen: b.regen + sustain, heal: sustain, armor: b.armor };
}

/** XP multiplier from territory (each held point) and, for PvP kills, the Red Fang perk. */
export function xpScale(e: SimEntity, terr: Territory, pvp = false): number {
  return (1 + terr.buffsFor(e.faction).xp) * (pvp ? 1 + perkOf(e.faction, 'pvpXp') : 1);
}

/** Mount speed with the Free Isles League perk. */
export const mountScale = (faction: string): number => 1 + perkOf(faction, 'mountSpeed');

/** Keep the replicated bounty (nameplates, Sentinel perk) in step with real time. */
export function syncInfamy(p: FactionPlayer, now: number): void {
  p.entity.infamy = p.entity.side === 'outlaw' ? infamyNow(p.progress.standing, now) : 0;
}

// ---- pet eggs -------------------------------------------------------------------------

/** The Beastkeeper hands out eggs owed for faction rank: they hatch on the spot. Returns a line, or null. */
export function hatchEggs(p: FactionPlayer, pets: PetRules, now: number): string | null {
  const owed = eggsOwed(p.progress);
  if (!owed.length) return null;
  const st = p.progress.pets;
  if (st.owned.length >= PET_RULES.maxPets) return `Your faction rank earned you a pet egg, but your stable is full (${PET_RULES.maxPets} pets). Make room and come back.`;
  const egg = owed[0];
  const pool = PET_DEFS.filter((d) => d.tier === egg.tier);
  const fresh = pool.filter((d) => !st.owned.some((o) => o.kind === d.id));
  const pick = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))];
  if (!pick) return null;
  pets.addPet(p, pick, now);
  p.progress.standing.eggs.push(egg.rank);
  return `For reaching faction rank ${egg.rank}, an egg from our nests. It hatched in your hands: a ${pick.name}! Open the pets panel (O) to call it out.`;
}

// ---- shop and travel ----------------------------------------------------------------

export interface ShopItem {
  id: string;
  name: string;
  price: number;
  black?: boolean;
}

const blackMarketFor = (faction: string) => perkOf(faction, 'pvpXp') > 0;

/** What a Quartermaster offers this faction's members. */
export function shopItems(faction: string): ShopItem[] {
  const list: ShopItem[] = SHOP.sell.map((s) => ({ id: s.id, name: materialName(s.id), price: s.price }));
  if (blackMarketFor(faction)) list.push(...SHOP.blackMarket.map((s) => ({ id: s.id, name: materialName(s.id), price: s.price, black: true })));
  return list;
}

/** What a Quartermaster pays for one of these. */
export function sellPrice(id: string): number {
  const p = SHOP.sell.find((s) => s.id === id)?.price ?? SHOP.blackMarket.find((s) => s.id === id)?.price;
  return p ? Math.max(1, Math.floor(p * SHOP.buyBack)) : SHOP.junk;
}

export function buy(p: FactionPlayer, id: string, nIn: number): string {
  const item = shopItems(p.entity.faction).find((s) => s.id === id);
  if (!item) return "The Quartermaster doesn't sell that";
  const room = BAG_CAP - invTotal(p.progress.inv);
  const n = Math.min(Math.max(1, Math.floor(nIn) || 1), room);
  if (n <= 0) return 'Your bag is full';
  if (!payCoins(p.progress.standing, item.price * n)) return `${n} ${item.name} cost ${item.price * n} coins; you have ${p.progress.standing.coins}`;
  giveItems(p.progress.inv, { [id]: n });
  return `Bought ${n} ${item.name} for ${item.price * n} coins`;
}

export function sell(p: FactionPlayer, id: string, nIn: number): string {
  const n = Math.max(1, Math.floor(nIn) || 1);
  if (!hasItems(p.progress.inv, { [id]: n })) return "You don't carry that many";
  takeItems(p.progress.inv, { [id]: n });
  const got = sellPrice(id) * n;
  coins(p, got);
  return `Sold ${n} ${materialName(id)} for ${got} coins`;
}

/** Red Fang only: pay off your bounty. */
export function pardon(p: FactionPlayer, now: number): string {
  if (!blackMarketFor(p.entity.faction)) return 'Only the black market sells pardons';
  const b = infamyNow(p.progress.standing, now);
  if (b <= 0) return 'There is no bounty on your head';
  const cost = Math.ceil(b * SHOP.pardonPerInfamy);
  if (!payCoins(p.progress.standing, cost)) return `A pardon for a bounty of ${b} costs ${cost} coins`;
  clearInfamy(p.progress.standing, now);
  p.entity.infamy = 0;
  return `Your bounty of ${b} is wiped clean (${cost} coins)`;
}

export interface TravelSpot {
  id: string;
  name: string;
  x: number;
  z: number;
  cost: number;
}

/** Where a Quartermaster can send you: hubs of your side, your camp, your crew hall. */
export function travelSpots(e: SimEntity, camp: { x: number; z: number } | null, hall: { x: number; z: number; name: string } | null): TravelSpot[] {
  const cost = (x: number, z: number) => {
    const raw = SHOP.travel.base + (SHOP.travel.perKm * Math.hypot(x - e.pos.x, z - e.pos.z)) / 1000;
    const discount = factionById(e.faction)?.perk.travelDiscount ?? 0;
    return Math.max(1, Math.round(raw * (1 - discount)));
  };
  const out: TravelSpot[] = [];
  for (const f of FACTIONS) {
    if (f.side !== e.side || Math.hypot(f.hub.x - e.pos.x, f.hub.z - e.pos.z) < f.hub.safeRadius) continue;
    out.push({ id: `hub:${f.id}`, name: f.hub.name, x: f.hub.x, z: f.hub.z + 18, cost: cost(f.hub.x, f.hub.z) });
  }
  if (camp) out.push({ id: 'camp', name: 'Your camp', x: camp.x + 2.5, z: camp.z + 2.5, cost: cost(camp.x, camp.z) });
  if (hall) out.push({ id: 'hall', name: hall.name, x: hall.x, z: hall.z + 6, cost: cost(hall.x, hall.z) });
  return out;
}

/** Pay and go: returns where to put the player, or why not. */
export function travel(p: FactionPlayer, spot: TravelSpot | undefined, time: number, now: number): { x: number; z: number; text: string } | string {
  if (!spot) return "The Quartermaster can't send you there";
  const e = p.entity;
  if (e.dead) return 'Get back on your feet first';
  if (time - e.lastCombat < SHOP.travel.combatSeconds) return 'Not in the middle of a fight';
  if (infamyNow(p.progress.standing, now) > SHOP.travel.maxInfamy) return `No ship will take someone with a bounty over ${SHOP.travel.maxInfamy}`;
  if (zoneAt(e.pos.x, e.pos.z).kind !== 'safe') return 'Fast travel leaves from a hub';
  if (!payCoins(p.progress.standing, spot.cost)) return `Travel to ${spot.name} costs ${spot.cost} coins; you have ${p.progress.standing.coins}`;
  return { x: spot.x, z: spot.z, text: `Travelled to ${spot.name} (${spot.cost} coins)` };
}
