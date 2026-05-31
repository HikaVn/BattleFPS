// BattleFPS server: static file hosting + WebSocket room-based multiplayer.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { WEAPONS, HEALS, MAX_AMMO, MAX_HP, MAX_SHIELD, lootCatalogue } from '../public/js/shared.js';

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
const RING_DAMAGE = 5;         // hp lost per tick while outside the ring
const LOOT_COUNT = 70;         // number of ground loot items spawned per match

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
let nextLootId = 1;

function randomSpawn() {
  const r = MAP_SIZE * 0.42;
  return {
    x: (Math.random() * 2 - 1) * r,
    y: 1.6,
    z: (Math.random() * 2 - 1) * r,
  };
}

// A fresh inventory: every player starts with a pistol and a little of everything.
function freshInventory() {
  return {
    weapons: ['pistol'],           // owned weapon ids
    current: 'pistol',             // equipped weapon id
    mag: { pistol: WEAPONS.pistol.mag },
    ammo: { light: 30, shell: 0, heavy: 0 },
    heals: { syringe: 1, medkit: 0, cell: 1, battery: 0 },
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
    this.loot = new Map();    // lootId -> loot item
  }

  broadcast(obj, exceptId = null) {
    const msg = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue;
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
    }
  }

  send(player, obj) {
    if (player.ws.readyState === player.ws.OPEN) player.ws.send(JSON.stringify(obj));
  }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      hp: p.hp,
      shield: p.shield,
      alive: p.alive,
      kills: p.kills,
    }));
  }

  spawnLoot() {
    this.loot.clear();
    const cat = lootCatalogue();
    for (let i = 0; i < LOOT_COUNT; i++) {
      const pick = cat[Math.floor(Math.random() * cat.length)];
      const id = String(nextLootId++);
      const r = MAP_SIZE * 0.88;
      this.loot.set(id, {
        id,
        type: pick.type,
        key: pick.key,
        amount: pick.amount || 0,
        x: (Math.random() * 2 - 1) * r,
        z: (Math.random() * 2 - 1) * r,
      });
    }
  }

  lootArray() {
    return [...this.loot.values()];
  }

  start() {
    if (this.phase === 'playing') return;
    this.phase = 'playing';
    this.startTime = Date.now();
    this.spawnLoot();
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
      p.shield = 0;
      p.kills = 0;
      p.inv = freshInventory();
      p.healing = null;
      p.pos = randomSpawn();
      p.rot = { x: 0, y: 0 };
      this.send(p, {
        t: 'started',
        mapSize: MAP_SIZE,
        spawn: p.pos,
        ring: this.ring,
        loot: this.lootArray(),
        inv: p.inv,
      });
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

    // Resolve in-progress healing.
    for (const p of this.players.values()) {
      if (p.alive && p.healing && now >= p.healing.done) {
        this.finishHeal(p);
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
        shield: p.shield,
        alive: p.alive,
        kills: p.kills,
        moving: p.moving,
        weapon: p.inv ? p.inv.current : 'pistol',
        healing: !!p.healing,
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
          this.loot.clear();
          this.broadcast({ t: 'roomUpdate', players: this.playerList(), hostId: this.hostId, phase: this.phase });
        }
      }, 8000);
    }
  }

  // Apply damage; shield absorbs first, then health.
  damagePlayer(victim, dmg, attacker, cause) {
    if (!victim.alive) return;
    // taking damage cancels healing
    if (victim.healing) { victim.healing = null; this.send(victim, { t: 'healCancel' }); }
    let remaining = dmg;
    if (victim.shield > 0) {
      const absorbed = Math.min(victim.shield, remaining);
      victim.shield -= absorbed;
      remaining -= absorbed;
    }
    victim.hp -= remaining;
    this.send(victim, { t: 'hurt', hp: victim.hp, shield: victim.shield, from: attacker ? attacker.name : cause });
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      victim.healing = null;
      if (attacker && attacker !== victim) attacker.kills += 1;
      // Drop the victim's gear as a loot beacon at their position.
      this.dropDeathLoot(victim);
      this.broadcast({
        t: 'kill',
        victim: victim.id,
        victimName: victim.name,
        killer: attacker ? attacker.id : null,
        killerName: attacker ? attacker.name : cause,
      });
    }
  }

  dropDeathLoot(victim) {
    if (!victim.inv) return;
    // Drop the current weapon (if not the starter pistol) and some ammo.
    const drops = [];
    for (const w of victim.inv.weapons) {
      if (w !== 'pistol') drops.push({ type: 'weapon', key: w, amount: 0 });
    }
    drops.push({ type: 'ammo', key: 'light', amount: 40 });
    if (victim.shield > 0) drops.push({ type: 'shield', key: 'cell', amount: 0 });
    let i = 0;
    for (const d of drops) {
      const id = String(nextLootId++);
      const item = {
        id, type: d.type, key: d.key, amount: d.amount,
        x: victim.pos.x + (i - drops.length / 2) * 1.4,
        z: victim.pos.z + 0.5,
      };
      this.loot.set(id, item);
      this.broadcast({ t: 'lootSpawn', item });
      i++;
    }
  }

  finishHeal(player) {
    const h = player.healing;
    player.healing = null;
    const def = HEALS[h.key];
    if (!def) return;
    if (def.kind === 'hp') player.hp = Math.min(MAX_HP, player.hp + def.amount);
    else player.shield = Math.min(MAX_SHIELD, player.shield + def.amount);
    this.send(player, { t: 'healDone', hp: player.hp, shield: player.shield, inv: player.inv });
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
    shield: 0,
    alive: false,
    kills: 0,
    moving: false,
    inv: null,
    healing: null,
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
      room.broadcast({ t: 'shoot', id: player.id, origin: msg.origin, dir: msg.dir, weapon: player.inv.current }, player.id);
      break;
    }
    case 'hit': {
      const room = player.room;
      if (!room || !player.alive) return;
      const target = room.players.get(String(msg.target));
      if (!target || !target.alive || target === player) return;
      const weapon = WEAPONS[player.inv.current] || WEAPONS.pistol;
      // Loose server validation: target must be within the weapon's range.
      const dist = Math.hypot(player.pos.x - target.pos.x, player.pos.y - target.pos.y, player.pos.z - target.pos.z);
      if (dist > weapon.range * 1.3 + 5) return;
      let dmg = weapon.damage;
      if (msg.head) dmg = Math.round(dmg * weapon.head);
      room.damagePlayer(target, dmg, player, null);
      break;
    }
    case 'switch': {
      const room = player.room;
      if (!room || !player.alive || !player.inv) return;
      const w = String(msg.weapon || '');
      if (player.inv.weapons.includes(w)) {
        player.inv.current = w;
        player.healing = null; // switching cancels heal
        room.send(player, { t: 'invUpdate', inv: player.inv });
      }
      break;
    }
    case 'reload': {
      const room = player.room;
      if (!room || !player.alive || !player.inv) return;
      const wid = player.inv.current;
      const w = WEAPONS[wid];
      if (!w) return;
      const have = player.inv.ammo[w.ammoType] || 0;
      const inMag = player.inv.mag[wid] || 0;
      const need = w.mag - inMag;
      const take = Math.min(need, have);
      if (take <= 0) return;
      player.inv.mag[wid] = inMag + take;
      player.inv.ammo[w.ammoType] = have - take;
      room.send(player, { t: 'invUpdate', inv: player.inv });
      break;
    }
    case 'spend': {
      // Client reports it fired one shot; decrement the magazine authoritatively.
      const room = player.room;
      if (!room || !player.alive || !player.inv) return;
      const wid = player.inv.current;
      if ((player.inv.mag[wid] || 0) > 0) {
        player.inv.mag[wid] -= 1;
        room.send(player, { t: 'invUpdate', inv: player.inv });
      }
      break;
    }
    case 'pickup': {
      const room = player.room;
      if (!room || !player.alive || !player.inv) return;
      const item = room.loot.get(String(msg.loot));
      if (!item) return;
      const dx = player.pos.x - item.x, dz = player.pos.z - item.z;
      if (Math.hypot(dx, dz) > 4) return; // must be close
      if (applyPickup(player, item)) {
        room.loot.delete(item.id);
        room.broadcast({ t: 'lootGone', id: item.id });
        room.send(player, { t: 'invUpdate', inv: player.inv });
      }
      break;
    }
    case 'useHeal': {
      const room = player.room;
      if (!room || !player.alive || !player.inv) return;
      const key = String(msg.key || '');
      const def = HEALS[key];
      if (!def) return;
      if ((player.inv.heals[key] || 0) <= 0) return;
      if (player.healing) return; // already healing
      if (def.kind === 'hp' && player.hp >= MAX_HP) return;
      if (def.kind === 'shield' && player.shield >= MAX_SHIELD) return;
      player.inv.heals[key] -= 1;
      player.healing = { key, done: Date.now() + def.time };
      room.send(player, { t: 'healStart', key, time: def.time, inv: player.inv });
      break;
    }
    case 'cancelHeal': {
      if (player.healing) { player.healing = null; player.room && player.room.send(player, { t: 'healCancel' }); }
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

// Apply a loot item to a player's inventory. Returns true if consumed.
function applyPickup(player, item) {
  const inv = player.inv;
  switch (item.type) {
    case 'weapon': {
      if (!WEAPONS[item.key]) return false;
      if (!inv.weapons.includes(item.key)) {
        if (inv.weapons.length >= 3) {
          // replace current (non-pistol) slot, otherwise append
          const idx = inv.weapons.indexOf(inv.current);
          if (inv.current !== 'pistol') inv.weapons[idx] = item.key;
          else inv.weapons.push(item.key);
        } else {
          inv.weapons.push(item.key);
        }
        inv.mag[item.key] = inv.mag[item.key] || WEAPONS[item.key].mag;
      }
      inv.current = item.key;
      return true;
    }
    case 'ammo': {
      const cap = MAX_AMMO[item.key] || 0;
      const cur = inv.ammo[item.key] || 0;
      if (cur >= cap) return false;
      inv.ammo[item.key] = Math.min(cap, cur + item.amount);
      return true;
    }
    case 'heal': {
      const def = HEALS[item.key];
      if (!def) return false;
      const cur = inv.heals[item.key] || 0;
      if (cur >= def.max) return false;
      inv.heals[item.key] = Math.min(def.max, cur + 1);
      return true;
    }
    case 'shield': {
      const def = HEALS[item.key];
      if (!def) return false;
      const cur = inv.heals[item.key] || 0;
      if (cur >= def.max) return false;
      inv.heals[item.key] = Math.min(def.max, cur + 1);
      return true;
    }
    case 'armor': {
      // Instant shield boost (body armor pickup).
      if (player.shield >= MAX_SHIELD) return false;
      player.shield = Math.min(MAX_SHIELD, player.shield + (item.amount || 50));
      return true;
    }
    default:
      return false;
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
