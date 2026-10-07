// Poker AI v2.
// Preflop: starting-hand ranking (169 hands) + per-personality ranges, position, raise size.
// Postflop: Monte-Carlo equity vs the number of live opponents compared with pot odds,
//           plus draws (semi-bluffs / drawing calls), continuation bets, bluffs and floats.
import { evaluate } from './evaluator.js';
import { PREFLOP_ORDER } from './preflop.js';

export const BOT_STYLES = {
  //            open-raise range, total voluntary range, 3-bet range, c-bet freq, bluff freq, float freq, call margin
  loose:    { pfr: 0.22, vpip: 0.44, threeBet: 0.09, cbet: 0.78, bluff: 0.16, float: 0.18, margin: -0.04, limp: 0.55 }, // 粉哥：松凶
  tight:    { pfr: 0.15, vpip: 0.21, threeBet: 0.045, cbet: 0.60, bluff: 0.06, float: 0.05, margin: 0.04, limp: 0.15 }, // Micheal：紧
  balanced: { pfr: 0.19, vpip: 0.29, threeBet: 0.065, cbet: 0.68, bluff: 0.10, float: 0.10, margin: 0.0, limp: 0.30 }, // Grok Bot：平衡
};

// ---------- preflop hand percentile (0 = AA ... 1 = 32o), by combos ----------
const RANKS = '23456789TJQKA';
const PCT = new Map();
{
  let cum = 0;
  for (const k of PREFLOP_ORDER) {
    const combos = k.length === 2 ? 6 : k[2] === 's' ? 4 : 12;
    PCT.set(k, (cum + combos / 2) / 1326);
    cum += combos;
  }
}
export function handKey(hole) {
  const [a, b] = hole;
  let r1 = a >> 2, r2 = b >> 2;
  if (r1 < r2) [r1, r2] = [r2, r1];
  if (r1 === r2) return RANKS[r1] + RANKS[r2];
  return RANKS[r1] + RANKS[r2] + ((a & 3) === (b & 3) ? 's' : 'o');
}
export const handPercentile = (hole) => PCT.get(handKey(hole));
const PAIR_PCT = new Float32Array(52 * 52);
for (let a = 0; a < 52; a++) for (let c = 0; c < 52; c++) if (a !== c) PAIR_PCT[a * 52 + c] = PCT.get(handKey([a, c]));

// ---------- equity ----------
// Equity vs `numOpp` opponents. `ranges` (optional) gives, per opponent, the weakest preflop percentile
// they are assumed to hold (e.g. 0.25 = top 25% of hands), sampled by rejection; 1 = any two cards.
export function estimateEquity(hole, board, numOpp, iters = 300, random = Math.random, ranges = null) {
  const used = new Set([...hole, ...board]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const n = deck.length;
  let score = 0;
  const mine = new Array(7);
  const opp = new Array(7);
  const swap = (i, j) => { const t = deck[i]; deck[i] = deck[j]; deck[j] = t; };
  for (let it = 0; it < iters; it++) {
    let k = 0;
    // board runout
    for (let i = board.length; i < 5; i++) { swap(k, k + Math.floor(random() * (n - k))); k++; }
    mine[0] = hole[0]; mine[1] = hole[1];
    for (let i = 0; i < 5; i++) {
      const c = i < board.length ? board[i] : deck[i - board.length];
      mine[i + 2] = c; opp[i + 2] = c;
    }
    const my = evaluate(mine);
    let ties = 0, lost = false;
    for (let o = 0; o < numOpp; o++) {
      const limit = ranges ? ranges[o] : 1;
      for (let tries = 0; ; tries++) {
        swap(k, k + Math.floor(random() * (n - k)));
        swap(k + 1, k + 1 + Math.floor(random() * (n - k - 1)));
        if (limit >= 1 || tries >= 15 || PAIR_PCT[deck[k] * 52 + deck[k + 1]] <= limit) break;
      }
      opp[0] = deck[k]; opp[1] = deck[k + 1]; k += 2;
      const s = evaluate(opp);
      if (s > my) { lost = true; break; }
      if (s === my) ties++;
    }
    if (!lost) score += ties ? 1 / (ties + 1) : 1;
  }
  return score / iters;
}

// ---------- draws ----------
// Returns outs-ish count for flush draws / open-ended / gutshot straight draws that use a hole card.
export function drawOuts(hole, board) {
  if (board.length < 3 || board.length >= 5) return 0;
  const all = [...hole, ...board];
  let outs = 0;
  for (let s = 0; s < 4; s++) {
    const n = all.filter((c) => (c & 3) === s).length;
    if (n === 4 && hole.some((c) => (c & 3) === s)) outs += 9;
  }
  const mask = (cards) => cards.reduce((m, c) => m | (1 << ((c >> 2) + 2)), 0);
  let m = mask(all);
  if (m & (1 << 14)) m |= 2;
  const holeMask = mask(hole) | ((mask(hole) & (1 << 14)) ? 2 : 0);
  let best = 0;
  for (let lo = 1; lo <= 10; lo++) {
    const win = 0x1f << lo;
    const have = m & win;
    const cnt = have.toString(2).split('1').length - 1;
    if (cnt === 5) return outs; // already a straight
    if (cnt === 4 && (have & holeMask)) {
      const missing = win & ~have;
      const open = missing === (1 << lo) || missing === (1 << (lo + 4));
      best = Math.max(best, open ? 8 : 4);
    }
  }
  return Math.min(15, outs + best);
}

const roundTo = (x, unit) => Math.max(unit, Math.round(x / unit) * unit);

// Opponent model: how loose/aggressive has this player been? (Bayesian prior ≈ a normal player)
export function villainProfile(p) {
  const s = (p && p.stats) || { hands: 0, vpip: 0, pfr: 0, postActs: 0, postAggr: 0 };
  return {
    pfr: (s.pfr + 2) / (s.hands + 12),            // prior ≈ 17%
    vpip: (s.vpip + 3) / (s.hands + 12),          // prior ≈ 25%
    aggr: (s.postAggr + 3) / (s.postActs + 10),   // prior ≈ 30% of postflop actions are bets/raises
  };
}

export function botDecide(game, seat, opts = {}) {
  const random = opts.random || Math.random;
  const p = game.seats[seat];
  const la = game.legal(seat);
  if (!la) return null;
  const st = BOT_STYLES[p.botStyle] || BOT_STYLES.balanced;
  const unit = game.sb >= 100 ? 100 : 1;
  const pot = game.potTotal();
  const toCall = la.toCall;
  const live = game.liveSeats();
  const nOpp = Math.max(1, live.length - 1);
  const stack = p.chips + p.bet;
  const free = la.canCheck;

  const shove = { type: 'allin' };
  const sized = (target) => {
    target = roundTo(target, unit);
    target = Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, target));
    if (target >= la.maxRaiseTo * 0.8) return shove; // committing most of the stack anyway
    return { type: 'raise', amount: target };
  };
  const call = () => (free ? { type: 'check' } : { type: 'call' });
  const foldOrCheck = () => (free ? { type: 'check' } : { type: 'fold' }); // never fold when checking is free

  // ======================= PREFLOP =======================
  if (game.phase === 'preflop') {
    const pct = handPercentile(p.hole) + (random() - 0.5) * 0.05; // a little randomness around range edges
    // position: how many players still to act behind us (fewer = later position = wider)
    const behind = game.actors().filter((o) => o !== p && !o.acted && o.seat !== seat).length;
    const posAdj = behind <= 1 ? 0.07 : behind === 2 ? 0.03 : behind >= 4 ? -0.03 : 0;
    const raiseLevel = game.currentBet / game.bb; // 1 = unraised
    const limpers = live.filter((o) => o !== p && o.bet >= game.bb && o.seat !== game.bbSeat).length;

    if (raiseLevel <= 1) {
      // unraised pot
      if (pct < st.pfr + posAdj && la.canRaise) return sized(game.bb * (2.5 + random() * 0.7) + limpers * game.bb);
      if (free) {
        if (la.canRaise && pct < st.pfr * 0.8 && random() < 0.6) return sized(game.bb * (3 + limpers));
        return { type: 'check' };
      }
      const isSB = seat === game.sbSeat;
      const limpRange = st.vpip + posAdj + (isSB ? 0.12 : 0) + (limpers ? 0.04 : 0);
      if (pct < limpRange) {
        // loose players limp, tighter players prefer raise-or-fold
        if (la.canRaise && random() > st.limp + (limpers ? 0.3 : 0) && !isSB) return sized(game.bb * (2.5 + random() * 0.5) + limpers * game.bb);
        return call();
      }
      return foldOrCheck();
    }

    // facing a raise
    const potOdds = toCall / (pot + toCall);
    const shrink = Math.min(0.9, Math.max(0.22, 2.6 / raiseLevel)); // bigger raises -> narrower calling range
    // the more often the raiser raises, the weaker his range: fight back with wider calls / 3-bets
    const vill = villainProfile(game.seats[game.lastAggressor]);
    const loosen = Math.min(2.2, Math.max(0.8, Math.pow(vill.pfr / 0.17, 0.7)));
    let callRange = st.vpip * shrink * loosen + posAdj * 0.5;
    if (seat === game.bbSeat && potOdds < 0.36) callRange += 0.08; // defend the big blind
    const threeBet = st.threeBet * (raiseLevel > 6 ? 0.5 : 1) * loosen;
    const deep = toCall > stack * 0.35; // calling would commit a big part of the stack
    if (la.canRaise && pct < threeBet) {
      if (deep || raiseLevel > 12) return shove;
      return sized(game.currentBet * (2.8 + random() * 0.6));
    }
    // light 3-bet bluffs with hands just outside the calling range
    if (la.canRaise && !deep && raiseLevel < 5 && pct > callRange && pct < callRange + 0.12 && random() < st.bluff * 0.3) {
      return sized(game.currentBet * 3);
    }
    if (deep) return pct < Math.max(threeBet * 1.6, 0.04) ? call() : foldOrCheck();
    if (pct < callRange) return call();
    return foldOrCheck();
  }

  // ======================= POSTFLOP =======================
  const iters = opts.iters ?? (nOpp <= 2 ? 900 : nOpp <= 4 ? 650 : 450);
  // what each opponent could hold given how they played preflop
  const ranges = live.filter((o) => o !== p).map((o) => (o.seat === game.preflopAggressor ? 0.25 : o.voluntary ? 0.5 : 1));
  const eq = estimateEquity(p.hole, game.board, nOpp, iters, random, ranges);
  const outs = drawOuts(p.hole, game.board);
  const fair = 1 / (nOpp + 1);
  const valueT = Math.pow(fair, 0.72 - st.margin);   // HU ≈ 0.61, 3-way ≈ 0.45
  const strongT = Math.pow(fair, 0.42 - st.margin);  // HU ≈ 0.75, 3-way ≈ 0.63
  const r = random();
  const betPot = (frac) => sized(game.currentBet + (pot + toCall) * frac);
  const river = game.phase === 'river';

  if (free) {
    if (!la.canRaise) return { type: 'check' };
    if (eq > strongT) return r < 0.82 ? betPot(0.55 + random() * 0.35) : { type: 'check' }; // occasional slow-play
    if (eq > valueT) return r < 0.72 ? betPot(0.45 + random() * 0.25) : { type: 'check' };
    // continuation bet as the preflop raiser (flop) / barrel as last street's aggressor (turn)
    const cbetSpot = (game.phase === 'flop' && game.preflopAggressor === seat) || (game.phase === 'turn' && game.prevAggressor === seat && random() < 0.55);
    if (cbetSpot && game.streetRaises === 0 && random() < st.cbet * (nOpp === 1 ? 1 : nOpp === 2 ? 0.7 : 0.4)) return betPot(0.33 + random() * 0.3);
    if (outs >= 8 && random() < 0.45 + st.bluff) return betPot(0.5 + random() * 0.2); // semi-bluff
    if (nOpp <= 2 && random() < st.bluff * (river ? 0.7 : 1)) return betPot(0.4 + random() * 0.3); // bluff
    return { type: 'check' };
  }

  // facing a bet
  const potOdds = toCall / (pot + toCall);
  const pressure = Math.min(1.5, toCall / Math.max(pot - toCall, 1)); // bet size relative to the pot before it
  const raisedAgain = game.streetRaises >= 2;
  // a bettor's range is stronger than their preflop range: discount equity by bet size / re-raises
  const eAdj = eq * (1 - (0.15 * pressure + (raisedAgain ? 0.1 : 0)) * Math.min(1, 0.3 / villainProfile(game.seats[game.lastAggressor]).aggr));
  // ...unless this bettor bets all the time (then his bets mean less)
  const villAggr = villainProfile(game.seats[game.lastAggressor]).aggr;
  const trust = Math.min(1.2, Math.max(0.25, 0.3 / villAggr));
  const betRange = (0.08 + (river ? 0.04 : 0)) * trust - (1 - Math.min(1, trust)) * 0.04;
  const drawEq = river ? 0 : Math.min(0.5, outs * (game.phase === 'flop' ? 0.04 : 0.022) + 0.04); // + implied odds
  const commit = toCall > (p.chips) * 0.5 ? 0.05 : 0;

  if (la.canRaise && eAdj > strongT && !raisedAgain) return r < 0.6 ? sized(game.currentBet * (2.5 + random() * 0.7)) : call();
  if (la.canRaise && eAdj > strongT && raisedAgain && eAdj > 0.8) return shove;
  if (eAdj >= potOdds + betRange + st.margin + commit) return call();
  if (outs >= 8 && Math.max(drawEq, eAdj) >= potOdds + commit) {
    if (la.canRaise && nOpp === 1 && !raisedAgain && random() < st.bluff * 1.5) return sized(game.currentBet * 2.8); // semi-bluff raise
    return call();
  }
  // float small bets heads-up (bluff-catch / take it away later)
  if (!river && nOpp === 1 && pressure <= 0.6 && random() < st.float) return call();
  // pure bluff-raise, rare
  if (la.canRaise && !river && nOpp === 1 && !raisedAgain && pressure <= 0.5 && random() < st.bluff * 0.25) return sized(game.currentBet * 3);
  return { type: 'fold' };
}
