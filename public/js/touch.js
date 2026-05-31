// Mobile touch controls: a virtual movement joystick (left), a look/aim drag
// zone with tap-to-fire (right), and action buttons (jump, fire, reload,
// pickup, weapon swap, heals). Built only on touch devices; pointer-lock and
// keyboard paths are left untouched for desktop.

export function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

const $ = (id) => document.getElementById(id);

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.root = null;
    this.moveId = null;       // active touch id for the joystick
    this.lookId = null;       // active touch id for looking
    this.lookLast = null;     // {x,y} of last look position
    this.lookMoved = false;
    this.lookStartT = 0;
  }

  attach() {
    this.game.enableTouch();
    if (!this.root) this._build();
    this.root.style.display = 'block';
    document.body.classList.add('touch-active');
  }
  detach() {
    if (this.root) this.root.style.display = 'none';
    document.body.classList.remove('touch-active');
  }

  // Refresh the heal/weapon button labels from the inventory.
  syncInventory(inv) {
    if (!this.root || !inv) return;
    for (const key of ['syringe', 'medkit', 'cell', 'battery']) {
      const el = $('tc-heal-' + key);
      if (el) {
        const n = inv.heals[key] || 0;
        el.querySelector('.tc-count').textContent = n;
        el.classList.toggle('tc-empty', n <= 0);
      }
    }
  }

  // ---- build DOM ----------------------------------------------------------
  _build() {
    const root = document.createElement('div');
    root.id = 'touch-controls';
    // Heal/shield buttons use the generated item icons as their background.
    const healBtn = (id, kind, img) =>
      `<button class="tc-heal" data-kind="${kind}" id="tc-heal-${id}"
        style="background-image:url('assets/items/${img}')">
        <span class="tc-count">0</span></button>`;
    root.innerHTML = `
      <div id="tc-look"></div>
      <div id="tc-joystick"><div id="tc-stick"></div></div>
      <button class="tc-btn tc-fire" id="tc-fire">射撃</button>
      <button class="tc-btn tc-small tc-jump" id="tc-jump">ジャンプ</button>
      <button class="tc-btn tc-small tc-pickup" id="tc-pickup">拾う</button>
      <button class="tc-btn tc-small tc-reload" id="tc-reload">リロード</button>
      <button class="tc-btn tc-small tc-swap" id="tc-swap">武器</button>
      <div id="tc-heals">
        ${healBtn('syringe', 'hp',     'heal_syringe.png')}
        ${healBtn('medkit',  'hp',     'heal_medkit.png')}
        ${healBtn('cell',    'shield', 'shield_cell.png')}
        ${healBtn('battery', 'shield', 'shield_battery.png')}
      </div>`;
    document.body.appendChild(root);
    this.root = root;

    this._bindJoystick($('tc-joystick'), $('tc-stick'));
    this._bindLook($('tc-look'));

    // Action buttons.
    this._bindHold($('tc-fire'), (on) => this.game.setFiring(on));
    this._bindTap($('tc-jump'), () => this.game.touchJump());
    this._bindTap($('tc-reload'), () => this.game.touchReload());
    this._bindTap($('tc-pickup'), () => this.game.touchPickup());
    this._bindTap($('tc-swap'), () => this.game.touchSwitchNext());
    this._bindTap($('tc-heal-syringe'), () => this.game.touchHeal('syringe'));
    this._bindTap($('tc-heal-medkit'), () => this.game.touchHeal('medkit'));
    this._bindTap($('tc-heal-cell'), () => this.game.touchHeal('cell'));
    this._bindTap($('tc-heal-battery'), () => this.game.touchHeal('battery'));
  }

  // ---- joystick -----------------------------------------------------------
  _bindJoystick(base, stick) {
    const radius = 56;
    const reset = () => { stick.style.transform = 'translate(0px,0px)'; this.game.setMoveAxis(0, 0, false); this.moveId = null; };
    base.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.moveId = t.identifier;
      this._moveOrigin = this._center(base);
      this._updateStick(t, stick, radius);
    }, { passive: false });
    base.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.moveId) this._updateStick(t, stick, radius);
      }
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) if (t.identifier === this.moveId) reset();
    };
    base.addEventListener('touchend', end);
    base.addEventListener('touchcancel', end);
  }

  _center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  _updateStick(t, stick, radius) {
    let dx = t.clientX - this._moveOrigin.x;
    let dy = t.clientY - this._moveOrigin.y;
    const len = Math.hypot(dx, dy);
    if (len > radius) { dx = dx / len * radius; dy = dy / len * radius; }
    stick.style.transform = `translate(${dx}px,${dy}px)`;
    // forward is up on screen (negative dy)
    const nx = dx / radius;
    const nz = -dy / radius;
    this.game.setMoveAxis(nx, nz, len > radius * 0.92);
  }

  // ---- look / aim ---------------------------------------------------------
  _bindLook(zone) {
    zone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.lookId = t.identifier;
      this.lookLast = { x: t.clientX, y: t.clientY };
      this.lookMoved = false;
      this.lookStartT = performance.now();
    }, { passive: false });
    zone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this.lookId) continue;
        const dx = t.clientX - this.lookLast.x;
        const dy = t.clientY - this.lookLast.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.lookMoved = true;
        this.game.applyLook(dx, dy);
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.lookId) continue;
        // A quick tap (no drag) fires a single shot.
        if (!this.lookMoved && performance.now() - this.lookStartT < 250) {
          this.game.setFiring(true);
          setTimeout(() => this.game.setFiring(false), 60);
        }
        this.lookId = null;
        this.lookLast = null;
      }
    };
    zone.addEventListener('touchend', end);
    zone.addEventListener('touchcancel', end);
  }

  // ---- button helpers -----------------------------------------------------
  _bindTap(el, fn) {
    el.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.add('tc-press');
      fn();
    }, { passive: false });
    el.addEventListener('touchend', (e) => { e.preventDefault(); el.classList.remove('tc-press'); }, { passive: false });
  }
  _bindHold(el, fn) {
    el.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.add('tc-press');
      fn(true);
    }, { passive: false });
    const up = (e) => { e.preventDefault(); el.classList.remove('tc-press'); fn(false); };
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
  }
}
