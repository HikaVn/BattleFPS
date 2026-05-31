// Network layer with two interchangeable transports behind one interface:
//
//   • WebSocket  — when a Node backend (server/server.js) is serving the page.
//   • WebRTC P2P — for static hosting (GitHub Pages) with no backend. The
//                  player who creates the room becomes the authoritative host
//                  and runs the shared GameRoom in their browser; everyone
//                  else connects to them over a PeerJS data channel.
//
// main.js uses the same API for both: net.on(type, fn), net.send(obj), and
// the create/join messages. The transport is chosen automatically: we try a
// WebSocket first and fall back to P2P if no backend answers (or honour an
// explicit ?net=ws / ?net=p2p override).
import { GameRoom, sanitizeName } from './game-core.js';

const HOST_ID = 'h';                 // local player id for the P2P host
const PEER_PREFIX = 'bfps-';         // namespace so room codes are short
const PEERJS_CDN = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

let _peerLib = null;
function loadPeerJS() {
  if (_peerLib) return _peerLib;
  _peerLib = new Promise((resolve, reject) => {
    if (window.Peer) return resolve(window.Peer);
    const s = document.createElement('script');
    s.src = PEERJS_CDN;
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS load failed')));
    s.onerror = () => reject(new Error('PeerJS CDN unreachable'));
    document.head.appendChild(s);
  });
  return _peerLib;
}

export class Net {
  constructor() {
    this.handlers = {};
    this.connected = false;
    this.mode = null;        // 'ws' | 'p2p'
    this.queue = [];

    // ws
    this.ws = null;
    // p2p
    this.peer = null;
    this.isHost = false;
    this.room = null;        // GameRoom (host only)
    this.conns = new Map();  // host: playerId -> DataConnection
    this.hostConn = null;    // joiner: connection to host
    this.nextPid = 1;

    const override = new URLSearchParams(location.search).get('net');
    this.forced = (override === 'ws' || override === 'p2p') ? override : null;
  }

  on(type, fn) { this.handlers[type] = fn; return this; }
  _emit(msg) { const fn = this.handlers[msg.t]; if (fn) fn(msg); }

  // connect() resolves immediately; the real transport is established lazily
  // on the first create/join so we can probe for a backend then fall back.
  connect() { this.connected = true; return Promise.resolve(); }

  // ---- public send --------------------------------------------------------
  send(obj) {
    if (obj.t === 'create') { this._begin('create', obj); return; }
    if (obj.t === 'join') { this._begin('join', obj); return; }

    if (this.mode === 'ws') {
      const data = JSON.stringify(obj);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
      else this.queue.push(data);
    } else if (this.mode === 'p2p') {
      if (this.isHost) this.room.handleMessage(HOST_ID, obj);
      else if (this.hostConn && this.hostConn.open) this.hostConn.send(obj);
    }
  }

  // ---- transport selection ------------------------------------------------
  async _begin(kind, obj) {
    if (this.mode) { this._dispatchCreateJoin(kind, obj); return; }

    if (this.forced === 'ws') { await this._startWs(kind, obj); return; }
    if (this.forced === 'p2p') { await this._startP2P(kind, obj); return; }

    // Auto: try WebSocket, fall back to P2P if no backend answers.
    const ok = await this._tryWsHandshake();
    if (ok) await this._startWs(kind, obj, true);
    else await this._startP2P(kind, obj);
  }

  _dispatchCreateJoin(kind, obj) {
    if (this.mode === 'ws') {
      this.ws.send(JSON.stringify(obj));
    } else if (kind === 'create') {
      this._p2pCreate(obj.name);
    } else {
      this._p2pJoin(obj.room, obj.name);
    }
  }

  // Probe a WebSocket to the current origin; resolve true if it opens quickly.
  _tryWsHandshake() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let ws;
      try {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${location.host}`);
      } catch { return finish(false); }
      const timer = setTimeout(() => { try { ws.close(); } catch {} finish(false); }, 2500);
      ws.onopen = () => { clearTimeout(timer); this._pendingWs = ws; finish(true); };
      ws.onerror = () => { clearTimeout(timer); finish(false); };
    });
  }

  // ---- WebSocket mode -----------------------------------------------------
  async _startWs(kind, obj, reuse = false) {
    this.mode = 'ws';
    if (reuse && this._pendingWs) { this.ws = this._pendingWs; this._pendingWs = null; }
    else {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}`);
      await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    }
    this.ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } this._emit(m); };
    this.ws.onclose = () => { this.connected = false; this._emit({ t: 'close' }); };
    for (const m of this.queue) this.ws.send(m);
    this.queue = [];
    this.ws.send(JSON.stringify(obj));
  }

  // ---- P2P mode -----------------------------------------------------------
  async _startP2P(kind, obj) {
    this.mode = 'p2p';
    try { await loadPeerJS(); }
    catch { this._emit({ t: 'error', msg: 'P2P接続ライブラリを読み込めませんでした。' }); return; }
    if (kind === 'create') this._p2pCreate(obj.name);
    else this._p2pJoin(obj.room, obj.name);
  }

  _p2pTransport() {
    return {
      broadcast: (msg, exceptId = null) => {
        for (const [pid, conn] of this.conns) {
          if (pid === exceptId) continue;
          if (conn.open) conn.send(msg);
        }
        if (exceptId !== HOST_ID) this._emit(msg); // deliver to host's own UI
      },
      sendTo: (id, msg) => {
        if (id === HOST_ID) { this._emit(msg); return; }
        const conn = this.conns.get(id);
        if (conn && conn.open) conn.send(msg);
      },
    };
  }

  _p2pCreate(name, attempt = 0) {
    const code = makeCode();
    const peer = new window.Peer(PEER_PREFIX + code);
    this.peer = peer;
    this.isHost = true;

    peer.on('open', () => {
      this.room = new GameRoom(code, this._p2pTransport());
      this.room.addPlayer(HOST_ID, sanitizeName(name)); // emits 'joined' to host UI
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {});
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'join') {
          if (this.room.phase === 'playing') { conn.send({ t: 'error', msg: 'ゲームは既に進行中です' }); return; }
          const pid = 'p' + (this.nextPid++);
          conn._pid = pid;
          this.conns.set(pid, conn);
          this.room.addPlayer(pid, sanitizeName(msg.name));
        } else if (conn._pid) {
          this.room.handleMessage(conn._pid, msg);
        }
      });
      conn.on('close', () => {
        if (conn._pid) { this.room.removePlayer(conn._pid); this.conns.delete(conn._pid); }
      });
    });

    peer.on('error', (err) => {
      if (err && err.type === 'unavailable-id' && attempt < 5) {
        try { peer.destroy(); } catch {}
        this._p2pCreate(name, attempt + 1);
      } else {
        this._emit({ t: 'error', msg: 'ルーム作成に失敗しました（' + (err && err.type || 'error') + '）' });
      }
    });
  }

  _p2pJoin(code, name) {
    code = String(code || '').toUpperCase().trim();
    const peer = new window.Peer();
    this.peer = peer;
    this.isHost = false;

    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      this.hostConn = conn;
      let opened = false;
      const failTimer = setTimeout(() => {
        if (!opened) this._emit({ t: 'error', msg: 'ルームが見つかりません: ' + code });
      }, 8000);
      conn.on('open', () => { opened = true; clearTimeout(failTimer); conn.send({ t: 'join', name: sanitizeName(name) }); });
      conn.on('data', (msg) => { if (msg && typeof msg === 'object') this._emit(msg); });
      conn.on('close', () => { this.connected = false; this._emit({ t: 'close' }); });
      conn.on('error', () => { clearTimeout(failTimer); this._emit({ t: 'error', msg: 'ホストへ接続できませんでした。' }); });
    });

    peer.on('error', (err) => {
      const t = err && err.type;
      if (t === 'peer-unavailable') this._emit({ t: 'error', msg: 'ルームが見つかりません: ' + code });
      else this._emit({ t: 'error', msg: '接続エラー（' + (t || 'error') + '）' });
    });
  }
}
