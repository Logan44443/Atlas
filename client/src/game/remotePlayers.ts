import type * as THREE from 'three/webgpu';
import type { SimEntity } from '@shared/sim/combatSim';
import { Avatar, type Element } from './avatar';
import { Nameplate } from './nameplate';
import type { CombatView } from './combat/combatView';
import { factionById } from '@shared/factions';

/** Nameplate text + colour: NPCs show their title in faction colours, PvP-flagged players glow red. */
function plateFor(e: SimEntity): { text: string; color: string } {
  if (e.kind === 'npc') return { text: `${e.name} · ${e.title ?? ''}`, color: factionById(e.faction)?.color ?? '#ffe6a0' };
  return { text: e.name, color: e.pvp ? '#ff9a7a' : '#ffffff' };
}

interface RemoteView {
  avatar: Avatar;
  plate: Nameplate;
  element: string;
  plateKey: string;
  last: THREE.Vector3;
  speed: number;
  vy: number;
}

/** Avatars + nameplates for other players and NPC members. */
export class RemotePlayers {
  private views = new Map<string, RemoteView>();

  constructor(private scene: THREE.Scene, private combatView: CombatView) {}

  get count(): number {
    return this.views.size;
  }

  update(dt: number, entities: Map<string, SimEntity>, myId: string): void {
    for (const e of entities.values()) {
      if ((e.kind !== 'player' && e.kind !== 'npc') || e.id === myId) continue;
      let v = this.views.get(e.id);
      const el = e.element ?? 'fire';
      if (v && v.element !== el) {
        this.drop(e.id);
        v = undefined;
      }
      if (!v) {
        const avatar = new Avatar(el as Element);
        const pl = plateFor(e);
        const plate = new Nameplate(pl.text, pl.color);
        avatar.root.add(plate.sprite);
        avatar.root.position.copy(e.pos);
        avatar.root.name = `remote ${e.name}`;
        this.scene.add(avatar.root);
        v = { avatar, plate, element: el, plateKey: pl.text + pl.color, last: e.pos.clone(), speed: 0, vy: 0 };
        this.views.set(e.id, v);
      }
      const pl = plateFor(e);
      if (v.plateKey !== pl.text + pl.color) {
        v.plateKey = pl.text + pl.color;
        v.plate.set(pl.text, pl.color);
      }
      // Speed for the walk cycle comes from how far the interpolated body moved.
      const dx = e.pos.x - v.last.x;
      const dz = e.pos.z - v.last.z;
      if (dt > 0) {
        v.speed += (Math.hypot(dx, dz) / dt - v.speed) * Math.min(1, dt * 10);
        v.vy = (e.pos.y - v.last.y) / dt;
      }
      v.last.copy(e.pos);
      v.avatar.root.position.copy(e.pos);
      v.avatar.root.rotation.y = e.yaw;
      v.avatar.root.rotation.z = e.dead ? Math.PI / 2 : 0;
      const g = this.combatView.gesture(e.id);
      v.avatar.update(dt, { speed: v.speed, grounded: Math.abs(v.vy) < 2, vy: v.vy, dodge: 0, swimming: false, blocking: e.blocking, cast: g.cast, castStyle: g.castStyle });
    }
    for (const id of [...this.views.keys()]) {
      const e = entities.get(id);
      if (!e || (e.kind !== 'player' && e.kind !== 'npc') || e.id === myId) this.drop(id);
    }
  }

  private drop(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    v.avatar.root.removeFromParent();
    this.views.delete(id);
  }
}
