// 3D FPS engine built on Three.js: map, local controller, remote players,
// weapons + inventory, ground loot, shields, healing, the shrinking ring
// and the minimap.
import * as THREE from 'three';
import { WEAPONS, HEALS, AMMO_TYPES, lootImage } from './shared.js';

// Cache of loaded item textures so each PNG is only fetched once.
const _texLoader = new THREE.TextureLoader();
const _texCache = new Map();
function loadItemTexture(url) {
  if (_texCache.has(url)) return _texCache.get(url);
  // load() will quietly fail if the file is missing; callers use onError below.
  const tex = _texLoader.load(url, undefined, undefined, () => {});
  _texCache.set(url, tex);
  return tex;
}

const EYE_HEIGHT = 1.6;
const PLAYER_RADIUS = 0.5;
const MOVE_SPEED = 9;
const SPRINT_SPEED = 14;
const GRAVITY = 28;
const JUMP_VELOCITY = 10;
const PICKUP_RANGE = 3.2;

// Small seeded PRNG so every client builds an identical map for a room.
function makeRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h = (h ^= h >>> 16) >>> 0;
    return h / 4294967296;
  };
}

export class Game {
  constructor(net, callbacks) {
    this.net = net;
    this.cb = callbacks || {};
    this.canvas = document.getElementById('game-canvas');
    this.running = false;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc6e8);
    this.scene.fog = new THREE.Fog(0x9fc6e8, 80, 260);

    this.camera = new THREE.PerspectiveCamera(80, innerWidth / innerHeight, 0.1, 1000);

    this.colliders = [];        // AABB cover boxes for collision
    this.boxMeshes = [];        // meshes used for tracer wall-clipping
    this.remote = new Map();    // id -> { group, body, head, label, target }
    this.tracers = [];
    this.lootMeshes = new Map(); // lootId -> { mesh, item }
    this.ringMesh = null;
    this.ringData = null;

    // local player state
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;
    this.hp = 100;
    this.shield = 0;
    this.kills = 0;
    this.alive = true;
    this.selfId = null;
    this.mapSize = 200;

    // inventory (mirrors server; server is authoritative)
    this.inv = { weapons: ['pistol'], current: 'pistol', mag: { pistol: 12 }, ammo: { light: 30, shell: 0, heavy: 0 }, heals: { syringe: 1, medkit: 0, cell: 1, battery: 0 } };
    this.reloading = false;
    this.healing = null;       // { key, until }
    this.lastShot = 0;

    this.keys = {};
    this.locked = false;
    this._raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this._lastInputSent = 0;
    this.nearbyLoot = null;

    this._bindEvents();
    addEventListener('resize', () => this._onResize());
  }

  // ---- public API ---------------------------------------------------------
  build(opts) {
    this.selfId = opts.selfId;
    this.mapSize = opts.mapSize || 200;
    this._buildMap(opts.seed || 'SEED');
    this.pos.set(opts.spawn.x, 0, opts.spawn.z);
    this.vel.set(0, 0, 0);
    this.hp = 100;
    this.shield = 0;
    this.kills = 0;
    this.alive = true;
    this.reloading = false;
    this.healing = null;
    if (opts.inv) this.inv = opts.inv;
    if (opts.loot) for (const item of opts.loot) this._addLoot(item);
    this._updateHud();
    this._updateGunModel();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._onResize();
    this.clock.start();
    this._loop();
  }

  stop() { this.running = false; }
  requestLock() { this.canvas.requestPointerLock(); }

  // Update remote players + ring from a server state snapshot.
  setState(state) {
    if (state.ring) this._updateRing(state.ring);
    const seen = new Set();
    let alive = 0;
    for (const p of state.players) {
      if (p.alive) alive++;
      if (p.id === this.selfId) {
        if (typeof p.kills === 'number') this.kills = p.kills;
        continue;
      }
      seen.add(p.id);
      let r = this.remote.get(p.id);
      if (!r) r = this._addRemote(p);
      r.target.set(p.pos.x, p.pos.y - EYE_HEIGHT, p.pos.z);
      r.targetYaw = p.rot.y;
      r.alive = p.alive;
      r.group.visible = p.alive;
    }
    for (const [id] of this.remote) {
      if (!seen.has(id)) this._removeRemote(id);
    }
    if (this.cb.onAlive) this.cb.onAlive(alive);
  }

  removePlayer(id) { this._removeRemote(id); }

  remoteShoot(origin, dir, weapon) {
    const o = new THREE.Vector3(origin.x, origin.y, origin.z);
    const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
    const color = (WEAPONS[weapon] || WEAPONS.pistol).color;
    this._spawnTracer(o, o.clone().add(d.multiplyScalar(200)), color);
  }

  setVitals(hp, shield) {
    const dropped = (hp + shield) < (this.hp + this.shield);
    this.hp = hp;
    if (typeof shield === 'number') this.shield = shield;
    this._updateHud();
    if (dropped && this.cb.onHurt) this.cb.onHurt();
  }

  setInventory(inv) {
    if (inv) this.inv = inv;
    this.reloading = false;
    this._updateHud();
    this._updateGunModel();
  }

  setDead() {
    this.alive = false;
    this.healing = null;
    if (this.locked && document.exitPointerLock) document.exitPointerLock();
  }

  // ---- loot ---------------------------------------------------------------
  addLoot(item) { this._addLoot(item); }
  removeLoot(id) {
    const l = this.lootMeshes.get(id);
    if (!l) return;
    this.scene.remove(l.mesh);
    this.lootMeshes.delete(id);
  }

  _lootColor(item) {
    if (item.type === 'weapon') return (WEAPONS[item.key] || {}).color || 0xffffff;
    if (item.type === 'ammo') return 0xd9b35b;
    if (item.type === 'armor') return 0x9b6bff;
    return (HEALS[item.key] || {}).color || 0xffffff;
  }

  _addLoot(item) {
    if (this.lootMeshes.has(item.id)) return;
    const color = this._lootColor(item);

    // Container group positioned at the loot location.
    const group = new THREE.Group();
    group.position.set(item.x, 0.7, item.z);

    // Procedural placeholder mesh (used until/unless a PNG loads).
    let geo;
    if (item.type === 'weapon') geo = new THREE.BoxGeometry(1.2, 0.3, 0.3);
    else if (item.type === 'ammo') geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    else if (item.type === 'armor') geo = new THREE.OctahedronGeometry(0.5);
    else geo = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 8);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4 });
    const proc = new THREE.Mesh(geo, mat);
    proc.castShadow = true;
    group.add(proc);

    // Glow beacon so loot is visible from afar.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 6, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25 }));
    beam.position.y = 3;
    group.add(beam);

    // If a generated PNG exists, swap in a billboard sprite on successful load.
    const imgUrl = lootImage(item.type, item.key);
    if (imgUrl) {
      const img = new Image();
      img.onload = () => {
        const tex = loadItemTexture(imgUrl);
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
        spr.scale.set(1.4, 1.4, 1.4);
        spr.position.y = 0.2;
        group.add(spr);
        proc.visible = false; // hide placeholder once art is shown
      };
      img.onerror = () => { /* keep procedural placeholder */ };
      img.src = imgUrl;
    }

    this.scene.add(group);
    this.lootMeshes.set(item.id, { mesh: group, item });
  }

  // ---- map ----------------------------------------------------------------
  _buildMap(seed) {
    const rng = makeRng(seed);
    const S = this.mapSize;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x556677, 0.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(60, 120, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
    sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
    this.scene.add(sun);

    const groundMat = new THREE.MeshStandardMaterial({ color: 0x4f7a4a });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(S * 2.2, S * 2.2), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(S * 2, 60, 0x3a5a37, 0x3a5a37);
    grid.position.y = 0.02;
    grid.material.opacity = 0.35; grid.material.transparent = true;
    this.scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x6b7280 });
    const wallH = 8, t = 2;
    const walls = [
      [0, S, S * 2 + t, t], [0, -S, S * 2 + t, t],
      [S, 0, t, S * 2 + t], [-S, 0, t, S * 2 + t],
    ];
    for (const [x, z, w, d] of walls) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
      m.position.set(x, wallH / 2, z);
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
      this.boxMeshes.push(m);
      this.colliders.push({ min: new THREE.Vector3(x - w / 2, 0, z - d / 2), max: new THREE.Vector3(x + w / 2, wallH, z + d / 2) });
    }

    const palette = [0x8d6e63, 0x90a4ae, 0xa1887f, 0x78909c, 0xbcaaa4];
    const count = 46;
    for (let i = 0; i < count; i++) {
      const w = 4 + rng() * 16;
      const d = 4 + rng() * 16;
      const h = 3 + rng() * 14;
      const x = (rng() * 2 - 1) * S * 0.85;
      const z = (rng() * 2 - 1) * S * 0.85;
      if (Math.hypot(x, z) < 10) continue;
      const mat = new THREE.MeshStandardMaterial({ color: palette[Math.floor(rng() * palette.length)] });
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      box.position.set(x, h / 2, z);
      box.castShadow = true; box.receiveShadow = true;
      this.scene.add(box);
      this.boxMeshes.push(box);
      this.colliders.push({ min: new THREE.Vector3(x - w / 2, 0, z - d / 2), max: new THREE.Vector3(x + w / 2, h, z + d / 2) });
    }

    // Gun viewmodel attached to the camera (rebuilt when weapon changes).
    this.gun = new THREE.Group();
    this.camera.add(this.gun);
    this.scene.add(this.camera);
    this._updateGunModel();
  }

  _updateGunModel() {
    if (!this.gun) return;
    while (this.gun.children.length) this.gun.remove(this.gun.children[0]);
    const w = WEAPONS[this.inv.current] || WEAPONS.pistol;
    const mat = new THREE.MeshStandardMaterial({ color: 0x222831 });
    const accent = new THREE.MeshStandardMaterial({ color: w.color });
    // barrel length scales loosely with range
    const len = 0.5 + Math.min(1.2, w.range / 300);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, len), mat);
    barrel.position.set(0.32, -0.28, -0.5 - len / 2);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.5), accent);
    body.position.set(0.32, -0.32, -0.4);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.16), mat);
    grip.position.set(0.32, -0.5, -0.3);
    this.gun.add(barrel); this.gun.add(body); this.gun.add(grip);
  }

  // ---- remote players -----------------------------------------------------
  _addRemote(p) {
    const group = new THREE.Group();
    const color = new THREE.Color().setHSL((parseInt(p.id, 10) * 0.13) % 1, 0.6, 0.55);
    const bodyMat = new THREE.MeshStandardMaterial({ color });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 8), bodyMat);
    body.position.y = 0.9; body.castShadow = true;
    body.userData = { playerId: p.id, part: 'body' };
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffe0b2 }));
    head.position.y = 1.75; head.castShadow = true;
    head.userData = { playerId: p.id, part: 'head' };
    group.add(body); group.add(head);

    const label = this._makeLabel(p.name);
    label.position.y = 2.4;
    group.add(label);

    group.position.set(p.pos.x, p.pos.y - EYE_HEIGHT, p.pos.z);
    this.scene.add(group);
    const r = { group, body, head, label, target: group.position.clone(), targetYaw: 0, alive: true };
    this.remote.set(p.id, r);
    return r;
  }

  _removeRemote(id) {
    const r = this.remote.get(id);
    if (!r) return;
    this.scene.remove(r.group);
    this.remote.delete(id);
  }

  _makeLabel(text) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = 'bold 32px sans-serif';
    ctx.fillStyle = '#ffd24d';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(cv);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    spr.scale.set(2.4, 0.6, 1);
    return spr;
  }

  // ---- ring ---------------------------------------------------------------
  _updateRing(ring) {
    this.ringData = ring;
    if (!this.ringMesh) {
      const geo = new THREE.CylinderGeometry(1, 1, 60, 64, 1, true);
      const mat = new THREE.MeshBasicMaterial({ color: 0x4dc3ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
      this.ringMesh = new THREE.Mesh(geo, mat);
      this.scene.add(this.ringMesh);
    }
    this.ringMesh.position.set(ring.x, 30, ring.z);
    this.ringMesh.scale.set(ring.radius, 1, ring.radius);

    if (this.cb.onRing) {
      const dx = this.pos.x - ring.x, dz = this.pos.z - ring.z;
      const inside = Math.hypot(dx, dz) <= ring.radius;
      this.cb.onRing(inside, ring.radius);
    }
  }

  // ---- input --------------------------------------------------------------
  _bindEvents() {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // weapon switching
      if (e.code === 'Digit1') this._switchSlot(0);
      else if (e.code === 'Digit2') this._switchSlot(1);
      else if (e.code === 'Digit3') this._switchSlot(2);
      else if (e.code === 'KeyR') this._reload();
      else if (e.code === 'KeyE') this._tryPickup();
      else if (e.code === 'KeyZ') this.net.send({ t: 'useHeal', key: 'syringe' });
      else if (e.code === 'KeyX') this.net.send({ t: 'useHeal', key: 'cell' });
      else if (e.code === 'KeyC') this.net.send({ t: 'useHeal', key: 'medkit' });
      else if (e.code === 'KeyV') this.net.send({ t: 'useHeal', key: 'battery' });
      this.keys[e.code] = true;
    });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.cb.onLockChange) this.cb.onLockChange(this.locked);
    });

    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const s = 0.0022;
      this.yaw -= e.movementX * s;
      this.pitch -= e.movementY * s;
      const lim = Math.PI / 2 - 0.05;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });

    addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.locked) this._mouseDown = true;
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this._mouseDown = false; });

    addEventListener('wheel', (e) => {
      if (!this.locked) return;
      const dir = e.deltaY > 0 ? 1 : -1;
      const idx = this.inv.weapons.indexOf(this.inv.current);
      this._switchSlot((idx + dir + this.inv.weapons.length) % this.inv.weapons.length);
    });
  }

  _switchSlot(i) {
    const w = this.inv.weapons[i];
    if (w && w !== this.inv.current) {
      this._cancelHeal();
      this.net.send({ t: 'switch', weapon: w });
    }
  }

  _cancelHeal() {
    if (this.healing) { this.healing = null; this.net.send({ t: 'cancelHeal' }); if (this.cb.onHealProgress) this.cb.onHealProgress(0); }
  }

  // healing lifecycle driven by the server
  healStart(key, time) {
    this.healing = { key, until: performance.now() + time, total: time };
  }
  healDone() { this.healing = null; if (this.cb.onHealProgress) this.cb.onHealProgress(0); }
  healCancel() { this.healing = null; if (this.cb.onHealProgress) this.cb.onHealProgress(0); }

  _reload() {
    if (!this.alive || this.reloading) return;
    const wid = this.inv.current;
    const w = WEAPONS[wid];
    if (!w) return;
    if ((this.inv.mag[wid] || 0) >= w.mag) return;
    if ((this.inv.ammo[w.ammoType] || 0) <= 0) return;
    this._cancelHeal();
    this.reloading = true;
    if (this.cb.onReload) this.cb.onReload(true);
    setTimeout(() => {
      this.reloading = false;
      if (this.cb.onReload) this.cb.onReload(false);
      this.net.send({ t: 'reload' });
    }, w.reload);
  }

  _tryPickup() {
    if (this.nearbyLoot) this.net.send({ t: 'pickup', loot: this.nearbyLoot.item.id });
  }

  _tryShoot() {
    if (!this.alive || this.reloading || this.healing) return;
    const wid = this.inv.current;
    const w = WEAPONS[wid] || WEAPONS.pistol;
    const now = performance.now();
    if (now - this.lastShot < w.fireInterval) return;
    if ((this.inv.mag[wid] || 0) <= 0) { this._reload(); return; }
    this.lastShot = now;
    this.inv.mag[wid] = (this.inv.mag[wid] || 0) - 1;
    this.net.send({ t: 'spend' });
    if (this.cb.onAmmo) this.cb.onAmmo(this.inv.mag[wid], this.inv.ammo[w.ammoType]);

    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const baseDir = this.camera.getWorldDirection(new THREE.Vector3());
    this.net.send({ t: 'shoot', origin: { x: origin.x, y: origin.y, z: origin.z }, dir: { x: baseDir.x, y: baseDir.y, z: baseDir.z } });

    const enemyMeshes = [];
    for (const r of this.remote.values()) if (r.alive) enemyMeshes.push(r.body, r.head);

    const pellets = w.pellets || 1;
    const hitThisShot = new Set();
    for (let i = 0; i < pellets; i++) {
      const dir = baseDir.clone();
      if (w.spread > 0) {
        dir.x += (Math.random() * 2 - 1) * w.spread;
        dir.y += (Math.random() * 2 - 1) * w.spread;
        dir.z += (Math.random() * 2 - 1) * w.spread;
        dir.normalize();
      }
      this._raycaster.set(origin, dir);
      this._raycaster.far = w.range;
      const hits = this._raycaster.intersectObjects(enemyMeshes, false);
      const mapHits = this._raycaster.intersectObjects(this.boxMeshes, false);
      const wallDist = mapHits.length ? mapHits[0].distance : Infinity;
      let endPoint = origin.clone().add(dir.clone().multiplyScalar(w.range));

      if (hits.length && hits[0].distance < wallDist) {
        const hit = hits[0];
        endPoint = hit.point.clone();
        const pid = hit.object.userData.playerId;
        const head = hit.object.userData.part === 'head';
        // each pellet can register; server validates and applies damage
        this.net.send({ t: 'hit', target: pid, head });
        hitThisShot.add(pid);
      } else if (mapHits.length) {
        endPoint = mapHits[0].point.clone();
      }
      this._spawnTracer(origin.clone(), endPoint, w.color);
    }
    if (hitThisShot.size && this.cb.onHitConfirm) this.cb.onHitConfirm();

    if (this.gun) this.gun.position.z = 0.12;
  }

  _spawnTracer(a, b, color) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.08 });
  }

  // ---- main loop ----------------------------------------------------------
  _loop() {
    if (!this.running) return;
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this._updateMovement(dt);
    if (this._mouseDown) this._tryShoot();
    this._updateRemotes(dt);
    this._updateTracers(dt);
    this._updateLoot(dt);
    this._updateHeal();
    this._sendInput();
    this._drawMinimap();
    this.renderer.render(this.scene, this.camera);
  }

  _updateMovement(dt) {
    if (this.gun && this.gun.position.z > 0) this.gun.position.z = Math.max(0, this.gun.position.z - dt * 0.9);

    const canMove = this.alive && this.locked && !this.healing;
    if (canMove) {
      const forward = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
      const strafe = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
      const speed = this.keys['ShiftLeft'] ? SPRINT_SPEED : MOVE_SPEED;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      let dx = (-sin * forward + cos * strafe);
      let dz = (-cos * forward - sin * strafe);
      const len = Math.hypot(dx, dz);
      if (len > 0) { dx /= len; dz /= len; }
      this.vel.x = dx * speed;
      this.vel.z = dz * speed;
      if (this.keys['Space'] && this.onGround) { this.vel.y = JUMP_VELOCITY; this.onGround = false; }
    } else {
      this.vel.x = 0; this.vel.z = 0;
    }

    this.vel.y -= GRAVITY * dt;
    this.pos.x += this.vel.x * dt; this._resolveXZ();
    this.pos.z += this.vel.z * dt; this._resolveXZ();
    this.pos.y += this.vel.y * dt; this._resolveY();

    const lim = this.mapSize - 1;
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x));
    this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z));

    this.camera.position.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
    this.camera.rotation.set(0, 0, 0, 'YXZ');
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }

  _resolveXZ() {
    for (const b of this.colliders) {
      if (this.pos.y + EYE_HEIGHT < b.min.y || this.pos.y > b.max.y) continue;
      const cx = Math.max(b.min.x, Math.min(this.pos.x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(this.pos.z, b.max.z));
      const dx = this.pos.x - cx, dz = this.pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < PLAYER_RADIUS * PLAYER_RADIUS) {
        const d = Math.sqrt(d2) || 0.0001;
        const push = (PLAYER_RADIUS - d);
        this.pos.x += (dx / d) * push;
        this.pos.z += (dz / d) * push;
      }
    }
  }

  _resolveY() {
    if (this.pos.y <= 0) { this.pos.y = 0; this.vel.y = 0; this.onGround = true; return; }
    this.onGround = false;
    for (const b of this.colliders) {
      const within = this.pos.x > b.min.x - PLAYER_RADIUS && this.pos.x < b.max.x + PLAYER_RADIUS &&
                     this.pos.z > b.min.z - PLAYER_RADIUS && this.pos.z < b.max.z + PLAYER_RADIUS;
      if (within && this.vel.y <= 0 && this.pos.y <= b.max.y && this.pos.y >= b.max.y - 1.2) {
        this.pos.y = b.max.y; this.vel.y = 0; this.onGround = true;
      }
    }
  }

  _updateRemotes(dt) {
    for (const r of this.remote.values()) {
      r.group.position.lerp(r.target, Math.min(1, dt * 12));
      let diff = r.targetYaw - r.group.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      r.group.rotation.y += diff * Math.min(1, dt * 12);
    }
  }

  _updateTracers(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life -= dt;
      tr.line.material.opacity = Math.max(0, tr.life / 0.08) * 0.9;
      if (tr.life <= 0) {
        this.scene.remove(tr.line);
        tr.line.geometry.dispose();
        tr.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
  }

  _updateLoot(dt) {
    let nearest = null, nearestD = PICKUP_RANGE;
    for (const l of this.lootMeshes.values()) {
      l.mesh.rotation.y += dt * 1.5;
      const d = Math.hypot(this.pos.x - l.item.x, this.pos.z - l.item.z);
      if (d < nearestD) { nearestD = d; nearest = l; }
    }
    if (nearest !== this.nearbyLoot) {
      this.nearbyLoot = nearest;
      if (this.cb.onNearbyLoot) this.cb.onNearbyLoot(nearest ? nearest.item : null);
    }
  }

  _updateHeal() {
    if (!this.healing) return;
    const now = performance.now();
    const frac = 1 - Math.max(0, (this.healing.until - now)) / this.healing.total;
    if (this.cb.onHealProgress) this.cb.onHealProgress(Math.min(1, frac), this.healing.key);
  }

  _sendInput() {
    const now = performance.now();
    if (now - this._lastInputSent < 50) return;
    this._lastInputSent = now;
    if (!this.alive) return;
    const moving = !!(this.keys['KeyW'] || this.keys['KeyA'] || this.keys['KeyS'] || this.keys['KeyD']);
    this.net.send({
      t: 'input',
      pos: { x: this.pos.x, y: this.pos.y + EYE_HEIGHT, z: this.pos.z },
      rot: { x: this.pitch, y: this.yaw },
      moving,
    });
  }

  // ---- HUD / minimap ------------------------------------------------------
  _updateHud() {
    const wid = this.inv.current;
    const w = WEAPONS[wid] || WEAPONS.pistol;
    if (this.cb.onHp) this.cb.onHp(this.hp);
    if (this.cb.onShield) this.cb.onShield(this.shield);
    if (this.cb.onAmmo) this.cb.onAmmo(this.inv.mag[wid] || 0, this.inv.ammo[w.ammoType] || 0);
    if (this.cb.onKills) this.cb.onKills(this.kills);
    if (this.cb.onWeapon) this.cb.onWeapon(this.inv, w);
    if (this.cb.onHeals) this.cb.onHeals(this.inv.heals);
  }

  _drawMinimap() {
    const cv = document.getElementById('minimap');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const S = this.mapSize;
    const toMap = (x, z) => [((x / S) * 0.5 + 0.5) * W, ((z / S) * 0.5 + 0.5) * H];
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);

    // loot dots
    ctx.fillStyle = 'rgba(255,210,77,0.6)';
    for (const l of this.lootMeshes.values()) {
      const [lx, lz] = toMap(l.item.x, l.item.z);
      ctx.fillRect(lx - 1, lz - 1, 2, 2);
    }

    if (this.ringData) {
      const [rx, rz] = toMap(this.ringData.x, this.ringData.z);
      ctx.strokeStyle = '#4dc3ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(rx, rz, (this.ringData.radius / S) * 0.5 * W, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#ff5a3c';
    for (const r of this.remote.values()) {
      if (!r.alive) continue;
      const [ex, ez] = toMap(r.group.position.x, r.group.position.z);
      ctx.beginPath(); ctx.arc(ex, ez, 3, 0, Math.PI * 2); ctx.fill();
    }
    const [sx, sz] = toMap(this.pos.x, this.pos.z);
    ctx.save();
    ctx.translate(sx, sz);
    ctx.rotate(-this.yaw);
    ctx.fillStyle = '#39d353';
    ctx.beginPath();
    ctx.moveTo(0, -5); ctx.lineTo(4, 4); ctx.lineTo(-4, 4); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }
}
