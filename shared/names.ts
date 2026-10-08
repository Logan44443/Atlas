// Name rules shared by the settings menu, character creation and the server.
import characterData from '../data/character.json';

export function validateName(name: string): string | null {
  const n = name.trim();
  if (n.length < characterData.nameMinLength) return `At least ${characterData.nameMinLength} characters`;
  if (n.length > characterData.nameMaxLength) return `At most ${characterData.nameMaxLength} characters`;
  if (!/^[A-Za-z0-9 _'-]+$/.test(n)) return "Letters, numbers, spaces, _ ' and - only";
  if (/\s{2,}/.test(n)) return 'No double spaces';
  return null;
}

export function validateUsername(u: string): string | null {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return 'Username: 3-20 letters, numbers or _';
  return null;
}

export function validatePassword(p: string): string | null {
  if (typeof p !== 'string' || p.length < 8) return 'Password: at least 8 characters';
  if (p.length > 200) return 'Password is too long';
  return null;
}

export function randomName(): string {
  const a = ['Swift', 'Quiet', 'Ember', 'Stone', 'Tide', 'Gale', 'Bright', 'Ashen', 'Jade', 'Iron'];
  const b = ['Crane', 'Fox', 'Lotus', 'Badger', 'Heron', 'Tiger', 'Otter', 'Moth', 'Ox', 'Lynx'];
  return `${a[Math.floor(Math.random() * a.length)]}${b[Math.floor(Math.random() * b.length)]}`;
}
