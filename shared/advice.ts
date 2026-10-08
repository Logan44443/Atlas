// Hub NPCs give advice that fits the player in front of them: where to hunt
// at their level, what their element is good at right now, unspent mastery
// points, the next Special Art, bosses rising, pets, camps and PvP rules.
// Pure function of state every client already has, so it runs in the browser.
import { artsFor, questStatus } from './arts';
import { BAG_CAP, invTotal, raidOpen, raidText } from './building';
import { PVP, factionById } from './factions';
import { pointsEarned, pointsSpent, LANDMARKS, type Progress } from './progression';
import { BOSSES, SPECIES, theName, bossWindow, bossNextMinutes, densNear, directions, speciesById } from './sim/wildlife';
import { PET_DEFS, PET_RULES, fedNow } from './pets';
import type { SimEntity } from './sim/combatSim';
import type { ElementId } from './combat';

export interface AdviceInput {
  role: string;
  me: SimEntity;
  progress: Progress;
  /** wall clock ms (world clock) */
  now: number;
  /** 0 day .. 1 night */
  night: number;
  /** pick among several useful lines (rotates on each talk) */
  seed: number;
}

const ELEMENT_TIPS: Record<ElementId, string[]> = {
  fire: [
    'Fire burns brightest at noon and weakest at night. Pick your fights in daylight.',
    "Fire breaks Air's barriers. Save your heavy for when they raise a shield.",
    'Your burns keep ticking: hit, step back, and let the fire do the work.',
  ],
  water: [
    'Water is strongest at night, and stronger still under a full moon or near the sea.',
    'Your control slows. Slow them first, then land the heavy.',
    'Water beats Fire. Fire benders fear you after dark.',
  ],
  earth: [
    'Earth needs solid ground under your feet. Never bend mid-jump.',
    'Standing on rock makes your stone hit harder. Fight on the mountainside.',
    "Your walls stop projectiles. Raise one when an archer-type bender won't let up.",
  ],
  air: [
    "Air outmanoeuvres Earth. Keep moving and they can't pin you down.",
    'Your mobility is your armour: dodge through attacks, then strike from the side.',
    'Gusts knock people off ledges. Fight near edges and let gravity help.',
  ],
};

const pick = <T>(list: T[], seed: number): T => list[Math.abs(Math.floor(seed)) % list.length];

/** Den closest to the player's level within a few hundred metres. */
function huntingGround(me: SimEntity, level: number): string | null {
  const dens = densNear(me.pos.x, me.pos.z, 700).filter((d) => d.level <= level + 3);
  if (!dens.length) return null;
  dens.sort((a, b) => Math.abs(a.level - level) * 40 + Math.hypot(a.x - me.pos.x, a.z - me.pos.z) / 20 - (Math.abs(b.level - level) * 40 + Math.hypot(b.x - me.pos.x, b.z - me.pos.z) / 20));
  const d = dens[0];
  const sp = speciesById(d.species)!;
  return `${sp.name}s around level ${d.level} roam ${directions(me.pos.x, me.pos.z, d.x, d.z)}. Good hunting for you.`;
}

function bossNews(me: SimEntity, now: number, night: number): string | null {
  const up = BOSSES.filter((b) => b.tier !== 'mini' && bossWindow(b, now, night) >= 0);
  if (up.length) {
    const b = up[0];
    return `${theName(b, true)} is awake right now, ${directions(me.pos.x, me.pos.z, b.x, b.z)}. Bring friends: it grows stronger with every challenger.`;
  }
  const next = BOSSES.filter((b) => b.tier !== 'mini').map((b) => ({ b, m: bossNextMinutes(b, now) })).sort((a, c) => a.m - c.m)[0];
  if (!next) return null;
  const when = next.m >= 60 ? `${Math.round(next.m / 60)} h` : `${next.m} min`;
  return `Word is ${theName(next.b)} stirs in about ${when}, ${directions(me.pos.x, me.pos.z, next.b.x, next.b.z)}.`;
}

/** One useful line for this NPC role and this player. */
export function adviceFor(a: AdviceInput): string {
  const { me, progress: p, seed } = a;
  const el = me.element;
  const lines: string[] = [];
  switch (a.role) {
    case 'trainer': {
      const free = pointsEarned(p.level) - pointsSpent(p.mastery);
      if (free > 0) lines.push(`You have ${free} unspent mastery point${free > 1 ? 's' : ''}. Press K and put them to use before your next fight.`);
      if (el) {
        if (el === 'fire' && a.night > 0.5) lines.push("Night has fallen and your fire is weaker. Train now, hunt at sunrise.");
        if (el === 'water' && a.night > 0.5) lines.push('The night is yours, waterbender. Your bending is at its strongest now.');
        lines.push(pick(ELEMENT_TIPS[el], seed));
      }
      const nextArt = artsFor(el).filter((x) => !p.arts.learned.includes(x.id)).sort((x, y) => x.level - y.level)[0];
      if (nextArt) {
        if (nextArt.level > p.level) lines.push(`At level ${nextArt.level} you can learn ${nextArt.name}. ${nextArt.master ? `${nextArt.master.name} teaches it, ${directions(me.pos.x, me.pos.z, nextArt.master.x, nextArt.master.z)}.` : ''}`);
        else lines.push(`${nextArt.name}: ${questStatus(nextArt, p.arts, p.level)}${nextArt.master ? ` Find ${nextArt.master.name} ${directions(me.pos.x, me.pos.z, nextArt.master.x, nextArt.master.z)}.` : ''}`);
      }
      lines.push('Hold block just as a hit lands for a perfect block: it staggers melee attackers and throws projectiles back.');
      break;
    }
    case 'quest': {
      const hunt = huntingGround(me, p.level);
      if (hunt) lines.push(hunt);
      const boss = bossNews(me, a.now, a.night);
      if (boss) lines.push(boss);
      const unseen = LANDMARKS.filter((l) => !p.discovered.includes(l.id)).sort((x, y) => Math.hypot(x.x - me.pos.x, x.z - me.pos.z) - Math.hypot(y.x - me.pos.x, y.z - me.pos.z))[0];
      if (unseen) lines.push(`You've never seen ${unseen.name}. It's ${directions(me.pos.x, me.pos.z, unseen.x, unseen.z)}, and the first visit is worth ${unseen.xp} XP.`);
      if (p.level < 5) lines.push('New out here? Train on the dummies by the spawn, then hunt Hop-hares and Fox-hounds outside the walls.');
      break;
    }
    case 'vendor': {
      const n = invTotal(p.inv);
      if (n > BAG_CAP * 0.8) lines.push(`Your bag is nearly full (${n}/${BAG_CAP}). Build a chest at your camp (B) to store more.`);
      if (!(p.inv.berries || p.inv.meat)) lines.push('Carry food. Fallen timber gives berries and hunting gives meat; pets eat both, and wild ones can be tamed with them.');
      if ((p.inv.ore ?? 0) > 0 && !(p.inv.refined_ore ?? 0)) lines.push('Raw ore is worth more refined. A firebender channelling (C) by a hot spring or ash pile turns it into refined ore.');
      if ((p.inv.hide ?? 0) + (p.inv.fang ?? 0) > 0) lines.push('Hides and fangs from the wild will be wanted when the caravans return. Hold on to them.');
      lines.push('Camps go up only in the Wilds. Start with a campfire: it becomes your respawn point.');
      lines.push('Water and Fire benders channelling together make steam cores; Earth and Water make mud for strong walls.');
      break;
    }
    case 'guard': {
      lines.push(`Inside these walls no one can hurt you. Out in the Wilds, PvP needs both sides flagged (P, from level ${PVP.flagMinLevel}). The shrines are always open war.`);
      lines.push(raidOpen(a.now) ? 'The raid window is open right now. Guard your camp or hit theirs.' : `Camps are safe for now. ${raidText(a.now)}`);
      const f = factionById(me.faction);
      if (f) lines.push(`Remember your oath to the ${f.name}: ${f.perk.text}.`);
      break;
    }
    case 'fighter': {
      const near = densNear(me.pos.x, me.pos.z, 300).map((d) => ({ d, sp: speciesById(d.species)! })).filter((x) => x.sp.temper === 'aggressive');
      if (near.length) {
        const x = near[0];
        lines.push(`${x.sp.name}s hunt ${directions(me.pos.x, me.pos.z, x.d.x, x.d.z)}, around level ${x.d.level}. They'll come for you on sight.`);
      }
      lines.push('Wolves run in packs. Fight with your back to a tree so they come at you one at a time.');
      lines.push('Bears and boars wind up before they hit. Watch for the glow and dodge (V) through it.');
      break;
    }
    case 'beast': {
      const st = p.pets;
      const active = st.owned.find((x) => x.uid === st.active);
      if (active) {
        const fed = fedNow(active, a.now);
        if (fed < PET_RULES.hungry) lines.push(`${active.name} is starving. Feed it from the pets panel (O) or it will fight half-hearted and refuse to carry you.`);
        else lines.push(`${active.name} looks well. Pets level with you; keep it fed and it will keep up.`);
      } else if (st.owned.length) lines.push('Your pets are resting in the stable. Call one out from the pets panel (O).');
      const tameable = SPECIES.filter((s) => s.tame);
      lines.push(`To tame a ${pick(tameable, seed).name}, walk up to one with berries or meat and press G, then win its trust.`);
      const mounts = PET_DEFS.filter((d) => d.mount && st.owned.some((o) => o.kind === d.id));
      if (mounts.length) lines.push(`Your ${mounts[0].name} can carry you: press H with it out to ride.`);
      break;
    }
    default:
      lines.push('Keep your eyes open out there.');
  }
  if (!lines.length) lines.push('Stay sharp out there.');
  return pick(lines, seed);
}

/** Masters are handled by quests; everything else gets advice. */
export const givesAdvice = (role: string | undefined): boolean => !!role && role !== 'master';

