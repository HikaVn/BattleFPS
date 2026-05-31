// Thin WebSocket client wrapper with an event-callback interface.
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.connected = false;
    this.queue = [];
  }

  on(type, fn) {
    this.handlers[type] = fn;
    return this;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}`);
      this.ws.onopen = () => {
        this.connected = true;
        for (const m of this.queue) this.ws.send(m);
        this.queue = [];
        resolve();
      };
      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => {
        this.connected = false;
        if (this.handlers.close) this.handlers.close();
      };
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const fn = this.handlers[msg.t];
        if (fn) fn(msg);
      };
    });
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.queue.push(data);
    }
  }
}
