// Authoritative No-Limit Texas Hold'em engine (runs on the host / in single-player).
import { newDeck, shuffle, cryptoRandInt } from './cards.js?v=6';
import { evaluate, describeScore } from './evaluator.js?v=6';
import { computePots, splitPot } from './pots.js?v=6';
import { updateTilt } from './bot.js?v=6';

export const STARTING_CHIPS = 100000;
export const MAX_SEATS = 8;
export const BETTING_PHASES = ['preflop', 'flop', 'turn', 'river'];
const fmt = (n) => Number(n).toLocaleString('en-US');

export class Game {
  constructor(opts = {}) {
    this.sb = opts.sb ?? 500;
    this.bb = opts.bb ?? 1000;
    this.randInt = opts.randInt || cryptoRandInt;
    this.seats = new Array(MAX_SEATS).fill(null);
    this.phase = 'idle'; // idle | preflop | flop | turn | river | handover
    this.button = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.board = [];
    this.deck = [];
    this.toAct = -1;
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.handNo = 0;
    this.log = [];
    this.logSeq = 0;
    this.result = null;
    this.runout = false;
    this.preflopAggressor = -1; // last preflop raiser (for c-bets)
    this.lastAggressor = -1;    // last bettor/raiser on the current street
    this.prevAggressor = -1;    // last bettor/raiser on the previous street
    this.streetRaises = 0;      // bets + raises on the current street
  }

  // ---------- seats ----------
  addPlayer(seat, info) {
    if (seat < 0 || seat >= MAX_SEATS || this.seats[seat]) throw new Error('seat taken');
    const p = {
      seat,
      id: info.id,
      name: info.name,
      isBot: !!info.isBot,
      botStyle: info.botStyle || null,
      chips: info.chips ?? STARTING_CHIPS,
      connected: true,
      offSince: 0,          // ms timestamp when the connection dropped (0 = online)
      sittingOut: false,
      autoSitOut: false,    // sat out by the table (timeouts), cleared automatically when they come back
      ready: !!info.isBot,
      pendingRemove: false,
      hole: [], bet: 0, totalBet: 0,
      folded: true, allIn: false, acted: false, inHand: false,
      lastAction: '', showCards: false, score: 0, handName: '',
      stats: { hands: 0, vpip: 0, pfr: 0, postActs: 0, postAggr: 0 }, // observed tendencies (for the AI)
      pfRaised: false,
      tilt: 0, handStart: 0, lastNet: 0,
    };
    this.seats[seat] = p;
    return p;
  }

  removePlayer(seat) {
    const p = this.seats[seat];
    if (!p) return;
    if (this.isBetting() && p.inHand && !p.folded) {
      p.pendingRemove = true;
      this.forceFold(seat);
    } else if (this.isBetting() && p.inHand) {
      p.pendingRemove = true; // folded but chips still in the pot: remove at hand end
    } else {
      if (this.onRemove) this.onRemove(p);
      this.seats[seat] = null;
    }
  }

  // Can chips be added to this seat right now? (not while the player still has live cards)
  canAddChips(seat) {
    const p = this.seats[seat];
    return !!p && !(this.isBetting() && p.inHand && !p.folded);
  }
  addChips(seat, amount) {
    const p = this.seats[seat];
    amount = Math.floor(amount);
    if (!p || !(amount > 0) || !this.canAddChips(seat)) return false;
    p.chips += amount;
    return true;
  }

  isBetting() { return BETTING_PHASES.includes(this.phase); }

  emit(text, kind = 'info') {
    this.log.push({ id: ++this.logSeq, text, kind });
    if (this.log.length > 150) this.log.shift();
  }

  isEligible(p) {
    return !!p && p.chips > 0 && !p.sittingOut && p.connected !== false && !p.pendingRemove;
  }
  eligibleSeats() { return this.seats.filter((p) => this.isEligible(p)).map((p) => p.seat); }
  canStart() { return !this.isBetting() && this.eligibleSeats().length >= 2; }

  nextSeat(from, pred) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (from + i + MAX_SEATS) % MAX_SEATS;
      const p = this.seats[s];
      if (p && pred(p)) return s;
    }
    return -1;
  }

  canAct(p) { return !!p && p.inHand && !p.folded && !p.allIn; }
  liveSeats() { return this.seats.filter((p) => p && p.inHand && !p.folded); }
  actors() { return this.seats.filter((p) => this.canAct(p)); }
  potTotal() { return this.seats.reduce((s, p) => s + (p ? p.totalBet : 0), 0); }
  potCollected() { return this.seats.reduce((s, p) => s + (p ? p.totalBet - p.bet : 0), 0); }
  totalChips() { return this.seats.reduce((s, p) => s + (p ? p.chips + p.totalBet : 0), 0); }

  // ---------- hand flow ----------
  startHand() {
    if (this.isBetting()) throw new Error('hand in progress');
    const elig = this.eligibleSeats();
    if (elig.length < 2) return false;
    this.handNo++;
    this.result = null;
    this.board = [];
    this.runout = false;
    this.preflopAggressor = this.lastAggressor = this.prevAggressor = -1;
    this.streetRaises = 0;
    for (const p of this.seats) {
      if (!p) continue;
      p.hole = []; p.bet = 0; p.totalBet = 0; p.allIn = false; p.acted = false;
      p.lastAction = ''; p.showCards = false; p.score = 0; p.handName = ''; p.voluntary = false; p.pfRaised = false;
      p.handStart = p.chips;
      p.inHand = this.isEligible(p);
      p.folded = !p.inHand;
    }
    const inHand = (p) => p.inHand;
    this.button = this.nextSeat(this.button, inHand);
    if (elig.length === 2) {
      this.sbSeat = this.button;
      this.bbSeat = this.nextSeat(this.button, inHand);
    } else {
      this.sbSeat = this.nextSeat(this.button, inHand);
      this.bbSeat = this.nextSeat(this.sbSeat, inHand);
    }
    this.deck = shuffle(newDeck(), this.randInt);
    // deal two cards each, one at a time, starting left of the button
    for (let round = 0; round < 2; round++) {
      let s = this.sbSeat;
      for (let k = 0; k < elig.length; k++) {
        this.seats[s].hole.push(this.deck.pop());
        s = this.nextSeat(s, inHand);
      }
    }
    this.phase = 'preflop';
    this.emit(`—— 第 ${this.handNo} 手 · 庄家 ${this.seats[this.button].name} · 盲注 ${fmt(this.sb)}/${fmt(this.bb)} ——`, 'hand');
    this.postBlind(this.sbSeat, this.sb, '小盲');
    this.postBlind(this.bbSeat, this.bb, '大盲');
    this.currentBet = this.bb;
    this.minRaise = this.bb;
    this.toAct = this.bbSeat; // advance() moves to the first player who needs to act
    this.advance(this.bbSeat);
    return true;
  }

  postBlind(seat, amount, label) {
    const p = this.seats[seat];
    const amt = Math.min(amount, p.chips);
    this.put(p, amt);
    p.lastAction = `${label} ${fmt(amt)}`;
    this.emit(`${p.name} 下${label} ${fmt(amt)}${p.allIn ? '（全下）' : ''}`);
  }

  put(p, amt) {
    amt = Math.max(0, Math.min(amt, p.chips));
    p.chips -= amt;
    p.bet += amt;
    p.totalBet += amt;
    if (p.chips === 0) p.allIn = true;
  }

  legal(seat) {
    const p = this.seats[seat];
    if (!p || !this.isBetting() || seat !== this.toAct) return null;
    const toCall = Math.max(0, this.currentBet - p.bet);
    const othersCanAct = this.actors().filter((o) => o !== p).length;
    const maxRaiseTo = p.bet + p.chips;
    const minRaiseTo = Math.min(this.currentBet + this.minRaise, maxRaiseTo);
    const canRaise = p.chips > toCall && !p.acted && othersCanAct > 0;
    return {
      toCall,
      canCheck: toCall === 0,
      callAmount: Math.min(toCall, p.chips),
      canRaise,
      minRaiseTo,
      maxRaiseTo,
      isBet: this.currentBet === 0,
      currentBet: this.currentBet,
    };
  }

  // action: { type: 'fold'|'check'|'call'|'raise'|'allin', amount?: raise-to total for this street }
  act(seat, action) {
    const la = this.legal(seat);
    if (!la) return { ok: false, error: '还没轮到你' };
    const p = this.seats[seat];
    let type = action.type;
    let aggressive = false;
    if (type === 'bet') type = 'raise';
    if (type === 'check' && !la.canCheck) return { ok: false, error: '不能过牌' };
    if (type === 'call' && la.canCheck) type = 'check';

    if (type === 'fold') {
      p.folded = true;
      p.lastAction = '弃牌';
      this.emit(`${p.name} 弃牌`);
    } else if (type === 'check') {
      p.lastAction = '过牌';
      this.emit(`${p.name} 过牌`);
    } else if (type === 'call') {
      this.put(p, la.callAmount);
      p.lastAction = p.allIn ? `全下 ${fmt(p.bet)}` : `跟注 ${fmt(la.callAmount)}`;
      this.emit(`${p.name} ${p.allIn ? '跟注全下' : '跟注'} ${fmt(la.callAmount)}`);
    } else if (type === 'raise' || type === 'allin') {
      let target = type === 'allin' ? la.maxRaiseTo : Math.floor(Number(action.amount) || 0);
      if (target >= la.maxRaiseTo) target = la.maxRaiseTo;
      if (target <= this.currentBet) {
        // all-in for less than (or equal to) a call
        if (type !== 'allin') return { ok: false, error: '加注金额太小' };
        this.put(p, la.callAmount);
        p.lastAction = `全下 ${fmt(p.bet)}`;
        this.emit(`${p.name} 全下 ${fmt(p.bet)}`);
      } else {
        if (!la.canRaise) return { ok: false, error: '现在不能加注' };
        if (target < la.minRaiseTo) return { ok: false, error: `最少加注到 ${fmt(la.minRaiseTo)}` };
        const raiseSize = target - this.currentBet;
        const wasBet = this.currentBet === 0;
        if (raiseSize >= this.minRaise) {
          this.minRaise = raiseSize;
          for (const o of this.seats) if (o && o !== p && this.canAct(o)) o.acted = false; // full raise reopens action
        }
        this.currentBet = target;
        this.put(p, target - p.bet);
        this.lastAggressor = seat;
        this.streetRaises++;
        aggressive = true;
        if (this.phase === 'preflop') { this.preflopAggressor = seat; p.pfRaised = true; }
        const verb = p.allIn ? '全下' : (wasBet ? '下注' : '加注到');
        p.lastAction = `${verb} ${fmt(target)}`;
        this.emit(`${p.name} ${verb} ${fmt(target)}`);
      }
    } else {
      return { ok: false, error: '未知操作' };
    }
    p.acted = true;
    if (this.phase === 'preflop' && type !== 'fold' && type !== 'check') p.voluntary = true; // VPIP
    if (this.phase !== 'preflop' && p.stats) {
      p.stats.postActs++;
      if (aggressive) p.stats.postAggr++;
    }
    this.advance(seat);
    return { ok: true };
  }

  // Fold a player out of turn (removal / disconnect while hand running).
  forceFold(seat) {
    const p = this.seats[seat];
    if (!p || !this.isBetting() || !p.inHand || p.folded) return;
    if (seat === this.toAct) { this.act(seat, { type: 'fold' }); return; }
    p.folded = true;
    p.lastAction = '弃牌';
    this.emit(`${p.name} 弃牌`);
    const live = this.liveSeats();
    if (live.length === 1) this.awardUncontested(live[0]);
    else if (this.roundComplete()) this.endRound();
  }

  roundComplete() {
    const actors = this.actors();
    if (actors.length === 0) return true;
    if (actors.length === 1 && actors[0].bet >= this.currentBet) return true;
    return actors.every((p) => p.acted && p.bet === this.currentBet);
  }

  advance(fromSeat) {
    const live = this.liveSeats();
    if (live.length === 1) { this.awardUncontested(live[0]); return; }
    if (this.roundComplete()) { this.endRound(); return; }
    this.toAct = this.nextSeat(fromSeat, (p) => this.canAct(p) && (!p.acted || p.bet < this.currentBet));
  }

  endRound() {
    for (const p of this.seats) if (p) { p.bet = 0; p.acted = false; }
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.toAct = -1;
    this.prevAggressor = this.lastAggressor;
    this.lastAggressor = -1;
    this.streetRaises = 0;
    if (this.phase === 'river') { this.showdown(); return; }
    this.dealNextStreet();
    if (this.actors().length <= 1) {
      // nobody (or only one player) can still bet: reveal and run the board out
      this.runout = true;
      for (const p of this.liveSeats()) p.showCards = true;
    } else {
      for (const p of this.seats) if (p && this.canAct(p)) p.lastAction = '';
      this.toAct = this.nextSeat(this.button, (p) => this.canAct(p));
    }
  }

  dealNextStreet() {
    this.deck.pop(); // burn
    if (this.phase === 'preflop') {
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
    } else if (this.phase === 'flop') {
      this.board.push(this.deck.pop());
      this.phase = 'turn';
    } else if (this.phase === 'turn') {
      this.board.push(this.deck.pop());
      this.phase = 'river';
    }
    const names = { flop: '翻牌', turn: '转牌', river: '河牌' };
    this.emit(`【${names[this.phase]}】`, 'street');
  }

  // Called by the controller (with a delay for drama) while this.runout is true.
  continueRunout() {
    if (!this.runout) return;
    if (this.phase === 'river') { this.runout = false; this.showdown(); return; }
    this.dealNextStreet();
  }
  finishRunout() { while (this.runout) this.continueRunout(); }

  // seats ordered starting left of the button (odd-chip priority)
  orderFromButton(seats) {
    return [...seats].sort((a, b) => ((a - this.button - 1 + 16) % 8) - ((b - this.button - 1 + 16) % 8));
  }

  showdown() {
    this.toAct = -1;
    this.runout = false;
    const live = this.liveSeats();
    for (const p of live) {
      p.showCards = true;
      p.score = evaluate([...p.hole, ...this.board]);
      p.handName = describeScore(p.score);
      this.emit(`${p.name} 亮牌：${p.handName}`);
    }
    const pots = computePots(this.seats.filter(Boolean).map((p) => ({ seat: p.seat, amount: p.totalBet, folded: p.folded || !p.inHand })));
    const winnings = new Map();
    const potResults = [];
    pots.forEach((pot, idx) => {
      const elig = pot.eligible.map((s) => this.seats[s]);
      if (!elig.length) return;
      const best = Math.max(...elig.map((p) => p.score));
      const winners = this.orderFromButton(elig.filter((p) => p.score === best).map((p) => p.seat));
      const split = splitPot(pot.amount, winners);
      for (const [s, amt] of split) winnings.set(s, (winnings.get(s) || 0) + amt);
      potResults.push({ amount: pot.amount, winners, handName: this.seats[winners[0]].handName, uncalled: elig.length === 1 });
      const label = pots.length > 1 ? (idx === 0 ? '主池' : `边池${idx}`) : '底池';
      if (elig.length === 1) {
        this.emit(`${this.seats[winners[0]].name} 收回未被跟注的 ${fmt(pot.amount)}`);
      } else {
        this.emit(`${winners.map((s) => this.seats[s].name).join('、')} ${winners.length > 1 ? '平分' : '赢得'}${label} ${fmt(pot.amount)}（${this.seats[winners[0]].handName}）`, 'win');
      }
    });
    for (const [s, amt] of winnings) this.seats[s].chips += amt;
    this.result = {
      showdown: true,
      pots: potResults,
      winners: [...winnings.entries()].map(([seat, amount]) => ({ seat, amount })),
    };
    this.endHand();
  }

  awardUncontested(p) {
    const total = this.potTotal();
    p.chips += total;
    this.toAct = -1;
    this.runout = false;
    this.emit(`${p.name} 赢得底池 ${fmt(total)}（其他人弃牌）`, 'win');
    this.result = { showdown: false, pots: [{ amount: total, winners: [p.seat], handName: '' }], winners: [{ seat: p.seat, amount: total }] };
    this.endHand();
  }

  endHand() {
    this.phase = 'handover';
    this.toAct = -1;
    for (const p of this.seats) {
      if (!p) continue;
      p.bet = 0;
      p.totalBet = 0; // pot has been paid out
      if (p.inHand && p.stats) { p.stats.hands++; if (p.voluntary) p.stats.vpip++; if (p.pfRaised) p.stats.pfr++; }
      p.lastNet = p.inHand ? p.chips - p.handStart : 0;
      if (p.isBot) {
        const before = p.tilt || 0;
        updateTilt(p, p.lastNet, this.bb);
        if (p.tilt >= 0.5 && before < 0.5) this.emit(`😤 ${p.name} 输了个大锅，有点上头了…`, 'info');
      }
      if (p.inHand && p.chips === 0) this.emit(`${p.name} 筹码输光，出局（房主可补码）`, 'bust');
    }
    for (let i = 0; i < MAX_SEATS; i++) {
      const p = this.seats[i];
      if (p && p.pendingRemove) { if (this.onRemove) this.onRemove(p); this.seats[i] = null; }
    }
  }

  rebuy(seat, amount = STARTING_CHIPS) {
    const p = this.seats[seat];
    if (!p) return false;
    if (this.isBetting() && p.inHand && !p.folded) return false; // not while still in a hand
    if (this.isBetting() && p.inHand) return false;
    if (p.chips >= amount) return false;
    p.chips = amount;
    this.emit(`${p.name} 补码到 ${fmt(amount)}`, 'info');
    return true;
  }

  setBlinds(sb, bb) {
    this.sb = sb; this.bb = bb;
    if (!this.isBetting()) this.minRaise = bb;
    this.emit(`盲注调整为 ${fmt(sb)}/${fmt(bb)}`, 'info');
  }

  // Sanitized view for one viewer (seat index, or -1 for spectator). Hole cards only for owner / showdown.
  view(viewerSeat = -1) {
    return {
      handNo: this.handNo,
      phase: this.phase,
      sb: this.sb, bb: this.bb,
      button: this.button, sbSeat: this.sbSeat, bbSeat: this.bbSeat,
      toAct: this.toAct,
      currentBet: this.currentBet,
      board: [...this.board],
      pot: this.potCollected(),
      potTotal: this.potTotal(),
      runout: this.runout,
      seats: this.seats.map((p) => {
        if (!p) return null;
        const visible = p.seat === viewerSeat || (p.showCards && p.inHand && !p.folded);
        return {
          seat: p.seat, name: p.name, chips: p.chips, bet: p.bet, totalBet: p.totalBet,
          folded: p.folded, allIn: p.allIn, inHand: p.inHand, isBot: p.isBot,
          connected: p.connected, sittingOut: p.sittingOut, lastAction: p.lastAction,
          offMs: p.connected === false && p.offSince ? Date.now() - p.offSince : 0, ready: !!p.ready,
          style: p.isBot ? p.botStyle : null, tilt: p.isBot ? Math.round((p.tilt || 0) * 100) / 100 : 0,
          lastNet: p.lastNet || 0,
          stats: p.stats ? { h: p.stats.hands, v: p.stats.vpip, p: p.stats.pfr, a: p.stats.postAggr, n: p.stats.postActs } : null,
          hasCards: p.hole.length > 0 && p.inHand,
          cards: visible ? [...p.hole] : null,
          handName: visible && p.showCards ? p.handName : '',
        };
      }),
      legal: viewerSeat >= 0 ? this.legal(viewerSeat) : null,
      result: this.result,
      log: this.log.slice(-60),
    };
  }
}
