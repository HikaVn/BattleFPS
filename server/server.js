// BattleFPS Node server: static file hosting + WebSocket transport.
//
// All gameplay logic lives in public/js/game-core.js (GameRoom), shared with
// the browser-hosted WebRTC mode used for the GitHub Pages deployment. This
// file only bridges WebSocket connections to a GameRoom.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { GameRoom, sanitizeName } from '../public/js/game-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Rooms + WebSocket transport
// ---------------------------------------------------------------------------
/** @type {Map<string, GameRoom>} */
const rooms = new Map();
const sockets = new Map(); // playerId -> ws
let nextPlayerId = 1;

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// A transport bound to one room: knows how to reach that room's players.
function makeTransport(room) {
  return {
    broadcast(obj, exceptId = null) {
      const data = JSON.stringify(obj);
      for (const id of room.players.keys()) {
        if (id === exceptId) continue;
        const ws = sockets.get(id);
        if (ws && ws.readyState === ws.OPEN) ws.send(data);
      }
    },
    sendTo(id, obj) {
      const ws = sockets.get(id);
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    },
  };
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const playerId = String(nextPlayerId++);
  sockets.set(playerId, ws);
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.t === 'create') {
      const code = makeRoomCode();
      room = new GameRoom(code, null);
      room.transport = makeTransport(room);
      rooms.set(code, room);
      room.addPlayer(playerId, sanitizeName(msg.name));
      return;
    }
    if (msg.t === 'join') {
      const code = (msg.room || '').toUpperCase().trim();
      const target = rooms.get(code);
      if (!target) { ws.send(JSON.stringify({ t: 'error', msg: 'ルームが見つかりません: ' + code })); return; }
      if (target.phase === 'playing') { ws.send(JSON.stringify({ t: 'error', msg: 'ゲームは既に進行中です' })); return; }
      room = target;
      room.addPlayer(playerId, sanitizeName(msg.name));
      return;
    }
    if (room) room.handleMessage(playerId, msg);
  });

  ws.on('close', () => {
    sockets.delete(playerId);
    if (room) {
      room.removePlayer(playerId);
      if (room.isEmpty()) rooms.delete(room.code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`BattleFPS server running on http://localhost:${PORT}`);
});
