// Bending crafting (Phase 9, DESIGN section 10a): gather by hand, channel (C)
// near a resource node or together with a partner of another element, and
// forge metal at a camp forge. Pure rules for the server and offline play.
import comboData from '../data/crafting/combos.json';
import matData from '../data/crafting/materials.json';
import type { ElementId } from './combat';
import type { SimEntity } from './sim/combatSim';
import { NODE_DEFS, nearestNode, nodeById, type NodeType } from './resources';
import { giveItems, hasItems, itemsText, materialName, shortfall, takeItems, type Camps, type Inventory } from './building';

export interface PartyRecipe {
  id: string;
  name: string;
  elements: [ElementId, ElementId];
  windowSeconds: number;
  rangeMeters: number;
  chiCost: number;
  cooldown: number;
  output: { material: string; qty: number };
  xp: number;
}
export interface EnvRecipe {
  id: string;
  name: string;
  element: ElementId;
  source: NodeType;
  chiCost: number;
  cooldown: number;
  output: { material: string; qty: number };
  xp: number;
}
export interface ForgeRecipe {
  id: string;
  name: string;
  inputs: Inventory;
  output: Inventory;
}

export const PARTY_RECIPES = comboData.party as PartyRecipe[];
export const ENV_RECIPES = comboData.environment as EnvRecipe[];
export const UPGRADES = comboData.upgrades;
export const FORGE_RECIPES = matData.forge as unknown as ForgeRecipe[];
export const SOURCE_RANGE = comboData.sourceRange;
export const FORGE_RANGE = matData.forgeRange;
export const GATHER_RANGE = 3.5;

/** A character that can craft: its sim entity, bag and learned Special Arts. */
export interface Crafter {
  entity: SimEntity;
  charId: string;
  inv: Inventory;
  arts: string[];
}

/** What the host should apply and announce. */
export interface Crafted {
  recipe: string;
  name: string;
  pos: [number, number, number];
  /** per crafter: what landed in their bag (may be less than made when the bag is full) */
  gains: Array<{ crafter: Crafter; items: Inventory; xp: number }>;
}

export type ChannelResult = { kind: 'crafted'; crafted: Crafted } | { kind: 'waiting'; text: string } | { kind: 'failed'; reason: string };

interface Pending {
  crafter: Crafter;
  t: number;
}

/** One per host. Remembers who is channelling and per-player cooldowns. */
export class CraftRules {
  private pending = new Map<string, Pending>();
  private ready = new Map<string, number>();

  private cooling(c: Crafter, recipe: string, time: number): number {
    return Math.max(0, (this.ready.get(`${c.charId}:${recipe}`) ?? 0) - time);
  }
  private cool(c: Crafter, recipe: string, seconds: number, time: number): void {
    this.ready.set(`${c.charId}:${recipe}`, time + seconds);
  }

  /**
   * Channel bending at `time` (sim seconds). Environment recipes need a node of
   * the right kind close by; party recipes need an ally of the other element
   * channelling within the window. `others` are crafters who may be partners.
   */
  channel(c: Crafter, others: Iterable<Crafter>, time: number): ChannelResult {
    const e = c.entity;
    if (e.dead || !e.element) return { kind: 'failed', reason: "You can't bend right now" };
    // 1. Environment: the nearest matching node within reach.
    let best: { r: EnvRecipe; d: number; node: { x: number; y: number; z: number } } | null = null;
    for (const r of ENV_RECIPES) {
      if (r.element !== e.element) continue;
      const n = nearestNode(e.pos.x, e.pos.z, SOURCE_RANGE, r.source);
      if (!n) continue;
      const d = Math.hypot(n.x - e.pos.x, n.z - e.pos.z);
      if (!best || d < best.d) best = { r, d, node: n };
    }
    if (best) {
      const { r, node } = best;
      const cd = this.cooling(c, r.id, time);
      if (cd > 0) return { kind: 'failed', reason: `${r.name}: ready in ${cd.toFixed(1)} s` };
      if (e.chi < r.chiCost) return { kind: 'failed', reason: `Not enough chi (${r.chiCost})` };
      e.chi -= r.chiCost;
      this.cool(c, r.id, r.cooldown, time);
      const items = giveItems(c.inv, { [r.output.material]: r.output.qty });
      return { kind: 'crafted', crafted: { recipe: r.id, name: r.name, pos: [node.x, node.y + 0.5, node.z], gains: [{ crafter: c, items, xp: r.xp }] } };
    }

    // 2. Party: an ally of the other element channelled within the window.
    for (const [id, p] of this.pending) {
      if (time - p.t > 3) this.pending.delete(id);
    }
    for (const o of others) {
      const p = this.pending.get(o.charId);
      const oe = o.entity;
      if (!p || o.charId === c.charId || oe.dead || !oe.element || oe.element === e.element) continue;
      if (!e.side || oe.side !== e.side) continue;
      const r = PARTY_RECIPES.find((x) => x.elements.includes(e.element!) && x.elements.includes(oe.element!));
      if (!r || time - p.t > r.windowSeconds || oe.pos.distanceTo(e.pos) > r.rangeMeters) continue;
      const cd = Math.max(this.cooling(c, r.id, time), this.cooling(o, r.id, time));
      if (cd > 0) return { kind: 'failed', reason: `${r.name}: ready in ${cd.toFixed(1)} s` };
      if (e.chi < r.chiCost || oe.chi < r.chiCost) return { kind: 'failed', reason: `Both of you need ${r.chiCost} chi` };
      e.chi -= r.chiCost;
      oe.chi -= r.chiCost;
      this.pending.delete(o.charId);
      this.cool(c, r.id, r.cooldown, time);
      this.cool(o, r.id, r.cooldown, time);
      // Special Arts upgrade the output (Lava: obsidian, Metal: steel).
      const up = UPGRADES.find((u) => u.recipe === r.id && (c.arts.includes(u.requiresArt) || o.arts.includes(u.requiresArt)));
      const out = up?.output ?? r.output;
      const name = up ? materialName(out.material) : r.name;
      const pos: [number, number, number] = [(e.pos.x + oe.pos.x) / 2, (e.pos.y + oe.pos.y) / 2 + 1.2, (e.pos.z + oe.pos.z) / 2];
      return {
        kind: 'crafted',
        crafted: {
          recipe: r.id, name, pos,
          gains: [c, o].map((who) => ({ crafter: who, items: giveItems(who.inv, { [out.material]: out.qty }), xp: r.xp })),
        },
      };
    }
    this.pending.set(c.charId, { crafter: c, t: time });
    const partners = PARTY_RECIPES.filter((r) => r.elements.includes(e.element!)).map((r) => r.elements.find((x) => x !== e.element)!);
    return { kind: 'waiting', text: `Channelling… an ally (${[...new Set(partners)].join('/')}) must channel with you, or stand by a resource node` };
  }

  /** Gather by hand from the nearest node (or `nodeId`). */
  gather(c: Crafter, nodeId: string | null, time: number): { items: Inventory; node: string; text: string } | string {
    const e = c.entity;
    const n = nodeId ? nodeById(nodeId) : nearestNode(e.pos.x, e.pos.z, GATHER_RANGE);
    if (!n || Math.hypot(n.x - e.pos.x, n.z - e.pos.z) > GATHER_RANGE + 0.5) return 'Nothing to gather here';
    const def = NODE_DEFS[n.type];
    if (!def.gather) {
      const r = ENV_RECIPES.find((x) => x.source === n.type);
      return r ? `${def.name}: channel (C) here as a ${r.element}bender to make ${r.name}` : def.name;
    }
    const key = `g:${n.id}`;
    const cd = this.cooling(c, key, time);
    if (cd > 0) return `${def.name} is spent: back in ${Math.ceil(cd)} s`;
    const items = giveItems(c.inv, def.gather);
    if (!Object.keys(items).length) return 'Your bag is full';
    this.cool(c, key, def.cooldown, time);
    return { items, node: n.id, text: `+${itemsText(items)}` };
  }

  /** Forge recipe at a forge of your side within range. */
  forge(c: Crafter, recipeId: string, camps: Camps): { items: Inventory; text: string } | string {
    const r = FORGE_RECIPES.find((x) => x.id === recipeId);
    if (!r) return 'Unknown recipe';
    const e = c.entity;
    if (!camps.effectNear(e.pos.x, e.pos.z, 'forge', FORGE_RANGE, (s) => s.side === e.side)) return 'Stand next to a forge';
    if (!hasItems(c.inv, r.inputs)) return `Needs ${shortfall(c.inv, r.inputs)} more`;
    takeItems(c.inv, r.inputs);
    const items = giveItems(c.inv, r.output);
    return { items, text: `Forged ${itemsText(items)}` };
  }
}
