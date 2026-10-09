// Host-side controller: owns the authoritative Game, drives bots, timers, hand scheduling.
import { Game, STARTING_CHIPS } from './engine.js?v=5';
import { botDecide, resolveStyle, STYLE_KEYS, PERSONALITIES } from './bot.js?v=5';

export const BOT_NAMES = ['粉哥', 'Micheal', 'Grok Bot', '小龙', '阿杰', 'Lucy', '老王', '阿May'];
// default personality per AI seat (the host can change it in the menu / lobby)
export const STYLE_BY_NAME = { '粉哥': 'maniac', 'Micheal': 'rock', 'Grok Bot': 'tricky', '小龙': 'station', '阿杰': 'regular', 'Lucy': 'tricky', '老王': 'station', '阿May': 'maniac' };
export const defaultStyleFor = (name, i = 0) => STYLE_BY_NAME[name] || STYLE_KEYS[i % STYLE_KEYS.length];
// thinking time (ms) per personality: maniacs snap-act, rocks take their time, tricksters tank before traps
const TEMPO = { maniac: [350, 700], rock: [800, 900], station: [550, 700], tricky: [600, 1300], regular: [550, 900] };

// play-money buy-ins
export const BUYIN_PRESETS = [50000, 100000, 200000];
export const DEFAULT_RULES = { maxBuyIn: 200000, allowRebuy: true, approval: false };
export const DISC_GRACE_MS = 12000; // a player who dropped mid-hand gets this long to come back before auto check/fold
const fmtN = (n) => Number(n).toLocaleString('en-US');

let uidSeq = 0;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(uidSeq++).toString(36)}`;

export class HostController {
  constructor({ sb = 500, bb = 1000, turnTime = 30, onChange = () => {} } = {}) {
    this.game = new Game({ sb, bb });
    this.turnTime = turnTime; // seconds
    this.onChange = onChange;
    this.running = false;
    this.turnTimer = null;
    this.botTimer = null;
    this.handTimer = null;
    this.deadline = 0;
    this.pendingBlinds = null;
    this.turnTotal = turnTime * 1000;
    this.rules = { ...DEFAULT_RULES };
    this.ledger = new Map();   // player id -> { id, name, isBot, bought, cashout, buys }
    this.requests = [];        // buy-ins waiting for host approval: { rid, id, name, amount, at }
    this.queued = new Map();   // player id -> chips bought mid-hand, credited before the next deal
    this.reqSeq = 0;
    this.game.onRemove = (p) => {
      const e = this.ledger.get(p.id);
      if (e) e.cashout += p.chips;
      this.queued.delete(p.id);
      this.requests = this.requests.filter((r) => r.id !== p.id);
    };
  }

  // ---------- ledger / buy-ins ----------
  book(p, amount) {
    let e = this.ledger.get(p.id);
    if (!e) { e = { id: p.id, name: p.name, isBot: !!p.isBot, bought: 0, cashout: 0, buys: 0 }; this.ledger.set(p.id, e); }
    e.name = p.name;
    e.bought += amount;
    e.buys++;
  }

  setRules(r = {}) {
    const max = Math.floor(Number(r.maxBuyIn));
    if (max >= 1000) this.rules.maxBuyIn = Math.min(max, 100000000);
    if (typeof r.allowRebuy === 'boolean') this.rules.allowRebuy = r.allowRebuy;
    if (typeof r.approval === 'boolean') this.rules.approval = r.approval;
    this.changed();
  }

  // How much more this seat may buy under the table rules (stack after buying ≤ max buy-in).
  buyRoom(seat) {
    const p = this.game.seats[seat];
    if (!p) return 0;
    return Math.max(0, this.rules.maxBuyIn - p.chips - (this.queued.get(p.id) || 0) - this.pendingOf(p.id));
  }
  pendingOf(id) { return this.requests.filter((r) => r.id === id).reduce((a, r) => a + r.amount, 0); }

  // A buy-in request. opts.skipApproval: host buying for themself; opts.ignoreRules: host topping someone up.
  // Returns { ok, status: 'done' | 'queued' | 'pending', error, rid }
  buyIn(seat, amount, opts = {}) {
    const p = this.game.seats[seat];
    if (!p) return { ok: false, error: '没有这个座位' };
    amount = Math.floor(Number(amount));
    if (!(amount > 0) || amount > 100000000) return { ok: false, error: '金额无效' };
    if (!opts.ignoreRules) {
      if (!this.rules.allowRebuy) return { ok: false, error: '房主已关闭买入' };
      const room = this.buyRoom(seat);
      if (room <= 0) return { ok: false, error: `筹码已达买入上限 ${fmtN(this.rules.maxBuyIn)}` };
      if (amount > room) return { ok: false, error: `最多还能买入 ${fmtN(room)}` };
      if (this.rules.approval && !opts.skipApproval && !p.isBot) {
        const rid = ++this.reqSeq;
        this.requests.push({ rid, id: p.id, seat, name: p.name, amount, at: Date.now() });
        this.game.emit(`💰 ${p.name} 申请买入 ${fmtN(amount)}，等待房主批准`);
        this.changed();
        return { ok: true, status: 'pending', rid };
      }
    }
    return this.grant(p, amount);
  }

  grant(p, amount) {
    if (this.game.addChips(p.seat, amount)) {
      this.book(p, amount);
      this.game.emit(`💰 ${p.name} 买入 ${fmtN(amount)}`, 'buy');
      this.changed(); this.kick();
      return { ok: true, status: 'done' };
    }
    this.queued.set(p.id, (this.queued.get(p.id) || 0) + amount);
    this.game.emit(`💰 ${p.name} 买入 ${fmtN(amount)}（本手结束后到账）`, 'buy');
    this.changed();
    return { ok: true, status: 'queued' };
  }

  // host decision on a pending request → { ok, seat, id, amount, approved }
  decide(rid, approve) {
    const i = this.requests.findIndex((r) => r.rid === rid);
    if (i < 0) return { ok: false };
    const r = this.requests.splice(i, 1)[0];
    const seat = this.seatOf(r.id);
    if (seat < 0) { this.changed(); return { ok: false }; }
    if (approve) this.grant(this.game.seats[seat], r.amount);
    else { this.game.emit(`房主拒绝了 ${r.name} 的买入申请`); this.changed(); }
    return { ok: true, seat, id: r.id, amount: r.amount, approved: !!approve };
  }

  applyQueued() {
    let any = false;
    for (const [id, amount] of this.queued) {
      const seat = this.seatOf(id);
      if (seat < 0) { this.queued.delete(id); continue; }
      const p = this.game.seats[seat];
      if (this.game.addChips(seat, amount)) { this.book(p, amount); this.queued.delete(id); any = true; this.game.emit(`💰 ${p.name} 的 ${fmtN(amount)} 筹码已到账`, 'buy'); }
    }
    return any;
  }

  ledgerList() {
    const g = this.game;
    const live = g.isBetting();
    return [...this.ledger.values()].map((e) => {
      const p = g.seats.find((x) => x && x.id === e.id);
      const stack = p ? p.chips + (live && p.inHand ? p.totalBet : 0) : 0;
      return { name: e.name, isBot: e.isBot, bought: e.bought, buys: e.buys, stack, cashout: e.cashout, net: stack + e.cashout - e.bought,
        seated: !!p, connected: p ? p.connected !== false : false, queued: this.queued.get(e.id) || 0 };
    }).sort((a, b) => b.net - a.net);
  }

  // Invariant: every chip on the table was bought, every chip bought is on the table or was cashed out.
  chipAudit() {
    let bought = 0, cashout = 0;
    for (const e of this.ledger.values()) { bought += e.bought; cashout += e.cashout; }
    const onTable = this.game.totalChips();
    return { bought, cashout, onTable, ok: bought === onTable + cashout };
  }

  freeSeat(preferred = -1) {
    if (preferred >= 0 && !this.game.seats[preferred]) return preferred;
    return this.game.seats.findIndex((s) => !s);
  }

  addHuman(id, name, preferredSeat = -1) {
    const seat = this.freeSeat(preferredSeat);
    if (seat < 0) return -1;
    const p = this.game.addPlayer(seat, { id, name });
    this.book(p, p.chips);
    this.game.emit(`${name} 加入了牌桌`);
    this.changed();
    this.kick();
    return seat;
  }

  addBot(name, style) {
    const seat = this.freeSeat();
    if (seat < 0) return -1;
    const used = new Set(this.game.seats.filter(Boolean).map((p) => p.name));
    if (!name) name = BOT_NAMES.find((n) => !used.has(n)) || `机器人${seat + 1}`;
    const botStyle = style && PERSONALITIES[style] ? style : defaultStyleFor(name, seat);
    const p = this.game.addPlayer(seat, { id: uid('bot'), name, isBot: true, botStyle });
    this.book(p, p.chips);
    this.game.emit(`🤖 ${name}（${PERSONALITIES[botStyle].label}）入座`);
    this.changed();
    this.kick();
    return seat;
  }

  setBotStyle(seat, style) {
    const p = this.game.seats[seat];
    if (!p || !p.isBot || !PERSONALITIES[style] || resolveStyle(p.botStyle) === style) return false;
    p.botStyle = style;
    p.tilt = 0;
    this.game.emit(`${p.name} 换成了「${PERSONALITIES[style].label}」打法`);
    this.after();
    return true;
  }

  seatOf(id) { const p = this.game.seats.find((s) => s && s.id === id); return p ? p.seat : -1; }

  // Rejoin from a new browser/webview (lost token): take back a *disconnected* human seat with the same name.
  reclaimSeat(name, newId) {
    const p = this.game.seats.find((s) => s && !s.isBot && s.name === name && s.connected === false && !s.pendingRemove);
    if (!p) return -1;
    const e = this.ledger.get(p.id);
    if (e) { this.ledger.delete(p.id); e.id = newId; this.ledger.set(newId, e); }
    if (this.queued.has(p.id)) { this.queued.set(newId, this.queued.get(p.id)); this.queued.delete(p.id); }
    for (const r of this.requests) if (r.id === p.id) r.id = newId;
    p.id = newId;
    return p.seat;
  }

  setReady(seat, v) {
    const p = this.game.seats[seat];
    if (!p || p.ready === !!v) return;
    p.ready = !!v;
    this.changed();
  }

  removeSeat(seat) {
    const p = this.game.seats[seat];
    if (!p) return;
    this.game.emit(`${p.name} 离开了牌桌`);
    this.game.removePlayer(seat);
    this.after();
  }

  // legacy "补码": top a player back up to the starting stack (host action, ignores table rules)
  rebuy(seat) {
    const p = this.game.seats[seat];
    if (!p || p.chips >= STARTING_CHIPS || !this.game.canAddChips(seat)) return false;
    return this.buyIn(seat, STARTING_CHIPS - p.chips, { ignoreRules: true }).ok;
  }

  setBlinds(sb, bb) {
    sb = Math.max(1, Math.floor(sb)); bb = Math.max(sb, Math.floor(bb));
    if (this.game.isBetting()) {
      this.pendingBlinds = { sb, bb };
      this.game.emit(`盲注将在下一手调整为 ${sb.toLocaleString()}/${bb.toLocaleString()}`);
    } else this.game.setBlinds(sb, bb);
    this.changed();
  }

  setTurnTime(sec) { this.turnTime = sec; this.changed(); }

  setConnected(seat, connected) {
    const p = this.game.seats[seat];
    if (!p) return;
    if (connected) {
      p.offSince = 0;
      // the table sat them out for timing out while they were gone: they're back, deal them in again
      if (p.autoSitOut) { p.sittingOut = false; p.autoSitOut = false; p.timeouts = 0; }
    }
    if (p.connected === connected) { this.changed(); return; }
    p.connected = connected;
    if (!connected) p.offSince = Date.now();
    this.game.emit(connected ? `📶 ${p.name} 重新连接` : `📴 ${p.name} 掉线（${Math.round(DISC_GRACE_MS / 1000)} 秒内回来可继续行动，否则自动过牌/弃牌）`);
    if (this.game.toAct === seat) this.after(); // restart their clock (back: normal turn time; gone: grace period)
    else { this.changed(); if (connected) this.kick(); }
  }

  setSittingOut(seat, v) {
    const p = this.game.seats[seat];
    if (!p) return;
    p.sittingOut = v;
    p.autoSitOut = false;
    p.timeouts = 0;
    this.game.emit(v ? `${p.name} 暂离` : `${p.name} 回到座位`);
    if (v && this.game.toAct === seat) this.after();
    else { this.changed(); if (!v) this.kick(); }
  }

  start() { this.running = true; this.game.emit('房主开始了游戏'); this.changed(); this.kick(); }
  pause() { this.running = false; this.game.emit('房主暂停：本手结束后不再发新牌'); this.changed(); }

  kick() {
    if (!this.running || this.game.isBetting() || this.handTimer) return;
    this.handTimer = setTimeout(() => { this.handTimer = null; this.startHand(); }, 600);
  }

  startHand() {
    if (!this.running || this.game.isBetting()) return;
    if (this.pendingBlinds) { this.game.setBlinds(this.pendingBlinds.sb, this.pendingBlinds.bb); this.pendingBlinds = null; }
    this.applyQueued();
    // busted AIs buy back in automatically (if the table allows rebuys) so the table never runs dry
    if (this.rules.allowRebuy) {
      for (const p of this.game.seats) if (p && p.isBot && p.chips === 0) this.buyIn(p.seat, Math.min(STARTING_CHIPS, this.rules.maxBuyIn));
    }
    if (!this.game.canStart()) { this.changed(); return; }
    this.game.startHand();
    this.after();
  }

  clearTimers() {
    clearTimeout(this.turnTimer); clearTimeout(this.botTimer);
    this.turnTimer = this.botTimer = null;
    this.deadline = 0;
    this.turnTotal = this.turnTime * 1000;
  }

  // After any state change in the game: schedule what happens next.
  after() {
    this.clearTimers();
    const g = this.game;
    if (g.phase === 'handover') {
      this.applyQueued();
      if (this.running && !this.handTimer) {
        const delay = g.result && g.result.showdown ? 5500 : 2500;
        this.handTimer = setTimeout(() => { this.handTimer = null; this.startHand(); }, delay);
      }
    } else if (g.runout) {
      this.botTimer = setTimeout(() => { g.continueRunout(); this.after(); }, 1300);
    } else if (g.toAct >= 0) {
      const p = g.seats[g.toAct];
      const seat = g.toAct, hand = g.handNo;
      if (p.isBot) {
        // decide now, act after a personality-dependent "thinking" pause (longer before big moves)
        let d = null;
        try { d = botDecide(g, seat); } catch (e) { console.error(e); }
        const [base, spread] = TEMPO[resolveStyle(p.botStyle)] || TEMPO.regular;
        const big = d && (d.type === 'allin' || d.tag === 'checkraise' || (d.type === 'raise' && g.streetRaises >= 1));
        const delay = this.fast ? 0 : base + Math.random() * spread + (big ? 500 + Math.random() * 700 : 0);
        this.botTimer = setTimeout(() => this.botMove(seat, hand, d), delay);
      } else if (!p.connected) {
        // dropped mid-hand: hold their turn for a short grace period (shown as a countdown), then check/fold
        const gone = Date.now() - (p.offSince || Date.now());
        const grace = gone > 60000 ? 800 : DISC_GRACE_MS;
        this.deadline = Date.now() + grace;
        this.turnTotal = grace;
        this.botTimer = setTimeout(() => this.autoAct(seat, hand, false), grace);
      } else if (p.sittingOut) {
        this.botTimer = setTimeout(() => this.autoAct(seat, hand, false), 600);
      } else {
        this.deadline = Date.now() + this.turnTime * 1000;
        this.turnTimer = setTimeout(() => this.autoAct(seat, hand, true), this.turnTime * 1000);
      }
    }
    this.changed();
  }

  botMove(seat, hand, planned) {
    const g = this.game;
    if (g.toAct !== seat || g.handNo !== hand) return;
    let d = planned;
    if (!d) { try { d = botDecide(g, seat); } catch (e) { console.error(e); } }
    let r = d ? g.act(seat, d) : { ok: false };
    if (!r.ok && planned) { try { d = botDecide(g, seat); r = d ? g.act(seat, d) : r; } catch (e) { console.error(e); } }
    if (!r.ok) r = g.act(seat, { type: g.legal(seat)?.canCheck ? 'check' : 'fold' });
    this.after();
  }

  autoAct(seat, hand, isTimeout) {
    const g = this.game;
    if (g.toAct !== seat || g.handNo !== hand) return;
    const p = g.seats[seat];
    const la = g.legal(seat);
    g.act(seat, { type: la && la.canCheck ? 'check' : 'fold' });
    if (isTimeout) {
      p.timeouts = (p.timeouts || 0) + 1;
      g.emit(`${p.name} 超时，自动${la && la.canCheck ? '过牌' : '弃牌'}`);
      if (p.timeouts >= 2) { p.sittingOut = true; p.autoSitOut = true; g.emit(`${p.name} 连续超时，已设为暂离`); }
    }
    this.after();
  }

  // Action from a human player identified by seat
  handleAction(seat, action) {
    const g = this.game;
    if (g.toAct !== seat) return { ok: false, error: '还没轮到你' };
    const r = g.act(seat, action);
    if (r.ok) {
      const p = g.seats[seat];
      if (p) p.timeouts = 0;
      this.after();
    }
    return r;
  }

  view(seat, { host = false } = {}) {
    const v = this.game.view(seat);
    v.turnRemainingMs = this.deadline ? Math.max(0, this.deadline - Date.now()) : 0;
    v.turnTotalMs = this.turnTotal || this.turnTime * 1000;
    v.rules = { ...this.rules };
    v.ledger = this.ledgerList();
    const me = seat >= 0 ? this.game.seats[seat] : null;
    v.buy = me ? { pending: this.pendingOf(me.id), queued: this.queued.get(me.id) || 0, room: this.buyRoom(seat) } : null;
    v.requests = host ? this.requests.map((r) => ({ rid: r.rid, name: r.name, amount: r.amount, seat: this.seatOf(r.id) })) : [];
    v.running = this.running;
    v.pendingBlinds = this.pendingBlinds;
    return v;
  }

  changed() { this.onChange(); }

  destroy() { this.clearTimers(); clearTimeout(this.handTimer); this.running = false; }
}
