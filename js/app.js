// UI + session management (single-player / host / client).
import { HostController } from './controller.js';
import { hostRoom, joinRoom, peerAvailable, errText, normalizeCode } from './net.js';
import { evaluate, describeScore } from './evaluator.js';
import { RANKS, SUIT_SYMBOLS } from './cards.js';
import { STARTING_CHIPS, MAX_SEATS } from './engine.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);

// seat positions (percent of table box) by position relative to the viewer (0 = bottom / me), clockwise

function getToken() {
  let t = sessionStorage.getItem('holdem.token');
  if (!t) {
    const a = new Uint32Array(4); crypto.getRandomValues(a);
    t = [...a].map((x) => x.toString(36)).join('');
    sessionStorage.setItem('holdem.token', t);
  }
  return t;
}

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
  brokerOk: true,
  heartbeat: null,
};

// ---------------- toast / modal ----------------
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function openModal(html) { $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); S.modalKind = null; }
$('#modal .modal-close').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// ---------------- lobby ----------------
const nick = $('#nick');
nick.value = localStorage.getItem('holdem.nick') || '';
const params = new URLSearchParams(location.search);
const roomParam = normalizeCode(params.get('room'));
if (roomParam) {
  $('#join-code').value = roomParam;
  $('#join-panel').classList.add('highlight');
  $('#join-panel h2').textContent = `加入房间 ${roomParam}`;
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

$('#btn-solo').onclick = () => { if (requireName()) startSolo(Number($('#solo-bots').value)); };
$('#btn-host').onclick = () => { if (requireName()) startHost(); };
$('#btn-join').onclick = () => {
  if (!requireName()) return;
  const code = normalizeCode($('#join-code').value);
  if (code.length < 4) { lobbyMsg('请输入正确的房间码'); return; }
  startJoin(code);
};
$('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
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
    setView(S.ctrl.view(S.mySeat));
    if (S.mode === 'host') {
      for (const r of S.remotes.values()) {
        if (r.conn.open) { try { r.conn.send({ t: 'state', view: S.ctrl.view(r.seat) }); } catch (e) { /* ignore */ } }
      }
    }
    if (S.modalKind === 'settings') refreshSettings();
  });
}

function startSolo(nBots) {
  S.mode = 'solo';
  makeController();
  S.mySeat = S.ctrl.addHuman('me', S.name, 0);
  for (let i = 0; i < nBots; i++) S.ctrl.addBot();
  showGame();
  S.ctrl.start();
}

function startHost() {
  if (!peerAvailable()) { lobbyMsg('联网组件加载失败（PeerJS），请检查网络后刷新；也可以先玩单机。'); return; }
  lobbyMsg('正在创建房间…');
  $('#btn-host').disabled = true;
  S.mode = 'host';
  makeController();
  S.mySeat = S.ctrl.addHuman('host:' + S.token, S.name, 0);
  const handlers = {
    onReady(code, peer) {
      S.code = code; S.peer = peer;
      $('#btn-host').disabled = false;
      showGame();
      setView(S.ctrl.view(S.mySeat));
      showInvite();
      startHostHeartbeat();
    },
    onRetry(peer) { S.peer = peer; },
    onConnection: handleIncoming,
    onBrokerState(ok) { S.brokerOk = ok; renderNetDot(); },
    onError(err, opened) {
      console.warn('peer error', err);
      if (!opened) {
        $('#btn-host').disabled = false;
        lobbyMsg('创建房间失败：' + errText(err));
        S.mode = null; S.ctrl.destroy(); S.ctrl = null;
      } else if (err.type !== 'peer-unavailable') {
        toast('网络提示：' + errText(err));
      }
    },
  };
  S.peer = hostRoom(handlers);
  window.addEventListener('beforeunload', (e) => { if (S.mode === 'host') { e.preventDefault(); e.returnValue = ''; } });
}

function inviteLink() {
  return `${location.origin}${location.pathname}?room=${S.code}`;
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
    // drop any older connection for the same player
    for (const [pid, other] of S.remotes) {
      if (other.seat === seat && seat >= 0 && pid !== conn.peer) { S.remotes.delete(pid); try { other.conn.close(); } catch (e) { /* */ } }
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
    r = { conn, seat, lastSeen: Date.now() };
    S.remotes.set(conn.peer, r);
    conn.send({ t: 'welcome', seat, code: S.code });
    onLocalChange();
    return;
  }
  if (!r) return;
  if (msg.t === 'act' && msg.action && typeof msg.action === 'object') {
    const res = ctrl.handleAction(r.seat, { type: String(msg.action.type), amount: Number(msg.action.amount) || 0 });
    if (!res.ok) { conn.send({ t: 'error', text: res.error }); onLocalChange(); }
  } else if (msg.t === 'sitout') {
    ctrl.setSittingOut(r.seat, !!msg.v);
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
  S.heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [pid, r] of S.remotes) {
      if (now - r.lastSeen > 13000) { try { r.conn.close(); } catch (e) { /* */ } onRemoteClose(r.conn); S.remotes.delete(pid); continue; }
      if (r.conn.open) { try { r.conn.send({ t: 'ping' }); } catch (e) { /* */ } }
    }
  }, 3000);
}

// ---------------- client ----------------
function startJoin(code) {
  if (!peerAvailable()) { lobbyMsg('联网组件加载失败（PeerJS），请检查网络后刷新。'); return; }
  S.mode = 'client';
  S.code = code;
  lobbyMsg(`正在连接房间 ${code}…`);
  $('#btn-join').disabled = true;
  connectClient();
  if (!roomParam) history.replaceState(null, '', `?room=${code}`);
}

function connectClient() {
  try { S.client && S.client.peer.destroy(); } catch (e) { /* */ }
  S.client = joinRoom(S.code, {
    onOpen(conn) { conn.send({ t: 'join', name: S.name, token: S.token }); S.lastMsgAt = Date.now(); },
    onData: onHostMsg,
    onClose() { onClientDisconnected('连接已断开'); },
    onError(err) {
      console.warn('client error', err);
      if (!S.joined) {
        $('#btn-join').disabled = false;
        lobbyMsg('加入失败：' + errText(err));
        try { S.client.peer.destroy(); } catch (e) { /* */ }
        S.mode = null;
      } else onClientDisconnected(errText(err));
    },
  });
}

function sendToHost(msg) {
  const c = S.client && S.client.conn;
  if (c && c.open) { c.send(msg); return true; }
  toast('未连接到房主');
  return false;
}

function onHostMsg(msg) {
  S.lastMsgAt = Date.now();
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'welcome') {
    S.mySeat = msg.seat;
    const first = !S.joined;
    S.joined = true;
    S.reconnectTries = 0;
    $('#btn-join').disabled = false;
    hideBanner();
    if (first) { showGame(); startClientWatchdog(); toast('已加入房间，等待房主开始'); }
    renderNetDot(true);
  } else if (msg.t === 'state') {
    setView(msg.view);
  } else if (msg.t === 'ping') {
    sendToHost({ t: 'pong' });
  } else if (msg.t === 'reject') {
    alert(msg.reason || '无法加入');
    location.href = location.pathname;
  } else if (msg.t === 'error') {
    S.pending = false; S.actionKey = '';
    toast(msg.text || '操作无效');
  }
}

function startClientWatchdog() {
  clearInterval(S.heartbeat);
  S.heartbeat = setInterval(() => {
    if (S.joined && !S.reconnecting && Date.now() - S.lastMsgAt > 13000) onClientDisconnected('长时间没有收到房主数据');
  }, 3000);
}

function onClientDisconnected(reason) {
  if (S.leaving || !S.joined || S.reconnecting) return;
  S.reconnecting = true;
  renderNetDot(false);
  const tryAgain = () => {
    S.reconnectTries++;
    if (S.reconnectTries > 10) {
      S.reconnecting = false;
      showBanner(`与房主的连接已断开（${esc(reason)}）。房主可能关闭了页面。<button class="btn small-btn" onclick="location.reload()">重试</button>`);
      return;
    }
    showBanner(`连接中断，正在重连…（第 ${S.reconnectTries} 次）`, 'info');
    S.client = joinRoom(S.code, {
      onOpen(conn) { S.reconnecting = false; conn.send({ t: 'join', name: S.name, token: S.token }); S.lastMsgAt = Date.now(); },
      onData: onHostMsg,
      onClose() { S.reconnecting = false; onClientDisconnected('连接已断开'); },
      onError() { try { S.client.peer.destroy(); } catch (e) { /* */ } setTimeout(tryAgain, 3000); },
    });
  };
  try { S.client && S.client.peer.destroy(); } catch (e) { /* */ }
  setTimeout(tryAgain, 1500);
}

function showBanner(html, kind = '') { const b = $('#banner'); b.innerHTML = html; b.className = 'banner ' + kind; }
function hideBanner() { $('#banner').className = 'banner hidden'; }
function renderNetDot(ok) {
  const d = $('#net-dot');
  if (S.mode === 'solo') { d.className = 'net-dot hidden'; return; }
  if (ok === undefined) ok = S.mode === 'host' ? S.brokerOk : !S.reconnecting;
  d.className = 'net-dot ' + (ok ? 'ok' : 'bad');
}

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
// seat anchor points (% of table box) by position relative to the viewer (0 = me at the bottom), clockwise
const POS_P = [[50, 86], [11, 69], [9, 44], [15, 19], [50, 10.5], [85, 19], [91, 44], [89, 69]];
const POS_L = [[50, 85], [21, 80], [8, 50], [21, 19], [50, 12], [79, 19], [92, 50], [79, 80]];
const CENTER_PT = [50, 45];
const POT_PT_P = [50, 31];
const POT_PT_L = [50, 29];
let POT_PT = POT_PT_P;
let landscape = false;
const posOf = (seat) => {
  const base = S.mySeat >= 0 ? S.mySeat : 0;
  return (landscape ? POS_L : POS_P)[(seat - base + MAX_SEATS) % MAX_SEATS];
};
const toward = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
// portrait: hand-placed bet spots so chips never cover the board
const BET_P = [[41, 72], [26, 62], [19, 57], [27, 29], [50, 21], [73, 29], [81, 57], [74, 62]];
const betPt = (seat) => {
  if (landscape) return toward(posOf(seat), CENTER_PT, 0.36);
  const base = S.mySeat >= 0 ? S.mySeat : 0;
  return BET_P[(seat - base + MAX_SEATS) % MAX_SEATS];
};
function dealerPt(seat) {
  const p = posOf(seat);
  const [x, y] = toward(p, CENTER_PT, 0.25);
  const dx = CENTER_PT[0] - p[0], dy = CENTER_PT[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  return [x - (dy / len) * 7, y + (dx / len) * 5];
}

// ---- animation bookkeeping: an animation keeps running smoothly across re-renders ----
const animT = new Map();
let animHand = -1;
function anim(key, cls, dur, delay = 0) {
  const now = performance.now();
  if (!animT.has(key)) animT.set(key, now);
  const el = now - animT.get(key);
  if (el > dur + delay) return { cls: '', style: '' };
  return { cls, style: `animation-delay:${Math.round(delay - el)}ms;` };
}

// ---- cards ----
function cardHTML(c, cls = '', style = '') {
  if (c === null || c === undefined) return `<div class="card back ${cls}" style="${style}"></div>`;
  const r = RANKS[c >> 2]; const s = c & 3;
  const rank = r === 'T' ? '10' : r;
  const sym = SUIT_SYMBOLS[s];
  const face = 'JQK'.includes(r);
  const big = cls.includes('big');
  return `<div class="card s${s} ${cls}" style="${style}"><span class="ci"><b>${rank}</b><i>${sym}</i></span>` +
    `<span class="cc${face && !big ? ' face' : ''}">${face && !big ? r : sym}</span>` +
    (big ? `<span class="ci2"><b>${rank}</b><i>${sym}</i></span>` : '') + '</div>';
}

// ---- chips ----
const DENOMS = [100000, 25000, 5000, 1000, 500, 100];
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
const stackHTML = (amount, max = 6) => `<div class="stack">${chipList(amount, max).reverse().map((d) => `<i class="chip-d d${d}"></i>`).join('')}</div>`;
function potStacksHTML(amount) {
  const groups = [];
  let rest = amount;
  for (const d of DENOMS) {
    const n = Math.floor(rest / d);
    rest -= n * d;
    if (n > 0) groups.push([d, Math.min(n, 6)]);
  }
  return groups.slice(0, 4).map(([d, n]) => `<div class="stack">${`<i class="chip-d d${d}"></i>`.repeat(n)}</div>`).join('');
}

// ---- avatars ----
const BOT_EMOJI = { '粉哥': '🌸', 'Micheal': '🎩', 'Grok Bot': '🤖', '小龙': '🐲', '阿杰': '🦊', 'Lucy': '🐱', '老王': '🐼', '阿May': '🦄' };
const PALETTE = [['#ff9e9e', '#c62828'], ['#9ec2ff', '#1e4fb8'], ['#9ff0c2', '#14804a'], ['#ffe08a', '#b57f00'], ['#e6a3ff', '#7b1fa2'],
  ['#8ff3f3', '#00796b'], ['#ffc78a', '#d84315'], ['#c5d0d6', '#455a64']];
function avatarOf(p) {
  if (p.name === '粉哥') return { c1: '#ffc2dc', c2: '#d81b60', t: '🌸' };
  let h = 0;
  for (const ch of p.name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const [c1, c2] = PALETTE[h % PALETTE.length];
  const t = p.isBot ? (BOT_EMOJI[p.name] || '🤖') : esc([...p.name][0].toUpperCase());
  return { c1, c2, t };
}
function pillKind(t) {
  if (!t) return '';
  if (t.startsWith('弃牌')) return 'fold';
  if (t.startsWith('过牌')) return 'check';
  if (t.startsWith('跟注')) return 'call';
  if (t.startsWith('全下')) return 'allin';
  if (t.startsWith('下注') || t.startsWith('加注')) return 'raise';
  if (t.includes('盲')) return 'blind';
  return 'status';
}

function setView(v) {
  const prev = S.view;
  S.view = v;
  S.deadline = v.turnRemainingMs ? Date.now() + v.turnRemainingMs : 0;
  S.pending = false;
  if (v.handNo !== animHand) { animT.clear(); animHand = v.handNo; }
  render();
  spawnFx(prev, v);
  const turnKey = `${v.handNo}-${v.phase}-${v.toAct}-${v.currentBet}`;
  if (v.toAct === S.mySeat && S.mySeat >= 0 && turnKey !== S.lastTurnKey) {
    if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) { /* */ } }
    if (document.hidden) document.title = '🔔 轮到你了 · 德州扑克';
  }
  if (v.toAct !== S.mySeat) document.title = '德州扑克 · 朋友局';
  S.lastTurnKey = turnKey;
}

function render() {
  const v = S.view;
  if (!v) return;
  const t = $('#table');
  landscape = t.clientWidth / Math.max(1, t.clientHeight) > 1.25;
  POT_PT = landscape ? POT_PT_L : POT_PT_P;
  t.classList.toggle('landscape', landscape);
  const isHost = S.mode !== 'client';
  $('#room-label').textContent = S.mode === 'solo' ? '单机练习 · 对战 AI' : `房间 ${S.code || ''}${isHost ? ' · 房主' : ''}`;
  $('#blind-label').textContent = `盲注 ${fmt(v.sb)}/${fmt(v.bb)}${v.pendingBlinds ? `（下手 ${fmt(v.pendingBlinds.sb)}/${fmt(v.pendingBlinds.bb)}）` : ''} · 第 ${v.handNo} 手`;
  $('#btn-invite').classList.toggle('hidden', S.mode === 'solo');
  renderNetDot();
  renderSeats(v, isHost);
  renderCenter(v, isHost);
  renderActionBar(v, isHost);
  renderLog(v);
}

function renderSeats(v, isHost) {
  const winners = new Map();
  if (v.phase === 'handover' && v.result) for (const w of v.result.winners) winners.set(w.seat, w.amount);
  const betting = BETTING.includes(v.phase);
  const tw = $('#table').clientWidth, th = $('#table').clientHeight;
  let html = '';
  let dealOrder = 0;
  for (let i = 0; i < MAX_SEATS; i++) {
    const [x, y] = posOf(i);
    const p = v.seats[i];
    if (!p) {
      html += `<div class="seat empty ${isHost ? 'can-add' : ''}" data-empty="${i}" style="left:${x}%;top:${y}%">
        <div class="avatar-wrap"><div class="avatar">${isHost ? '＋' : ''}</div></div>
        <div class="plate"><div class="name">${isHost ? '添加 AI' : '空位'}</div><div class="chips">&nbsp;</div></div></div>`;
      continue;
    }
    const me = i === S.mySeat;
    const active = v.toAct === i;
    const out = !p.inHand && p.chips === 0;
    const isWin = winners.has(i);
    const side = y < 30 ? (x <= 50 && x > 30 ? 'top tl' : x <= 30 ? 'top tr' : 'top tl') : '';
    const cls = ['seat', side, me && 'me', active && 'active', p.inHand && p.folded && 'folded', (out || p.sittingOut || !p.connected) && 'out', isWin && 'winner'].filter(Boolean).join(' ');
    let hole = '';
    if (p.hasCards && !me) {
      if (p.cards) {
        const a = anim(`rev-${i}`, 'flip', 450);
        hole = `<div class="hole revealed">${p.cards.map((c, k) => cardHTML(c, a.cls, a.style.replace(/(-?\d+)ms/, (m, n) => `${Number(n) + k * 90}ms`))).join('')}</div>`;
      } else if (!p.folded) {
        const dx = Math.round(((CENTER_PT[0] - x) / 100) * tw), dy = Math.round(((CENTER_PT[1] - y) / 100) * th);
        const order = dealOrder++;
        hole = `<div class="hole">${[0, 1].map((k) => {
          const a = anim(`deal-${i}-${k}`, 'deal', 450, order * 45 + k * 260);
          return cardHTML(null, a.cls, `--dx:${dx}px;--dy:${dy}px;${a.style}`);
        }).join('')}</div>`;
      }
    }
    let tag = p.lastAction || '';
    let kind = pillKind(tag);
    if (!p.connected) { tag = '📴 离线'; kind = 'status'; } else if (p.sittingOut) { tag = '暂离'; kind = 'status'; } else if (out) { tag = '出局'; kind = 'status'; }
    if (p.handName) { tag = p.handName; kind = 'hand'; }
    const av = avatarOf(p);
    html += `<div class="${cls}" style="left:${x}%;top:${y}%">${hole}
      <div class="avatar-wrap">
        <svg class="ring" viewBox="0 0 56 56"><circle class="bg" cx="28" cy="28" r="26"/><circle class="fg" cx="28" cy="28" r="26" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="0"/></svg>
        <div class="avatar" style="--c1:${av.c1};--c2:${av.c2}">${av.t}</div>
        ${isWin ? '<div class="crown">👑</div>' : ''}
      </div>
      <div class="plate"><div class="name">${esc(p.name)}${me ? '（我）' : ''}</div><div class="chips">${fmt(p.chips)}</div></div>
      <div class="pill ${kind}">${esc(tag)}</div>
      ${isWin ? `<div class="win-pop">+${fmt(winners.get(i))}</div>` : ''}
    </div>`;
    if (p.bet > 0) {
      const [bx, by] = betPt(i);
      const a = anim(`bet-${i}-${p.bet}`, '', 300);
      html += `<div class="bet" style="left:${bx}%;top:${by}%;${a.style ? a.style : 'animation:none;'}">${stackHTML(p.bet, 5)}<span class="amt">${fmt(p.bet)}</span></div>`;
    }
  }
  if (v.button >= 0 && v.seats[v.button] && (betting || v.phase === 'handover')) {
    const [dx, dy] = dealerPt(v.button);
    html += `<div class="dealer" style="left:${dx}%;top:${dy}%">D</div>`;
  }
  const seatsEl = $('#seats');
  seatsEl.innerHTML = html;
  seatsEl.querySelectorAll('.seat.empty.can-add').forEach((el) => { el.onclick = () => { S.ctrl.addBot(); }; });
  updateTimers();
}

function renderCenter(v, isHost) {
  const board = [];
  for (let i = 0; i < 5; i++) {
    if (i < v.board.length) {
      const stagger = i < 3 ? i * 140 : 0;
      const a = anim(`board-${i}`, 'flip', 450, stagger);
      board.push(cardHTML(v.board[i], a.cls, a.style));
    } else board.push('<div class="card slot"></div>');
  }
  $('#board').innerHTML = board.join('');
  const betting = BETTING.includes(v.phase);
  const pot = $('#pot');
  pot.style.left = POT_PT[0] + '%';
  pot.style.top = POT_PT[1] + '%';
  pot.innerHTML = betting && v.potTotal > 0
    ? `<div class="stacks">${potStacksHTML(v.pot || v.potTotal)}</div><span class="amt"><span class="lbl">底池</span>${fmt(v.potTotal)}</span>`
    : '';
  let msg = '';
  if (v.phase === 'handover' && v.result) {
    const pots = v.result.pots.filter((pt) => !pt.uncalled || v.result.pots.length === 1);
    const best = pots.find((pt) => pt.handName);
    const lines = pots.map((pt, idx, arr) => {
      const names = pt.winners.map((s) => (v.seats[s] ? esc(v.seats[s].name) : '?')).join('、');
      const label = arr.length > 1 ? (idx === 0 ? '主池' : `边池${idx}`) : '';
      return `<div class="wl">${names} ${pt.winners.length > 1 ? '平分' : '赢得'}${label} ${fmt(pt.amount)}</div>`;
    }).join('');
    msg = `<div class="win-banner">${lines}<div class="hn">${best ? esc(best.handName) : '其他人弃牌'}</div></div>`;
  }
  if (!betting) {
    const eligible = v.seats.filter((p) => p && p.chips > 0 && !p.sittingOut && p.connected).length;
    if (!v.running) {
      if (isHost) {
        msg += eligible >= 2
          ? `<div>${S.mode === 'host' ? '朋友到齐后点击开始' : ''}</div><button class="btn primary" id="btn-start">▶ 开始游戏</button>`
          : '<div>至少需要 2 名玩家 · 点空位添加 AI 或邀请朋友</div>';
      } else msg += '<div>等待房主开始游戏…</div>';
    } else if (eligible < 2) {
      msg += `<div>等待更多有筹码的玩家…${isHost ? '（可在菜单中补码或添加 AI）' : ''}</div>`;
    }
  }
  $('#center-msg').innerHTML = msg;
  const bs = $('#btn-start');
  if (bs) bs.onclick = () => S.ctrl.start();
}

// chips flying: bets -> pot at the end of a street, pot -> winners at the end of the hand
function spawnFx(prev, v) {
  if (!prev || prev.handNo !== v.handNo) return;
  const fx = $('#fx');
  const fly = (from, to, amount, delay = 0) => {
    const g = document.createElement('div');
    g.className = 'ghost';
    g.innerHTML = stackHTML(amount, 5);
    g.style.left = from[0] + '%'; g.style.top = from[1] + '%';
    fx.appendChild(g);
    setTimeout(() => requestAnimationFrame(() => { g.style.left = to[0] + '%'; g.style.top = to[1] + '%'; g.style.opacity = '0'; }), 30 + delay);
    setTimeout(() => g.remove(), 1200 + delay);
  };
  if (prev.phase !== v.phase) {
    for (let i = 0; i < MAX_SEATS; i++) {
      const a = prev.seats[i], b = v.seats[i];
      if (a && a.bet > 0 && (!b || b.bet === 0)) fly(betPt(i), POT_PT, a.bet);
    }
  }
  if (BETTING.includes(prev.phase) && v.phase === 'handover' && v.result) {
    for (const w of v.result.winners) if (v.seats[w.seat]) fly(POT_PT, posOf(w.seat), w.amount, 550);
  }
}

function myHandText(v, me) {
  if (!me || !me.cards || me.cards.length < 2) return '';
  if (v.board.length >= 3) return describeScore(evaluate([...me.cards, ...v.board]));
  const [a, b] = me.cards;
  if ((a >> 2) === (b >> 2)) return '口袋对子';
  return (a & 3) === (b & 3) ? '同花底牌' : '';
}

function renderActionBar(v, isHost) {
  const bar = $('#action-bar');
  const me = S.mySeat >= 0 ? v.seats[S.mySeat] : null;
  const la = v.legal;
  const key = `${v.handNo}|${v.phase}|${v.toAct}|${v.currentBet}|${la ? la.minRaiseTo + '-' + la.maxRaiseTo : ''}|${me ? me.chips + '-' + me.sittingOut + '-' + me.inHand + '-' + me.folded + '-' + (me.cards || []).join(',') : ''}|${v.board.length}|${v.running}`;
  if (key === S.actionKey && bar.innerHTML) { updateTimers(); return; }
  S.actionKey = key;
  if (!me) { bar.innerHTML = '<div class="waiting">观战中</div>'; return; }

  const cards = me.cards && me.inHand
    ? me.cards.map((c, k) => { const a = anim(`my-${k}`, 'deal', 450, k * 260); return cardHTML(c, 'big ' + a.cls + (me.folded ? ' dim' : ''), a.style); }).join('')
    : '<div class="card slot big"></div><div class="card slot big"></div>';
  const hn = me.inHand && !me.folded ? myHandText(v, me) : '';
  let info = `<div>筹码 <b>${fmt(me.chips)}</b>${me.bet ? ` <span class="muted">· 已下 ${fmt(me.bet)}</span>` : ''}</div>`;
  if (hn) info += `<div class="hn">${esc(hn)}</div>`;
  else if (me.inHand && me.folded) info += '<div class="muted">已弃牌</div>';
  const clock = `<div class="turn-clock idle" id="my-clock"><svg viewBox="0 0 44 44"><circle class="bg" cx="22" cy="22" r="19"/><circle class="fg" cx="22" cy="22" r="19" stroke-dasharray="${CLOCK_C.toFixed(2)}" stroke-dashoffset="0"/></svg><span></span></div>`;
  let html = `<div class="my-row"><div class="my-cards">${cards}</div><div class="my-info">${info}</div>${clock}</div>`;

  if (la) {
    const allinCall = !la.canCheck && la.callAmount >= me.chips;
    const callBtn = la.canCheck
      ? '<button class="btn act-check" data-act="check">过牌</button>'
      : `<button class="btn act-call" data-act="call">${allinCall ? '全下' : '跟注'}<small>${fmt(la.callAmount)}</small></button>`;
    html += `<div class="actions">
      <button class="btn act-fold" data-act="fold">弃牌</button>
      ${callBtn}
      ${la.canRaise ? '<button class="btn act-raise" data-act="raise" id="btn-raise"></button>' : ''}
    </div>`;
    if (la.canRaise) {
      html += `<div class="raise-row">
        <div class="quick">
          <button class="btn" data-q="min">最小</button>
          <button class="btn" data-q="0.5">½ 池</button>
          <button class="btn" data-q="0.75">¾ 池</button>
          <button class="btn" data-q="1">1 倍池</button>
          <button class="btn" data-q="max">全下</button>
        </div>
        <div class="slider-row">
          <input type="range" id="raise-slider" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" step="1" value="${la.minRaiseTo}">
          <input type="number" id="raise-input" class="raise-amt" inputmode="numeric" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" value="${la.minRaiseTo}">
        </div>
      </div>`;
    }
  } else if (me.sittingOut) {
    html += '<div class="actions"><button class="btn green" id="btn-back">我回来了（回到座位）</button></div>';
  } else if (!me.inHand && me.chips === 0) {
    html += isHost
      ? `<div class="actions"><button class="btn primary" id="btn-rebuy">补码到 ${fmt(STARTING_CHIPS)}</button></div>`
      : '<div class="waiting">筹码输光了，请房主在菜单里为你补码</div>';
  } else {
    const t = v.toAct >= 0 && v.seats[v.toAct] ? `等待 ${esc(v.seats[v.toAct].name)} 行动…` : (v.phase === 'handover' ? '本手结束，下一手即将开始…' : (v.runout ? '发牌中…' : ''));
    html += `<div class="waiting">${t}${me.inHand ? '' : (BETTING.includes(v.phase) ? '（下一手加入）' : '')}</div>`;
  }
  bar.innerHTML = html;

  bar.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.act;
      if (t === 'raise') {
        const amt = S.raiseValue;
        sendAction(amt >= la.maxRaiseTo ? { type: 'allin' } : { type: 'raise', amount: amt });
      } else sendAction({ type: t });
    };
  });
  const back = $('#btn-back'); if (back) back.onclick = () => setSitOut(false);
  const rb = $('#btn-rebuy'); if (rb) rb.onclick = () => S.ctrl.rebuy(S.mySeat);
  if (la && la.canRaise) setupRaise(v, la);
  updateTimers();
}

function setupRaise(v, la) {
  const slider = $('#raise-slider'), input = $('#raise-input'), btn = $('#btn-raise');
  const unit = v.sb >= 100 ? 100 : 1;
  const clamp = (x) => Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, Math.round(x)));
  const set = (x, fromInput) => {
    x = clamp(x);
    S.raiseValue = x;
    if (!fromInput) input.value = x;
    slider.value = x;
    const span = la.maxRaiseTo - la.minRaiseTo;
    slider.style.setProperty('--fill', (span > 0 ? ((x - la.minRaiseTo) / span) * 100 : 100) + '%');
    const allin = x >= la.maxRaiseTo;
    btn.innerHTML = allin ? `全下<small>${fmt(x)}</small>` : `${la.isBet ? '下注' : '加注到'}<small>${fmt(x)}</small>`;
  };
  slider.oninput = () => {
    let x = Number(slider.value);
    if (x < la.maxRaiseTo) x = Math.round(x / unit) * unit;
    set(x);
  };
  input.oninput = () => { const x = Number(input.value); if (x) set(x, true); };
  input.onblur = () => set(Number(input.value) || la.minRaiseTo);
  const pot = v.potTotal;
  document.querySelectorAll('[data-q]').forEach((b) => {
    b.onclick = () => {
      const q = b.dataset.q;
      if (q === 'min') set(la.minRaiseTo);
      else if (q === 'max') set(la.maxRaiseTo);
      else set(Math.round((v.currentBet + Number(q) * (pot + la.toCall)) / unit) * unit);
    };
  });
  set(la.minRaiseTo);
}

function updateTimers() {
  const v = S.view;
  if (!v) return;
  const left = S.deadline ? Math.max(0, S.deadline - Date.now()) : 0;
  const frac = v.turnTotalMs && S.deadline ? left / v.turnTotalMs : 1;
  document.querySelectorAll('.seat.active .ring .fg').forEach((c) => {
    c.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(2));
    c.classList.toggle('urgent', S.deadline && frac < 0.3);
  });
  const clock = $('#my-clock');
  if (clock) {
    if (v.toAct === S.mySeat && S.deadline) {
      const s = Math.ceil(left / 1000);
      clock.classList.remove('idle');
      clock.querySelector('span').textContent = s;
      clock.querySelector('.fg').setAttribute('stroke-dashoffset', (CLOCK_C * (1 - frac)).toFixed(2));
      clock.classList.toggle('urgent', s <= 8);
    } else clock.classList.add('idle');
  }
}
setInterval(updateTimers, 250);
if (window.ResizeObserver) new ResizeObserver(() => { if (S.view) render(); }).observe(document.querySelector('#table-wrap'));

let lastLogId = 0;
function renderLog(v) {
  const el = $('#log');
  const last = v.log.length ? v.log[v.log.length - 1].id : 0;
  if (last === lastLogId) return;
  lastLogId = last;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = v.log.map((l) => `<div class="${l.kind}">${esc(l.text)}</div>`).join('');
  if (atBottom || true) el.scrollTop = el.scrollHeight;
}
$('#log').onclick = () => $('#log').classList.toggle('open');

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
      <li>把链接发到微信群（或告诉朋友房间码）</li>
      <li>朋友打开链接 → 输入昵称 → 点「加入」</li>
      <li>人齐后，房主点「▶ 开始游戏」</li>
    </ol>
    <p class="muted small">房主负责发牌，请保持本页面打开、手机不要锁屏。</p>`);
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
      <p class="muted small">补码：把玩家筹码补回 ${fmt(STARTING_CHIPS)}（输光或不足时，且不在本手牌局中）。</p>
      <h4>盲注</h4>
      <div class="row"><label class="inline">小盲<input type="number" id="st-sb" value="${g.sb}" inputmode="numeric"></label>
        <label class="inline">大盲<input type="number" id="st-bb" value="${g.bb}" inputmode="numeric"></label>
        <button class="btn" id="st-blinds">保存</button></div>
      <h4>每回合行动时间</h4>
      <div class="row"><select id="st-time">${[15, 20, 30, 45, 60, 90].map((s) => `<option value="${s}" ${s === S.ctrl.turnTime ? 'selected' : ''}>${s} 秒</option>`).join('')}</select>
      <span class="muted small">超时自动过牌/弃牌</span></div>`;
  }
  html += '<h4>我</h4><div class="row">';
  if (me) html += me.sittingOut ? '<button class="btn green" id="st-back">回到座位</button>' : '<button class="btn" id="st-away">暂离</button>';
  html += '<button class="btn" id="st-rules">牌型大小</button><button class="btn danger" id="st-leave">退出</button></div>';
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
    bindPlayerList();
  }
  on('st-away', () => { setSitOut(true); closeModal(); });
  on('st-back', () => { setSitOut(false); closeModal(); });
  on('st-rules', showRules);
  on('st-leave', () => {
    if (!confirm(S.mode === 'host' ? '退出将结束整个牌局，确定？' : '确定退出？')) return;
    S.leaving = true;
    if (S.mode === 'client') sendToHost({ t: 'leave' });
    setTimeout(() => { S.mode = null; location.href = location.pathname; }, 300);
  });
}

function playerListHTML() {
  const players = S.ctrl.game.seats.filter(Boolean);
  return `<h4>玩家（${players.length}/8）</h4>
      <ul class="plist">${players.map((p) => `<li>
          <span class="nm">${p.isBot ? '🤖' : (p.connected ? '🟢' : '📴')} ${esc(p.name)} · ${fmt(p.chips)}${p.sittingOut ? ' · 暂离' : ''}</span>
          ${p.chips < STARTING_CHIPS ? `<button class="btn" data-rebuy="${p.seat}">补码</button>` : ''}
          ${p.seat !== S.mySeat ? `<button class="btn danger" data-kick="${p.seat}">移除</button>` : ''}
        </li>`).join('')}</ul>`;
}

// light refresh while the settings modal is open (keeps typed inputs intact)
function refreshSettings() {
  if (S.mode === 'client' || $('#modal').classList.contains('hidden')) return;
  const pl = $('#st-plist');
  if (pl) { pl.innerHTML = playerListHTML(); bindPlayerList(); }
  const run = $('#st-run');
  if (run) { run.textContent = S.ctrl.running ? '⏸ 暂停（本手结束后）' : '▶ 开始游戏'; run.className = `btn ${S.ctrl.running ? '' : 'primary'} wide`; }
  const ab = $('#st-addbot');
  if (ab) ab.disabled = S.ctrl.game.seats.every(Boolean);
}

function bindPlayerList() {
    document.querySelectorAll('[data-rebuy]').forEach((b) => { b.onclick = () => { if (!S.ctrl.rebuy(Number(b.dataset.rebuy))) toast('该玩家正在本手牌局中，等本手结束再补码'); }; });
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
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// expose for debugging / automated smoke tests
window.__holdem = S;
