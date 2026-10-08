// Pure combat rules shared by client (prediction / offline play) and, from
// Phase 5, the authoritative server. No three.js, no DOM.
import progressionData from '../data/progression.json';

export type ElementId = 'fire' | 'water' | 'earth' | 'air';
export const ELEMENTS: ElementId[] = ['fire', 'water', 'earth', 'air'];
export type Slot = 'basic' | 'heavy' | 'mobility' | 'defense' | 'control' | 'ultimate';
export const SLOTS: Slot[] = ['basic', 'heavy', 'control', 'defense', 'mobility', 'ultimate'];
export type AbilityKind = 'projectile' | 'melee' | 'dash' | 'shield' | 'ring' | 'cone';
export type StatusType = 'burn' | 'slow' | 'root' | 'stagger' | 'blind';

export interface StatusDef {
  type: StatusType;
  duration: number;
  dps?: number;
  amount?: number;
}

export interface AbilityDef {
  slot: Slot;
  id: string;
  name: string;
  kind: AbilityKind;
  damage: number;
  chiCost: number;
  cooldown: number;
  range?: number;
  speed?: number;
  radius?: number;
  angle?: number;
  duration?: number;
  tick?: number;
  distance?: number;
  lift?: number;
  splash?: number;
  knockback?: number;
  pull?: number;
  windup?: number;
  combo?: number;
  comboBonus?: number;
  count?: number;
  spread?: number;
  gravity?: number;
  reduction?: number;
  blocksProjectiles?: boolean;
  reflects?: boolean;
  selfHeal?: number;
  /** synthetic ability for a party combo area (never chains another combo) */
  partyCombo?: boolean;
  status?: StatusDef;
  vfx: string;
  anim: string;
}

export interface ElementKit {
  element: ElementId;
  requiresGrounded?: boolean;
  abilities: AbilityDef[];
}

export interface CombatConfig {
  health: number;
  chi: { max: number; regenOutOfCombat: number; regenInCombat: number; combatTimeout: number };
  block: { damageTaken: number; perfectWindow: number; staggerSeconds: number; reflectSpeedScale: number; chiPerBlockedHit: number };
  dodgeInvulnerable: [number, number];
  targetAssist: { range: number; angleDegrees: number };
  elements: {
    fire: { dayBonus: number; noonBonus: number; nightPenalty: number };
    water: { nightBonus: number; fullMoonBonus: number; nearWaterBonus: number; nearWaterMeters: number };
    earth: { rockBonus: number; airborneDisabled: boolean };
  };
  matchups: Record<string, Record<string, number>>;
}

/** World/caster context that element bonuses depend on. */
export interface ElementContext {
  /** 0 day .. 1 full night */
  night: number;
  /** sun elevation: 1 = straight up (noon), <= 0 below horizon */
  sunHeight: number;
  /** 0 new .. 1 full */
  moonPhase: number;
  nearWater: boolean;
  onRock: boolean;
  grounded: boolean;
}

/** Outgoing power multiplier from element + environment (the "stronger at night/noon/on rock" rules). */
export function elementPower(cfg: CombatConfig, el: ElementId, ctx: ElementContext): number {
  let m = 1;
  if (el === 'fire') {
    const e = cfg.elements.fire;
    if (ctx.sunHeight > 0) m += e.dayBonus * Math.min(1, ctx.sunHeight * 2) + e.noonBonus * Math.max(0, (ctx.sunHeight - 0.8) / 0.2);
    else m -= e.nightPenalty * ctx.night;
  } else if (el === 'water') {
    const e = cfg.elements.water;
    m += e.nightBonus * ctx.night + e.fullMoonBonus * ctx.night * Math.max(0, (ctx.moonPhase - 0.85) / 0.15);
    if (ctx.nearWater) m += e.nearWaterBonus;
  } else if (el === 'earth') {
    if (ctx.onRock) m += cfg.elements.earth.rockBonus;
  }
  return m;
}

export function canBend(cfg: CombatConfig, kit: ElementKit, ctx: ElementContext): boolean {
  if (kit.element === 'earth' && cfg.elements.earth.airborneDisabled && !ctx.grounded) return false;
  return true;
}

export function matchup(cfg: CombatConfig, attacker: ElementId | null, defender: ElementId | null): number {
  if (!attacker || !defender) return 1;
  return cfg.matchups[attacker]?.[defender] ?? 1;
}

/** Level scaling from the design: +2% bending power per level above 1 (data/progression.json). */
export function levelPower(level: number): number {
  return 1 + progressionData.powerPerLevel * (level - 1);
}

export function chiRegen(cfg: CombatConfig, inCombat: boolean): number {
  return inCombat ? cfg.chi.regenInCombat : cfg.chi.regenOutOfCombat;
}
