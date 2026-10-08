// What a character stores about pets (kept apart from shared/pets.ts so
// progression.ts can use it without importing the pet runtime).

export interface OwnedPet {
  /** unique per character */
  uid: string;
  kind: string;
  name: string;
  /** 0..100 at fedAt (ms wall time) */
  fed: number;
  fedAt: number;
}

export interface PetsState {
  owned: OwnedPet[];
  /** uid of the pet out with you, null = all in the stable */
  active: string | null;
  /** rare pet quests: pet id -> 'started' */
  quests: Record<string, string>;
  /** failed Bond Trial rolls per legendary boss (bad-luck protection) */
  pity: Record<string, number>;
}

export const newPetsState = (): PetsState => ({ owned: [], active: null, quests: {}, pity: {} });
