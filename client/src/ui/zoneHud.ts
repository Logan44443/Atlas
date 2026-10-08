import { zoneAt, factionById, type Zone } from '@shared/factions';

/** Zone name at the top of the screen, a banner when you cross into a new zone, and short notices. */
export class ZoneHud {
  private tag = document.createElement('div');
  private banner = document.createElement('div');
  private notice = document.createElement('div');
  private current = '';
  private bannerT = 0;
  private noticeT = 0;
  pvp = false;

  constructor() {
    this.tag.className = 'zone-tag';
    this.banner.className = 'zone-banner hidden';
    this.notice.className = 'notice hidden';
    document.body.append(this.tag, this.banner, this.notice);
  }

  show(text: string, warn = false): void {
    this.notice.textContent = text;
    this.notice.className = `notice${warn ? ' warn' : ''}`;
    this.noticeT = 3;
  }

  private describe(z: Zone): { title: string; sub: string } {
    if (z.kind === 'safe') return { title: z.name, sub: `${factionById(z.faction)?.name ?? ''} hub · Safe zone, no PvP` };
    if (z.kind === 'contested') return { title: z.name, sub: 'Contested territory · PvP always on' };
    return { title: 'The Wilds', sub: this.pvp ? 'PvP flag up: flagged rivals can attack you' : 'PvE · raise your PvP flag to fight rivals' };
  }

  update(dt: number, x: number, z: number): void {
    const zone = zoneAt(x, z);
    const key = `${zone.kind}:${zone.name}:${this.pvp}`;
    if (key !== this.current) {
      const changedZone = this.current.split(':').slice(0, 2).join(':') !== `${zone.kind}:${zone.name}`;
      this.current = key;
      const d = this.describe(zone);
      this.tag.className = `zone-tag ${zone.kind}`;
      this.tag.textContent = `${d.title}${zone.kind === 'wilds' && this.pvp ? ' · PvP flagged' : ''}`;
      if (changedZone) {
        this.banner.innerHTML = `<b>${d.title}</b><span>${d.sub}</span>`;
        this.banner.className = 'zone-banner';
        this.bannerT = 3.5;
      }
    }
    if (this.bannerT > 0 && (this.bannerT -= dt) <= 0) this.banner.classList.add('hidden');
    if (this.noticeT > 0 && (this.noticeT -= dt) <= 0) this.notice.classList.add('hidden');
  }
}
