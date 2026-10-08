// Four Winds shard server: Colyseus over WebSocket plus a tiny HTTP API.
//   GET /health  -> ok
//   GET /shards  -> open world shards with player counts (for the join flow)
//   /api/*       -> accounts and characters (server/api.ts)
import http from 'node:http';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { NET, ROOM_NAME } from '../shared/net';
import { WorldRoom } from './worldRoom';
import { openStore } from './db/store';
import { createApi } from './api';
import { initCamps, flushCamps } from './camps';

const port = Number(process.env.PORT ?? NET.port);
const store = await openStore();
WorldRoom.store = store;
await initCamps(store);
const api = createApi(store);

const httpServer = http.createServer(async (req, res) => {
  if (await api(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.end('ok');
    return;
  }
  if (req.url === '/shards') {
    const rooms = await matchMaker.query({ name: ROOM_NAME });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(rooms.map((r) => ({ id: r.roomId, players: r.clients, max: r.maxClients, locked: r.locked }))));
    return;
  }
  res.statusCode = 404;
  res.end();
});

const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
// joinOrCreate fills a shard up to maxClients, then opens a new one.
gameServer.define(ROOM_NAME, WorldRoom);

await gameServer.listen(port);
console.log(`Four Winds shard server on :${port}`);
// Write pending camp changes before exiting (rooms have saved their players by then).
gameServer.onShutdown(() => flushCamps());
