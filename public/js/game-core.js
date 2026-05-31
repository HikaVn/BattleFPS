// Transport-agnostic authoritative game logic.
//
// The same GameRoom drives matches in two deployments:
//   • Node WebSocket server (server/server.js) — classic dedicated host.
//   • Browser WebRTC host (js/net.js P2P mode) — works on GitHub Pages with
//     no backend; the host player's browser is the authority.
//
// The room never touches the network directly. A transport object supplies
//   broadcast(obj, exceptId)  — send to every player (optionally skip one)
//   sendTo(playerId, obj)     — send to a single player
// so the exact same code runs in Node and in the browser.
import { WEAPONS, HEALS, MAX_AMMO, MAX_HP, MAX_SHIELD, lootCatalogue } from './shared.js';

export const MAP_SIZE = 200;   // arena is MAP_SIZE x MAP_SIZE centred on origin
export const TICK_RATE = 20;   // network state broadcasts per second
const RING_DAMAGE = 5;         // hp lost per tick while outside the ring
const LOOT_COUNT = 70;         // ground loot items spawned per match

let nextLootId = 1;

export function randomSpawn() {
  const r = MAP_SIZE * 0.42;
  return { x: (Math.random() * 2 - 1) * r, y: 1.6, z: (Math.random() * 2 - 1) * r };
}

// A fresh inventory: every player starts with a pistol and a little of everything.
export function freshInventory() {
  return {
    weapons: ['pistol'],
    current: 'pistol',
    mag: { pistol: WEAPONS.pistol.mag },
    ammo: { light: 30, shell: 0, heavy: 0 },
    heals: { syringe: 1, medkit: 0, cell: 1, battery: 0 },
  };
}

export function sanitizeName(n) {
  const s = String(n || '').replace(/[<>]/g, '').trim().slice(0, 16);
  return s || 'Player';
}
function clampNum(v) { v = Number(v); return Number.isFinite(v) ? v : 0; }
function clampPos(p) {
  const lim = MAP_SIZE;
  return {
    x: Math.max(-lim, Math.min(lim, clampNum(p.x))),
    y: Math.max(0, Math.min(60, clampNum(p.y))),
    z: Math.max(-lim, Math.min(lim, clampNum(p.z))),
  };
}

export class GameRoom {
  constructor(code, transport) {
    this.code = code;
    this.transport = transport;      // { broadcast(obj, exceptId), sendTo(id, obj) }
    this.players = new Map();         // id -> player
    this.hostId = null;
    this.phase = 'lobby';             // 'lobby' | 'playing' | 'ended'
    this.ring = null;
    this.tickTimer = null;
    this.loot = new Map();            // lootId -> loot item
    this.tutorial = false;            // solo practice: no ring, no gameover, bots respawn
  }

  // ---- transport helpers --------------------------------------------------
  broadcast(obj, exceptId = null) { this.transport.broadcast(obj, exceptId); }
  send(player, obj) { this.transport.sendTo(player.id, obj); }

  // ---- membership ---------------------------------------------------------
  addPlayer(id, name) {
    const player = {
      id: String(id),
      name: sanitizeName(name),
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
    if (!this.hostId) this.hostId = player.id;
    this.players.set(player.id, player);
    this.send(player, {
      t: 'joined',
      id: player.id,
      room: this.code,
      hostId: this.hostId,
      phase: this.phase,
      players: this.playerList(),
      mapSize: MAP_SIZE,
    });
    this.broadcast({ t: 'roomUpdate', players: this.playerList(), hostId: this.hostId, phase: this.phase });
    return player;
  }

  removePlayer(id) {
    id = String(id);
    if (!this.players.has(id)) return;
    this.players.delete(id);
    this.broadcast({ t: 'left', id });
    if (this.players.size === 0) {
      if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
      return;
    }
    if (this.hostId === id) this.hostId = this.players.keys().next().value;
    this.broadcast({ t: 'roomUpdate', players: this.playerList(), hostId: this.hostId, phase: this.phase });
  }

  isEmpty() { return this.players.size === 0; }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, hp: p.hp, shield: p.shield, alive: p.alive, kills: p.kills,
    }));
  }

  // ---- loot ---------------------------------------------------------------
  spawnLoot() {
    this.loot.clear();
    const cat = lootCatalogue();
    for (let i = 0; i < LOOT_COUNT; i++) {
      const pick = cat[Math.floor(Math.random() * cat.length)];
      const id = String(nextLootId++);
      const r = MAP_SIZE * 0.88;
      this.loot.set(id, {
        id, type: pick.type, key: pick.key, amount: pick.amount || 0,
        x: (Math.random() * 2 - 1) * r,
        z: (Math.random() * 2 - 1) * r,
      });
    }
  }
  lootArray() { return [...this.loot.values()]; }

  // ---- match lifecycle ----------------------------------------------------
  // opts (optional): { tutorial: bool, loot: [{type,key,amount,x,z}], spawn: {x,z} }
  start(opts = null) {
    if (this.phase === 'playing') return;
    this.phase = 'playing';
    this.tutorial = !!(opts && opts.tutorial);

    if (opts && Array.isArray(opts.loot)) {
      // Curated loot for the tutorial: deterministic positions.
      this.loot.clear();
      for (const it of opts.loot) {
        const id = String(nextLootId++);
        this.loot.set(id, { id, type: it.type, key: it.key, amount: it.amount || 0, x: it.x, z: it.z });
      }
    } else {
      this.spawnLoot();
    }

    if (this.tutorial) {
      // No closing ring in the dojo.
      this.ring = null;
    } else {
      const cx = (Math.random() * 2 - 1) * MAP_SIZE * 0.2;
      const cz = (Math.random() * 2 - 1) * MAP_SIZE * 0.2;
      this.ring = {
        x: cx, z: cz,
        radius: MAP_SIZE * 0.75, targetRadius: MAP_SIZE * 0.75,
        minRadius: 12, shrinkRate: 0, nextShrink: Date.now() + 15000,
      };
    }

    for (const p of this.players.values()) {
      if (p.bot) continue;  // dummies keep their placed position / state
      p.alive = true; p.hp = MAX_HP; p.shield = 0; p.kills = 0;
      p.inv = freshInventory(); p.healing = null;
      p.pos = (opts && opts.spawn) ? { x: opts.spawn.x, y: 1.6, z: opts.spawn.z } : randomSpawn();
      p.rot = { x: 0, y: 0 };
      this.send(p, {
        t: 'started', mapSize: MAP_SIZE, spawn: p.pos, ring: this.ring,
        loot: this.lootArray(), inv: p.inv, tutorial: this.tutorial,
      });
    }
    this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  // Add a stationary training dummy (tutorial only). It is a normal player in
  // every respect except it never moves and is flagged so the client can label
  // it. Returns its id.
  addDummy(id, name, pos) {
    const bot = {
      id: String(id), name, bot: true,
      pos: { x: pos.x, y: 1.6, z: pos.z }, rot: { x: 0, y: 0 },
      hp: MAX_HP, shield: 0, alive: true, kills: 0, moving: false,
      inv: freshInventory(), healing: null,
      spawn: { x: pos.x, z: pos.z },
    };
    this.players.set(bot.id, bot);
    return bot.id;
  }

  tick() {
    const now = Date.now();
    const ring = this.ring;
    if (ring) {
      if (now >= ring.nextShrink && ring.targetRadius > ring.minRadius) {
        ring.targetRadius = Math.max(ring.minRadius, ring.targetRadius * 0.6);
        ring.shrinkRate = (ring.radius - ring.targetRadius) / (TICK_RATE * 12);
        ring.nextShrink = now + 22000;
      }
      if (ring.radius > ring.targetRadius) {
        ring.radius = Math.max(ring.targetRadius, ring.radius - ring.shrinkRate);
      }
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.pos.x - ring.x, dz = p.pos.z - ring.z;
        if (Math.hypot(dx, dz) > ring.radius) this.damagePlayer(p, RING_DAMAGE, null, 'ring');
      }
    }

    for (const p of this.players.values()) {
      if (p.alive && p.healing && now >= p.healing.done) this.finishHeal(p);
    }

    // Tutorial: respawn downed dummies after a short delay so the player can
    // keep practising.
    if (this.tutorial) {
      for (const p of this.players.values()) {
        if (p.bot && !p.alive && p.downAt && now - p.downAt >= 2500) {
          p.alive = true; p.hp = MAX_HP; p.shield = 0; p.healing = null;
          p.pos = { x: p.spawn.x, y: 1.6, z: p.spawn.z };
          p.downAt = 0;
        }
      }
    }

    this.broadcast({
      t: 'state',
      ring: ring ? { x: ring.x, z: ring.z, radius: Math.round(ring.radius * 100) / 100 } : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, pos: p.pos, rot: p.rot, hp: p.hp, shield: p.shield,
        alive: p.alive, kills: p.kills, moving: p.moving, bot: !!p.bot,
        weapon: p.inv ? p.inv.current : 'pistol', healing: !!p.healing,
      })),
    });

    // No win condition in the tutorial dojo.
    if (this.tutorial) return;

    const alive = [...this.players.values()].filter((p) => p.alive);
    if (this.phase === 'playing' && this.players.size >= 2 && alive.length <= 1) {
      this.phase = 'ended';
      const winner = alive[0] || null;
      this.broadcast({ t: 'gameover', winner: winner ? { id: winner.id, name: winner.name } : null });
      if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
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

  // ---- combat / heals -----------------------------------------------------
  damagePlayer(victim, dmg, attacker, cause) {
    if (!victim.alive) return;
    if (victim.healing) { victim.healing = null; this.send(victim, { t: 'healCancel' }); }
    let remaining = dmg;
    if (victim.shield > 0) {
      const absorbed = Math.min(victim.shield, remaining);
      victim.shield -= absorbed; remaining -= absorbed;
    }
    victim.hp -= remaining;
    this.send(victim, { t: 'hurt', hp: victim.hp, shield: victim.shield, from: attacker ? attacker.name : cause });
    if (victim.hp <= 0) {
      victim.hp = 0; victim.alive = false; victim.healing = null;
      if (attacker && attacker !== victim) attacker.kills += 1;
      if (victim.bot) victim.downAt = Date.now();  // tutorial dummies respawn
      else this.dropDeathLoot(victim);
      this.broadcast({
        t: 'kill', victim: victim.id, victimName: victim.name,
        killer: attacker ? attacker.id : null, killerName: attacker ? attacker.name : cause,
      });
    }
  }

  dropDeathLoot(victim) {
    if (!victim.inv) return;
    const drops = [];
    for (const w of victim.inv.weapons) if (w !== 'pistol') drops.push({ type: 'weapon', key: w, amount: 0 });
    drops.push({ type: 'ammo', key: 'light', amount: 40 });
    if (victim.shield > 0) drops.push({ type: 'shield', key: 'cell', amount: 0 });
    let i = 0;
    for (const d of drops) {
      const id = String(nextLootId++);
      const item = {
        id, type: d.type, key: d.key, amount: d.amount,
        x: victim.pos.x + (i - drops.length / 2) * 1.4, z: victim.pos.z + 0.5,
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

  // ---- per-player messages ------------------------------------------------
  handleMessage(playerId, msg) {
    const player = this.players.get(String(playerId));
    if (!player || !msg) return;
    switch (msg.t) {
      case 'start': {
        if (this.hostId === player.id && this.phase === 'lobby') this.start();
        break;
      }
      case 'input': {
        if (!player.alive) return;
        if (msg.pos) player.pos = clampPos(msg.pos);
        if (msg.rot) player.rot = { x: clampNum(msg.rot.x), y: clampNum(msg.rot.y) };
        player.moving = !!msg.moving;
        break;
      }
      case 'shoot': {
        if (!player.alive) return;
        this.broadcast({ t: 'shoot', id: player.id, origin: msg.origin, dir: msg.dir, weapon: player.inv.current }, player.id);
        break;
      }
      case 'hit': {
        if (!player.alive) return;
        const target = this.players.get(String(msg.target));
        if (!target || !target.alive || target === player) return;
        const weapon = WEAPONS[player.inv.current] || WEAPONS.pistol;
        const dist = Math.hypot(player.pos.x - target.pos.x, player.pos.y - target.pos.y, player.pos.z - target.pos.z);
        if (dist > weapon.range * 1.3 + 5) return;
        let dmg = weapon.damage;
        if (msg.head) dmg = Math.round(dmg * weapon.head);
        this.damagePlayer(target, dmg, player, null);
        break;
      }
      case 'switch': {
        if (!player.alive || !player.inv) return;
        const w = String(msg.weapon || '');
        if (player.inv.weapons.includes(w)) {
          player.inv.current = w;
          player.healing = null;
          this.send(player, { t: 'invUpdate', inv: player.inv });
        }
        break;
      }
      case 'reload': {
        if (!player.alive || !player.inv) return;
        const wid = player.inv.current;
        const w = WEAPONS[wid];
        if (!w) return;
        const have = player.inv.ammo[w.ammoType] || 0;
        const inMag = player.inv.mag[wid] || 0;
        const take = Math.min(w.mag - inMag, have);
        if (take <= 0) return;
        player.inv.mag[wid] = inMag + take;
        player.inv.ammo[w.ammoType] = have - take;
        this.send(player, { t: 'invUpdate', inv: player.inv });
        break;
      }
      case 'spend': {
        if (!player.alive || !player.inv) return;
        const wid = player.inv.current;
        if ((player.inv.mag[wid] || 0) > 0) {
          player.inv.mag[wid] -= 1;
          this.send(player, { t: 'invUpdate', inv: player.inv });
        }
        break;
      }
      case 'pickup': {
        if (!player.alive || !player.inv) return;
        const item = this.loot.get(String(msg.loot));
        if (!item) return;
        if (Math.hypot(player.pos.x - item.x, player.pos.z - item.z) > 4) return;
        if (applyPickup(player, item)) {
          this.loot.delete(item.id);
          this.broadcast({ t: 'lootGone', id: item.id });
          this.send(player, { t: 'invUpdate', inv: player.inv });
        }
        break;
      }
      case 'useHeal': {
        if (!player.alive || !player.inv) return;
        const key = String(msg.key || '');
        const def = HEALS[key];
        if (!def) return;
        if ((player.inv.heals[key] || 0) <= 0) return;
        if (player.healing) return;
        if (def.kind === 'hp' && player.hp >= MAX_HP) return;
        if (def.kind === 'shield' && player.shield >= MAX_SHIELD) return;
        player.inv.heals[key] -= 1;
        player.healing = { key, done: Date.now() + def.time };
        this.send(player, { t: 'healStart', key, time: def.time, inv: player.inv });
        break;
      }
      case 'cancelHeal': {
        if (player.healing) { player.healing = null; this.send(player, { t: 'healCancel' }); }
        break;
      }
      case 'chat': {
        const text = String(msg.msg || '').slice(0, 200);
        if (text.trim()) this.broadcast({ t: 'chat', name: player.name, msg: text });
        break;
      }
      default: break;
    }
  }
}

// Apply a loot item to a player's inventory. Returns true if consumed.
export function applyPickup(player, item) {
  const inv = player.inv;
  switch (item.type) {
    case 'weapon': {
      if (!WEAPONS[item.key]) return false;
      if (!inv.weapons.includes(item.key)) {
        if (inv.weapons.length >= 3) {
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
    case 'heal':
    case 'shield': {
      const def = HEALS[item.key];
      if (!def) return false;
      const cur = inv.heals[item.key] || 0;
      if (cur >= def.max) return false;
      inv.heals[item.key] = Math.min(def.max, cur + 1);
      return true;
    }
    case 'armor': {
      if (player.shield >= MAX_SHIELD) return false;
      player.shield = Math.min(MAX_SHIELD, player.shield + (item.amount || 50));
      return true;
    }
    default:
      return false;
  }
}
