// Networking. Two transports, same message format, host browser stays authoritative:
//  • direct — WebRTC data channel via PeerJS (free 0.peerjs.com broker only for signalling).
//    Fast, but needs NATs that allow hole punching; often fails on 4G/5G carrier-grade NAT.
//  • relay  — end-to-end encrypted messages through free public MQTT-over-WSS brokers
//    (see relay.js). Works on any network that can open https pages.
// The host listens on both. A joining client tries direct first and starts the relay ~2.5 s later
// (or immediately if direct errors); whichever opens first wins.
import { relayHost, relayJoin, genKey, validKey } from './relay.js?v=6';

const PREFIX = 'kunyi-holdem-v1-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PEER_CONFIG = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};
const DIRECT_HEAD_START = 2500;

export function genCode(n = 5) {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
export const peerAvailable = () => typeof window !== 'undefined' && typeof window.Peer === 'function';
export { genKey, validKey };

// Accepts a bare room code or a whole pasted invite link. Returns { code, key }.
export function parseInvite(text, hash = '') {
  const s = String(text || '').trim();
  let code = '', key = '';
  const m = /[?&]room=([A-Za-z0-9]+)/.exec(s);
  if (m) code = m[1]; else if (!/[/#?]/.test(s)) code = s;
  const k = /#(?:.*&)?k=([A-Za-z0-9_-]{22})/.exec(s) || /(?:^#|&)k=([A-Za-z0-9_-]{22})/.exec(hash);
  if (k) key = k[1];
  return { code: normalizeCode(code), key };
}

// debugging / testing override: ?net=relay or ?net=direct
const NET_MODE = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('net') || '') : '';

const ERR_ZH = {
  'peer-unavailable': '找不到这个房间（房间码错误，或房主已关闭页面）',
  'network': '无法连接到信令服务器，请检查网络',
  'server-error': '信令服务器错误，请稍后再试',
  'socket-error': '信令服务器连接失败',
  'socket-closed': '信令服务器连接断开',
  'browser-incompatible': '浏览器不支持 WebRTC',
  'unavailable-id': '房间码被占用',
  'webrtc': 'WebRTC 直连失败（网络 NAT 限制）',
  'relay-unreachable': '连不上中继服务器（请检查网络，或换 Wi-Fi / 流量再试）',
  'relay-no-host': '房间没有响应：房主可能已关闭页面或锁屏，请让房主回到游戏页面',
  'relay-badkey': '邀请链接不完整，请让房主重新发送链接',
  'no-key': '直连失败。请使用房主分享的完整邀请链接（包含 # 后面的部分），即可走中继连接',
  'timeout': '连接超时，请检查网络后重试',
};
export const errText = (err) => ERR_ZH[err && err.type] || (err && err.message) || String(err);

// ---------------- host ----------------
// handlers: onReady(code, key, net), onConnection(conn), onNetState(net), onError(err)
// net = { direct: bool, relay: number of live relay brokers, relayTotal }
export function hostRoom(handlers) {
  let code = genCode();
  const key = genKey();
  const net = { direct: false, relay: 0, relayTotal: 0 };
  let peer = null, relay = null, ready = false, destroyed = false, peerSettled = false, relaySettled = false;
  const emit = () => handlers.onNetState && handlers.onNetState({ ...net });
  const maybeReady = () => {
    if (ready || destroyed || !(peerSettled && relaySettled)) return;
    ready = true;
    if (!net.direct && !net.relay) { handlers.onError({ type: 'network', message: '无法连接到任何联网服务器，请检查网络后重试' }, false); api.destroy(); return; }
    handlers.onReady(code, key, { ...net });
  };

  const startPeer = (attempt = 0) => {
    if (!peerAvailable() || NET_MODE === 'relay') { peerSettled = true; maybeReady(); return; }
    let p;
    try { p = new window.Peer(PREFIX + code, PEER_CONFIG); } catch (e) { peerSettled = true; maybeReady(); return; }
    peer = p;
    const t = setTimeout(() => { if (!peerSettled) { peerSettled = true; maybeReady(); } }, 7000);
    p.on('open', () => { clearTimeout(t); net.direct = true; emit(); if (!peerSettled) { peerSettled = true; maybeReady(); } });
    p.on('connection', (conn) => { conn.transport = 'direct'; handlers.onConnection(conn); });
    // signalling socket lost (phone slept / network switch): keep trying until it is back
    let backoff = 2000;
    const retry = () => {
      if (p.destroyed || destroyed || !p.disconnected) return;
      try { p.reconnect(); } catch (e) { /* ignore */ }
      backoff = Math.min(backoff * 1.6, 30000);
      setTimeout(retry, backoff);
    };
    p.on('disconnected', () => { net.direct = false; emit(); backoff = 2000; setTimeout(retry, backoff); });
    p.on('open', () => { backoff = 2000; });
    p.on('error', (err) => {
      if (err.type === 'unavailable-id' && !ready && attempt < 4) { p.destroy(); clearTimeout(t); code = genCode(); startPeer(attempt + 1); return; }
      if (err.type === 'peer-unavailable') return;
      if (err.type === 'unavailable-id' && ready) { console.warn('room id lost on the signalling server; relay keeps working'); return; }
      console.warn('peer error', err.type, err.message);
      if (!peerSettled) { clearTimeout(t); peerSettled = true; maybeReady(); }
    });
  };

  const api = {
    get key() { return key; },
    get code() { return code; },
    net,
    kick() {
      if (relay) relay.kick();
      if (peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) { /* */ } }
    },
    destroy() { destroyed = true; try { peer && peer.destroy(); } catch (e) { /* */ } try { relay && relay.destroy(); } catch (e) { /* */ } },
  };

  startPeer();
  if (NET_MODE === 'direct') { relaySettled = true; maybeReady(); } else {
    relayHost(key, {
      onConnection: (conn) => handlers.onConnection(conn),
      onState: (s) => { net.relay = s.up; net.relayTotal = s.total; emit(); },
    }).then((r) => {
      relay = r; net.relay = r.up; net.relayTotal = r.total;
      if (destroyed) r.destroy();
      relaySettled = true; emit(); maybeReady();
    }, (e) => { console.warn('relay host failed', e && e.message); relaySettled = true; maybeReady(); });
  }
  return api;
}

// ---------------- client ----------------
// handlers: onOpen(conn) [conn.transport = 'direct' | 'relay'], onData(msg), onClose(), onError(err), onProgress(text)
export function joinRoom(code, key, handlers, opts = {}) {
  const useDirect = !!code && peerAvailable() && NET_MODE !== 'relay' && opts.direct !== false;
  const useRelay = validKey(key) && NET_MODE !== 'direct';
  let winner = null, finished = false, peer = null, relayTry = null, relayTimer = null;
  let directDone = !useDirect, relayDone = !useRelay;
  const errors = [];
  const progress = (t) => handlers.onProgress && handlers.onProgress(t);

  const win = (conn, transport) => {
    if (finished) { try { conn.close(); } catch (e) { /* */ } return; }
    finished = true; winner = conn; conn.transport = transport;
    clearTimeout(relayTimer); clearTimeout(overall);
    if (transport === 'direct') { if (relayTry) relayTry.cancel(); }
    else if (peer) { try { peer.destroy(); } catch (e) { /* */ } peer = null; }
    conn.on('data', (m) => { if (winner === conn) handlers.onData(m); });
    conn.on('close', () => { if (winner === conn) { winner = null; handlers.onClose(); } });
    conn.on('error', (e) => console.warn('conn error', e));
    handlers.onOpen(conn);
  };
  const fail = (err) => {
    errors.push(err);
    if (finished || !(directDone && relayDone)) return;
    finished = true; clearTimeout(overall); clearTimeout(relayTimer);
    // the most useful explanation: relay errors beat direct ones; no key → tell them to use the full link
    const r = errors.find((e) => String(e.type).startsWith('relay'));
    handlers.onError(r || (!useRelay ? { type: errors.some((e) => e.type === 'peer-unavailable') ? 'peer-unavailable' : 'no-key' } : errors[0]));
  };
  const startRelay = () => {
    if (!useRelay || relayTry || finished) return;
    clearTimeout(relayTimer);
    progress(useDirect ? '直连较慢，同时尝试加密中继…' : '正在通过加密中继连接…');
    relayTry = relayJoin(key, {
      onOpen: (conn) => win(conn, 'relay'),
      onError: (e) => { relayDone = true; fail(e); },
    });
  };
  const overall = setTimeout(() => {
    if (finished) return;
    directDone = true; relayDone = true;
    try { peer && peer.destroy(); } catch (e) { /* */ }
    if (relayTry) relayTry.cancel();
    fail({ type: 'timeout' });
  }, useRelay ? 16000 : 15000);

  if (useDirect) {
    progress('正在直连房主…');
    try {
      peer = new window.Peer(PEER_CONFIG);
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + normalizeCode(code), { reliable: true, serialization: 'json' });
        conn.on('open', () => win(conn, 'direct'));
      });
      peer.on('error', (err) => {
        if (finished) return;
        directDone = true;
        try { peer.destroy(); } catch (e) { /* */ }
        startRelay();
        fail(err);
      });
    } catch (e) { directDone = true; errors.push({ type: 'webrtc' }); }
  }
  if (useRelay) relayTimer = setTimeout(startRelay, useDirect && !directDone ? DIRECT_HEAD_START : 0);
  if (!useDirect && !useRelay) setTimeout(() => fail({ type: 'no-key' }), 0);

  return {
    get conn() { return winner; },
    destroy() {
      finished = true; clearTimeout(overall); clearTimeout(relayTimer);
      try { peer && peer.destroy(); } catch (e) { /* */ }
      if (relayTry) relayTry.cancel();
      if (winner) { try { winner.close(); } catch (e) { /* */ } winner = null; }
    },
  };
}
