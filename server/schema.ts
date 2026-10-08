// Replicated shard state. Entities are filtered per client with StateView
// (interest management), so each client only receives what is near it.
import { schema, type SchemaType } from '@colyseus/schema';

export const EntityState = schema(
  {
    id: 'string',
    name: 'string',
    kind: 'string',
    team: 'string',
    el: 'string',
    lv: 'uint8',
    x: 'float32',
    y: 'float32',
    z: 'float32',
    yaw: 'float32',
    hp: 'uint16',
    maxHp: 'uint16',
    chi: 'uint8',
    maxChi: 'uint8',
    dead: 'boolean',
    blk: 'boolean',
    /** comma-separated active statuses */
    st: 'string',
    slow: 'float32',
    sh: 'boolean',
    /** attack wind-up 0..1 (dummies) */
    wu: 'float32',
    pvp: 'boolean',
    fac: 'string',
    role: 'string',
    title: 'string',
  },
  'EntityState',
);
export type EntityState = SchemaType<typeof EntityState>;

export const WorldState = schema(
  {
    shard: 'string',
    entities: { map: EntityState, view: true },
  },
  'WorldState',
);
export type WorldState = SchemaType<typeof WorldState>;
