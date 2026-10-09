// UI + session management (single-player / host / client).
import { HostController } from './controller.js?v=5';
import { hostRoom, joinRoom, errText, normalizeCode, parseInvite } from './net.js?v=5';
import { RANKS, SUIT_SYMBOLS } from './cards.js?v=5';
import { STARTING_CHIPS, MAX_SEATS } from './engine.js?v=5';
import { PERSONALITIES, STYLE_KEYS, styleInfo, resolveStyle } from './bot.js?v=5';
import { BOT_NAMES, defaultStyleFor } from './controller.js?v=5';
import { bestFive, heroHandInfo, quickEquity } from './handinfo.js?v=5';
import { play, isMuted, setMuted } from './sound.js?v=5';
import { toast as uiToast, dropToast, haptic, confirmSheet, confetti, installPressFeedback } from './ui.js?v=5';
import { BUYIN_PRESETS } from './controller.js?v=5';

const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtShort = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'K' : String(n));
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);

const styleKey = (s) => resolveStyle(s);

// Stable player identity on this device (survives reloads, closing the tab and re-opening the link).
function getToken() {
  let t = null;
  try { t = localStorage.getItem('holdem.token2') || sessionStorage.getItem('holdem.token'); } catch (e) { /* private mode */ }
  if (!t) {
    const a = new Uint32Array(4); crypto.getRandomValues(a);
    t = [...a].map((x) => x.toString(36)).join('');
  }
  try { localStorage.setItem('holdem.token2', t); } catch (e) { /* */ }
  return t;
}
// last room this device was seated in (for automatic rejoin after a reload / closed tab)
const SESSION_KEY = 'holdem.session';
const SESSION_TTL = 12 * 3600 * 1000;
function loadSession() {
  try { const x = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); return x && Date.now() - x.at < SESSION_TTL ? x : null; } catch (e) { return null; }
}
function saveSession() { try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code: S.code, key: S.key, name: S.name, at: Date.now() })); } catch (e) { /* */ } }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* */ } }

const S = {
  mode: null,            // 'solo' | 'host' | 'client'
  name: '',
  token: getToken(),
  ctrl: null,
  peer: null,
  code: null,
  remotes: new Map(),    // host: peerId -> { conn, seat, lastSeen }
  mySeat: -1,
  view: null,
  deadline: 0,
  client: null,
  joined: false,
  lastMsgAt: 0,
  reconnectTries: 0,
  leaving: false,
  actionKey: '',
  raiseValue: 0,
  pending: false,
  broadcastQueued: false,
  lastTurnKey: '',
  net: null,             // host: { direct, relay, relayTotal }
  key: '',               // room encryption key (lives only in the link #fragment)
  transport: '',         // client: 'direct' | 'relay'
  netState: '',          // client: 'connecting' | 'ok' | 'reconnecting' | 'failed'
  heartbeat: null,
};

// ---------------- toast / modal ----------------
function toast(msg, opts) { return uiToast(msg, opts); }
function openModal(html) { $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); S.modalKind = null; }
$('#modal .modal-close').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// ---------------- lobby ----------------
const nick = $('#nick');
nick.value = localStorage.getItem('holdem.nick') || '';
const params = new URLSearchParams(location.search);
const invite = parseInvite(location.search, location.hash);
const roomParam = invite.code;
S.key = invite.key;
if (roomParam) {
  $('#join-code').value = roomParam;
  $('#join-panel').classList.add('highlight');
  $('#join-panel h2').textContent = `加入房间 ${roomParam}`;
}

// Same room as last time (reload / closed tab / re-opened the link): rejoin automatically.
const lastSession = loadSession();
if (roomParam && lastSession && lastSession.code === roomParam) {
  if (!S.key && lastSession.key) S.key = invite.key = lastSession.key;
  if (!nick.value && lastSession.name) nick.value = lastSession.name;
  S.autoRejoin = true;
} else if (!roomParam && lastSession && lastSession.key) {
  const box = document.createElement('section');
  box.className = 'card-panel resume';
  box.innerHTML = `<h2><span class="ic">🔄</span>回到刚才的房间 ${esc(lastSession.code)}</h2><div class="row"><button class="btn green wide" id="btn-resume">重新加入</button><button class="btn ghost-btn" id="btn-forget" aria-label="忘记">✕</button></div>`;
  $('#join-panel').before(box);
  $('#btn-resume').onclick = () => { location.href = `${location.pathname}?room=${lastSession.code}#k=${lastSession.key}`; };
  $('#btn-forget').onclick = () => { clearSession(); box.remove(); };
}

function requireName() {
  const n = cleanName(nick.value);
  if (!n) { $('#lobby-msg').textContent = '请先输入昵称'; nick.focus(); return null; }
  localStorage.setItem('holdem.nick', n);
  S.name = n;
  $('#lobby-msg').textContent = '';
  return n;
}
function lobbyMsg(t) { $('#lobby-msg').textContent = t; }

// solo lineup: which AIs sit down and with which personality (remembered between visits)
let lineup = (() => {
  try {
    const l = JSON.parse(localStorage.getItem('holdem.lineup3') || 'null');
    if (Array.isArray(l) && l.length >= 1 && l.length <= 7) return l.map((b, i) => ({ name: BOT_NAMES[i], style: PERSONALITIES[b.style] ? b.style : defaultStyleFor(BOT_NAMES[i], i) }));
  } catch (e) { /* ignore */ }
  return BOT_NAMES.slice(0, 4).map((name, i) => ({ name, style: defaultStyleFor(name, i) }));
})();
const saveLineup = () => localStorage.setItem('holdem.lineup3', JSON.stringify(lineup));
function renderLineup() {
  $('#solo-lineup').innerHTML = lineup.map((b, i) => {
    const s = PERSONALITIES[b.style];
    const av = avatarOf({ name: b.name, isBot: true });
    return `<div class="lu-row"><div class="avatar sm" style="--c1:${av.c1};--c2:${av.c2}">${av.t}</div>
      <div class="lu-main"><div class="lu-name">${esc(b.name)}</div><div class="lu-blurb">${esc(s.blurb)}</div></div>
      <button class="stag lu-style" data-lu="${i}" style="--sc:${s.color}">${s.emoji}<b>${s.label}</b><span class="caret">▾</span></button></div>`;
  }).join('');
  $('#bot-count').textContent = `${lineup.length} 个 AI`;
  $('#btn-bot-minus').disabled = lineup.length <= 1;
  $('#btn-bot-plus').disabled = lineup.length >= 7;
  document.querySelectorAll('[data-lu]').forEach((b) => {
    b.onclick = () => { // cycle through personalities
      const i = Number(b.dataset.lu);
      lineup[i].style = STYLE_KEYS[(STYLE_KEYS.indexOf(lineup[i].style) + 1) % STYLE_KEYS.length];
      saveLineup(); renderLineup(); play('click');
    };
  });
}
$('#btn-bot-minus').onclick = () => { if (lineup.length > 1) { lineup.pop(); saveLineup(); renderLineup(); } };
$('#btn-bot-plus').onclick = () => { if (lineup.length < 7) { const i = lineup.length; lineup.push({ name: BOT_NAMES[i], style: defaultStyleFor(BOT_NAMES[i], i) }); saveLineup(); renderLineup(); } };
$('#btn-solo').onclick = () => { if (requireName()) startSolo(lineup); };
$('#btn-host').onclick = () => { if (requireName()) startHost(); };
$('#btn-join').onclick = () => {
  if (!requireName()) return;
  const raw = $('#join-code').value;
  const inv = parseInvite(raw);
  const code = inv.code;
  if (code.length < 4) { lobbyMsg('请输入正确的房间码（或直接粘贴邀请链接）'); return; }
  // typed code = same room as the link we opened → keep the link's key
  const key = inv.key || (code === roomParam ? invite.key : '');
  startJoin(code, key);
};
$('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#join-code').addEventListener('paste', () => setTimeout(() => { // pasted a whole invite link → keep it, show the code
  const el = $('#join-code'); const inv = parseInvite(el.value);
  if (inv.key && inv.code) { el.dataset.key = inv.key; invite.key = inv.key; el.value = inv.code; }
}, 0));
$('#lnk-rules').onclick = (e) => { e.preventDefault(); showRules(); };

function showGame() {
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
  requestWakeLock();
}

// keep the phone screen on while playing (helps the host's browser keep running)
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not supported / denied */ }
}

// ---------------- local controller (solo + host) ----------------
function makeController() {
  S.ctrl = new HostController({ onChange: onLocalChange });
}
function onLocalChange() {
  if (S.broadcastQueued) return;
  S.broadcastQueued = true;
  queueMicrotask(() => {
    S.broadcastQueued = false;
    if (!S.ctrl) return;
    setView(S.ctrl.view(S.mySeat, { host: true }));
    if (S.mode === 'host') {
      S.rev = (S.rev || 0) + 1;
      for (const r of S.remotes.values()) sendState(r);
      saveLedger();
    }
    if (S.modalKind === 'settings') refreshSettings();
    if (S.modalKind === 'ledger') renderLedger();
    hostRequestsToasts();
  });
}

function sendState(r) {
  if (r.conn.open) { try { r.conn.send({ t: 'state', rev: S.rev || 0, view: S.ctrl.view(r.seat) }); } catch (e) { /* ignore */ } }
}
// session ledger survives the page: host writes it, everyone can look at it from the lobby later
function saveLedger() {
  const v = S.view;
  if (!v || !v.ledger || !S.code) return;
  clearTimeout(S.ledgerTimer);
  S.ledgerTimer = setTimeout(() => { try { localStorage.setItem('holdem.ledger', JSON.stringify({ code: S.code, at: Date.now(), ledger: v.ledger })); } catch (e) { /* */ } }, 800);
}
// host: one-tap approve / deny toasts for buy-in requests
function hostRequestsToasts() {
  if (S.mode !== 'host' || !S.view) return;
  const reqs = S.view.requests || [];
  S.shownReq = S.shownReq || new Set();
  for (const r of reqs) {
    if (S.shownReq.has(r.rid)) continue;
    S.shownReq.add(r.rid);
    play('turn'); haptic([20, 40, 20]);
    toast(`<b>${esc(r.name)}</b> 申请买入 <b>${fmt(r.amount)}</b>`, { html: true, type: 'money', key: 'req' + r.rid, ms: 0,
      actions: [{ label: '拒绝', onClick: () => decideBuy(r.rid, false) }, { label: '批准', kind: 'ok', onClick: () => decideBuy(r.rid, true) }] });
  }
  for (const rid of S.shownReq) if (!reqs.some((r) => r.rid === rid)) dropToast('req' + rid);
}
function decideBuy(rid, yes) {
  const res = S.ctrl.decide(rid, yes);
  if (!res.ok) return;
  for (const r of S.remotes.values()) if (r.seat === res.seat) { try { r.conn.send({ t: 'buyres', approved: res.approved, amount: res.amount }); } catch (e) { /* */ } }
  toast(yes ? `已批准买入 ${fmt(res.amount)}` : '已拒绝', { type: yes ? 'ok' : 'info', ms: 1500 });
}

function startSolo(bots) {
  S.mode = 'solo';
  makeController();
  S.mySeat = S.ctrl.addHuman('me', S.name, 0);
  if (typeof bots === 'number') bots = BOT_NAMES.slice(0, bots).map((name, i) => ({ name, style: defaultStyleFor(name, i) }));
  for (const b of bots) S.ctrl.addBot(b.name, b.style);
  showGame();
  S.ctrl.start();
}

function startHost() {
  lobbyMsg('正在创建房间…');
  $('#btn-host').disabled = true;
  S.mode = 'host';
  makeController();
  S.mySeat = S.ctrl.addHuman('host:' + S.token, S.name, 0);
  S.ctrl.game.seats[S.mySeat].ready = true;
  S.peer = hostRoom({
    onReady(code, key, net) {
      S.code = code; S.key = key; S.net = net;
      S.rev = 0;
      $('#btn-host').disabled = false;
      lobbyMsg('');
      history.replaceState(null, '', `?room=${code}#k=${key}`);
      showGame();
      setView(S.ctrl.view(S.mySeat));
      showInvite();
      startHostHeartbeat();
    },
    onConnection: handleIncoming,
    onNetState(net) { S.net = net; renderNetDot(); },
    onError(err) {
      console.warn('host error', err);
      $('#btn-host').disabled = false;
      lobbyMsg('创建房间失败：' + errText(err) + '（可点「创建房间」重试）');
      S.mode = null; S.ctrl.destroy(); S.ctrl = null;
    },
  });
  window.addEventListener('beforeunload', (e) => { if (S.mode === 'host') { e.preventDefault(); e.returnValue = ''; } });
}

function inviteLink() {
  return `${location.origin}${location.pathname}?room=${S.code}${S.key ? '#k=' + S.key : ''}`;
}

function handleIncoming(conn) {
  conn.on('data', (msg) => onRemoteMsg(conn, msg));
  conn.on('close', () => onRemoteClose(conn));
  conn.on('error', (e) => console.warn('conn error', e));
}

function onRemoteMsg(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  let r = S.remotes.get(conn.peer);
  if (r) r.lastSeen = Date.now();
  const ctrl = S.ctrl;
  if (msg.t === 'join') {
    const token = String(msg.token || '').slice(0, 40);
    const name = cleanName(msg.name) || '玩家';
    const id = 'p:' + token;
    let seat = ctrl.seatOf(id);
    // lost their token (new browser / WeChat webview)? take back their own disconnected seat by name
    if (seat < 0) seat = ctrl.reclaimSeat(name, id);
    // drop any older connection for the same player (tell it why, so it doesn't fight back)
    for (const [pid, other] of S.remotes) {
      if (other.seat === seat && seat >= 0 && pid !== conn.peer) {
        S.remotes.delete(pid);
        try { other.conn.send({ t: 'replaced' }); } catch (e) { /* */ }
        setTimeout(() => { try { other.conn.close(); } catch (e) { /* */ } }, 300);
      }
    }
    if (seat >= 0) {
      ctrl.setConnected(seat, true);
    } else {
      seat = ctrl.addHuman(id, name);
      if (seat < 0) {
        conn.send({ t: 'reject', reason: '房间已满（最多 8 人）' });
        setTimeout(() => conn.close(), 800);
        return;
      }
    }
    const isNew = !S.remotes.has(conn.peer);
    r = { conn, seat, lastSeen: Date.now(), transport: conn.transport || 'direct' };
    S.remotes.set(conn.peer, r);
    if (isNew) toast(`${name} 已连接（${r.transport === 'relay' ? '加密中继' : '直连'}）`);
    conn.send({ t: 'welcome', seat, code: S.code });
    sendState(r); // full table state right away (own hole cards included)
    onLocalChange();
    return;
  }
  if (!r) { if (msg.t !== 'pong') { try { conn.send({ t: 'rejoin' }); } catch (e) { /* */ } } return; } // unknown connection: ask it to say hello
  if (msg.t === 'act' && msg.action && typeof msg.action === 'object') {
    const res = ctrl.handleAction(r.seat, { type: String(msg.action.type), amount: Number(msg.action.amount) || 0 });
    if (!res.ok) { conn.send({ t: 'error', text: res.error }); onLocalChange(); }
  } else if (msg.t === 'sitout') {
    ctrl.setSittingOut(r.seat, !!msg.v);
  } else if (msg.t === 'ready') {
    ctrl.setReady(r.seat, !!msg.v);
  } else if (msg.t === 'buyin') {
    const res = ctrl.buyIn(r.seat, Number(msg.amount));
    conn.send({ t: 'buyack', ...res, amount: Number(msg.amount) || 0 });
  } else if (msg.t === 'leave') {
    S.remotes.delete(conn.peer);
    ctrl.removeSeat(r.seat);
    try { conn.close(); } catch (e) { /* */ }
  }
}

function onRemoteClose(conn) {
  const r = S.remotes.get(conn.peer);
  if (!r) return;
  S.remotes.delete(conn.peer);
  const p = S.ctrl && S.ctrl.game.seats[r.seat];
  if (p && p.id.startsWith('p:')) S.ctrl.setConnected(r.seat, false);
}

function startHostHeartbeat() {
  clearInterval(S.heartbeat);
  S.hbLast = Date.now();
  S.heartbeat = setInterval(() => {
    const now = Date.now();
    // our own page was frozen (phone in background): don't blame the players for the silence
    if (now - S.hbLast > 6000) for (const r of S.remotes.values()) r.lastSeen = now;
    S.hbLast = now;
    for (const [pid, r] of S.remotes) {
      if (now - r.lastSeen > 9000) { try { r.conn.close(); } catch (e) { /* */ } onRemoteClose(r.conn); S.remotes.delete(pid); continue; }
      if (r.conn.open) { try { r.conn.send({ t: 'ping' }); } catch (e) { /* */ } }
    }
    // a seated human with no live connection at all is offline (e.g. host was frozen and missed the close)
    if (S.ctrl) for (const p of S.ctrl.game.seats) if (p && p.id.startsWith('p:') && p.connected && ![...S.remotes.values()].some((r) => r.seat === p.seat)) S.ctrl.setConnected(p.seat, false);
  }, 2000);
}

// ---------------- client ----------------
function startJoin(code, key) {
  S.mode = 'client';
  S.code = code;
  S.key = key || '';
  S.netState = 'connecting';
  S.reconnectTries = 0;
  lobbyMsg(`正在连接房间 ${code}…`);
  $('#btn-join').disabled = true;
  const netParam = new URLSearchParams(location.search).get('net');
  history.replaceState(null, '', `?room=${code}${netParam ? '&net=' + netParam : ''}${S.key ? '#k=' + S.key : ''}`);
  connectClient();
}

// One connection attempt (direct first, encrypted relay fallback — see net.js).
// Every attempt ends in exactly one of: welcome (ok) · failure → retry/backoff. Nothing can leave us stuck.
function connectClient() {
  try { S.client && S.client.destroy(); } catch (e) { /* */ }
  clearTimeout(S.welcomeTimer);
  const attempt = S.client = joinRoom(S.code, S.key, {
    onProgress(t) { if (!S.joined) lobbyMsg(t); else if (S.netState !== 'ok') showNetBanner(t); },
    onOpen(conn) {
      if (S.client !== attempt) return;
      S.transport = conn.transport;
      S.lastRev = -1;
      conn.send({ t: 'join', name: S.name, token: S.token });
      S.lastMsgAt = Date.now();
      if (!S.joined) lobbyMsg(`已连接（${conn.transport === 'relay' ? '加密中继' : '直连'}），正在入座…`);
      // the host must answer with a welcome; if not, this attempt is dead
      S.welcomeTimer = setTimeout(() => { if (S.client === attempt && S.netState !== 'ok') attemptFailed(attempt, { type: 'timeout', message: '房主没有回应' }); }, 9000);
    },
    onData(msg) { if (S.client === attempt) onHostMsg(msg); },
    onClose() {
      if (S.client !== attempt) return;
      if (S.netState === 'ok') onClientDisconnected('连接已断开');
      else attemptFailed(attempt, { type: 'socket-closed', message: '连接被关闭' });
    },
    onError(err) { if (S.client === attempt) attemptFailed(attempt, err); },
  });
}

function attemptFailed(attempt, err) {
  if (S.client !== attempt) return;
  console.warn('connect attempt failed', err);
  clearTimeout(S.welcomeTimer);
  try { attempt.destroy(); } catch (e) { /* */ }
  S.client = null;
  if (!S.joined) {
    // first join from the lobby: auto-retry a couple of times before asking the user
    if (S.autoRejoin && S.reconnectTries < 3) { S.reconnectTries++; lobbyMsg(`重新加入中…（第 ${S.reconnectTries + 1} 次）`); S.retryTimer = setTimeout(connectClient, 1500); return; }
    $('#btn-join').disabled = false;
    lobbyMsg('加入失败：' + errText(err) + '。可点「加入」重试。');
    S.mode = null; S.netState = 'failed';
    return;
  }
  scheduleReconnect(err);
}

function sendToHost(msg) {
  const c = S.client && S.client.conn;
  if (c && c.open && S.netState === 'ok') { try { c.send(msg); return true; } catch (e) { /* */ } }
  if (msg.t !== 'pong') toast('未连接到房主，正在重连…', { type: 'warn', key: 'nohost' });
  return false;
}

function onHostMsg(msg) {
  S.lastMsgAt = Date.now();
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'welcome') {
    clearTimeout(S.welcomeTimer); clearTimeout(S.retryTimer);
    S.mySeat = msg.seat;
    const first = !S.joined;
    const wasDown = S.netState !== 'ok';
    S.joined = true;
    S.reconnectTries = 0;
    S.netState = 'ok';
    S.autoRejoin = false;
    saveSession();
    $('#btn-join').disabled = false;
    lobbyMsg('');
    hideBanner();
    dropToast('nohost');
    if (first) { showGame(); startClientWatchdog(); toast(`已加入房间（${S.transport === 'relay' ? '加密中继' : '直连'}）`, { type: 'ok' }); }
    else if (wasDown) { toast('已重新连上 👍', { type: 'ok', key: 'net' }); haptic(15); }
    renderNetDot();
  } else if (msg.t === 'state') {
    if (typeof msg.rev === 'number') { if (msg.rev <= S.lastRev) return; S.lastRev = msg.rev; } // stale/out-of-order snapshot
    setView(msg.view);
  } else if (msg.t === 'ping') {
    sendToHost({ t: 'pong' });
  } else if (msg.t === 'rejoin') {
    const c = S.client && S.client.conn;
    if (c && c.open) c.send({ t: 'join', name: S.name, token: S.token });
  } else if (msg.t === 'replaced') {
    // this seat was taken over by another window/device of ours: stop here (no reconnect tug-of-war)
    S.netState = 'failed'; S.replaced = true;
    try { S.client && S.client.destroy(); } catch (e) { /* */ }
    S.client = null;
    renderNetDot();
    showBanner('你已在其他窗口/设备进入这个座位。 <button class="btn small-btn" id="btn-take-back">在这里继续</button>');
    $('#btn-take-back').onclick = () => { S.replaced = false; manualRejoin(); };
  } else if (msg.t === 'reject') {
    S.leaving = true;
    clearSession();
    alert(msg.reason || '无法加入');
    location.href = location.pathname;
  } else if (msg.t === 'buyack') {
    if (!msg.ok) toast(msg.error || '买入失败', { type: 'err' });
    else toast(msg.status === 'pending' ? `已申请买入 ${fmt(msg.amount)}，等待房主批准…` : msg.status === 'queued' ? `买入 ${fmt(msg.amount)}，本手结束后到账` : `买入成功 +${fmt(msg.amount)}`, { type: msg.status === 'done' ? 'ok' : 'money', key: 'buy' });
    if (msg.ok && msg.status === 'done') play('chips');
  } else if (msg.t === 'buyres') {
    toast(msg.approved ? `房主已批准买入 ${fmt(msg.amount)} 🎉` : '房主拒绝了你的买入申请', { type: msg.approved ? 'ok' : 'warn', key: 'buy' });
    if (msg.approved) play('chips');
  } else if (msg.t === 'error') {
    S.pending = false; S.actionKey = '';
    toast(msg.text || '操作无效', { type: 'warn' });
  }
}

function startClientWatchdog() {
  clearInterval(S.heartbeat);
  S.heartbeat = setInterval(() => {
    if (S.joined && S.netState === 'ok' && Date.now() - S.lastMsgAt > 8000) onClientDisconnected('长时间没有收到房主数据');
    if (S.netState !== 'ok' && S.view) renderNetDot();
  }, 2000);
}

// Lost the host: retry (direct + relay) with gentle backoff — forever, slower after a while.
function onClientDisconnected(reason) {
  if (S.leaving || !S.joined || S.replaced || S.netState === 'reconnecting') return;
  S.netState = 'reconnecting';
  S.lastReason = reason;
  S.reconnectTries = 0;
  S.downSince = Date.now();
  clearTimeout(S.welcomeTimer);
  try { S.client && S.client.destroy(); } catch (e) { /* */ }
  S.client = null;
  renderNetDot();
  render();
  showNetBanner();
  clearTimeout(S.retryTimer);
  S.retryTimer = setTimeout(reconnectNow, 600);
}
function reconnectNow() {
  clearTimeout(S.retryTimer);
  if (S.leaving || S.replaced || S.netState === 'ok' || !S.joined) return;
  if (S.netState !== 'failed') S.netState = 'reconnecting';
  S.reconnectTries++;
  renderNetDot();
  showNetBanner();
  connectClient();
}
function scheduleReconnect() {
  if (S.netState === 'ok' || S.leaving || S.replaced) return;
  if (S.reconnectTries >= 10) S.netState = 'failed'; // keep trying, but tell the user and offer the button
  renderNetDot();
  showNetBanner();
  const wait = S.reconnectTries < 4 ? 1500 * S.reconnectTries : Math.min(20000, 5000 + 1500 * S.reconnectTries);
  clearTimeout(S.retryTimer);
  S.retryTimer = setTimeout(reconnectNow, wait);
}
// "重新加入": always works from the same link — a fresh attempt right now
function manualRejoin() {
  if (S.mode !== 'client') { location.reload(); return; }
  S.replaced = false;
  S.reconnectTries = 0;
  S.netState = 'reconnecting';
  toast('正在重新加入…', { type: 'net', key: 'net' });
  reconnectNow();
}
function showNetBanner(detail) {
  if (S.netState === 'ok' || S.replaced) return;
  const secs = Math.round((Date.now() - (S.downSince || Date.now())) / 1000);
  const failed = S.netState === 'failed';
  showBanner(`<span class="nb-ic ${failed ? 'bad' : ''}">${failed ? '⚠️' : '📶'}</span>${failed ? '暂时连不上房主（房主可能锁屏/切到后台），仍在自动重试' : '连接中断，正在重连'}<span class="nb-sub">${secs}s · 第 ${S.reconnectTries} 次${detail ? ' · ' + esc(detail) : ''}</span><button class="btn small-btn" id="btn-rejoin">重新加入</button>`, failed ? 'warn' : 'info');
  const b = $('#btn-rejoin'); if (b) b.onclick = manualRejoin;
}

function showBanner(html, kind = '') { const b = $('#banner'); b.innerHTML = html; b.className = 'banner ' + kind; }
function hideBanner() { $('#banner').className = 'banner hidden'; }
function renderNetDot() {
  const d = $('#net-dot');
  if (S.mode === 'solo' || !S.mode) { d.className = 'net-pill hidden'; return; }
  let cls, text, title;
  if (S.mode === 'host') {
    const n = S.net || {};
    const ok = n.direct || n.relay > 0;
    cls = ok ? 'ok' : 'bad';
    text = ok ? '在线' : '离线';
    title = `直连信令：${n.direct ? '正常' : '断开'} · 加密中继：${n.relay || 0}/${n.relayTotal || 0} 个服务器在线`;
    const relays = [...S.remotes.values()].filter((r) => r.transport === 'relay').length;
    if (S.remotes.size) { text += `·${S.remotes.size}人`; title += ` · 已连接 ${S.remotes.size} 人（${relays} 人走中继）`; }
  } else {
    const st = S.netState;
    cls = st === 'ok' ? (S.transport === 'relay' ? 'ok relay' : 'ok') : st === 'failed' ? 'bad' : 'warn';
    text = st === 'ok' ? (S.transport === 'relay' ? '中继' : '直连') : st === 'failed' ? '已断开' : '重连中';
    title = st === 'ok' ? (S.transport === 'relay' ? '通过加密中继连接房主（端到端加密）' : 'WebRTC 直连房主') : '点我立即重连';
  }
  d.className = 'net-pill ' + cls;
  d.title = title;
  d.innerHTML = `<i></i>${esc(text)}`;
}
$('#net-dot').onclick = () => {
  if (S.mode === 'client' && S.netState !== 'ok') { S.reconnectTries = 0; reconnectNow(); }
  else if (S.mode) toast($('#net-dot').title, 3500);
};

// ---------------- actions ----------------
function sendAction(action) {
  if (S.pending) return;
  S.pending = true;
  if (S.mode === 'client') {
    if (!sendToHost({ t: 'act', action })) S.pending = false;
  } else {
    const r = S.ctrl.handleAction(S.mySeat, action);
    if (!r.ok) { S.pending = false; toast(r.error); }
  }
  setTimeout(() => { S.pending = false; }, 4000);
}
function setSitOut(v) {
  if (S.mode === 'client') sendToHost({ t: 'sitout', v });
  else S.ctrl.setSittingOut(S.mySeat, v);
}

// ---------------- rendering ----------------
const RING_C = 2 * Math.PI * 26;   // seat countdown ring (viewBox 56, r 26)
const CLOCK_C = 2 * Math.PI * 19;  // my countdown (viewBox 44, r 19)
const BETTING = ['preflop', 'flop', 'turn', 'river'];
const mq = (q) => (window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener() {} });
const reduceMQ = mq('(prefers-reduced-motion: reduce)');
const wideMQ = mq('(min-width: 900px)');
const reduceMotion = () => reduceMQ.matches;
// seat anchor points (% of table box) by position relative to the viewer (0 = me at the bottom), clockwise
const POS_P = [[50, 88], [14, 71], [10.5, 46], [17.5, 21], [50, 11], [82.5, 21], [89.5, 46], [86, 71]];
const POS_L = [[50, 85], [22, 80], [8, 50], [21, 20], [50, 13.5], [79, 20], [92, 50], [78, 80]];
const CENTER_PT = [50, 46];
const POT_PT_P = [50, 32.5];
const POT_PT_L = [50, 30];
let POT_PT = POT_PT_P;
let landscape = false;
const relPos = (seat) => (seat - (S.mySeat >= 0 ? S.mySeat : 0) + MAX_SEATS) % MAX_SEATS;
const posOf = (seat) => (landscape ? POS_L : POS_P)[relPos(seat)];
const toward = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
// portrait: hand-placed bet spots so chips never cover the board
const BET_P = [[50, 73], [27, 64], [24, 51], [28, 31], [50, 22], [72, 31], [76, 51], [73, 64]];
const betPt = (seat) => (landscape ? toward(posOf(seat), CENTER_PT, 0.38) : BET_P[relPos(seat)]);
function dealerPt(seat) {
  const p = posOf(seat);
  const [x, y] = toward(p, CENTER_PT, landscape ? 0.26 : 0.22);
  const dx = CENTER_PT[0] - p[0], dy = CENTER_PT[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  return [x - (dy / len) * (landscape ? 6 : 9), y + (dx / len) * 4];
}

// ---- animation bookkeeping: an animation keeps running smoothly across re-renders ----
const animT = new Map();
let animHand = -1;
function anim(key, cls, dur, delay = 0) {
  if (reduceMotion()) return { cls: '', style: '' };
  const now = performance.now();
  if (!animT.has(key)) animT.set(key, now);
  const el = now - animT.get(key);
  if (el > dur + delay) return { cls: '', style: '' };
  return { cls, style: `animation-delay:${Math.round(delay - el)}ms;` };
}

// ---- cards ----
const COURT = { J: '⚜\uFE0E', Q: '♛\uFE0E', K: '♚\uFE0E' };
function cardHTML(c, cls = '', style = '') {
  if (c === null || c === undefined) return `<div class="card back ${cls}" style="${style}"><span class="bk"></span></div>`;
  const r = RANKS[c >> 2]; const s = c & 3;
  const rank = r === 'T' ? '10' : r;
  const sym = SUIT_SYMBOLS[s] + '\uFE0E';
  const center = COURT[r] ? `<span class="court"><b>${r}</b><i>${COURT[r]}</i></span>` : r === 'A' ? `<span class="cc ace">${sym}</span>` : `<span class="cc">${sym}</span>`;
  return `<div class="card s${s} ${cls}" data-c="${c}" style="${style}"><span class="ci"><b>${rank}</b><i>${sym}</i></span>${center}<span class="ci ci2"><b>${rank}</b><i>${sym}</i></span></div>`;
}

// ---- chips ----
const DENOMS = [100000, 25000, 5000, 1000, 500, 100];
const DLABEL = { 100000: '100K', 25000: '25K', 5000: '5K', 1000: '1K', 500: '500', 100: '100' };
function chipList(amount, max = 6) {
  const out = [];
  let rest = amount;
  for (const d of DENOMS) {
    let n = Math.floor(rest / d);
    rest -= n * d;
    while (n-- > 0 && out.length < max) out.push(d);
  }
  if (!out.length && amount > 0) out.push(100);
  return out;
}
const chipHTML = (d, label) => `<i class="chip-d d${d}"${label ? ` data-v="${DLABEL[d]}"` : ''}></i>`;
const stackHTML = (amount, max = 6) => {
  const l = chipList(amount, max).reverse();
  return `<div class="stack">${l.map((d, i) => chipHTML(d, i === l.length - 1)).join('')}</div>`;
};
function potStacksHTML(amount) {
  const groups = [];
  let rest = amount;
  for (const d of DENOMS) {
    const n = Math.floor(rest / d);
    rest -= n * d;
    if (n > 0) groups.push([d, Math.min(n, 7)]);
  }
  return groups.slice(0, 4).map(([d, n]) => `<div class="stack">${Array.from({ length: n }, (_, i) => chipHTML(d, i === n - 1)).join('')}</div>`).join('');
}

// ---- avatars / personalities ----
const BOT_EMOJI = { '粉哥': '🌸', 'Micheal': '🎩', 'Grok Bot': '🤖', '小龙': '🐲', '阿杰': '🦊', 'Lucy': '🐱', '老王': '🐼', '阿May': '🦄' };
const PALETTE = [['#ff9e9e', '#c62828'], ['#9ec2ff', '#1e4fb8'], ['#9ff0c2', '#14804a'], ['#ffe08a', '#b57f00'], ['#e6a3ff', '#7b1fa2'],
  ['#8ff3f3', '#00796b'], ['#ffc78a', '#d84315'], ['#c5d0d6', '#455a64']];
const AV_FIXED = { '粉哥': ['#ffd0e4', '#d81b60'], 'Micheal': ['#cfd8e3', '#34495e'], 'Grok Bot': ['#b8c6ff', '#3a3f9e'], '小龙': ['#b9f6ca', '#1b7a43'] };
function avatarOf(p) {
  let h = 0;
  for (const ch of p.name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const [c1, c2] = AV_FIXED[p.name] || PALETTE[h % PALETTE.length];
  const t = p.isBot ? (BOT_EMOJI[p.name] || '🤖') : esc([...p.name][0].toUpperCase());
  return { c1, c2, t };
}
function bubbleOf(t) {
  if (!t) return null;
  if (t.startsWith('弃牌')) return { kind: 'fold', text: '弃牌' };
  if (t.startsWith('过牌')) return { kind: 'check', text: '过牌' };
  if (t.startsWith('跟注')) return { kind: 'call', text: t };
  if (t.startsWith('全下')) return { kind: 'allin', text: t };
  if (t.startsWith('加注到')) return { kind: 'raise', text: t.replace('加注到', '加注') };
  if (t.startsWith('下注')) return { kind: 'raise', text: t };
  if (t.includes('盲')) return { kind: 'blind', text: t };
  return { kind: 'status', text: t };
}

// ---- showdown: which cards make the winning hands ----
function winningCards(v) {
  if (v.phase !== 'handover' || !v.result || !v.result.showdown || v.board.length < 5) return null;
  const seats = new Map();
  const board = new Set();
  for (const pt of v.result.pots) {
    if (pt.uncalled) continue;
    for (const s of pt.winners) {
      const p = v.seats[s];
      if (!p || !p.cards || seats.has(s)) continue;
      const bf = bestFive([...p.cards, ...v.board]);
      seats.set(s, new Set(bf.cards));
      for (const c of bf.cards) if (v.board.includes(c)) board.add(c);
    }
  }
  return seats.size ? { seats, board } : null;
}

function setView(v) {
  const prev = S.view;
  S.view = v;
  S.viewAt = Date.now();
  S.deadline = v.turnRemainingMs ? Date.now() + v.turnRemainingMs : 0;
  S.pending = false;
  if (v.handNo !== animHand) { animT.clear(); animHand = v.handNo; }
  render();
  spawnFx(prev, v);
  playSounds(prev, v);
  const turnKey = `${v.handNo}-${v.phase}-${v.toAct}-${v.currentBet}`;
  if (prev && prev.phase !== 'handover' && v.phase === 'handover' && v.result && v.result.winners.some((w) => w.seat === S.mySeat)) {
    const big = v.result.winners.find((w) => w.seat === S.mySeat).amount >= 10 * v.bb;
    setTimeout(() => { const [x, y] = posOf(S.mySeat); const r = $('#table').getBoundingClientRect(); confetti(((r.left + r.width * x / 100) / innerWidth) * 100, ((r.top + r.height * y / 100) / innerHeight) * 100, big ? 64 : 34); haptic([30, 50, 30]); }, 900);
  }
  if (v.toAct === S.mySeat && S.mySeat >= 0 && turnKey !== S.lastTurnKey) {
    S.raiseOpen = false;
    S.allinArm = 0;
    play('turn');
    if (navigator.vibrate) { try { navigator.vibrate([40, 60, 40]); } catch (e) { /* */ } }
    if (document.hidden) document.title = '🔔 轮到你了 · 德州扑克';
  }
  if (v.toAct !== S.mySeat) document.title = '德州扑克 · 朋友局';
  S.lastTurnKey = turnKey;
}

function render() {
  const v = S.view;
  if (!v) return;
  const t = $('#table');
  landscape = t.clientWidth / Math.max(1, t.clientHeight) > 1.2;
  POT_PT = landscape ? POT_PT_L : POT_PT_P;
  t.classList.toggle('landscape', landscape);
  t.classList.toggle('betting', BETTING.includes(v.phase));
  const isHost = S.mode !== 'client';
  $('#room-label').textContent = S.mode === 'solo' ? '单机练习 · 对战 AI' : `房间 ${S.code || ''}${isHost ? ' · 房主' : ''}`;
  $('#blind-label').textContent = `盲注 ${fmt(v.sb)}/${fmt(v.bb)}${v.pendingBlinds ? `（下手 ${fmt(v.pendingBlinds.sb)}/${fmt(v.pendingBlinds.bb)}）` : ''} · 第 ${v.handNo} 手`;
  $('#btn-invite').classList.toggle('hidden', S.mode === 'solo');
  renderNetDot();
  const win = winningCards(v);
  renderSeats(v, isHost, win);
  renderCenter(v, isHost, win);
  renderActionBar(v, isHost);
  renderLog(v);
}

function seatSide(x, y) {
  if (y < 30) return x < 40 ? 'top tl' : x > 60 ? 'top tr' : 'top tc';
  if (x === 50) return 'bottom';
  return x < 50 ? 'left' : 'right';
}

function renderSeats(v, isHost, win) {
  const winners = new Map();
  if (v.phase === 'handover' && v.result) for (const w of v.result.winners) winners.set(w.seat, w.amount);
  const betting = BETTING.includes(v.phase);
  const tw = $('#table').clientWidth, th = $('#table').clientHeight;
  let html = '';
  let dealOrder = 0;
  for (let i = 0; i < MAX_SEATS; i++) {
    const [x, y] = posOf(i);
    const p = v.seats[i];
    const side = seatSide(x, y);
    if (!p) {
      if (!isHost && v.seats.filter(Boolean).length >= 6) continue; // keep small screens tidy
      html += `<div class="seat empty ${side} ${isHost ? 'can-add' : ''}" data-empty="${i}" style="left:${x}%;top:${y}%">
        <div class="avatar-wrap"><div class="avatar">${isHost ? '＋' : ''}</div></div>
        ${isHost ? '<div class="add-lbl">添加 AI</div>' : ''}</div>`;
      continue;
    }
    const me = i === S.mySeat;
    const active = v.toAct === i;
    const out = !p.inHand && p.chips === 0;
    const isWin = winners.has(i);
    const showdownLoser = win && p.cards && !win.seats.has(i) && p.inHand && !p.folded;
    const tilted = p.isBot && p.tilt >= 0.5;
    const cls = ['seat', side, me && 'me', active && 'active', active && p.isBot && 'thinking', p.inHand && p.folded && 'folded',
      (out || p.sittingOut || !p.connected) && 'out', !p.connected && 'offline', isWin && 'winner', showdownLoser && 'loser', tilted && 'tilt', p.cards && !me && p.hasCards && 'shown'].filter(Boolean).join(' ');
    let hole = '';
    if (p.hasCards && !me) {
      if (p.cards) {
        const a = anim(`rev-${i}`, 'flip', 450);
        const ws = win && win.seats.get(i);
        hole = `<div class="hole revealed">${p.cards.map((c, k) => cardHTML(c, `${a.cls}${ws ? (ws.has(c) ? ' lift' : ' dim') : ''}`,
          a.style.replace(/(-?\d+)ms/, (m, n) => `${Number(n) + k * 90}ms`))).join('')}</div>`;
      } else if (!p.folded) {
        const dx = Math.round(((CENTER_PT[0] - x) / 100) * tw), dy = Math.round(((CENTER_PT[1] - y) / 100) * th);
        const order = dealOrder++;
        hole = `<div class="hole">${[0, 1].map((k) => {
          const a = anim(`deal-${i}-${k}`, 'deal', 420, order * 70 + k * 300);
          return cardHTML(null, a.cls, `--dx:${dx}px;--dy:${dy}px;${a.style}`);
        }).join('')}</div>`;
      }
    }
    // action bubble
    let b = bubbleOf(p.lastAction);
    if (!p.connected) b = { kind: 'offline', text: '' };
    else if (p.sittingOut) b = { kind: 'status', text: '暂离' };
    else if (out) b = { kind: 'status', text: '出局' };
    if (p.handName) b = { kind: 'hand', text: p.handName };
    if (active && p.isBot) b = { kind: 'think', text: '思考中<i>.</i><i>.</i><i>.</i>' };
    let bubble = '';
    if (b && b.kind === 'offline') {
      bubble = `<div class="bubble offline" data-off="${p.offMs || 0}" data-turn="${active ? 1 : 0}">${offlineText(p.offMs || 0, active)}</div>`;
    } else if (b) {
      const a = anim(`bub-${i}-${b.text}`, 'pop', 350);
      bubble = `<div class="bubble ${b.kind} ${a.cls}" style="${a.style}">${b.kind === 'think' ? b.text : esc(b.text)}</div>`;
    }
    const readyBadge = !v.running && !p.isBot && p.connected ? (p.ready ? '<span class="rdy ok">✓</span>' : '<span class="rdy">…</span>') : '';
    const av = avatarOf(p);
    const info = p.isBot ? styleInfo(p.style) : null;
    const tag = info
      ? `<span class="stag" style="--sc:${info.color}">${info.emoji}<b>${info.label}</b>${tilted ? '<em>😤上头</em>' : ''}</span>`
      : `<span class="stag human">${me ? '我' : '玩家'}</span>`;
    const posTag = i === v.sbSeat && betting ? '<span class="ptag sb">SB</span>' : i === v.bbSeat && betting ? '<span class="ptag bb">BB</span>' : '';
    html += `<div class="${cls}" data-seat="${i}" style="left:${x}%;top:${y}%">
      <div class="avatar-wrap">
        <svg class="ring" viewBox="0 0 56 56"><circle class="bg" cx="28" cy="28" r="26"/><circle class="fg" cx="28" cy="28" r="26" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="0"/></svg>
        <div class="avatar" style="--c1:${av.c1};--c2:${av.c2}">${av.t}</div>
        ${posTag}${hole}${readyBadge}
        ${!p.connected ? '<span class="off-ic" aria-label="掉线">📶</span>' : ''}
        ${isWin ? '<div class="crown">👑</div>' : ''}
      </div>
      <div class="plate"><div class="name">${esc(p.name)}</div><div class="chips">${fmt(p.chips)}</div>${tag}</div>
      ${bubble}
      ${isWin ? `<div class="win-pop">+${fmt(winners.get(i))}</div>` : ''}
    </div>`;
    if (p.bet > 0) {
      const [bx, by] = betPt(i);
      const a = anim(`bet-${i}-${p.bet}`, 'in', 380);
      const fx = Math.round(((x - bx) / 100) * tw), fy = Math.round(((y - by) / 100) * th);
      html += `<div class="bet ${a.cls}" style="left:${bx}%;top:${by}%;--fx:${fx}px;--fy:${fy}px;${a.style}">${stackHTML(p.bet, 5)}<span class="amt">${fmt(p.bet)}</span></div>`;
    }
  }
  if (v.button >= 0 && v.seats[v.button] && (betting || v.phase === 'handover')) {
    const [dx, dy] = dealerPt(v.button);
    html += `<div class="dealer" style="left:${dx}%;top:${dy}%">D</div>`;
  }
  const seatsEl = $('#seats');
  seatsEl.innerHTML = html;
  seatsEl.querySelectorAll('.seat.empty.can-add').forEach((el) => { el.onclick = () => { play('click'); S.ctrl.addBot(); }; });
  seatsEl.querySelectorAll('.seat[data-seat]').forEach((el) => { el.onclick = () => showSeatInfo(Number(el.dataset.seat)); });
  updateTimers();
}

function offlineText(offMs, myTurn) {
  if (myTurn && S.deadline) return `掉线中… ${Math.max(0, Math.ceil((S.deadline - Date.now()) / 1000))}s 后自动过牌/弃牌`;
  const sec = Math.floor(offMs / 1000);
  return `掉线中… ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function renderCenter(v, isHost, win) {
  const board = [];
  for (let i = 0; i < 5; i++) {
    if (i < v.board.length) {
      const stagger = i < 3 ? i * 150 : 0;
      const a = anim(`board-${i}`, 'flip', 450, stagger);
      const c = v.board[i];
      board.push(cardHTML(c, `${a.cls}${win ? (win.board.has(c) ? ' lift' : ' dim') : ''}`, a.style));
    } else board.push('<div class="card slot"></div>');
  }
  $('#board').innerHTML = board.join('');
  const betting = BETTING.includes(v.phase);
  const pot = $('#pot');
  pot.style.left = POT_PT[0] + '%';
  pot.style.top = POT_PT[1] + '%';
  const potKey = betting ? v.potTotal : 0;
  if (pot.dataset.k !== String(potKey)) {
    pot.dataset.k = String(potKey);
    pot.innerHTML = betting && v.potTotal > 0
      ? `<div class="stacks">${potStacksHTML(v.pot || v.potTotal)}</div><span class="amt"><span class="lbl">底池</span><span class="num">${fmt(v.potTotal)}</span></span>`
      : '';
    if (!reduceMotion() && betting && v.potTotal > 0) { pot.classList.remove('bump'); void pot.offsetWidth; pot.classList.add('bump'); }
  }
  let msg = '';
  if (v.phase === 'handover' && v.result) {
    const pots = v.result.pots.filter((pt) => !pt.uncalled || v.result.pots.length === 1);
    const best = pots.find((pt) => pt.handName);
    const iWon = v.result.winners.some((w) => w.seat === S.mySeat);
    const lines = pots.map((pt, idx, arr) => {
      const names = pt.winners.map((s) => (s === S.mySeat ? '你' : v.seats[s] ? esc(v.seats[s].name) : '?')).join('、');
      const label = arr.length > 1 ? (idx === 0 ? '主池' : `边池${idx}`) : '';
      return `<div class="wl">${names} ${pt.winners.length > 1 ? '平分' : '赢得'}${label} <b>${fmt(pt.amount)}</b></div>`;
    }).join('');
    msg = `<div class="win-banner ${iWon ? 'mine' : ''}"><div class="wt">${iWon ? '🎉 你赢了！' : '🏆 本手结果'}</div>${lines}<div class="hn">${best ? esc(best.handName) : '其他人弃牌'}</div></div>`;
  }
  if (!betting) {
    const eligible = v.seats.filter((p) => p && p.chips > 0 && !p.sittingOut && p.connected).length;
    if (!v.running && S.mode !== 'solo') {
      // waiting room: who's here, who's ready
      const humans = v.seats.filter((p) => p && !p.isBot);
      const isReady = (p) => p.ready;
      const ready = humans.filter((p) => isReady(p) && p.connected).length;
      const chips = v.seats.filter(Boolean).map((p) => { const av = avatarOf(p); return `<div class="wr-p ${p.connected ? '' : 'off'} ${p.isBot || isReady(p) ? 'ok' : ''}"><div class="avatar sm" style="--c1:${av.c1};--c2:${av.c2}">${av.t}</div><span>${esc(p.name)}</span><em>${p.isBot ? 'AI' : !p.connected ? '掉线' : isReady(p) ? '已准备' : '未准备'}</em></div>`; }).join('');
      msg += `<div class="waitroom"><div class="wr-title">${isHost ? '等待朋友加入' : '等待房主开始'} · <b>${ready}/${humans.length}</b> 已准备</div><div class="wr-list">${chips}</div>
        ${isHost ? (eligible >= 2 ? `<button class="btn primary big-start" id="btn-start">▶ 开始游戏</button>` : '<div class="hint">至少需要 2 名玩家 · 点空位添加 AI 或邀请朋友</div>') : ''}</div>`;
    } else if (!v.running) {
      msg += isHost && eligible >= 2 ? '<button class="btn primary big-start" id="btn-start">▶ 开始游戏</button>' : '<div class="hint">至少需要 2 名玩家</div>';
    } else if (eligible < 2) {
      msg += `<div class="hint">等待更多有筹码的玩家…${isHost ? '（可在菜单中买入或添加 AI）' : '（可点「买筹码」）'}</div>`;
    }
  }
  const cm = $('#center-msg');
  if (cm.dataset.k !== msg) { cm.dataset.k = msg; cm.innerHTML = msg; }
  const bs = $('#btn-start');
  if (bs) bs.onclick = () => { play('click'); S.ctrl.start(); };
}

// chips flying: bets -> pot at the end of a street, pot -> winners at the end of the hand
function spawnFx(prev, v) {
  if (!prev || prev.handNo !== v.handNo || reduceMotion()) return;
  const fx = $('#fx');
  const fly = (from, to, amount, delay = 0, cls = '') => {
    const g = document.createElement('div');
    g.className = 'ghost ' + cls;
    g.innerHTML = stackHTML(amount, 6);
    g.style.left = from[0] + '%'; g.style.top = from[1] + '%';
    fx.appendChild(g);
    setTimeout(() => requestAnimationFrame(() => { g.style.left = to[0] + '%'; g.style.top = to[1] + '%'; g.classList.add('go'); }), 30 + delay);
    setTimeout(() => g.remove(), 1300 + delay);
  };
  if (prev.phase !== v.phase) {
    for (let i = 0; i < MAX_SEATS; i++) {
      const a = prev.seats[i], b = v.seats[i];
      if (a && a.bet > 0 && (!b || b.bet === 0)) fly(betPt(i), POT_PT, a.bet);
    }
  }
  if (BETTING.includes(prev.phase) && v.phase === 'handover' && v.result) {
    v.result.winners.forEach((w, k) => { if (v.seats[w.seat]) fly(POT_PT, posOf(w.seat), w.amount, 650 + k * 120, 'big'); });
  }
}

function playSounds(prev, v) {
  if (!prev) return;
  if (prev.handNo !== v.handNo && BETTING.includes(v.phase)) {
    const n = v.seats.filter((p) => p && p.inHand).length * 2;
    for (let k = 0; k < Math.min(n, 12); k++) setTimeout(() => play('deal'), k * 70);
    return;
  }
  if (v.board.length > prev.board.length) for (let k = 0; k < v.board.length - prev.board.length; k++) setTimeout(() => play('flip'), k * 150);
  for (let i = 0; i < MAX_SEATS; i++) {
    const a = prev.seats[i], b = v.seats[i];
    if (!a || !b || a.lastAction === b.lastAction || !b.lastAction) continue;
    const k = bubbleOf(b.lastAction).kind;
    play({ fold: 'fold', check: 'check', call: 'chip', raise: 'raise', allin: 'allin' }[k] || '');
  }
  if (prev.phase !== v.phase && v.phase === 'handover' && v.result) {
    const iWon = v.result.winners.some((w) => w.seat === S.mySeat);
    const me = S.mySeat >= 0 ? v.seats[S.mySeat] : null;
    setTimeout(() => play(iWon ? 'win' : me && me.inHand && !me.folded && v.result.showdown ? 'lose' : 'chips'), 600);
  }
}

// hero hand-strength (label + draws + equity meter), cached per cards/board/opponents
let eqCache = { key: '', eq: 0 };
function heroStrengthHTML(v, me) {
  if (!me || !me.cards || me.cards.length < 2 || !me.inHand || me.folded) return '';
  const hi = heroHandInfo(me.cards, v.board);
  if (!hi) return '';
  const nOpp = Math.max(1, v.seats.filter((p) => p && p.inHand && !p.folded && p.seat !== S.mySeat).length);
  const key = `${me.cards.join(',')}|${v.board.join(',')}|${nOpp}`;
  const live = BETTING.includes(v.phase);
  if (live && eqCache.key !== key) eqCache = { key, eq: quickEquity(me.cards, v.board, nOpp, v.board.length ? 500 : 350) };
  const pct = Math.round(eqCache.eq * 100);
  return `<div class="hs tier${hi.tier}">
      <div class="hs-label">${esc(hi.label)}</div>
      ${hi.sub ? `<div class="hs-sub">${esc(hi.sub)}</div>` : ''}
      ${live ? `<div class="meter" title="对 ${nOpp} 名对手的大致胜率"><i style="width:${pct}%"></i></div>
      <div class="eq">胜率≈${pct}% <span>vs ${nOpp}人</span></div>` : ''}
    </div>`;
}

function renderActionBar(v, isHost) {
  const bar = $('#action-bar');
  const me = S.mySeat >= 0 ? v.seats[S.mySeat] : null;
  const la = v.legal;
  const key = `${v.handNo}|${v.phase}|${v.toAct}|${v.currentBet}|${la ? la.minRaiseTo + '-' + la.maxRaiseTo : ''}|${me ? me.chips + '-' + me.bet + '-' + me.sittingOut + '-' + me.inHand + '-' + me.folded + '-' + (me.cards || []).join(',') : ''}|${v.board.length}|${v.running}|${wideMQ.matches}|${JSON.stringify(v.buy)}|${me && me.ready}|${v.rules && v.rules.allowRebuy}|${S.netState}`;
  if (key === S.actionKey && bar.innerHTML) { updateTimers(); return; }
  S.actionKey = key;
  if (!me) { bar.innerHTML = '<div class="waiting">观战中</div>'; return; }

  const cards = me.cards && me.inHand
    ? me.cards.map((c, k) => { const a = anim(`my-${k}`, 'deal', 450, k * 300); return cardHTML(c, 'big ' + a.cls + (me.folded ? ' dim' : ''), a.style); }).join('')
    : '<div class="card slot big"></div><div class="card slot big"></div>';
  let info = heroStrengthHTML(v, me);
  if (!info) info = me.inHand && me.folded ? '<div class="hs"><div class="hs-label muted">已弃牌</div></div>' : '<div class="hs"><div class="hs-label muted">等待发牌</div></div>';
  const clock = `<div class="turn-clock idle" id="my-clock"><svg viewBox="0 0 44 44"><circle class="bg" cx="22" cy="22" r="19"/><circle class="fg" cx="22" cy="22" r="19" stroke-dasharray="${CLOCK_C.toFixed(2)}" stroke-dashoffset="0"/></svg><span></span></div>`;
  const canBuy = S.mode !== 'client' || (v.rules && v.rules.allowRebuy);
  const buyNote = v.buy && v.buy.pending ? `<span class="buy-note">⏳ 待批 ${fmtShort(v.buy.pending)}</span>` : v.buy && v.buy.queued ? `<span class="buy-note">＋${fmtShort(v.buy.queued)} 下手到账</span>` : '';
  const stack = `<div class="my-stack"><span class="lbl">筹码${canBuy ? '<button class="buy-plus" id="btn-buy-quick" aria-label="买筹码" title="买筹码">＋</button>' : ''}</span><b>${fmt(me.chips)}</b>${me.bet ? `<span class="muted">已下 ${fmt(me.bet)}</span>` : buyNote}</div>`;
  let html = `<div class="my-row"><div class="my-cards">${cards}</div><div class="my-info">${info}</div>${stack}${clock}</div>`;

  if (la) {
    const allinCall = !la.canCheck && la.callAmount >= me.chips;
    const callBtn = la.canCheck
      ? '<button class="btn act-check" data-act="check"><span>过牌</span><kbd>C</kbd></button>'
      : `<button class="btn act-call ${allinCall ? 'allin' : ''}" data-act="call"><span>${allinCall ? '全下跟注' : '跟注'}</span><small>${fmt(la.callAmount)}</small><kbd>C</kbd></button>`;
    html += `<div class="actions my-turn">
      <button class="btn act-fold" data-act="fold"><span>弃牌</span><kbd>F</kbd></button>
      ${callBtn}
      ${la.canRaise ? '<button class="btn act-raise" data-act="raise" id="btn-raise"></button>' : ''}
      <span class="your-turn" aria-hidden="true">轮到你了</span>
    </div>`;
    if (la.canRaise) {
      const pot = v.potTotal;
      const unit = v.sb >= 100 ? 100 : 1;
      const q = (f) => Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, Math.round((v.currentBet + f * (pot + la.toCall)) / unit) * unit));
      const qb = (f, label) => { const amt = q(f); return `<button class="btn" data-q="${amt}"><span>${label}</span><small>${fmt(amt)}</small></button>`; };
      html += `<div class="raise-panel ${S.raiseOpen ? 'open' : ''}" id="raise-panel">
        <div class="quick">${qb(0.5, '½ 池')}${qb(0.75, '¾ 池')}${qb(1, '1 倍池')}<button class="btn q-allin" data-q="${la.maxRaiseTo}"><span>全下</span><small>${fmt(la.maxRaiseTo)}</small></button></div>
        <div class="slider-row">
          <button class="btn step" data-step="-1" aria-label="减少">−</button>
          <input type="range" id="raise-slider" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" step="1" value="${la.minRaiseTo}" aria-label="加注金额">
          <button class="btn step" data-step="1" aria-label="增加">＋</button>
          <input type="number" id="raise-input" class="raise-amt" inputmode="numeric" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" value="${la.minRaiseTo}">
        </div>
      </div>`;
    }
  } else if (me.sittingOut) {
    html += '<div class="actions"><button class="btn green" id="btn-back">我回来了（回到座位）</button></div>';
  } else if (!me.inHand && me.chips === 0 && !(v.buy && v.buy.queued)) {
    html += v.buy && v.buy.pending
      ? `<div class="actions"><div class="waiting">⏳ 已申请买入 ${fmt(v.buy.pending)}，等待房主批准…</div></div>`
      : canBuy
        ? '<div class="actions"><div class="waiting small">筹码输光了</div><button class="btn primary" id="btn-buy-big">💰 买筹码</button></div>'
        : '<div class="actions"><div class="waiting">筹码输光了 · 房主已关闭买入</div></div>';
  } else if (!v.running && S.mode === 'client') {
    html += `<div class="actions"><div class="waiting small">${me.ready ? '已准备，等待房主开始' : '准备好了就点一下'}</div><button class="btn ${me.ready ? '' : 'green'} ready-btn" id="btn-ready">${me.ready ? '✓ 已准备（取消）' : '✋ 准备'}</button></div>`;
  } else if (me.inHand && !me.folded && BETTING.includes(v.phase) && !me.allIn) {
    // in the hand, not my turn: show the controls, clearly disabled
    const who = v.toAct >= 0 && v.seats[v.toAct] ? v.seats[v.toAct] : null;
    html += `<div class="actions idle"><button class="btn act-fold" disabled><span>弃牌</span></button><button class="btn act-check" disabled><span>${v.currentBet > me.bet ? '跟注' : '过牌'}</span></button><button class="btn act-raise" disabled><span>加注</span></button>
      <div class="idle-tip">${who ? `等待 <b>${esc(who.name)}</b>${who.connected === false ? '（掉线中）' : who.isBot ? ' 思考' : ''}<span class="dots"><i>.</i><i>.</i><i>.</i></span>` : (v.runout ? '发牌中…' : '')}</div></div>`;
  } else {
    const who = v.toAct >= 0 && v.seats[v.toAct] ? v.seats[v.toAct] : null;
    const t = who ? `等待 <b>${esc(who.name)}</b> ${who.isBot ? '思考' : '行动'}<span class="dots"><i>.</i><i>.</i><i>.</i></span>` : (v.phase === 'handover' ? '本手结束，下一手即将开始…' : (v.runout ? '发牌中…' : ''));
    html += `<div class="actions"><div class="waiting">${t}${me.inHand ? '' : (BETTING.includes(v.phase) ? '（下一手加入）' : '')}</div></div>`;
  }
  bar.innerHTML = html;
  bar.classList.toggle('my-turn', !!la);

  bar.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => doAct(b.dataset.act); });
  const back = $('#btn-back'); if (back) back.onclick = () => setSitOut(false);
  ['#btn-buy-quick', '#btn-buy-big'].forEach((id) => { const b = $(id); if (b) b.onclick = (e) => { e.stopPropagation(); showBuyIn(); }; });
  const rd = $('#btn-ready'); if (rd) rd.onclick = () => { haptic(12); play('click'); sendToHost({ t: 'ready', v: !me.ready }); };
  if (la && la.canRaise) setupRaise(v, la);
  updateTimers();
}

function doAct(t) {
  const v = S.view, la = v && v.legal;
  if (!la) return;
  const me = v.seats[S.mySeat];
  // all-in needs a second tap (3 s window)
  const panelOpen = wideMQ.matches || ($('#raise-panel') && $('#raise-panel').classList.contains('open'));
  const goingAllIn = (t === 'raise' && la.canRaise && panelOpen && S.raiseValue >= la.maxRaiseTo) || (t === 'call' && !la.canCheck && me && la.callAmount >= me.chips);
  if (goingAllIn && Date.now() - (S.allinArm || 0) > 3000) {
    S.allinArm = Date.now();
    const btn = t === 'raise' ? $('#btn-raise') : $('[data-act=call]');
    if (btn) { btn.classList.add('confirm'); btn.querySelector('span').textContent = '再点一次 确认全下'; }
    haptic([15, 30, 15]); play('tick');
    clearTimeout(S.allinTimer);
    S.allinTimer = setTimeout(() => { S.allinArm = 0; S.actionKey = ''; render(); }, 3000);
    return;
  }
  if (goingAllIn) { S.allinArm = 0; clearTimeout(S.allinTimer); }
  if (t === 'raise') {
    if (!la.canRaise) return;
    const panel = $('#raise-panel');
    if (!wideMQ.matches && panel && !panel.classList.contains('open')) { // phones: first tap opens the sizing panel
      panel.classList.add('open'); S.raiseOpen = true; play('click'); updateRaiseBtn(la); return;
    }
    const amt = S.raiseValue;
    sendAction(amt >= la.maxRaiseTo ? { type: 'allin' } : { type: 'raise', amount: amt });
  } else if (t === 'call' && la.canCheck) sendAction({ type: 'check' });
  else sendAction({ type: t });
}

function updateRaiseBtn(la) {
  const btn = $('#btn-raise');
  if (!btn) return;
  const x = S.raiseValue;
  const allin = x >= la.maxRaiseTo;
  const open = wideMQ.matches || ($('#raise-panel') && $('#raise-panel').classList.contains('open'));
  const verb = allin ? '全下' : la.isBet ? '下注' : '加注到';
  btn.classList.toggle('allin', allin);
  btn.innerHTML = open ? `<span>${open && !wideMQ.matches ? '确认' : ''}${verb}</span><small>${fmt(x)}</small><kbd>R</kbd>` : `<span>${la.isBet ? '下注' : '加注'} ▴</span><small>${fmt(x)}</small><kbd>R</kbd>`;
}

function setupRaise(v, la) {
  const slider = $('#raise-slider'), input = $('#raise-input');
  const unit = v.sb >= 100 ? 100 : 1;
  const step = Math.max(unit, v.bb / 2);
  const clamp = (x) => Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, Math.round(x)));
  let lastTick = 0;
  const set = (x, fromInput) => {
    x = clamp(x);
    S.raiseValue = x;
    if (!fromInput) input.value = x;
    slider.value = x;
    const span = la.maxRaiseTo - la.minRaiseTo;
    slider.style.setProperty('--fill', (span > 0 ? ((x - la.minRaiseTo) / span) * 100 : 100) + '%');
    document.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('sel', Number(b.dataset.q) === x));
    updateRaiseBtn(la);
  };
  slider.oninput = () => {
    let x = Number(slider.value);
    if (x < la.maxRaiseTo) x = Math.round(x / unit) * unit;
    set(x);
    const now = performance.now();
    if (now - lastTick > 60) { lastTick = now; play('tick'); }
  };
  input.oninput = () => { const x = Number(input.value); if (x) set(x, true); };
  input.onblur = () => set(Number(input.value) || la.minRaiseTo);
  document.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => { play('chip'); set(Number(b.dataset.q)); }; });
  document.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => { play('tick'); set(S.raiseValue + Number(b.dataset.step) * step); }; });
  set(S.raiseValue >= la.minRaiseTo && S.raiseValue <= la.maxRaiseTo && S.raiseKey === S.actionKey ? S.raiseValue : la.minRaiseTo);
  S.raiseKey = S.actionKey;
}

// desktop keyboard shortcuts: F fold · C check/call · R raise
document.addEventListener('keydown', (e) => {
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (!S.view || !S.view.legal || !$('#modal').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') doAct('fold');
  else if (k === 'c' || k === ' ') { e.preventDefault(); doAct('call'); }
  else if (k === 'r') doAct('raise');
});

let lastTickSec = -1;
function updateTimers() {
  const v = S.view;
  if (!v) return;
  const left = S.deadline ? Math.max(0, S.deadline - Date.now()) : 0;
  const frac = v.turnTotalMs && S.deadline ? left / v.turnTotalMs : 1;
  document.querySelectorAll('.seat.active .ring .fg').forEach((c) => {
    c.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(2));
    c.classList.toggle('urgent', !!S.deadline && frac < 0.3);
  });
  document.querySelectorAll('.bubble.offline[data-off]').forEach((el) => {
    const t = offlineText(Number(el.dataset.off) + (Date.now() - (S.viewAt || Date.now())), el.dataset.turn === '1');
    if (el.textContent !== t) el.textContent = t;
  });
  const clock = $('#my-clock');
  if (clock) {
    if (v.toAct === S.mySeat && S.deadline) {
      const s = Math.ceil(left / 1000);
      clock.classList.remove('idle');
      clock.querySelector('span').textContent = s;
      clock.querySelector('.fg').setAttribute('stroke-dashoffset', (CLOCK_C * (1 - frac)).toFixed(2));
      clock.classList.toggle('urgent', s <= 8);
      if (s <= 5 && s > 0 && s !== lastTickSec) { lastTickSec = s; play('tick'); if (s <= 3 && navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* */ } } }
    } else clock.classList.add('idle');
  }
}
setInterval(updateTimers, 250);
if (window.ResizeObserver) new ResizeObserver(() => { if (S.view) { S.actionKey = ''; render(); } }).observe(document.querySelector('#table-wrap'));

let lastLogId = 0;
function renderLog(v) {
  const el = $('#log');
  const last = v.log.length ? v.log[v.log.length - 1].id : 0;
  if (last === lastLogId) return;
  lastLogId = last;
  el.innerHTML = v.log.map((l) => `<div class="${l.kind}">${esc(l.text)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}
$('#log').onclick = () => $('#log').classList.toggle('open');
$('#btn-log').onclick = () => { $('#log').classList.toggle('open'); play('click'); };
function renderMute() { const b = $('#btn-mute'); b.textContent = isMuted() ? '🔇' : '🔊'; b.setAttribute('aria-label', isMuted() ? '打开音效' : '关闭音效'); b.classList.toggle('off', isMuted()); }
$('#btn-mute').onclick = () => { setMuted(!isMuted()); renderMute(); toast(isMuted() ? '音效已关闭' : '音效已打开', 1200); };
renderMute();

// tap a seat: who is this player / what's their style (host can switch an AI's personality)
function showSeatInfo(seat) {
  const v = S.view; const p = v && v.seats[seat];
  if (!p) return;
  const av = avatarOf(p);
  const st = p.stats || { h: 0, v: 0, p: 0, a: 0, n: 0 };
  const pc = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—');
  const info = p.isBot ? styleInfo(p.style) : null;
  const canEdit = p.isBot && S.mode !== 'client';
  let html = `<div class="who"><div class="avatar big" style="--c1:${av.c1};--c2:${av.c2}">${av.t}</div>
    <div><h3>${esc(p.name)}${seat === S.mySeat ? '（我）' : ''}</h3>
    ${info ? `<span class="stag" style="--sc:${info.color}">${info.emoji}<b>${info.label}</b></span> <span class="muted small">${info.en}</span>` : '<span class="stag human">真人玩家</span>'}</div></div>`;
  if (info) html += `<p class="blurb">${esc(info.blurb)}</p>`;
  if (p.isBot && p.tilt >= 0.5) html += '<p class="small" style="color:#ff9a8f">😤 刚输了个大锅，正在上头：打得更松更凶。</p>';
  html += `<div class="statgrid"><div><b>${st.h}</b><span>已玩手数</span></div><div><b>${pc(st.v, st.h)}</b><span>入池率 VPIP</span></div>
    <div><b>${pc(st.p, st.h)}</b><span>翻前加注 PFR</span></div><div><b>${pc(st.a, st.n)}</b><span>翻后进攻</span></div></div>`;
  if (canEdit) {
    html += `<h4>换个性格</h4><div class="style-pick">${STYLE_KEYS.map((k) => { const s = PERSONALITIES[k]; return `<button class="btn ${k === styleKey(p.style) ? 'sel' : ''}" data-style="${k}" style="--sc:${s.color}">${s.emoji} ${s.label}</button>`; }).join('')}</div>`;
  }
  openModal(html);
  S.modalKind = 'seat';
  document.querySelectorAll('[data-style]').forEach((b) => {
    b.onclick = () => { S.ctrl.setBotStyle(seat, b.dataset.style); play('click'); closeModal(); toast(`${p.name} → ${PERSONALITIES[b.dataset.style].label}`); };
  });
}

// ---------------- buy-in / ledger ----------------
function showBuyIn(seat = S.mySeat) {
  const v = S.view;
  const p = v && v.seats[seat];
  if (!p) return;
  const isHost = S.mode !== 'client';
  const forOther = seat !== S.mySeat;
  const rules = v.rules || { maxBuyIn: 200000, allowRebuy: true, approval: false };
  if (!isHost && !rules.allowRebuy) { toast('房主已关闭买入', { type: 'warn' }); return; }
  const room = forOther ? 100000000 : isHost ? S.ctrl.buyRoom(seat) : (v.buy ? v.buy.room : 0);
  const capped = room < 100000000;
  const midHand = BETTING.includes(v.phase) && p.inHand && !p.folded;
  const needApproval = !isHost && rules.approval;
  const presets = [...BUYIN_PRESETS];
  if (capped && room > 0 && !presets.includes(room)) presets.push(room);
  const first = presets.find((a) => a <= room) || 0;
  openModal(`<h3>💰 买筹码${forOther ? ` · 为 ${esc(p.name)}` : ''}</h3>
    <div class="buy-head"><div><span class="muted small">当前筹码</span><b>${fmt(p.chips)}</b></div><div class="arrow">→</div><div><span class="muted small">买入后</span><b id="buy-after">${fmt(p.chips + first)}</b></div></div>
    <div class="buy-presets">${presets.sort((a, b) => a - b).map((a) => `<button class="btn chip-btn ${a === room && !BUYIN_PRESETS.includes(a) ? 'fill' : ''}" data-buy="${a}" ${a > room ? 'disabled' : ''}><i class="chip-d ${a >= 100000 ? 'd100000' : a >= 25000 ? 'd25000' : 'd5000'}"></i><b>${fmtShort(a)}</b>${a === room && !BUYIN_PRESETS.includes(a) ? '<small>补满</small>' : ''}</button>`).join('')}</div>
    <label class="buy-custom"><span>自定义</span><button class="btn step" data-bstep="-1">−</button><input type="number" id="buy-amt" inputmode="numeric" min="1000" step="1000" value="${first}"><button class="btn step" data-bstep="1">＋</button></label>
    <ul class="buy-rules muted small">
      ${capped ? `<li>买入后筹码不超过 <b>${fmt(rules.maxBuyIn)}</b>（还可买 ${fmt(room)}）</li>` : '<li>房主代买，不受上限限制</li>'}
      ${needApproval ? '<li>⏳ 需要房主批准</li>' : ''}
      ${midHand ? '<li>你正在牌局中：本手结束后到账</li>' : ''}
      <li>虚拟娱乐筹码，记入「账本」方便朋友结算</li>
    </ul>
    <button class="btn primary wide" id="buy-go" ${room > 0 ? '' : 'disabled'}>${room > 0 ? (needApproval ? '申请买入' : '确认买入') : '已达买入上限'}</button>`);
  S.modalKind = 'buy';
  const inp = $('#buy-amt');
  const sync = () => {
    const a = Math.max(0, Math.floor(Number(inp.value) || 0));
    $('#buy-after').textContent = fmt(p.chips + Math.min(a, room));
    document.querySelectorAll('[data-buy]').forEach((b) => b.classList.toggle('sel', Number(b.dataset.buy) === a));
    $('#buy-go').disabled = !(a > 0 && a <= room);
  };
  document.querySelectorAll('[data-buy]').forEach((b) => { b.onclick = () => { play('chip'); haptic(8); inp.value = b.dataset.buy; sync(); }; });
  document.querySelectorAll('[data-bstep]').forEach((b) => { b.onclick = () => { play('tick'); inp.value = Math.min(room, Math.max(1000, (Number(inp.value) || 0) + Number(b.dataset.bstep) * 10000)); sync(); }; });
  inp.oninput = sync;
  sync();
  $('#buy-go').onclick = () => {
    const amount = Math.floor(Number(inp.value) || 0);
    if (!(amount > 0 && amount <= room)) return;
    closeModal();
    if (S.mode === 'client') { sendToHost({ t: 'buyin', amount }); return; }
    const res = S.ctrl.buyIn(seat, amount, forOther ? { ignoreRules: true } : { skipApproval: true });
    if (!res.ok) toast(res.error, { type: 'err' });
    else { play('chips'); toast(res.status === 'queued' ? `买入 ${fmt(amount)}，本手结束后到账` : `${forOther ? p.name + ' ' : ''}买入成功 +${fmt(amount)}`, { type: 'ok' }); }
  };
}

// greedy settle-up: who pays whom (net losers → net winners)
function settleUp(rows) {
  const pos = rows.filter((r) => r.net > 0).map((r) => ({ ...r, left: r.net })).sort((a, b) => b.left - a.left);
  const neg = rows.filter((r) => r.net < 0).map((r) => ({ ...r, left: -r.net })).sort((a, b) => b.left - a.left);
  const out = [];
  let i = 0, j = 0;
  while (i < neg.length && j < pos.length) {
    const x = Math.min(neg[i].left, pos[j].left);
    if (x > 0) out.push({ from: neg[i].name, to: pos[j].name, amount: x });
    neg[i].left -= x; pos[j].left -= x;
    if (!neg[i].left) i++;
    if (!pos[j].left) j++;
  }
  return out;
}
function ledgerHTML(rows, { live = true, code = S.code } = {}) {
  if (!rows || !rows.length) return '<p class="muted">还没有记录</p>';
  const humans = rows.filter((r) => !r.isBot);
  const st = settleUp(humans);
  const sign = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '0');
  return `<table class="ledger"><thead><tr><th>玩家</th><th>买入</th><th>${live ? '当前筹码' : '筹码'}</th><th>净输赢</th></tr></thead><tbody>
    ${rows.map((r) => { const av = avatarOf({ name: r.name, isBot: r.isBot }); return `<tr class="${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''} ${r.seated ? '' : 'left'}">
      <td><span class="lg-n"><span class="avatar xs" style="--c1:${av.c1};--c2:${av.c2}">${av.t}</span><span class="lg-nm">${esc(r.name)}</span>${r.seated ? (r.connected ? '' : '<em class="tag-off">掉线</em>') : '<em class="tag-off">已离开</em>'}${r.buys > 1 ? `<small>×${r.buys}</small>` : ''}</span></td>
      <td>${fmt(r.bought)}</td><td>${fmt(r.stack + r.cashout)}${r.queued ? `<small> +${fmtShort(r.queued)}</small>` : ''}</td><td class="net">${sign(r.net)}</td></tr>`; }).join('')}
    </tbody></table>
    ${st.length ? `<h4>结算建议（仅真人）</h4><ul class="settle">${st.map((x) => `<li><b>${esc(x.from)}</b> → <b>${esc(x.to)}</b><span>${fmt(x.amount)}</span></li>`).join('')}</ul>` : ''}
    <p class="muted small">净输赢 = 当前筹码（含本手已下注）+ 离桌带走 − 总买入。${humans.length < rows.length ? 'AI 的输赢不计入结算建议。' : ''}${code ? ` 房间 ${esc(code)}` : ''}</p>`;
}
function renderLedger(open) {
  const v = S.view;
  if (!v) return;
  if (!open && (S.modalKind !== 'ledger' || $('#modal').classList.contains('hidden'))) return;
  const audit = S.mode !== 'client' && S.ctrl ? S.ctrl.chipAudit() : null;
  const body = `<h3>📒 账本</h3>${ledgerHTML(v.ledger)}
    ${audit ? `<p class="muted small audit ${audit.ok ? '' : 'bad'}">筹码核对：总买入 ${fmt(audit.bought)} = 桌上 ${fmt(audit.onTable)} + 带走 ${fmt(audit.cashout)} ${audit.ok ? '✓' : '✗'}</p>` : ''}
    <div class="row"><button class="btn" id="lg-copy">复制账本</button>${(S.mode !== 'client' || (v.rules && v.rules.allowRebuy)) && S.mySeat >= 0 ? '<button class="btn primary" id="lg-buy">💰 买筹码</button>' : ''}</div>`;
  if (open) { openModal(body); S.modalKind = 'ledger'; } else $('#modal-body').innerHTML = body;
  const c = $('#lg-copy'); if (c) c.onclick = () => copyText(ledgerText(v.ledger));
  const b = $('#lg-buy'); if (b) b.onclick = () => showBuyIn();
}
function ledgerText(rows) {
  const sign = (n) => (n > 0 ? '+' : '') + fmt(n);
  const lines = rows.map((r) => `${r.name}${r.isBot ? '(AI)' : ''}：买入 ${fmt(r.bought)}，筹码 ${fmt(r.stack + r.cashout)}，净 ${sign(r.net)}`);
  const st = settleUp(rows.filter((r) => !r.isBot)).map((x) => `${x.from} → ${x.to} ${fmt(x.amount)}`);
  return `德州扑克朋友局 账本${S.code ? ' · 房间 ' + S.code : ''}\n${lines.join('\n')}${st.length ? '\n结算：' + st.join('；') : ''}\n（虚拟娱乐筹码）`;
}

// ---------------- menus ----------------
$('#btn-invite').onclick = showInvite;
$('#btn-menu').onclick = () => { S.modalKind = 'settings'; renderSettings(true); };

function showInvite() {
  if (!S.code) return;
  const link = inviteLink();
  openModal(`<h3>邀请朋友</h3>
    <div class="muted small">房间码</div>
    <div class="code-big">${S.code}</div>
    <div class="link-box" id="inv-link">${esc(link)}</div>
    <div class="row">
      <button class="btn primary wide" id="btn-copy">复制邀请链接</button>
      ${navigator.share ? '<button class="btn" id="btn-share">分享</button>' : ''}
    </div>
    <ol class="steps">
      <li>把<b>完整链接</b>发到微信群（链接 # 后面是加密密钥，4G/5G 也能连）</li>
      <li>朋友打开链接 → 输入昵称 → 点「加入」</li>
      <li>人齐后，房主点「▶ 开始游戏」</li>
    </ol>
    <p class="muted small">房主负责发牌，请保持本页面打开、手机不要锁屏。网络不支持直连时会自动改走端到端加密的中继，服务器看不到牌。</p>`);
  S.modalKind = 'invite';
  $('#btn-copy').onclick = () => copyText(link);
  const sh = $('#btn-share');
  if (sh) sh.onclick = () => navigator.share({ title: '德州扑克朋友局', text: `来玩德州扑克！房间码 ${S.code}（娱乐筹码，非真钱）`, url: link }).catch(() => {});
}

function copyText(text) {
  const done = () => toast('已复制');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动复制'); }
  ta.remove();
}

function renderSettings(open) {
  const v = S.view;
  if (!v) return;
  if (!open && $('#modal').classList.contains('hidden')) return;
  const isHost = S.mode !== 'client';
  const me = S.mySeat >= 0 ? v.seats[S.mySeat] : null;
  let html = `<h3>${isHost ? '房间设置' : '菜单'}</h3>`;
  if (isHost) {
    const g = S.ctrl.game;
    const players = g.seats.filter(Boolean);
    html += `<div class="row">
        <button class="btn ${S.ctrl.running ? '' : 'primary'} wide" id="st-run">${S.ctrl.running ? '⏸ 暂停（本手结束后）' : '▶ 开始游戏'}</button>
      </div>
      <div id="st-plist">${playerListHTML()}</div>
      <div class="row" style="margin-top:8px"><button class="btn blue wide" id="st-addbot" ${players.length >= 8 ? 'disabled' : ''}>＋ 添加 AI 机器人</button></div>
      <h4>买入规则</h4>
      <div class="rules-box">
        <label class="rl"><span>买入上限<small>买入后筹码不超过</small></span><select id="st-max">${[50000, 100000, 200000, 300000, 500000, 1000000, 100000000].map((x) => `<option value="${x}" ${x === S.ctrl.rules.maxBuyIn ? 'selected' : ''}>${x >= 100000000 ? '不限' : fmt(x)}</option>`).join('')}</select></label>
        <label class="rl sw"><span>允许买入 / 重买<small>关闭后只有房主能给人加码</small></span><input type="checkbox" id="st-rebuy" ${S.ctrl.rules.allowRebuy ? 'checked' : ''}><i></i></label>
        <label class="rl sw"><span>需要房主批准<small>朋友申请后你一键批准</small></span><input type="checkbox" id="st-appr" ${S.ctrl.rules.approval ? 'checked' : ''}><i></i></label>
      </div>
      <h4>盲注</h4>
      <div class="row"><label class="inline">小盲<input type="number" id="st-sb" value="${g.sb}" inputmode="numeric"></label>
        <label class="inline">大盲<input type="number" id="st-bb" value="${g.bb}" inputmode="numeric"></label>
        <button class="btn" id="st-blinds">保存</button></div>
      <h4>每回合行动时间</h4>
      <div class="row"><select id="st-time">${[15, 20, 30, 45, 60, 90].map((s) => `<option value="${s}" ${s === S.ctrl.turnTime ? 'selected' : ''}>${s} 秒</option>`).join('')}</select>
      <span class="muted small">超时自动过牌/弃牌</span></div>`;
  }
  html += '<h4>我</h4><div class="row wrap">';
  if (me && (isHost || (v.rules && v.rules.allowRebuy))) html += '<button class="btn primary" id="st-buy">💰 买筹码</button>';
  html += '<button class="btn" id="st-ledger">📒 账本</button>';
  if (me) html += me.sittingOut ? '<button class="btn green" id="st-back">回到座位</button>' : '<button class="btn" id="st-away">暂离</button>';
  if (S.mode === 'client') html += '<button class="btn" id="st-rejoin">🔄 重新连接</button>';
  html += '<button class="btn" id="st-log">📜 牌局记录</button><button class="btn" id="st-rules">牌型大小</button><button class="btn danger" id="st-leave">退出</button></div>';
  if (S.mode === 'host') html += '<p class="muted small">你是房主：关闭页面会结束整个牌局。</p>';
  openModal(html);
  S.modalKind = 'settings';
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  if (isHost) {
    on('st-run', () => (S.ctrl.running ? S.ctrl.pause() : S.ctrl.start()));
    on('st-addbot', () => S.ctrl.addBot());
    on('st-blinds', () => {
      const sb = Number($('#st-sb').value), bb = Number($('#st-bb').value);
      if (!(sb > 0 && bb >= sb)) { toast('盲注不合法（大盲需 ≥ 小盲）'); return; }
      S.ctrl.setBlinds(sb, bb); toast('已保存');
    });
    $('#st-time').onchange = (e) => S.ctrl.setTurnTime(Number(e.target.value));
    $('#st-max').onchange = (e) => { S.ctrl.setRules({ maxBuyIn: Number(e.target.value) }); toast('已更新买入上限', { type: 'ok', ms: 1200 }); };
    $('#st-rebuy').onchange = (e) => { S.ctrl.setRules({ allowRebuy: e.target.checked }); haptic(8); };
    $('#st-appr').onchange = (e) => { S.ctrl.setRules({ approval: e.target.checked }); haptic(8); };
    bindPlayerList();
  }
  on('st-buy', () => showBuyIn());
  on('st-ledger', () => renderLedger(true));
  on('st-rejoin', () => { closeModal(); manualRejoin(); });
  on('st-log', () => { closeModal(); $('#log').classList.add('open'); });
  on('st-away', () => { setSitOut(true); closeModal(); });
  on('st-back', () => { setSitOut(false); closeModal(); });
  on('st-rules', showRules);
  on('st-leave', () => {
    if (!confirm(S.mode === 'host' ? '退出将结束整个牌局，确定？' : '确定退出？')) return;
    S.leaving = true;
    clearSession();
    if (S.mode === 'client') sendToHost({ t: 'leave' });
    setTimeout(() => { S.mode = null; location.href = location.pathname; }, 300);
  });
}

function playerListHTML() {
  const players = S.ctrl.game.seats.filter(Boolean);
  return `<h4>玩家（${players.length}/8）</h4>
      <ul class="plist">${players.map((p) => `<li>
          <span class="nm">${p.isBot ? '🤖' : (p.connected ? '🟢' : '📴')} ${esc(p.name)} · ${fmt(p.chips)}${p.sittingOut ? ' · 暂离' : ''}</span>
          ${p.isBot ? `<select class="style-sel" data-bstyle="${p.seat}">${STYLE_KEYS.map((k) => `<option value="${k}" ${k === resolveStyle(p.botStyle) ? 'selected' : ''}>${PERSONALITIES[k].emoji} ${PERSONALITIES[k].label}</option>`).join('')}</select>` : ''}
          <button class="btn" data-rebuy="${p.seat}">买入</button>
          ${p.seat !== S.mySeat ? `<button class="btn danger" data-kick="${p.seat}">移除</button>` : ''}
        </li>`).join('')}</ul>`;
}

// light refresh while the settings modal is open (keeps typed inputs intact)
function refreshSettings() {
  if (S.mode === 'client' || $('#modal').classList.contains('hidden')) return;
  const pl = $('#st-plist');
  const busy = document.activeElement && document.activeElement.closest && document.activeElement.closest('#st-plist select');
  if (pl && !busy) { pl.innerHTML = playerListHTML(); bindPlayerList(); }
  const run = $('#st-run');
  if (run) { run.textContent = S.ctrl.running ? '⏸ 暂停（本手结束后）' : '▶ 开始游戏'; run.className = `btn ${S.ctrl.running ? '' : 'primary'} wide`; }
  const ab = $('#st-addbot');
  if (ab) ab.disabled = S.ctrl.game.seats.every(Boolean);
}

function bindPlayerList() {
    document.querySelectorAll('[data-bstyle]').forEach((sel) => { sel.onchange = () => { S.ctrl.setBotStyle(Number(sel.dataset.bstyle), sel.value); toast('已切换性格'); }; });
    document.querySelectorAll('[data-rebuy]').forEach((b) => { b.onclick = () => showBuyIn(Number(b.dataset.rebuy)); });
    document.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = () => {
        const seat = Number(b.dataset.kick);
        const p = S.ctrl.game.seats[seat];
        if (!p || !confirm(`移除 ${p.name}？`)) return;
        for (const [pid, r] of S.remotes) if (r.seat === seat) { try { r.conn.send({ t: 'reject', reason: '你已被房主移出房间' }); } catch (e) { /* */ } S.remotes.delete(pid); }
        S.ctrl.removeSeat(seat);
      };
    });
}

function showRules() {
  const rows = [
    ['皇家同花顺', 'A K Q J 10 同花'], ['同花顺', '五张同花连牌'], ['四条', '四张同点'], ['葫芦', '三条 + 一对'],
    ['同花', '五张同花色'], ['顺子', '五张连牌（A-2-3-4-5 最小）'], ['三条', '三张同点'], ['两对', '两个对子'], ['一对', '一个对子'], ['高牌', '比最大单张'],
  ];
  openModal(`<h3>牌型大小（从大到小）</h3><table class="ranks">${rows.map((r) => `<tr><td><b>${r[0]}</b></td><td class="muted">${r[1]}</td></tr>`).join('')}</table>
    <p class="muted small">无限注德州：每人 2 张底牌 + 5 张公共牌，取最好的 5 张。最小加注额 = 上一次加注的幅度（至少一个大盲）。牌力相同则平分底池；全下时自动计算边池。</p>
    <p class="muted small">本游戏仅使用虚拟娱乐筹码，不涉及任何真钱。</p>`);
  S.modalKind = 'rules';
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  document.title = '德州扑克 · 朋友局';
  if (S.mode) requestWakeLock();
  // back from background / screen lock: revive connections right away instead of waiting for timeouts
  if (S.mode === 'host' && S.peer && S.peer.kick) S.peer.kick();
  if (S.mode === 'client' && S.joined && !S.replaced) {
    const c = S.client && S.client.conn;
    if (S.netState === 'ok') {
      if (Date.now() - S.lastMsgAt > 4000) onClientDisconnected('切回页面时连接已失效');
      else if (c && c._mq) c._mq.probe(); // socket may have died while we were asleep
    } else { S.reconnectTries = Math.min(S.reconnectTries, 3); reconnectNow(); }
  }
});
window.addEventListener('online', () => { if (S.mode === 'client' && S.joined && S.netState !== 'ok') reconnectNow(); if (S.mode === 'host' && S.peer && S.peer.kick) S.peer.kick(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

renderLineup();
installPressFeedback();
$('#btn-ledger').onclick = () => { play('click'); renderLedger(true); };
// previous session's ledger (from the lobby)
(() => {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('holdem.ledger') || 'null'); } catch (e) { /* */ }
  if (!saved || !saved.ledger || !saved.ledger.length || Date.now() - saved.at > 7 * 86400000) return;
  const a = document.createElement('a');
  a.href = '#'; a.textContent = `📒 上次账本（房间 ${saved.code}）`;
  a.onclick = (e) => { e.preventDefault(); openModal(`<h3>📒 上次账本</h3><p class="muted small">${new Date(saved.at).toLocaleString('zh-CN')}</p>${ledgerHTML(saved.ledger, { live: false, code: saved.code })}`); };
  const foot = document.querySelector('.foot'); if (foot) { foot.append(' · '); foot.append(a); }
})();
// reload / re-opened link of the room we were sitting in: rejoin without any taps
if (S.autoRejoin && cleanName(nick.value)) {
  S.name = cleanName(nick.value);
  lobbyMsg(`正在重新加入房间 ${roomParam}…`);
  startJoin(roomParam, S.key);
}

// expose for debugging / automated smoke tests
window.__holdem = S;
