// BattleFPS server: static file hosting + WebSocket room-based multiplayer.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

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
// Game / room state
// ---------------------------------------------------------------------------
const MAP_SIZE = 200;          // arena is MAP_SIZE x MAP_SIZE centred on origin
const TICK_RATE = 20;          // network state broadcasts per second
const MAX_HP = 100;
const RING_DAMAGE = 5;         // hp lost per tick while outside the ring

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

let nextPlayerId = 1;

function randomSpawn() {
  const r = MAP_SIZE * 0.42;
  return {
    x: (Math.random() * 2 - 1) * r,
    y: 1.6,
    z: (Math.random() * 2 - 1) * r,
  };
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player
    this.hostId = null;
    this.phase = 'lobby';     // 'lobby' | 'playing' | 'ended'
    this.ring = null;
    this.tickTimer = null;
    this.startTime = 0;
  }

  broadcast(obj, exceptId = null) {
    const msg = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue;
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
    }
  }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      hp: p.hp,
      alive: p.alive,
      kills: p.kills,
    }));
  }

  start() {
    if (this.phase === 'playing') return;
    this.phase = 'playing';
    this.startTime = Date.now();
    // Ring starts covering the whole map and shrinks toward a random point.
    const cx = (Math.random() * 2 - 1) * MAP_SIZE * 0.2;
    const cz = (Math.random() * 2 - 1) * MAP_SIZE * 0.2;
    this.ring = {
      x: cx,
      z: cz,
      radius: MAP_SIZE * 0.75,
      targetRadius: MAP_SIZE * 0.75,
      minRadius: 12,
      shrinkRate: 0,
      nextShrink: Date.now() + 15000,
    };
    for (const p of this.players.values()) {
      p.alive = true;
      p.hp = MAX_HP;
      p.kills = 0;
      p.pos = randomSpawn();
      p.rot = { x: 0, y: 0 };
      p.ws.send(JSON.stringify({ t: 'started', mapSize: MAP_SIZE, spawn: p.pos, ring: this.ring }));
    }
    this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  tick() {
    const now = Date.now();
    const ring = this.ring;
    if (ring) {
      // Periodically pick a new (smaller) target radius and shrink toward it.
      if (now >= ring.nextShrink && ring.targetRadius > ring.minRadius) {
        ring.targetRadius = Math.max(ring.minRadius, ring.targetRadius * 0.6);
        ring.shrinkRate = (ring.radius - ring.targetRadius) / (TICK_RATE * 12); // ~12s
        ring.nextShrink = now + 22000;
      }
      if (ring.radius > ring.targetRadius) {
        ring.radius = Math.max(ring.targetRadius, ring.radius - ring.shrinkRate);
      }
      // Damage players standing outside the ring.
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.pos.x - ring.x;
        const dz = p.pos.z - ring.z;
        if (Math.hypot(dx, dz) > ring.radius) {
          this.damagePlayer(p, RING_DAMAGE, null, 'ring');
        }
      }
    }

    // Broadcast world state.
    this.broadcast({
      t: 'state',
      ring: ring ? { x: ring.x, z: ring.z, radius: Math.round(ring.radius * 100) / 100 } : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        pos: p.pos,
        rot: p.rot,
        hp: p.hp,
        alive: p.alive,
        kills: p.kills,
        moving: p.moving,
      })),
    });

    // Check for a winner (last player standing) when 2+ joined.
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (this.phase === 'playing' && this.players.size >= 2 && alive.length <= 1) {
      this.phase = 'ended';
      const winner = alive[0] || null;
      this.broadcast({ t: 'gameover', winner: winner ? { id: winner.id, name: winner.name } : null });
      clearInterval(this.tickTimer);
      this.tickTimer = null;
      setTimeout(() => {
        if (this.players.size > 0) {
          this.phase = 'lobby';
          this.ring = null;
          this.broadcast({ t: 'roomUpdate', players: this.playerList(), hostId: this.hostId, phase: this.phase });
        }
      }, 8000);
    }
  }

  damagePlayer(victim, dmg, attacker, cause) {
    if (!victim.alive) return;
    victim.hp -= dmg;
    if (victim.ws.readyState === victim.ws.OPEN) {
      victim.ws.send(JSON.stringify({ t: 'hurt', hp: victim.hp, from: attacker ? attacker.name : cause }));
    }
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      if (attacker && attacker !== victim) attacker.kills += 1;
      this.broadcast({
        t: 'kill',
        victim: victim.id,
        victimName: victim.name,
        killer: attacker ? attacker.id : null,
        killerName: attacker ? attacker.name : cause,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const player = {
    id: String(nextPlayerId++),
    ws,
    name: 'Player',
    room: null,
    pos: { x: 0, y: 1.6, z: 0 },
    rot: { x: 0, y: 0 },
    hp: MAX_HP,
    alive: false,
    kills: 0,
    moving: false,
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(player, msg);
  });

  ws.on('close', () => {
    const room = player.room;
    if (!room) return;
    room.players.delete(player.id);
    room.broadcast({ t: 'left', id: player.id });
    if (room.players.size === 0) {
      if (room.tickTimer) clearInterval(room.tickTimer);
      rooms.delete(room.code);
    } else if (room.hostId === player.id) {
      room.hostId = room.players.keys().next().value;
      room.broadcast({ t: 'roomUpdate', players: room.playerList(), hostId: room.hostId, phase: room.phase });
    } else {
      room.broadcast({ t: 'roomUpdate', players: room.playerList(), hostId: room.hostId, phase: room.phase });
    }
  });
});

function handleMessage(player, msg) {
  switch (msg.t) {
    case 'create': {
      player.name = sanitizeName(msg.name);
      const code = makeRoomCode();
      const room = new Room(code);
      room.hostId = player.id;
      rooms.set(code, room);
      joinRoom(player, room);
      break;
    }
    case 'join': {
      player.name = sanitizeName(msg.name);
      const code = (msg.room || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        player.ws.send(JSON.stringify({ t: 'error', msg: 'ルームが見つかりません: ' + code }));
        return;
      }
      if (room.phase === 'playing') {
        player.ws.send(JSON.stringify({ t: 'error', msg: 'ゲームは既に進行中です' }));
        return;
      }
      joinRoom(player, room);
      break;
    }
    case 'start': {
      const room = player.room;
      if (room && room.hostId === player.id && room.phase === 'lobby') {
        room.start();
      }
      break;
    }
    case 'input': {
      const room = player.room;
      if (!room || !player.alive) return;
      if (msg.pos) player.pos = clampPos(msg.pos);
      if (msg.rot) player.rot = { x: clampNum(msg.rot.x), y: clampNum(msg.rot.y) };
      player.moving = !!msg.moving;
      break;
    }
    case 'shoot': {
      const room = player.room;
      if (!room || !player.alive) return;
      // Broadcast a tracer so everyone can render it.
      room.broadcast({ t: 'shoot', id: player.id, origin: msg.origin, dir: msg.dir }, player.id);
      break;
    }
    case 'hit': {
      const room = player.room;
      if (!room || !player.alive) return;
      const target = room.players.get(String(msg.target));
      if (!target || !target.alive || target === player) return;
      // Loose server validation: target must actually be within weapon range.
      const dist = Math.hypot(player.pos.x - target.pos.x, player.pos.y - target.pos.y, player.pos.z - target.pos.z);
      if (dist > 250) return;
      const dmg = msg.head ? 50 : 20;
      room.damagePlayer(target, dmg, player, null);
      break;
    }
    case 'chat': {
      const room = player.room;
      if (!room) return;
      const text = String(msg.msg || '').slice(0, 200);
      if (text.trim()) room.broadcast({ t: 'chat', name: player.name, msg: text });
      break;
    }
    default:
      break;
  }
}

function joinRoom(player, room) {
  player.room = room;
  room.players.set(player.id, player);
  player.ws.send(JSON.stringify({
    t: 'joined',
    id: player.id,
    room: room.code,
    hostId: room.hostId,
    phase: room.phase,
    players: room.playerList(),
    mapSize: MAP_SIZE,
  }));
  room.broadcast({ t: 'roomUpdate', players: room.playerList(), hostId: room.hostId, phase: room.phase });
}

function sanitizeName(n) {
  const s = String(n || '').replace(/[<>]/g, '').trim().slice(0, 16);
  return s || 'Player';
}
function clampNum(v) {
  v = Number(v);
  return Number.isFinite(v) ? v : 0;
}
function clampPos(p) {
  const lim = MAP_SIZE;
  return {
    x: Math.max(-lim, Math.min(lim, clampNum(p.x))),
    y: Math.max(0, Math.min(60, clampNum(p.y))),
    z: Math.max(-lim, Math.min(lim, clampNum(p.z))),
  };
}

server.listen(PORT, () => {
  console.log(`BattleFPS server running on http://localhost:${PORT}`);
});
