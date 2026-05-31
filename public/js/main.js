// App entry: wires the menu / lobby / HUD UI to the network and game engine.
import { Net } from './net.js';
import { Game } from './game.js';
import { Tutorial } from './tutorial.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { WEAPONS, HEALS, lootImage } from './shared.js';

const $ = (id) => document.getElementById(id);

const state = {
  selfId: null,
  room: null,
  hostId: null,
  phase: 'menu',
  name: '',
  solo: false,
};

const net = new Net();
let game = null;
const tutorial = new Tutorial(net, () => game);
const isTouch = isTouchDevice();
let touch = null;

// Swap the menu hint for the touch-specific one on mobile.
if (isTouch) {
  const hd = document.getElementById('hint-desktop');
  const ht = document.getElementById('hint-touch');
  if (hd) hd.style.display = 'none';
  if (ht) ht.style.display = 'block';
}

// ---- UI helpers -----------------------------------------------------------
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function showOverlay(which) {
  for (const id of ['menu', 'lobby']) {
    if (id === which) show($(id)); else hide($(id));
  }
}
function setHud(on) { $('hud').classList.toggle('active', on); }

function centerMsg(title, sub, ms) {
  $('center-title').textContent = title;
  $('center-sub').textContent = sub || '';
  $('center-msg').classList.add('show');
  if (ms) setTimeout(() => $('center-msg').classList.remove('show'), ms);
}
function hideCenter() { $('center-msg').classList.remove('show'); }

function addKillFeed(text, mine) {
  const feed = $('killfeed');
  const div = document.createElement('div');
  if (mine) div.className = 'me';
  div.textContent = text;
  feed.prepend(div);
  while (feed.children.length > 6) feed.removeChild(feed.lastChild);
  setTimeout(() => div.remove(), 6000);
}

function addChat(name, msg) {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.innerHTML = `<span class="name"></span> `;
  div.querySelector('.name').textContent = name + ':';
  div.append(document.createTextNode(msg));
  log.append(div);
  while (log.children.length > 8) log.removeChild(log.firstChild);
}

// ---- Menu actions ---------------------------------------------------------
function getName() {
  const n = $('name-input').value.trim();
  return n || ('Player' + Math.floor(Math.random() * 1000));
}

async function ensureConnected() {
  if (net.connected) return;
  try {
    await net.connect();
  } catch {
    $('menu-error').textContent = 'サーバーに接続できませんでした。';
    throw new Error('connect failed');
  }
}

$('tutorial-btn').onclick = () => {
  $('menu-error').textContent = '';
  state.name = getName();
  state.solo = true;
  tutorial.begin(state.name);   // emits solo 'joined' -> 'started'
};

$('create-btn').onclick = async () => {
  $('menu-error').textContent = '';
  state.solo = false;
  state.name = getName();
  await ensureConnected();
  net.send({ t: 'create', name: state.name });
};

$('join-btn').onclick = async () => {
  $('menu-error').textContent = '';
  const code = $('room-input').value.trim().toUpperCase();
  if (code.length < 3) { $('menu-error').textContent = 'ルームコードを入力してください。'; return; }
  state.name = getName();
  await ensureConnected();
  net.send({ t: 'join', name: state.name, room: code });
};

$('start-btn').onclick = () => net.send({ t: 'start' });
$('leave-btn').onclick = () => location.reload();

// allow Enter to join from the code field
$('room-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });

// ---- Lobby rendering ------------------------------------------------------
function renderLobby(players) {
  const ul = $('player-list');
  ul.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.textContent = p.name + (p.id === state.selfId ? '（あなた）' : '');
    li.append(nm);
    if (p.id === state.hostId) {
      const b = document.createElement('span');
      b.className = 'badge'; b.textContent = 'ホスト';
      li.append(b);
    }
    ul.append(li);
  }
  const isHost = state.selfId === state.hostId;
  $('start-btn').style.display = isHost ? 'block' : 'none';
  $('lobby-hint').textContent = isHost
    ? '準備ができたら「ゲーム開始」を押してください。1人でもテストプレイ可能です。'
    : 'ホストの開始を待っています…';
}

// ---- Game lifecycle -------------------------------------------------------
function enterGame(opts) {
  setHud(true);
  showOverlay(null);
  hideCenter();
  if (!game) {
    game = new Game(net, makeCallbacks());
  }
  game.build({ selfId: state.selfId, mapSize: opts.mapSize, spawn: opts.spawn, seed: state.room, inv: opts.inv, loot: opts.loot });
  game.start();
  if (isTouch) {
    // Mobile: show on-screen controls, no pointer lock needed.
    if (!touch) touch = new TouchControls(game);
    touch.attach();
    touch.syncInventory(opts.inv || game.inv);
    $('lock-hint').classList.remove('show');
  } else {
    // Desktop: require a click to lock the pointer.
    $('lock-hint').classList.add('show');
  }
}

function makeCallbacks() {
  return {
    onHp: (hp) => {
      $('health-num').textContent = Math.max(0, Math.round(hp));
      $('health-fill').style.width = Math.max(0, hp) + '%';
      $('health-fill').style.background = hp > 50
        ? 'linear-gradient(90deg,#39d353,#26a641)'
        : hp > 25 ? 'linear-gradient(90deg,#ffb33c,#ff8c1a)' : 'linear-gradient(90deg,#ff5a3c,#d11)';
    },
    onShield: (sh) => {
      $('shield-num').textContent = Math.round(sh) > 0 ? '🛡' + Math.round(sh) : '';
      $('shield-fill').style.width = Math.max(0, sh) + '%';
    },
    onAmmo: (mag, reserve) => {
      $('ammo-mag').textContent = mag;
      $('ammo-reserve').textContent = '/ ' + reserve;
    },
    onKills: (k) => { $('kill-count').textContent = k; },
    onAlive: (n) => { $('alive-count').textContent = n; },
    onWeapon: (inv, w) => {
      $('weapon-name').textContent = w.name;
      const slots = $('weapon-slots');
      slots.innerHTML = '';
      inv.weapons.forEach((wid, i) => {
        const d = document.createElement('span');
        d.className = 'wslot' + (wid === inv.current ? ' active' : '');
        const url = lootImage('weapon', wid);
        if (url) {
          const img = document.createElement('img');
          img.src = url; img.alt = '';
          img.onerror = () => { img.remove(); };
          d.append(img);
        }
        d.append(document.createTextNode((i + 1) + '·' + (WEAPONS[wid] ? WEAPONS[wid].name : wid)));
        slots.append(d);
      });
    },
    onHeals: (heals) => {
      for (const key of Object.keys(HEALS)) {
        const el = $('heal-' + key);
        if (el) el.textContent = heals[key] || 0;
        const item = document.querySelector(`.heal-item[data-key="${key}"]`);
        if (item) item.classList.toggle('empty', !(heals[key] > 0));
      }
      if (touch && game) touch.syncInventory(game.inv);
    },
    onReload: (on) => { $('reload-note').textContent = on ? 'リロード中…' : ''; },
    onHurt: () => {
      const f = $('damage-flash');
      f.style.background = 'rgba(255,40,30,0.35)';
      setTimeout(() => { f.style.background = 'rgba(255,40,30,0)'; }, 120);
    },
    onHitConfirm: () => {
      const c = $('crosshair');
      c.classList.add('hit');
      setTimeout(() => c.classList.remove('hit'), 120);
    },
    onNearbyLoot: (item) => {
      const p = $('pickup-prompt');
      if (!item) { p.classList.remove('show'); return; }
      const icon = $('pickup-icon');
      const url = lootImage(item.type, item.key);
      if (url) { icon.src = url; icon.style.display = 'inline-block'; icon.onerror = () => { icon.style.display = 'none'; }; }
      else icon.style.display = 'none';
      $('pickup-text').textContent = lootLabel(item);
      p.classList.add('show');
    },
    onHealProgress: (frac, key) => {
      const bar = $('heal-bar');
      if (frac <= 0) { bar.classList.remove('show'); return; }
      bar.classList.add('show');
      $('heal-bar-fill').style.width = (frac * 100) + '%';
      $('heal-bar-label').textContent = key && HEALS[key] ? HEALS[key].name + ' 使用中…' : '回復中…';
    },
    onRing: (inside, radius) => {
      $('ring-info').textContent = inside ? '' : '⚠ リング外！中心へ移動せよ';
    },
    onLockChange: (locked) => {
      $('lock-hint').classList.toggle('show', !locked && game && game.alive);
    },
  };
}

function lootLabel(item) {
  if (item.type === 'weapon') return (WEAPONS[item.key] || {}).name || item.key;
  if (item.type === 'ammo') {
    const names = { light: 'ライト弾', shell: 'シェル', heavy: 'ヘビー弾' };
    return (names[item.key] || item.key) + ' x' + item.amount;
  }
  if (item.type === 'armor') return 'ボディシールド';
  return (HEALS[item.key] || {}).name || item.key;
}

$('lock-hint').onclick = () => { if (game) game.requestLock(); };
$('game-canvas').addEventListener('click', () => { if (game && game.alive && !game.locked) game.requestLock(); });

// ---- Chat -----------------------------------------------------------------
const chatInput = $('chat-input');
addEventListener('keydown', (e) => {
  if (state.phase !== 'playing') return;
  if (e.code === 'Enter') {
    if (chatInput.classList.contains('show')) {
      const v = chatInput.value.trim();
      if (v) net.send({ t: 'chat', msg: v });
      chatInput.value = '';
      chatInput.classList.remove('show');
      chatInput.blur();
      if (game && game.alive) game.requestLock();
    } else {
      chatInput.classList.add('show');
      chatInput.focus();
      if (document.exitPointerLock) document.exitPointerLock();
    }
  } else if (e.code === 'Escape' && chatInput.classList.contains('show')) {
    chatInput.classList.remove('show');
    chatInput.blur();
  }
});

// ---- Network handlers -----------------------------------------------------
net.on('joined', (m) => {
  state.selfId = m.id;
  state.room = m.room;
  state.hostId = m.hostId;
  state.phase = m.phase;
  // Solo tutorial skips the lobby and goes straight into the dojo.
  if (state.solo) return;
  $('lobby-code').textContent = m.room;
  const modeEl = $('net-mode');
  if (modeEl) {
    modeEl.textContent = net.mode === 'p2p'
      ? 'P2P接続（サーバー不要・ホストのブラウザが進行役）'
      : 'サーバー接続';
  }
  showOverlay('lobby');
  renderLobby(m.players);
});

net.on('roomUpdate', (m) => {
  state.hostId = m.hostId;
  state.phase = m.phase;
  if (m.phase === 'lobby') {
    setHud(false);
    showOverlay('lobby');
    renderLobby(m.players);
  }
});

net.on('started', (m) => {
  state.phase = 'playing';
  enterGame({ mapSize: m.mapSize, spawn: m.spawn, inv: m.inv, loot: m.loot });
  if (state.solo) {
    tutorial.onStarted(m);
  } else {
    centerMsg('GAME START', '武器を拾って最後の1人になれ！', 2500);
  }
});

net.on('state', (m) => {
  if (game) game.setState(m);
  if (state.solo) tutorial.onState(m);
});

net.on('shoot', (m) => {
  if (game) game.remoteShoot(m.origin, m.dir, m.weapon);
});

net.on('hurt', (m) => {
  if (game) game.setVitals(m.hp, m.shield);
});

// inventory / loot / heal events
net.on('invUpdate', (m) => { if (game) game.setInventory(m.inv); });
net.on('lootSpawn', (m) => { if (game) game.addLoot(m.item); });
net.on('lootGone', (m) => { if (game) game.removeLoot(m.id); });
net.on('healStart', (m) => { if (game) { game.healStart(m.key, m.time); game.setInventory(m.inv); } });
net.on('healDone', (m) => { if (game) { game.healDone(); game.setVitals(m.hp, m.shield); game.setInventory(m.inv); } });
net.on('healCancel', () => { if (game) game.healCancel(); });

net.on('kill', (m) => {
  const mine = m.killer === state.selfId || m.victim === state.selfId;
  const killer = m.killerName || 'リング';
  addKillFeed(`${killer} ☠ ${m.victimName}`, mine);
  if (m.victim === state.selfId) {
    game.setDead();
    centerMsg('YOU DIED', '観戦モード — リスポーンを待っています…');
  }
  if (m.killer === state.selfId) {
    // brief hit confirm
    const f = $('damage-flash');
    f.style.background = 'rgba(60,255,90,0.12)';
    setTimeout(() => { f.style.background = 'rgba(255,40,30,0)'; }, 100);
  }
});

net.on('gameover', (m) => {
  state.phase = 'ended';
  const won = m.winner && m.winner.id === state.selfId;
  centerMsg(won ? '#1 VICTORY ROYALE' : 'GAME OVER',
    m.winner ? `勝者: ${m.winner.name}` : '引き分け', 7000);
  setTimeout(() => { if (document.exitPointerLock) document.exitPointerLock(); }, 100);
});

net.on('left', (m) => { if (game) game.removePlayer(m.id); });

net.on('error', (m) => { $('menu-error').textContent = m.msg; });

net.on('close', () => {
  if (state.phase !== 'menu') {
    $('menu-error').textContent = 'サーバーとの接続が切れました。';
    showOverlay('menu');
    setHud(false);
  }
});
