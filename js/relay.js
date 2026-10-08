// Relay transport: game messages travel through free public MQTT-over-WebSocket brokers.
// Works behind any NAT (incl. 4G/5G carrier-grade NAT) because both sides only make outgoing
// HTTPS/WSS connections. Every message is end-to-end encrypted with AES-GCM; the key exists only
// in the invite link's #fragment (never sent to any server), so the broker sees random bytes.
// The host stays authoritative; this only replaces the pipe.

export const BROKERS = [
  'wss://public:public@public.cloud.shiftr.io', // port 443: passes strict firewalls
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];
const TOPIC_ROOT = 'kyholdem/v4/';

const te = new TextEncoder();
const td = new TextDecoder();

// ---------------- base64url ----------------
export function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export const randId = (n = 10) => b64u(crypto.getRandomValues(new Uint8Array(n))).replace(/[-_]/g, 'x').slice(0, n);
export const genKey = () => b64u(crypto.getRandomValues(new Uint8Array(16)));
export const validKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{22}$/.test(k);

// ---------------- crypto ----------------
export async function makeCipher(keyB64) {
  const raw = unb64u(keyB64);
  if (raw.length !== 16) throw new Error('bad key');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode('holdem-room:' + keyB64)));
  const room = [...hash.slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    base: TOPIC_ROOT + room,
    async seal(obj, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, te.encode(JSON.stringify(obj))));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv); out.set(ct, 12);
      return out;
    },
    async open(bytes, aad) { // returns null if tampered / wrong key / garbage
      try {
        if (bytes.length < 29) return null;
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: te.encode(aad) }, key, bytes.slice(12));
        return JSON.parse(td.decode(pt));
      } catch (e) { return null; }
    },
  };
}

// Drops replayed/duplicated messages: per sender session, sequence numbers must increase.
export class ReplayGuard {
  constructor() { this.m = new Map(); }
  ok(sid, n) {
    if (typeof sid !== 'string' || !Number.isInteger(n)) return false;
    const last = this.m.get(sid) || 0;
    if (n <= last) return false;
    this.m.set(sid, n);
    if (this.m.size > 500) this.m.delete(this.m.keys().next().value);
    return true;
  }
}

// ---------------- minimal MQTT 3.1.1 client (QoS 0) ----------------
function encStr(s) { const b = te.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function encLen(n) { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0); return out; }
export function mqttPacket(type, body) {
  const head = [type, ...encLen(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head); out.set(body, head.length);
  return out;
}
export function mqttConnect(clientId, keepalive, user, pass) {
  let flags = 0x02; // clean session
  const tail = [...encStr(clientId)];
  if (user) { flags |= 0x80; tail.push(...encStr(user)); }
  if (user && pass) { flags |= 0x40; tail.push(...encStr(pass)); }
  return mqttPacket(0x10, Uint8Array.from([...encStr('MQTT'), 4, flags, keepalive >> 8, keepalive & 255, ...tail]));
}
export const mqttSubscribe = (id, topic) => mqttPacket(0x82, Uint8Array.from([id >> 8, id & 255, ...encStr(topic), 0]));
export function mqttPublish(topic, payload) {
  const t = encStr(topic);
  const body = new Uint8Array(t.length + payload.length);
  body.set(t); body.set(payload, t.length);
  return mqttPacket(0x30, body);
}
// Splits a byte stream into packets. Returns { packets: [{type, flags, body}], rest }.
export function mqttParse(buf) {
  const packets = [];
  let i = 0;
  for (;;) {
    if (buf.length - i < 2) break;
    let len = 0, mul = 1, j = i + 1, ok = false;
    for (let k = 0; k < 4 && j < buf.length; k++, j++) {
      len += (buf[j] & 127) * mul; mul *= 128;
      if (!(buf[j] & 128)) { ok = true; j++; break; }
    }
    if (!ok || buf.length - j < len) break;
    packets.push({ type: buf[i] >> 4, flags: buf[i] & 15, body: buf.subarray(j, j + len) });
    i = j + len;
  }
  return { packets, rest: buf.slice(i) };
}
export function mqttReadPublish(p) {
  const tl = (p.body[0] << 8) | p.body[1];
  const topic = td.decode(p.body.subarray(2, 2 + tl));
  const qos = (p.flags >> 1) & 3;
  return { topic, payload: p.body.slice(2 + tl + (qos ? 2 : 0)) };
}

export class MiniMqtt {
  constructor(url, opts = {}) {
    // credentials may be given as wss://user:pass@host/… ; they go into the MQTT CONNECT, not the URL
    const m = /^(wss?:\/\/)([^:@/]+):([^@/]*)@(.*)$/.exec(url);
    this.url = m ? m[1] + m[4] : url;
    this.user = m ? decodeURIComponent(m[2]) : opts.user;
    this.pass = m ? decodeURIComponent(m[3]) : opts.pass;
    this.clientId = opts.clientId || 'kh' + randId(16);
    this.keepalive = opts.keepalive || 20;
    this.WS = opts.WebSocket || globalThis.WebSocket;
    this.onmessage = null; this.onclose = null;
    this.connected = false; this.closed = false;
    this.buf = new Uint8Array(0); this.pid = 1; this.waiters = new Map();
  }
  connect(timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why) => { if (settled) return; settled = true; this.close(); reject(new Error(why)); };
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      let ws;
      try { ws = new this.WS(this.url, 'mqtt'); } catch (e) { clearTimeout(timer); reject(e); return; }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(mqttConnect(this.clientId, this.keepalive, this.user, this.pass));
      ws.onerror = () => fail('socket error');
      ws.onclose = () => { clearTimeout(timer); if (!settled) fail('socket closed'); else this._down(); };
      ws.onmessage = (ev) => {
        this.lastRx = Date.now();
        const data = new Uint8Array(ev.data);
        const all = new Uint8Array(this.buf.length + data.length);
        all.set(this.buf); all.set(data, this.buf.length);
        const { packets, rest } = mqttParse(all);
        this.buf = rest;
        for (const p of packets) {
          if (p.type === 2) { // CONNACK
            clearTimeout(timer);
            if (p.body[1] !== 0) { fail('refused ' + p.body[1]); return; }
            settled = true; this.connected = true; this._startPing(); resolve(this);
          } else if (p.type === 3) {
            const m = mqttReadPublish(p);
            if (this.onmessage) this.onmessage(m.topic, m.payload);
          } else if (p.type === 9) { // SUBACK
            const id = (p.body[0] << 8) | p.body[1];
            const w = this.waiters.get(id); if (w) { this.waiters.delete(id); w(p.body[2] !== 0x80); }
          }
        }
      };
    });
  }
  _startPing() {
    this.lastRx = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastRx > this.keepalive * 1500) { this.close(); return; } // dead socket (phone slept / network switch)
      this._send(Uint8Array.of(0xc0, 0));
    }, (this.keepalive * 1000) / 2);
  }
  _send(bytes) { if (this.ws && this.ws.readyState === 1) { this.ws.send(bytes); return true; } return false; }
  subscribe(topic, timeoutMs = 6000) {
    const id = this.pid = (this.pid % 65000) + 1;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error('suback timeout')); }, timeoutMs);
      this.waiters.set(id, (ok) => { clearTimeout(t); ok ? resolve() : reject(new Error('subscribe refused')); });
      if (!this._send(mqttSubscribe(id, topic))) { clearTimeout(t); reject(new Error('not connected')); }
    });
  }
  publish(topic, payload) { return this._send(mqttPublish(topic, payload)); }
  _down() {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    clearInterval(this.pingTimer);
    if (this.onclose) this.onclose();
  }
  close() {
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(Uint8Array.of(0xe0, 0)); } catch (e) { /* */ } }
    try { this.ws && this.ws.close(); } catch (e) { /* */ }
    this._down();
  }
}

// ---------------- tiny event emitter shaped like a PeerJS DataConnection ----------------
class Conn {
  constructor(peer) { this.peer = peer; this.open = false; this.transport = 'relay'; this.h = {}; }
  on(ev, fn) { (this.h[ev] ||= []).push(fn); return this; }
  emit(ev, a) { for (const fn of this.h[ev] || []) { try { fn(a); } catch (e) { console.error(e); } } }
}

// ---------------- host side ----------------
// Listens on every broker it can reach (so a client that can only reach one of them still gets in).
// opts: { onConnection(conn), onState({up,total}) }. Resolves once ≥1 broker is live; rejects if none within timeout.
export async function relayHost(keyB64, opts, { brokers = BROKERS, timeoutMs = 9000, WebSocket } = {}) {
  const cipher = await makeCipher(keyB64);
  const inTopic = cipher.base + '/h';
  const sid = randId(12);
  let seq = 0;
  const guard = new ReplayGuard();
  const conns = new Map(); // clientId -> Conn
  const links = brokers.map((url) => ({ url, mq: null, up: false, backoff: 1500, timer: null }));
  let destroyed = false;
  const state = () => opts.onState && opts.onState({ up: links.filter((l) => l.up).length, total: links.length });

  async function sendTo(conn, m, via) {
    const link = via && via.up ? via : conn.link && conn.link.up ? conn.link : links.find((l) => l.up);
    if (!link) return false;
    const topic = cipher.base + '/c/' + conn.peer;
    return link.mq.publish(topic, await cipher.seal({ s: sid, n: ++seq, m }, topic));
  }

  async function onIn(link, topic, payload) {
    if (topic !== inTopic) return;
    const env = await cipher.open(payload, inTopic);
    if (!env || typeof env.c !== 'string' || !/^[A-Za-z0-9]{6,24}$/.test(env.c) || !env.m) return;
    if (!guard.ok(env.c + '.' + env.s, env.n)) return;
    let conn = conns.get(env.c);
    const m = env.m;
    if (m.hello) {
      if (!conn) {
        conn = new Conn(env.c);
        conn.send = (msg) => { if (conn.open) sendTo(conn, { d: msg }); };
        conn.close = () => { if (!conn.open) return; sendTo(conn, { bye: 1 }); conn.open = false; conns.delete(conn.peer); conn.emit('close'); };
        conns.set(env.c, conn);
        conn.link = link;
        opts.onConnection(conn);
        conn.open = true;
        conn.emit('open');
      }
      if (!conn.live) conn.link = link; // until real traffic flows, follow the latest hello
      sendTo(conn, { ack: 1 }, link);
      return;
    }
    if (!conn) return;
    conn.link = link; conn.live = true; // reply on whichever broker the client is using now
    if (m.bye) { conn.open = false; conns.delete(conn.peer); conn.emit('close'); return; }
    if ('d' in m) conn.emit('data', m.d);
  }

  function dial(link) {
    if (destroyed) return Promise.resolve(false);
    const mq = new MiniMqtt(link.url, { WebSocket });
    link.mq = mq;
    mq.onmessage = (t, p) => onIn(link, t, p);
    return mq.connect().then(() => mq.subscribe(inTopic)).then(() => {
      link.up = true; link.backoff = 1500; state();
      mq.onclose = () => { link.up = false; state(); schedule(link); };
      return true;
    }).catch(() => { link.up = false; mq.close(); schedule(link); return false; });
  }
  function schedule(link) {
    if (destroyed || link.timer) return;
    link.timer = setTimeout(() => { link.timer = null; dial(link); }, link.backoff);
    link.backoff = Math.min(link.backoff * 2, 20000);
  }

  const first = await new Promise((resolve) => {
    let pending = links.length;
    const t = setTimeout(() => resolve(false), timeoutMs);
    for (const l of links) dial(l).then((ok) => { if (ok) { clearTimeout(t); resolve(true); } else if (--pending === 0) { clearTimeout(t); resolve(false); } });
  });
  const api = {
    base: cipher.base,
    get up() { return links.filter((l) => l.up).length; },
    total: links.length,
    kick() { for (const l of links) if (!l.up && !destroyed) { clearTimeout(l.timer); l.timer = null; l.backoff = 1500; dial(l); } },
    destroy() {
      destroyed = true;
      for (const c of conns.values()) c.close();
      for (const l of links) { clearTimeout(l.timer); l.mq && l.mq.close(); }
    },
  };
  if (!first) { api.destroy(); throw new Error('relay-unreachable'); }
  return api;
}

// ---------------- client side ----------------
// Dials all brokers in parallel, says hello on each, keeps the first one the host answers on.
// handlers: { onOpen(conn), onError(err) }; data/close are delivered as conn events.
export function relayJoin(keyB64, handlers, { brokers = BROKERS, timeoutMs = 11000, WebSocket } = {}) {
  const cid = randId(14);
  const sid = randId(12);
  let seq = 0, done = false, cancelled = false, anyBroker = false;
  const guard = new ReplayGuard();
  const tries = [];
  const conn = new Conn('host');
  let cipher, chosen = null;

  const finishErr = (type, message) => {
    if (done || cancelled) return;
    done = true;
    for (const t of tries) t.mq.close();
    handlers.onError({ type, message });
  };
  const timer = setTimeout(() => finishErr(anyBroker ? 'relay-no-host' : 'relay-unreachable'), timeoutMs);

  (async () => {
    try { cipher = await makeCipher(keyB64); } catch (e) { finishErr('relay-badkey'); return; }
    const myTopic = cipher.base + '/c/' + cid;
    const hostTopic = cipher.base + '/h';
    const post = async (mq, m) => mq.publish(hostTopic, await cipher.seal({ c: cid, s: sid, n: ++seq, m }, hostTopic));
    let failed = 0;
    for (const url of brokers) {
      const mq = new MiniMqtt(url, { WebSocket });
      const t = { mq };
      tries.push(t);
      mq.onmessage = async (topic, payload) => {
        if (topic !== myTopic) return;
        const env = await cipher.open(payload, myTopic);
        if (!env || !env.m || !guard.ok(env.s, env.n)) return;
        if (env.m.ack && !chosen && !done && !cancelled) {
          chosen = mq; done = true; clearTimeout(timer);
          for (const o of tries) { clearInterval(o.hello); if (o.mq !== mq) o.mq.close(); }
          conn.open = true;
          conn.broker = url; conn._mq = mq;
          conn.send = (msg) => { if (conn.open) post(mq, { d: msg }); };
          conn.close = () => { if (!conn.open) return; post(mq, { bye: 1 }); conn.open = false; setTimeout(() => mq.close(), 300); };
          mq.onclose = () => { if (conn.open) { conn.open = false; conn.emit('close'); } };
          handlers.onOpen(conn);
          return;
        }
        if (mq !== chosen) return;
        if (env.m.bye) { conn.open = false; mq.close(); conn.emit('close'); return; }
        if ('d' in env.m) conn.emit('data', env.m.d);
      };
      mq.connect().then(() => mq.subscribe(myTopic)).then(() => {
        anyBroker = true;
        if (done || cancelled) { mq.close(); return; }
        post(mq, { hello: 1 });
        t.hello = setInterval(() => { if (!done && !cancelled) post(mq, { hello: 1 }); else clearInterval(t.hello); }, 2500);
      }).catch(() => {
        clearInterval(t.hello);
        if (++failed === brokers.length) { clearTimeout(timer); finishErr('relay-unreachable'); }
      });
    }
  })();

  return {
    conn,
    cancel() {
      cancelled = true; clearTimeout(timer);
      for (const t of tries) { clearInterval(t.hello); if (t.mq !== chosen) t.mq.close(); }
      if (chosen) { conn.close && conn.close(); }
    },
  };
}
