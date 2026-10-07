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
const POS = [[50, 89], [15, 75], [13, 47], [17, 19], [50, 8], [83, 19], [87, 47], [85, 75]];
const CENTER = [50, 45];

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
function cardHTML(c, cls = '') {
  if (c === null || c === undefined) return `<div class="card back ${cls}"></div>`;
  const r = RANKS[c >> 2]; const s = c & 3;
  return `<div class="card s${s} ${cls}"><span class="r">${r === 'T' ? '10' : r}</span><span class="s">${SUIT_SYMBOLS[s]}</span></div>`;
}

let prevBoardLen = 0;
function setView(v) {
  const prevHand = S.view ? S.view.handNo : -1;
  S.view = v;
  S.deadline = v.turnRemainingMs ? Date.now() + v.turnRemainingMs : 0;
  S.pending = false;
  if (v.handNo !== prevHand) prevBoardLen = 0;
  render();
  // notify when it's my turn
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
  const isHost = S.mode !== 'client';
  $('#room-label').textContent = S.mode === 'solo' ? '单机练习' : `房间 ${S.code || ''}${isHost ? '（房主）' : ''}`;
  $('#blind-label').textContent = `盲注 ${fmt(v.sb)}/${fmt(v.bb)}${v.pendingBlinds ? `（下手 ${fmt(v.pendingBlinds.sb)}/${fmt(v.pendingBlinds.bb)}）` : ''} · 第 ${v.handNo} 手`;
  $('#btn-invite').classList.toggle('hidden', S.mode === 'solo');
  renderNetDot();
  renderSeats(v, isHost);
  renderCenter(v, isHost);
  renderActionBar(v, isHost);
  renderLog(v);
}

function renderSeats(v, isHost) {
  const base = S.mySeat >= 0 ? S.mySeat : 0;
  const winners = new Map();
  if (v.phase === 'handover' && v.result) for (const w of v.result.winners) winners.set(w.seat, w.amount);
  const betting = ['preflop', 'flop', 'turn', 'river'].includes(v.phase);
  let html = '';
  for (let i = 0; i < MAX_SEATS; i++) {
    const rel = (i - base + MAX_SEATS) % MAX_SEATS;
    const [x, y] = POS[rel];
    const p = v.seats[i];
    if (!p) {
      const canAdd = isHost;
      html += `<div class="seat empty ${canAdd ? 'can-add' : ''}" data-empty="${i}" style="left:${x}%;top:${y}%"><div class="hole"></div><div class="box">${canAdd ? '＋ 添加AI' : '空位'}</div></div>`;
      continue;
    }
    const me = i === S.mySeat;
    const active = v.toAct === i;
    const out = !p.inHand && p.chips === 0;
    const cls = ['seat', me && 'me', active && 'active', p.inHand && p.folded && 'folded', (out || p.sittingOut || !p.connected) && 'out', winners.has(i) && 'winner'].filter(Boolean).join(' ');
    let hole = '';
    if (p.hasCards && !me) {
      if (p.cards) hole = `<div class="hole revealed">${p.cards.map((c) => cardHTML(c)).join('')}</div>`;
      else if (!p.folded) hole = `<div class="hole">${cardHTML(null)}${cardHTML(null)}</div>`;
      else hole = '<div class="hole"></div>';
    } else hole = '<div class="hole"></div>';
    let tag = p.lastAction || '';
    if (!p.connected) tag = '📴 离线';
    else if (p.sittingOut) tag = '暂离';
    else if (out) tag = '出局 💸';
    if (winners.has(i)) tag = `赢 +${fmt(winners.get(i))}`;
    const badges = [
      v.button === i && (betting || v.phase === 'handover') ? '<span class="badge">D</span>' : '',
    ].join('');
    html += `<div class="${cls}" style="left:${x}%;top:${y}%">${hole}<div class="box">${badges}
      <div class="name">${p.isBot ? '🤖' : ''}${esc(p.name)}${me ? '（我）' : ''}</div>
      <div class="chips">${fmt(p.chips)}</div>
      ${p.handName ? `<div class="hand-name">${esc(p.handName)}</div>` : `<div class="tag">${esc(tag)}</div>`}
      ${active ? '<div class="timer"><i></i></div>' : ''}
    </div></div>`;
    if (p.bet > 0) {
      const bx = x + (CENTER[0] - x) * 0.42, by = y + (CENTER[1] - y) * 0.42;
      html += `<div class="bet-chip" style="left:${bx}%;top:${by}%">${fmt(p.bet)}</div>`;
    }
  }
  const seatsEl = $('#seats');
  seatsEl.innerHTML = html;
  seatsEl.querySelectorAll('.seat.empty.can-add').forEach((el) => {
    el.onclick = () => { S.ctrl.addBot(); };
  });
  updateTimers();
}

function renderCenter(v, isHost) {
  const board = [];
  for (let i = 0; i < 5; i++) {
    if (i < v.board.length) board.push(cardHTML(v.board[i], i >= prevBoardLen ? 'deal' : ''));
    else board.push('<div class="card slot"></div>');
  }
  prevBoardLen = v.board.length;
  $('#board').innerHTML = board.join('');
  const betting = ['preflop', 'flop', 'turn', 'river'].includes(v.phase);
  $('#pot').textContent = betting && v.potTotal > 0 ? `底池 ${fmt(v.potTotal)}` : '';
  let msg = '';
  if (v.phase === 'handover' && v.result) {
    msg = v.result.pots.filter((pt) => !pt.uncalled || v.result.pots.length === 1).map((pt, idx, arr) => {
      const names = pt.winners.map((s) => (v.seats[s] ? esc(v.seats[s].name) : '?')).join('、');
      const label = arr.length > 1 ? (idx === 0 ? '主池' : `边池${idx}`) : '';
      return `<div class="win-line">${names} ${pt.winners.length > 1 ? '平分' : '赢得'}${label} ${fmt(pt.amount)}${pt.handName ? ' · ' + esc(pt.handName) : ''}</div>`;
    }).join('');
  }
  if (!betting) {
    const eligible = v.seats.filter((p) => p && p.chips > 0 && !p.sittingOut && p.connected).length;
    if (!v.running) {
      if (isHost) {
        msg += eligible >= 2
          ? `<div>${S.mode === 'host' ? '朋友到齐后点击开始' : ''}</div><button class="btn primary" id="btn-start">▶ 开始游戏</button>`
          : `<div>至少需要 2 名玩家 · 点空位添加 AI 或邀请朋友</div>`;
      } else msg += '<div>等待房主开始游戏…</div>';
    } else if (eligible < 2) {
      msg += `<div>等待更多有筹码的玩家…${isHost ? '（可在菜单中补码或添加 AI）' : ''}</div>`;
    } else if (v.phase === 'handover') {
      msg += '<div class="muted small">下一手即将开始…</div>';
    }
  }
  $('#center-msg').innerHTML = msg;
  const bs = $('#btn-start');
  if (bs) bs.onclick = () => S.ctrl.start();
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
  const key = `${v.handNo}|${v.phase}|${v.toAct}|${v.currentBet}|${la ? la.minRaiseTo + '-' + la.maxRaiseTo : ''}|${me ? me.chips + '-' + me.sittingOut + '-' + me.inHand + '-' + (me.cards || []).join(',') : ''}|${v.board.length}|${v.running}`;
  if (key === S.actionKey && bar.innerHTML) { updateTimers(); return; }
  S.actionKey = key;
  if (!me) { bar.innerHTML = '<div class="waiting">观战中</div>'; return; }

  const cards = me.cards && me.inHand
    ? me.cards.map((c) => cardHTML(c, 'big' + (me.folded ? ' dim' : ''))).join('')
    : '<div class="card slot big"></div><div class="card slot big"></div>';
  const hn = me.inHand && !me.folded ? myHandText(v, me) : '';
  let info = `<div>筹码 <b>${fmt(me.chips)}</b>${me.bet ? ` · 本轮已下 ${fmt(me.bet)}` : ''}</div>`;
  if (hn) info += `<div class="hn">${esc(hn)}</div>`;
  else if (me.inHand && me.folded) info += '<div class="muted">已弃牌</div>';
  let html = `<div class="my-row"><div class="my-cards">${cards}</div><div class="my-info">${info}</div><div class="turn-clock" id="my-clock"></div></div>`;

  if (la) {
    const callTxt = la.canCheck ? '过牌' : (la.callAmount >= me.chips ? `全下 ${fmt(la.callAmount)}` : `跟注 ${fmt(la.callAmount)}`);
    html += `<div class="actions">
      <button class="btn danger" data-act="fold">弃牌</button>
      <button class="btn green" data-act="${la.canCheck ? 'check' : 'call'}">${callTxt}</button>
      ${la.canRaise ? `<button class="btn primary" data-act="raise" id="btn-raise"></button>` : ''}
    </div>`;
    if (la.canRaise) {
      html += `<div class="raise-row">
        <div class="quick">
          <button class="btn" data-q="min">最小</button>
          <button class="btn" data-q="0.5">½池</button>
          <button class="btn" data-q="0.75">¾池</button>
          <button class="btn" data-q="1">1倍池</button>
          <button class="btn" data-q="max">全下</button>
        </div>
        <div class="slider-row">
          <input type="range" id="raise-slider" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" step="1" value="${la.minRaiseTo}">
          <input type="number" id="raise-input" class="raise-amt" inputmode="numeric" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" value="${la.minRaiseTo}">
        </div>
      </div>`;
    }
  } else if (me.sittingOut) {
    html += `<div class="actions"><button class="btn green" id="btn-back">我回来了（回到座位）</button></div>`;
  } else if (!me.inHand && me.chips === 0) {
    html += isHost
      ? `<div class="actions"><button class="btn primary" id="btn-rebuy">补码到 ${fmt(STARTING_CHIPS)}</button></div>`
      : '<div class="waiting">筹码输光了，请房主在菜单里为你补码</div>';
  } else {
    const t = v.toAct >= 0 && v.seats[v.toAct] ? `等待 ${esc(v.seats[v.toAct].name)} 行动…` : (v.phase === 'handover' ? '本手结束' : (v.runout ? '发牌中…' : ''));
    html += `<div class="waiting">${t}${me.inHand ? '' : (['preflop', 'flop', 'turn', 'river'].includes(v.phase) ? '（下一手加入）' : '')}</div>`;
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
    const allin = x >= la.maxRaiseTo;
    btn.textContent = allin ? `全下 ${fmt(x)}` : `${la.isBet ? '下注' : '加注到'} ${fmt(x)}`;
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
  const pct = v.turnTotalMs ? (left / v.turnTotalMs) * 100 : 0;
  document.querySelectorAll('.seat.active .timer i').forEach((i) => { i.style.width = pct + '%'; });
  const clock = $('#my-clock');
  if (clock) {
    if (v.toAct === S.mySeat && S.deadline) {
      const s = Math.ceil(left / 1000);
      clock.textContent = s + 's';
      clock.classList.toggle('urgent', s <= 8);
    } else clock.textContent = '';
  }
}
setInterval(updateTimers, 250);

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
