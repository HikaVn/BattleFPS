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

// ---------------------------------------------------------------------------
// Procedural textures (canvas-generated so the game needs no external art and
// works offline on GitHub Pages). Each returns a cached THREE.CanvasTexture.
// ---------------------------------------------------------------------------
const _procTexCache = new Map();
function _canvasTex(key, size, draw) {
  if (_procTexCache.has(key)) return _procTexCache.get(key);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  _procTexCache.set(key, tex);
  return tex;
}

// Grass / dirt ground: mottled greens with darker dirt speckles.
function grassTexture() {
  return _canvasTex('grass', 512, (ctx, S) => {
    ctx.fillStyle = '#43662f';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      const g = 70 + Math.random() * 90;
      const r = 30 + Math.random() * 40;
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${(28 + Math.random() * 30) | 0},0.5)`;
      ctx.fillRect(x, y, 1.5, 1.5 + Math.random() * 2);
    }
    // a few dirt patches
    for (let i = 0; i < 24; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 12 + Math.random() * 40;
      const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(96,74,48,0.45)');
      grd.addColorStop(1, 'rgba(96,74,48,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  });
}

// Building facade: concrete base with a grid of lit/dark windows.
function buildingTexture(key, baseColor, floors, cols) {
  return _canvasTex(key, 256, (ctx, S) => {
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, S, S);
    // subtle concrete noise
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
      ctx.fillRect(Math.random() * S, Math.random() * S, 2, 2);
    }
    const mx = S * 0.12, my = S * 0.12;
    const gw = (S - mx * 2) / cols, gh = (S - my * 2) / floors;
    for (let r = 0; r < floors; r++) {
      for (let c = 0; c < cols; c++) {
        const x = mx + c * gw + gw * 0.16;
        const y = my + r * gh + gh * 0.16;
        const w = gw * 0.68, h = gh * 0.68;
        const lit = Math.random() < 0.32;
        ctx.fillStyle = lit ? `rgba(${230 + Math.random() * 25 | 0},${210 + Math.random() * 30 | 0},150,0.95)`
                            : 'rgba(35,45,58,0.92)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
      }
    }
  });
}

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
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    // Horizon colour shared by the sky dome and the distance fog so the world
    // fades seamlessly into the sky.
    this._horizon = new THREE.Color(0xbcd6ea);
    this.scene = new THREE.Scene();
    this.scene.background = this._horizon.clone();
    this.scene.fog = new THREE.Fog(this._horizon.clone(), 120, 340);

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
    this.touchMode = false;     // mobile: bypass pointer lock, use virtual controls
    this.moveX = 0;             // touch joystick strafe (-1..1)
    this.moveZ = 0;             // touch joystick forward (-1..1, + = forward)
    this.sprinting = false;     // touch: joystick pushed to edge
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
  requestLock() { if (!this.touchMode) this.canvas.requestPointerLock(); }

  // ---- touch / mobile API -------------------------------------------------
  enableTouch() {
    this.touchMode = true;
    this.locked = true;        // touch controls are always "active"
  }
  // Virtual joystick vector, components in -1..1 (z+ = forward / W).
  setMoveAxis(x, z, sprint) {
    this.moveX = Math.max(-1, Math.min(1, x));
    this.moveZ = Math.max(-1, Math.min(1, z));
    this.sprinting = !!sprint;
  }
  // Look delta in pixels from a drag on the right half of the screen.
  applyLook(dx, dy) {
    const s = 0.005;
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    const lim = Math.PI / 2 - 0.05;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }
  setFiring(on) { this._mouseDown = !!on; }
  touchJump() { if (this.alive && this.onGround) { this.vel.y = JUMP_VELOCITY; this.onGround = false; } }
  touchReload() { this._reload(); }
  touchPickup() { this._tryPickup(); }
  touchHeal(key) { this.net.send({ t: 'useHeal', key }); }
  touchSwitchNext() {
    const idx = this.inv.weapons.indexOf(this.inv.current);
    this._switchSlot((idx + 1) % this.inv.weapons.length);
  }

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

    // ---- lighting: warm sun + cool sky fill ----
    const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4a5a3a, 0.75);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d6, 2.0);
    sun.position.set(120, 180, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
    sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
    sun.shadow.camera.near = 10; sun.shadow.camera.far = 600;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);

    // ---- sky dome (gradient) + sun glow + clouds ----
    this._buildSky(S, sun.position);

    // ---- ground: tiled procedural grass ----
    const grassTex = grassTexture();
    grassTex.repeat.set(S / 6, S / 6);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(S * 2.4, S * 2.4),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // ---- perimeter walls (concrete) ----
    const concrete = buildingTexture('wall-concrete', '#8a8f96', 4, 8);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.9 });
    const wallH = 10, t = 2;
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

    // ---- buildings: textured facades with darker flat roofs ----
    const facades = [
      buildingTexture('fac-a', '#9a8f80', 6, 5),
      buildingTexture('fac-b', '#7f8a92', 7, 4),
      buildingTexture('fac-c', '#a8978a', 5, 6),
      buildingTexture('fac-d', '#8b9aa0', 8, 4),
      buildingTexture('fac-e', '#b3a596', 6, 5),
    ];
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3b4047, roughness: 0.95 });
    const count = 46;
    for (let i = 0; i < count; i++) {
      const w = 5 + rng() * 16;
      const d = 5 + rng() * 16;
      const h = 5 + rng() * 22;
      const x = (rng() * 2 - 1) * S * 0.85;
      const z = (rng() * 2 - 1) * S * 0.85;
      if (Math.hypot(x, z) < 12) continue;

      // Facade texture tiled by building size so windows stay roughly uniform.
      const tex = facades[Math.floor(rng() * facades.length)].clone();
      tex.needsUpdate = true;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(h / 5)));
      const sideMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.05 });
      // top/bottom use the plain roof material; sides use the facade
      const mats = [sideMat, sideMat, roofMat, roofMat, sideMat, sideMat];
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
      box.position.set(x, h / 2, z);
      box.castShadow = true; box.receiveShadow = true;
      this.scene.add(box);
      this.boxMeshes.push(box);
      this.colliders.push({ min: new THREE.Vector3(x - w / 2, 0, z - d / 2), max: new THREE.Vector3(x + w / 2, h, z + d / 2) });

      // a slightly overhanging roof cap for a bit of silhouette detail
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.5, d + 0.6), roofMat);
      cap.position.set(x, h + 0.25, z);
      cap.castShadow = true;
      this.scene.add(cap);
    }

    // Gun viewmodel attached to the camera (rebuilt when weapon changes).
    this.gun = new THREE.Group();
    this.camera.add(this.gun);
    this.scene.add(this.camera);
    this._updateGunModel();
  }

  // Large inward-facing sky dome with a vertical gradient (deep blue zenith ->
  // pale horizon), a soft sun disc/glow and a few drifting cloud sprites.
  _buildSky(S, sunPos) {
    const sky = _canvasTex('sky', 512, (ctx, T) => {
      const g = ctx.createLinearGradient(0, 0, 0, T);
      g.addColorStop(0.0, '#2a6fc4');   // zenith
      g.addColorStop(0.45, '#79b0e4');
      g.addColorStop(0.7, '#bcd6ea');   // horizon (matches fog)
      g.addColorStop(1.0, '#cfe0ee');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, T, T);
    });
    sky.wrapS = sky.wrapT = THREE.ClampToEdgeWrapping;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(480, 32, 16),
      new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.scene.add(dome);

    // Sun disc + glow billboard placed in the sun's direction.
    const dir = sunPos.clone().normalize().multiplyScalar(440);
    const glowTex = _canvasTex('sunglow', 256, (ctx, T) => {
      const grd = ctx.createRadialGradient(T / 2, T / 2, 0, T / 2, T / 2, T / 2);
      grd.addColorStop(0, 'rgba(255,250,230,1)');
      grd.addColorStop(0.18, 'rgba(255,245,210,0.95)');
      grd.addColorStop(0.5, 'rgba(255,235,180,0.35)');
      grd.addColorStop(1, 'rgba(255,235,180,0)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, T, T);
    });
    const sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    sunSpr.position.copy(dir);
    sunSpr.scale.set(150, 150, 1);
    this.scene.add(sunSpr);

    // Drifting clouds: soft white blobs on billboards high in the sky.
    const cloudTex = _canvasTex('cloud', 256, (ctx, T) => {
      ctx.clearRect(0, 0, T, T);
      for (let i = 0; i < 14; i++) {
        const x = T * (0.2 + Math.random() * 0.6);
        const y = T * (0.35 + Math.random() * 0.3);
        const r = T * (0.08 + Math.random() * 0.13);
        const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(255,255,255,0.95)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    });
    this.clouds = [];
    for (let i = 0; i < 12; i++) {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.8, fog: false, depthWrite: false }));
      const a = Math.random() * Math.PI * 2;
      const rad = 220 + Math.random() * 180;
      spr.position.set(Math.cos(a) * rad, 120 + Math.random() * 90, Math.sin(a) * rad);
      const sc = 80 + Math.random() * 120;
      spr.scale.set(sc, sc * 0.55, 1);
      spr.userData.drift = 1 + Math.random() * 2;
      this.scene.add(spr);
      this.clouds.push(spr);
    }
  }

  _updateGunModel() {
    if (!this.gun) return;
    while (this.gun.children.length) this.gun.remove(this.gun.children[0]);
    const w = WEAPONS[this.inv.current] || WEAPONS.pistol;

    // Weapon viewmodel: the generated PNG mapped onto a camera-facing plane.
    // Falls back to a simple box model if the texture is missing.
    const url = lootImage('weapon', this.inv.current);
    let usedTexture = false;
    if (url) {
      const tex = loadItemTexture(url);
      if (tex) {
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide });
        // wide plane so the side-on gun art reads clearly in the lower-right
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.5), mat);
        plane.position.set(0.34, -0.34, -0.78);
        plane.renderOrder = 10;
        this.gun.add(plane);
        usedTexture = true;
      }
    }
    if (!usedTexture) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x222831 });
      const accent = new THREE.MeshStandardMaterial({ color: w.color });
      const len = 0.5 + Math.min(1.2, w.range / 300);
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, len), mat);
      barrel.position.set(0.32, -0.28, -0.5 - len / 2);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.5), accent);
      body.position.set(0.32, -0.32, -0.4);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.16), mat);
      grip.position.set(0.32, -0.5, -0.3);
      this.gun.add(barrel); this.gun.add(body); this.gun.add(grip);
    }

    // Muzzle flash sprite at the barrel tip — hidden until a shot fires.
    const flashMat = new THREE.SpriteMaterial({ color: 0xffd86b, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending });
    this.muzzle = new THREE.Sprite(flashMat);
    this.muzzle.scale.set(0.5, 0.5, 0.5);
    this.muzzle.position.set(0.34, -0.3, -1.25);
    this.muzzle.renderOrder = 11;
    this.gun.add(this.muzzle);
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
    if (this.muzzle) { this.muzzle.material.opacity = 1; this.muzzle.scale.setScalar(0.35 + Math.random() * 0.3); }
  }

  _spawnTracer(a, b, color) {
    const dir = b.clone().sub(a);
    const dist = dir.length();
    if (dist < 0.001) return;
    dir.normalize();
    const mid = a.clone().add(b).multiplyScalar(0.5);

    // Glowing beam: a thin cylinder oriented along the shot, additively blended
    // so it reads as a bright streak. Much more visible than a 1px line.
    const beamGeo = new THREE.CylinderGeometry(0.05, 0.05, dist, 6, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.copy(mid);
    // cylinder's default axis is +Y; rotate it to align with the shot direction
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.scene.add(beam);

    // A bright "bullet" round that streaks from the muzzle to the impact point.
    const dotMat = new THREE.SpriteMaterial({
      color: 0xffffff, transparent: true, opacity: 1, depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const dot = new THREE.Sprite(dotMat);
    dot.scale.set(0.4, 0.4, 0.4);
    dot.position.copy(a);
    this.scene.add(dot);

    // Impact flash at the hit point.
    const hitMat = new THREE.SpriteMaterial({
      color, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending,
    });
    const hit = new THREE.Sprite(hitMat);
    hit.scale.set(0.8, 0.8, 0.8);
    hit.position.copy(b);
    this.scene.add(hit);

    this.tracers.push({
      beam, dot, hit, from: a.clone(), to: b.clone(),
      life: 0.18, max: 0.18, travel: 0, speed: 320, dist,
    });
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
    this._updateClouds(dt);
    this._sendInput();
    this._drawMinimap();
    this.renderer.render(this.scene, this.camera);
  }

  _updateClouds(dt) {
    if (!this.clouds) return;
    const lim = 460;
    for (const c of this.clouds) {
      c.position.x += c.userData.drift * dt;
      if (c.position.x > lim) c.position.x = -lim;
    }
  }

  _updateMovement(dt) {
    if (this.gun && this.gun.position.z > 0) this.gun.position.z = Math.max(0, this.gun.position.z - dt * 0.9);
    if (this.muzzle && this.muzzle.material.opacity > 0) {
      this.muzzle.material.opacity = Math.max(0, this.muzzle.material.opacity - dt * 18);
    }

    const canMove = this.alive && this.locked && !this.healing;
    if (canMove) {
      let forward, strafe, sprint;
      if (this.touchMode) {
        forward = this.moveZ; strafe = this.moveX; sprint = this.sprinting;
      } else {
        forward = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
        strafe = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
        sprint = this.keys['ShiftLeft'];
      }
      const speed = sprint ? SPRINT_SPEED : MOVE_SPEED;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      let dx = (-sin * forward + cos * strafe);
      let dz = (-cos * forward - sin * strafe);
      const len = Math.hypot(dx, dz);
      if (len > 1) { dx /= len; dz /= len; } // allow analog (len<1) speed on touch
      this.vel.x = dx * speed;
      this.vel.z = dz * speed;
      if (!this.touchMode && this.keys['Space'] && this.onGround) { this.vel.y = JUMP_VELOCITY; this.onGround = false; }
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
      const f = Math.max(0, tr.life / tr.max);   // 1 -> 0

      // beam streak fades out
      tr.beam.material.opacity = f * 0.85;

      // bullet round travels along the path, then disappears at impact
      tr.travel += tr.speed * dt;
      if (tr.travel < tr.dist) {
        const p = tr.from.clone().lerp(tr.to, tr.travel / tr.dist);
        tr.dot.position.copy(p);
        tr.dot.material.opacity = 1;
      } else {
        tr.dot.material.opacity = 0;
        // trigger impact flash once the round arrives
        tr.hit.material.opacity = Math.min(1, f * 2);
      }

      if (tr.life <= 0) {
        for (const o of [tr.beam, tr.dot, tr.hit]) {
          this.scene.remove(o);
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        }
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
