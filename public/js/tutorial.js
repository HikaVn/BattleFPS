// Solo tutorial / practice mode.
//
// Runs a real GameRoom locally (Net.startSolo) so every mechanic taught here
// behaves exactly like online play. The controller adds stationary training
// dummies, lays out curated loot near the spawn, and walks the player through
// movement, shooting, reloading, looting, weapon swaps, shields and healing —
// advancing each step when its goal is met. There is no ring and no defeat;
// dummies respawn so you can keep practising.
const $ = (id) => document.getElementById(id);

// Loot placed in a friendly arc in front of the spawn (spawn is at z=+40 looking toward origin / -z).
const TUTORIAL_LOOT = [
  { type: 'weapon', key: 'rifle',   x: -6, z: 30 },
  { type: 'weapon', key: 'shotgun', x:  6, z: 30 },
  { type: 'ammo',   key: 'light',   amount: 60, x: -3, z: 33 },
  { type: 'ammo',   key: 'shell',   amount: 16, x:  3, z: 33 },
  { type: 'shield', key: 'cell',    x: -2, z: 36 },
  { type: 'shield', key: 'battery', x:  2, z: 36 },
  { type: 'heal',   key: 'syringe', x: -5, z: 36 },
  { type: 'heal',   key: 'medkit',  x:  5, z: 36 },
  { type: 'armor',  key: 'armor',   amount: 50, x: 0, z: 38 },
];

// Three dummies downrange (toward -z, which is forward from the spawn).
const DUMMIES = [
  { id: 'd1', name: 'ダミーA', x: -8, z: -10 },
  { id: 'd2', name: 'ダミーB', x:  0, z: -16 },
  { id: 'd3', name: 'ダミーC', x:  8, z: -10 },
];

const SPAWN = { x: 0, z: 40 };

export class Tutorial {
  // getGame: () => the active Game instance built by main.js
  constructor(net, getGame) {
    this.net = net;
    this.getGame = getGame;
    this.room = null;
    this.active = false;
    this.stepIndex = 0;
    this.counter = 0;            // generic per-step progress counter
    this.flags = {};             // per-step event flags
    this.startPos = null;
    this._steps = this._buildSteps();
    $('tut-skip').onclick = () => this._advance(true);
  }

  get game() { return this.getGame(); }

  // ---- public entry -------------------------------------------------------
  // Spins up the offline room + dummies and starts the tutorial match. main.js
  // receives the resulting 'started'/'state' messages and builds the renderer
  // as usual; we only observe and guide.
  begin(name) {
    this.active = true;
    this.stepIndex = 0;
    this.flags = {};
    this._installHitTap();
    this._hookEvents();

    this.room = this.net.startSolo(name);   // emits 'joined' (handled by main.js)
    for (const d of DUMMIES) this.room.addDummy(d.id, d.name, { x: d.x, z: d.z });
    this.room.start({ tutorial: true, loot: TUTORIAL_LOOT, spawn: SPAWN });
  }

  // Called by main.js after it has built+started the renderer for solo 'started'.
  onStarted(m) {
    $('tutorial-panel').classList.add('show');
    if (this.game) this.game.yaw = Math.PI;   // face the dummies (down -z)
    this.startPos = { x: m.spawn.x, z: m.spawn.z };
    this._renderStep();
  }

  // Called every state tick (after main.js updates the renderer).
  onState() { this._checkMovement(); }

  end() {
    this.active = false;
    $('tutorial-panel').classList.remove('show');
    if (this.room && this.room.tickTimer) { clearInterval(this.room.tickTimer); this.room.tickTimer = null; }
  }

  // ---- event hooks --------------------------------------------------------
  _hookEvents() {
    // Wrap the existing handlers so we observe without breaking them.
    const observe = (type, fn) => {
      const prev = this.net.handlers[type];
      this.net.on(type, (m) => { if (prev) prev(m); if (this.active) fn(m); });
    };
    observe('kill', (m) => {
      if (m.killer === 'h') {
        this.flags.killed = (this.flags.killed || 0) + 1;
        this.flags.lastKillHead = this._pendingHead;
        this._onProgressEvent('kill', m);
      }
    });
    observe('invUpdate', (m) => { this._onProgressEvent('inv', m); });
    observe('healStart', () => { this.flags.healStarted = true; this._onProgressEvent('healStart'); });
    observe('healDone', () => { this.flags.healDone = true; this._onProgressEvent('healDone'); });
    observe('hurt', () => { this._onProgressEvent('hurt'); });
  }

  // game.js sends {t:'hit', head} to the room; tap it to know headshots.
  _installHitTap() {
    if (this._hitTapped) return;
    this._hitTapped = true;
    const realSend = this.net.send.bind(this.net);
    this.net.send = (obj) => {
      if (obj) {
        if (obj.t === 'hit') this._pendingHead = !!obj.head;
        else if (obj.t === 'reload') { this.flags.reloaded = true; this._onProgressEvent('reload'); }
        else if (obj.t === 'switch') { this.flags.switched = true; this._onProgressEvent('switch'); }
        else if (obj.t === 'pickup') this.flags.pickedUp = true;
      }
      return realSend(obj);
    };
  }

  // ---- step model ---------------------------------------------------------
  _buildSteps() {
    return [
      {
        key: 'move', step: 'ステップ 1 / 9', title: '移動する',
        desc: '<b>W A S D</b> キーで移動しよう。前後左右に動いてみて。',
        goal: 4, prog: () => `移動距離 ${Math.min(this.counter, 4) | 0} / 4 m`,
        kind: 'move',
      },
      {
        key: 'jump', step: 'ステップ 2 / 9', title: 'ジャンプ',
        desc: '<b>Space</b> でジャンプ。段差や敵の弾を避けるのに使う。',
        goal: 2, prog: () => `ジャンプ ${Math.min(this.counter, 2)} / 2 回`,
        kind: 'jump',
      },
      {
        key: 'shoot', step: 'ステップ 3 / 9', title: '射撃する',
        desc: 'マウスで前方の<b>ダミー</b>に狙いを定め、<b>左クリック</b>で撃とう。倒すと少しして復活する。',
        goal: 1, prog: () => `撃破 ${Math.min(this.flags.killed || 0, 1)} / 1`,
        kind: 'kill',
      },
      {
        key: 'reload', step: 'ステップ 4 / 9', title: 'リロード',
        desc: '弾を撃ち切る前に <b>R</b> で再装填。弾倉(左の大きい数字)と予備弾を管理しよう。',
        goal: 1, prog: () => this.flags.reloaded ? 'リロード完了！' : 'R を押してリロード',
        kind: 'reload',
      },
      {
        key: 'headshot', step: 'ステップ 5 / 9', title: 'ヘッドショット',
        desc: 'ダミーの<b>頭（球の部分）</b>を狙って撃つと大ダメージ。頭に当てて1体倒そう。',
        goal: 1, prog: () => this.flags.gotHead ? 'ヘッドショット成功！' : '頭を狙って撃破しよう',
        kind: 'headshot',
      },
      {
        key: 'loot', step: 'ステップ 6 / 9', title: 'アイテムを拾う',
        desc: '足元の光る武器に近づき <b>E</b> で拾おう。後方(スポーン付近)に武器・弾・回復・シールドがある。',
        goal: 1, prog: () => this.flags.pickedWeapon ? '武器を入手！' : '武器に近づいて E',
        kind: 'lootWeapon',
      },
      {
        key: 'switch', step: 'ステップ 7 / 9', title: '武器を切り替える',
        desc: '<b>1 2 3</b> またはマウスホイールで武器を切替。状況に応じて持ち替えよう。',
        goal: 1, prog: () => this.flags.switched ? '武器切替OK！' : '1 / 2 キーで切替',
        kind: 'switch',
      },
      {
        key: 'shield', step: 'ステップ 8 / 9', title: 'シールドを張る',
        desc: 'シールドはダメージを<b>HPより先に</b>吸収する。<b>X</b> でシールドセルを使ってチャージ（静止が必要）。',
        goal: 1, prog: () => this.flags.shieldUp ? 'シールド展開！' : 'X でシールド回復',
        kind: 'shield',
      },
      {
        key: 'heal', step: 'ステップ 9 / 9', title: '回復する',
        desc: 'ダメージを受けたら <b>Z</b>(注射器) や <b>C</b>(メドキット) でHP回復。使用中は動けないので安全な場所で。',
        goal: 1, prog: () => this.flags.healedHp ? '回復完了！' : 'Z で回復しよう',
        kind: 'heal',
      },
    ];
  }

  get current() { return this._steps[this.stepIndex]; }

  _renderStep() {
    const s = this.current;
    if (!s) return;
    $('tut-step').textContent = s.step;
    $('tut-title').textContent = s.title;
    $('tut-desc').innerHTML = s.desc;
    $('tut-progress').textContent = s.prog ? s.prog() : '';
    this.counter = 0;
    this._installHitTap();
    // Per-step setup.
    if (s.kind === 'heal') {
      // Make sure the player has something to heal by chipping a little HP.
      // (Handled lazily in _onProgressEvent via room damage below.)
      this._ensureDamaged();
    }
  }

  _updateProgressText() {
    const s = this.current;
    if (s && s.prog) $('tut-progress').textContent = s.prog();
  }

  // ---- progress detection -------------------------------------------------
  _checkMovement() {
    if (!this.active || !this.game) return;
    const s = this.current;
    if (!s) return;
    if (s.kind === 'move') {
      if (this.startPos) {
        const d = Math.hypot(this.game.pos.x - this.startPos.x, this.game.pos.z - this.startPos.z);
        this.counter = Math.max(this.counter, d);
        this._updateProgressText();
        if (d >= s.goal) this._advance();
      }
    } else if (s.kind === 'jump') {
      // Detect leaving the ground (rising edge).
      const air = !this.game.onGround;
      if (air && !this._wasAir) { this.counter++; this._updateProgressText(); }
      this._wasAir = air;
      if (this.counter >= s.goal) this._advance();
    }
  }

  _onProgressEvent(type, m) {
    if (!this.active) return;
    const s = this.current;
    if (!s) return;
    switch (s.kind) {
      case 'kill':
        if (type === 'kill') { this._updateProgressText(); this._advance(); }
        break;
      case 'reload':
        if (type === 'reload') { this._updateProgressText(); this._advance(); }
        break;
      case 'headshot':
        if (type === 'kill' && this.flags.lastKillHead) { this.flags.gotHead = true; this._updateProgressText(); this._advance(); }
        break;
      case 'lootWeapon':
        if (type === 'inv' && m && m.inv && m.inv.weapons.length > 1) { this.flags.pickedWeapon = true; this._updateProgressText(); this._advance(); }
        break;
      case 'switch':
        if (type === 'switch') { this._updateProgressText(); this._advance(); }
        break;
      case 'shield':
        if (type === 'healDone') { this.flags.shieldUp = true; this._updateProgressText(); this._advance(); }
        break;
      case 'heal':
        if (type === 'healDone') { this.flags.healedHp = true; this._updateProgressText(); this._advance(); }
        break;
    }
  }

  // Apply a little damage to the local player so the heal step is meaningful.
  _ensureDamaged() {
    const me = this.room && this.room.players.get('h');
    if (me && me.alive && me.hp > 40) {
      this.room.damagePlayer(me, me.hp - 35, null, 'tutorial');
    }
  }

  // ---- advance ------------------------------------------------------------
  _advance(skipped = false) {
    if (!this.active) return;
    const wasLast = this.stepIndex >= this._steps.length - 1;
    // brief positive feedback
    $('tut-progress').textContent = skipped ? 'スキップしました' : '✓ クリア！';
    this._wasAir = false;
    this._pendingHead = false;

    if (wasLast) { this._finish(); return; }
    this.stepIndex++;
    setTimeout(() => { if (this.active) this._renderStep(); }, 650);
  }

  _finish() {
    $('tutorial-panel').classList.remove('show');
    $('center-title').textContent = '🎉 トレーニング完了！';
    $('center-sub').textContent = '基本はバッチリ。ダミーで自由に練習を続けるか、メニューから本番へ。';
    $('center-msg').classList.add('show');
    setTimeout(() => $('center-msg').classList.remove('show'), 6000);
    // Free-practice panel.
    $('tut-step').textContent = 'フリープラクティス';
    $('tut-title').textContent = '自由練習モード';
    $('tut-desc').innerHTML = 'ダミーは倒すと復活します。好きなだけ練習しよう。<br>メニューに戻るには <b>Esc → 退出</b> またはページ再読込。';
    $('tut-progress').textContent = '';
    $('tut-skip').style.display = 'none';
    setTimeout(() => { if (this.active) $('tutorial-panel').classList.add('show'); }, 1200);
  }
}
