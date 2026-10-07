// Peer-to-peer networking via PeerJS (free public PeerJS cloud broker for signalling only).
// The host's browser is authoritative; game data flows directly between browsers over WebRTC.
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

export function genCode(n = 5) {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const peerAvailable = () => typeof window !== 'undefined' && typeof window.Peer === 'function';

const ERR_ZH = {
  'peer-unavailable': '找不到这个房间（房间码错误，或房主已关闭页面）',
  'network': '无法连接到信令服务器，请检查网络',
  'server-error': '信令服务器错误，请稍后再试',
  'socket-error': '信令服务器连接失败',
  'socket-closed': '信令服务器连接断开',
  'browser-incompatible': '浏览器不支持 WebRTC，请使用新版 Chrome / Safari',
  'unavailable-id': '房间码被占用',
  'webrtc': 'WebRTC 连接失败（可能是网络 NAT 限制）',
};
export const errText = (err) => ERR_ZH[err && err.type] || (err && err.message) || String(err);

// Host: create a room. handlers: onReady(code), onConnection(conn), onError(err), onBrokerState(ok)
export function hostRoom(handlers, attempt = 0) {
  const code = genCode();
  const peer = new window.Peer(PREFIX + code, PEER_CONFIG);
  let opened = false;
  peer.on('open', () => { opened = true; handlers.onReady(code, peer); });
  peer.on('connection', (conn) => handlers.onConnection(conn));
  peer.on('disconnected', () => {
    handlers.onBrokerState && handlers.onBrokerState(false);
    setTimeout(() => { if (!peer.destroyed) { try { peer.reconnect(); } catch (e) { /* ignore */ } } }, 2000);
  });
  peer.on('open', () => handlers.onBrokerState && handlers.onBrokerState(true));
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && !opened && attempt < 5) {
      peer.destroy();
      handlers.onRetry && handlers.onRetry(hostRoom(handlers, attempt + 1));
      return;
    }
    handlers.onError(err, opened);
  });
  return peer;
}

// Client: connect to a room. handlers: onOpen(conn), onData(msg), onClose(), onError(err)
export function joinRoom(code, handlers) {
  const peer = new window.Peer(PEER_CONFIG);
  let conn = null;
  let timeout = setTimeout(() => handlers.onError({ type: 'timeout', message: '连接超时（15 秒）。可能是网络/NAT 限制，请重试或换个网络' }), 15000);
  peer.on('open', () => {
    conn = peer.connect(PREFIX + normalizeCode(code), { reliable: true, serialization: 'json' });
    conn.on('open', () => { clearTimeout(timeout); handlers.onOpen(conn); });
    conn.on('data', (msg) => handlers.onData(msg));
    conn.on('close', () => handlers.onClose());
    conn.on('error', (err) => handlers.onError(err));
  });
  peer.on('error', (err) => { clearTimeout(timeout); handlers.onError(err); });
  return { peer, get conn() { return conn; }, cancelTimeout() { clearTimeout(timeout); } };
}
