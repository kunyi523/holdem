import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mqttConnect, mqttPublish, mqttSubscribe, mqttParse, mqttReadPublish, makeCipher, genKey, validKey, ReplayGuard, relayHost, relayJoin } from '../js/relay.js';
import { parseInvite } from '../js/net.js';

// In-memory MQTT broker speaking real MQTT 3.1.1 bytes, reachable through a fake WebSocket class.
function makeBroker() {
  const clients = new Set();
  const broker = { clients, published: [] };
  class FakeWS {
    constructor(url, proto) {
      assert.equal(proto, 'mqtt');
      this.readyState = 0; this.subs = new Set(); this.buf = new Uint8Array(0);
      clients.add(this);
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 1);
    }
    deliver(bytes) { if (this.readyState === 1) setTimeout(() => this.onmessage && this.onmessage({ data: bytes.slice().buffer }), 1); }
    send(bytes) {
      const all = new Uint8Array(this.buf.length + bytes.length); all.set(this.buf); all.set(bytes, this.buf.length);
      const { packets, rest } = mqttParse(all); this.buf = rest;
      for (const p of packets) {
        if (p.type === 1) this.deliver(Uint8Array.of(0x20, 2, 0, 0));
        else if (p.type === 8) { const tl = (p.body[2] << 8) | p.body[3]; this.subs.add(new TextDecoder().decode(p.body.subarray(4, 4 + tl))); this.deliver(Uint8Array.of(0x90, 3, p.body[0], p.body[1], 0)); }
        else if (p.type === 3) { const m = mqttReadPublish(p); broker.published.push(m); for (const c of clients) if (c.subs.has(m.topic)) c.deliver(mqttPublish(m.topic, m.payload)); }
        else if (p.type === 12) this.deliver(Uint8Array.of(0xd0, 0));
        else if (p.type === 14) this.close();
      }
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; clients.delete(this); setTimeout(() => this.onclose && this.onclose(), 1); }
  }
  broker.WS = FakeWS;
  return broker;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('MQTT packet codec round-trips (incl. multi-byte lengths and split frames)', () => {
  const payload = new Uint8Array(300).fill(7);
  const pkt = mqttPublish('a/b', payload);
  assert.equal(pkt[0], 0x30);
  const half = mqttParse(pkt.slice(0, 100));
  assert.equal(half.packets.length, 0);
  const both = new Uint8Array([...pkt, ...mqttSubscribe(5, 'x')]);
  const { packets, rest } = mqttParse(both);
  assert.equal(packets.length, 2); assert.equal(rest.length, 0);
  const m = mqttReadPublish(packets[0]);
  assert.equal(m.topic, 'a/b'); assert.equal(m.payload.length, 300);
  const c = mqttConnect('cid', 20, 'public', 'public');
  assert.equal(c[0], 0x10); assert.equal(c[9], 0xc2); // clean session + username + password flags
});

test('AES-GCM cipher: round trip, wrong key / tampering / wrong topic rejected', async () => {
  const key = genKey();
  assert.ok(validKey(key));
  const a = await makeCipher(key), b = await makeCipher(key), evil = await makeCipher(genKey());
  assert.equal(a.base, b.base); assert.notEqual(a.base, evil.base);
  assert.ok(!a.base.includes(key));
  const sealed = await a.seal({ t: 'state', cards: ['As', 'Kd'] }, 'topic/1');
  assert.ok(!new TextDecoder().decode(sealed).includes('As'));
  assert.deepEqual(await b.open(sealed, 'topic/1'), { t: 'state', cards: ['As', 'Kd'] });
  assert.equal(await evil.open(sealed, 'topic/1'), null);
  assert.equal(await b.open(sealed, 'topic/2'), null);
  const bad = sealed.slice(); bad[20] ^= 1;
  assert.equal(await b.open(bad, 'topic/1'), null);
});

test('replay guard drops repeats and old sequence numbers', () => {
  const g = new ReplayGuard();
  assert.ok(g.ok('s', 1)); assert.ok(g.ok('s', 2)); assert.ok(!g.ok('s', 2)); assert.ok(!g.ok('s', 1)); assert.ok(g.ok('t', 1));
  assert.ok(!g.ok('s', 1.5)); assert.ok(!g.ok(3, 4));
});

test('parseInvite handles codes, full links and hashes', () => {
  const k = 'AbCdEfGhIjKlMnOpQrStUv';
  assert.deepEqual(parseInvite('k7q2m'), { code: 'K7Q2M', key: '' });
  assert.deepEqual(parseInvite(`https://kunyi523.github.io/holdem/?room=K7Q2M#k=${k}`), { code: 'K7Q2M', key: k });
  assert.deepEqual(parseInvite('?room=ABCDE', `#k=${k}`), { code: 'ABCDE', key: k });
  assert.deepEqual(parseInvite('https://x.y/?room=ABCDE'), { code: 'ABCDE', key: '' });
});

test('relay: client joins host through broker, messages flow both ways, broker sees only ciphertext', async () => {
  const br = makeBroker();
  const key = genKey();
  const hostGot = [];
  let hostConn;
  const host = await relayHost(key, { onConnection(c) { hostConn = c; c.on('data', (d) => { hostGot.push(d); c.send({ t: 'state', view: { cards: ['Ah', 'Ad'] } }); }); } }, { brokers: ['wss://fake/a'], WebSocket: br.WS });
  const cliGot = [];
  let opened;
  const j = relayJoin(key, { onOpen(conn) { opened = conn; conn.on('data', (d) => cliGot.push(d)); conn.send({ t: 'join', name: '朋友' }); }, onError(e) { throw new Error(e.type); } }, { brokers: ['wss://fake/a'], WebSocket: br.WS });
  await wait(150);
  assert.ok(opened && opened.open);
  assert.deepEqual(hostGot, [{ t: 'join', name: '朋友' }]);
  assert.deepEqual(cliGot, [{ t: 'state', view: { cards: ['Ah', 'Ad'] } }]);
  for (const m of br.published) { const s = new TextDecoder().decode(m.payload); assert.ok(!s.includes('Ah') && !s.includes('join') && !s.includes('朋友')); assert.ok(!m.topic.includes(key)); }
  // replaying captured client packets must not deliver duplicates
  const before = hostGot.length;
  const spy = [...br.clients][0];
  for (const m of br.published.filter((x) => x.topic.endsWith('/h'))) spy.send(mqttPublish(m.topic, m.payload));
  await wait(60);
  assert.equal(hostGot.length, before);
  // closing from client side reaches host
  let closed = false; hostConn.on('close', () => { closed = true; });
  j.cancel();
  await wait(400);
  assert.ok(closed);
  host.destroy();
});

test('relay: wrong key never connects; host on two brokers serves a client that reaches only one', async () => {
  const b1 = makeBroker(), b2 = makeBroker();
  // route by URL to two separate brokers
  class Router { constructor(url, p) { return url.includes('one') ? new b1.WS(url, p) : new b2.WS(url, p); } }
  const key = genKey();
  let conns = 0;
  const host = await relayHost(key, { onConnection(c) { conns++; c.on('data', (d) => c.send({ echo: d })); } }, { brokers: ['wss://one', 'wss://two'], WebSocket: Router });
  const bad = await new Promise((res) => relayJoin(genKey(), { onOpen() { res('opened'); }, onError(e) { res(e.type); } }, { brokers: ['wss://one'], WebSocket: Router, timeoutMs: 300 }));
  assert.equal(bad, 'relay-no-host');
  let j2;
  const echo = await new Promise((res) => { j2 = relayJoin(key, { onOpen(c) { c.on('data', res); c.send(42); }, onError(e) { res(e.type); } }, { brokers: ['wss://two', 'wss://down'], WebSocket: class { constructor(u, p) { if (u.includes('down')) throw new Error('blocked'); return new Router(u, p); } } }); });
  assert.deepEqual(echo, { echo: 42 });
  j2.cancel();
  await wait(400);
  assert.equal(conns, 1);
  host.destroy();
});
