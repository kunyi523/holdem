// Host-side controller: owns the authoritative Game, drives bots, timers, hand scheduling.
import { Game, STARTING_CHIPS } from './engine.js';
import { botDecide } from './bot.js';

export const BOT_NAMES = ['粉哥', 'Micheal', 'Grok Bot', '小龙', '阿杰', 'Lucy', '老王', '阿May'];
const STYLE_BY_NAME = { '粉哥': 'loose', 'Micheal': 'tight', 'Grok Bot': 'balanced' };
const STYLES = ['loose', 'tight', 'balanced'];

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
  }

  freeSeat(preferred = -1) {
    if (preferred >= 0 && !this.game.seats[preferred]) return preferred;
    return this.game.seats.findIndex((s) => !s);
  }

  addHuman(id, name, preferredSeat = -1) {
    const seat = this.freeSeat(preferredSeat);
    if (seat < 0) return -1;
    this.game.addPlayer(seat, { id, name });
    this.game.emit(`${name} 加入了牌桌`);
    this.changed();
    this.kick();
    return seat;
  }

  addBot(name) {
    const seat = this.freeSeat();
    if (seat < 0) return -1;
    const used = new Set(this.game.seats.filter(Boolean).map((p) => p.name));
    if (!name) name = BOT_NAMES.find((n) => !used.has(n)) || `机器人${seat + 1}`;
    const botStyle = STYLE_BY_NAME[name] || STYLES[Math.floor(Math.random() * STYLES.length)];
    this.game.addPlayer(seat, { id: uid('bot'), name, isBot: true, botStyle });
    this.game.emit(`🤖 ${name} 入座`);
    this.changed();
    this.kick();
    return seat;
  }

  seatOf(id) { const p = this.game.seats.find((s) => s && s.id === id); return p ? p.seat : -1; }

  removeSeat(seat) {
    const p = this.game.seats[seat];
    if (!p) return;
    this.game.emit(`${p.name} 离开了牌桌`);
    this.game.removePlayer(seat);
    this.after();
  }

  rebuy(seat) {
    if (this.game.rebuy(seat, STARTING_CHIPS)) { this.changed(); this.kick(); return true; }
    return false;
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
    if (!p || p.connected === connected) return;
    p.connected = connected;
    this.game.emit(connected ? `${p.name} 重新连接` : `${p.name} 断线（轮到时自动过牌/弃牌）`);
    if (!connected && this.game.toAct === seat) this.after();
    else { this.changed(); if (connected) this.kick(); }
  }

  setSittingOut(seat, v) {
    const p = this.game.seats[seat];
    if (!p) return;
    p.sittingOut = v;
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
    if (!this.game.canStart()) { this.changed(); return; }
    this.game.startHand();
    this.after();
  }

  clearTimers() {
    clearTimeout(this.turnTimer); clearTimeout(this.botTimer);
    this.turnTimer = this.botTimer = null;
    this.deadline = 0;
  }

  // After any state change in the game: schedule what happens next.
  after() {
    this.clearTimers();
    const g = this.game;
    if (g.phase === 'handover') {
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
        this.botTimer = setTimeout(() => this.botMove(seat, hand), 500 + Math.random() * 900);
      } else if (!p.connected || p.sittingOut) {
        this.botTimer = setTimeout(() => this.autoAct(seat, hand, false), 600);
      } else {
        this.deadline = Date.now() + this.turnTime * 1000;
        this.turnTimer = setTimeout(() => this.autoAct(seat, hand, true), this.turnTime * 1000);
      }
    }
    this.changed();
  }

  botMove(seat, hand) {
    const g = this.game;
    if (g.toAct !== seat || g.handNo !== hand) return;
    let d;
    try { d = botDecide(g, seat); } catch (e) { console.error(e); }
    let r = d ? g.act(seat, d) : { ok: false };
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
      if (p.timeouts >= 2) { p.sittingOut = true; g.emit(`${p.name} 连续超时，已设为暂离`); }
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

  view(seat) {
    const v = this.game.view(seat);
    v.turnRemainingMs = this.deadline ? Math.max(0, this.deadline - Date.now()) : 0;
    v.turnTotalMs = this.turnTime * 1000;
    v.running = this.running;
    v.pendingBlinds = this.pendingBlinds;
    return v;
  }

  changed() { this.onChange(); }

  destroy() { this.clearTimers(); clearTimeout(this.handTimer); this.running = false; }
}
