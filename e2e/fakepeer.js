// Test double for PeerJS: routes messages between tabs with BroadcastChannel (same API surface used by the app).
(function () {
  const ch = new BroadcastChannel('fakepeer');
  const peers = new Map();
  ch.onmessage = (e) => { const m = e.data; const p = peers.get(m.to); if (p) p._recv(m); };
  class Emitter { constructor() { this._h = {}; } on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; } _emit(ev, ...a) { (this._h[ev] || []).forEach((f) => { try { f(...a); } catch (err) { console.error(err); } }); } }
  class Conn extends Emitter {
    constructor(owner, remote, id) { super(); this.owner = owner; this.peer = remote; this.connId = id; this.open = false; }
    send(d) { if (!this.open) return; ch.postMessage({ type: 'data', to: this.peer, connId: this.connId, payload: JSON.parse(JSON.stringify(d)) }); }
    close() { if (!this.open) return; this.open = false; ch.postMessage({ type: 'close', to: this.peer, connId: this.connId }); this._emit('close'); }
  }
  class Peer extends Emitter {
    constructor(id) {
      super();
      if (typeof id !== 'string') id = 'anon-' + Math.random().toString(36).slice(2);
      this.id = id; this.destroyed = false; this.conns = new Map();
      peers.set(id, this);
      setTimeout(() => this._emit('open', id), 50);
      addEventListener('pagehide', () => this.destroy());
    }
    connect(remote) {
      const id = Math.random().toString(36).slice(2);
      const c = new Conn(this, remote, id); this.conns.set(id, c);
      ch.postMessage({ type: 'connect', to: remote, from: this.id, connId: id });
      c._timer = setTimeout(() => { if (!c.open) this._emit('error', { type: 'peer-unavailable', message: 'unavailable' }); }, 3000);
      return c;
    }
    _recv(m) {
      if (m.type === 'connect') {
        const c = new Conn(this, m.from, m.connId); this.conns.set(m.connId, c);
        this._emit('connection', c);
        c.open = true; c._emit('open');
        ch.postMessage({ type: 'accept', to: m.from, connId: m.connId });
      } else {
        const c = this.conns.get(m.connId); if (!c) return;
        if (m.type === 'accept') { clearTimeout(c._timer); c.open = true; c._emit('open'); }
        else if (m.type === 'data') c._emit('data', m.payload);
        else if (m.type === 'close') { if (c.open) { c.open = false; c._emit('close'); } }
      }
    }
    destroy() { if (this.destroyed) return; this.destroyed = true; for (const c of this.conns.values()) c.close(); peers.delete(this.id); }
    reconnect() {}
  }
  window.Peer = Peer;
})();
