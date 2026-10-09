// Poker AI v3 — distinct, consistent personalities.
// Shared core: 169-hand preflop ranking, Monte-Carlo equity vs estimated ranges, draws, opponent modelling.
// Each personality is a parameter set that drives very different decisions on top of that core:
//   maniac  疯狂型  loose-aggressive: plays most hands, raises/re-raises, barrels, overbets, shoves
//   rock    紧凶型  tight: few hands, bets big when strong, almost never bluffs, folds to pressure
//   station 跟注站  loose-passive: limps/calls a lot, rarely raises, chases draws, hard to bluff
//   tricky  诡诈型  trapper: slow-plays monsters, check-raises, mixed sizings, river bluff-raises
//   regular 稳健型  solid baseline (the v2 "balanced" bot)
// Plus per-decision noise, varied bet sizes and mild tilt after losing a big pot (game sets p.tilt).
import { evaluate } from './evaluator.js?v=6';
import { PREFLOP_ORDER } from './preflop.js?v=6';

export const PERSONALITIES = {
  maniac: {
    label: '疯狂型', en: 'Maniac', emoji: '🔥', color: '#ff6a3d',
    blurb: '什么牌都想玩，爱加注、爱反加，连续开火，动不动超池或全下',
    open: 0.36, vpip: 0.66, limp: 0.12, raiseOption: 0.45, defend: 0.48, threeBet: 0.15, fourBet: 0.08, lightThreeBet: 0.3,
    openSize: [3, 3.5, 4, 5], threeBetSize: [3.2, 3.8, 4.5], pfShove: 0.035, trapPre: 0, posSense: 1,
    margin: -0.08, fear: 0.55, betValue: 0.95, betMedium: 0.7, cbet: 0.92, barrel: 0.72, semiBluff: 0.85, bluff: 0.36,
    float: 0.32, raiseValue: 0.85, raiseLight: 0.2, bluffRaise: 0.13, slowplay: 0.04, checkRaise: 0.15, chase: 0.04,
    sizes: [0.6, 0.75, 0.9, 1.1], overbet: 0.12, shove: 0.04, foldBig: 0, noise: 0.07, airMult: 1,
  },
  rock: {
    label: '紧凶型', en: 'Rock', emoji: '🪨', color: '#8fa3b8',
    blurb: '只玩好牌，一出手就是重注；几乎不诈唬，被大注施压没好牌就弃',
    open: 0.1, vpip: 0.1, limp: 0, raiseOption: 0.25, defend: 0.1, threeBet: 0.035, fourBet: 0.02, lightThreeBet: 0,
    openSize: [3, 3.5], threeBetSize: [3.5, 4], pfShove: 0, trapPre: 0, posSense: 0.5,
    margin: 0.06, fear: 1.5, betValue: 0.9, betMedium: 0.25, cbet: 0.55, barrel: 0.3, semiBluff: 0.2, bluff: 0.02,
    float: 0.0, raiseValue: 0.8, raiseLight: 0, bluffRaise: 0, slowplay: 0.05, checkRaise: 0.1, chase: -0.03,
    sizes: [0.75, 0.9, 1.05], overbet: 0.08, shove: 0, foldBig: 0.75, noise: 0.03, airMult: 0.35,
  },
  station: {
    label: '跟注站', en: 'Calling Station', emoji: '🐟', color: '#4fc3f7',
    blurb: '什么都跟，很少加注；听牌一定追，很难被诈唬走',
    open: 0.04, vpip: 0.62, limp: 1, raiseOption: 0.05, defend: 0.5, threeBet: 0.012, fourBet: 0.01, lightThreeBet: 0,
    openSize: [2.5, 3], threeBetSize: [3], pfShove: 0, trapPre: 0, posSense: 0.2,
    margin: -0.15, fear: 0.3, betValue: 0.3, betMedium: 0.1, cbet: 0.25, barrel: 0.15, semiBluff: 0.06, bluff: 0.02,
    float: 0.6, raiseValue: 0.2, raiseLight: 0, bluffRaise: 0, slowplay: 0.4, checkRaise: 0.05, chase: 0.2,
    sizes: [0.33, 0.45, 0.55], overbet: 0, shove: 0, foldBig: 0, noise: 0.05, airMult: 0.5, callsDown: true,
  },
  tricky: {
    label: '诡诈型', en: 'Trickster', emoji: '🦊', color: '#c77dff',
    blurb: '大牌慢打埋伏，爱过牌加注，下注尺度忽大忽小，河牌偶尔诈唬加注',
    open: 0.18, vpip: 0.24, limp: 0.15, raiseOption: 0.3, defend: 0.27, threeBet: 0.085, fourBet: 0.04, lightThreeBet: 0.12,
    openSize: [2.2, 2.5, 3, 4], threeBetSize: [2.8, 3.5, 4.5], pfShove: 0.01, trapPre: 0.35, posSense: 1,
    margin: 0, fear: 0.9, betValue: 0.55, betMedium: 0.3, cbet: 0.5, barrel: 0.45, semiBluff: 0.45, bluff: 0.13,
    float: 0.22, raiseValue: 0.45, raiseLight: 0.06, bluffRaise: 0.11, slowplay: 0.6, checkRaise: 0.7, chase: 0.02,
    sizes: [0.25, 0.4, 0.66, 1.0, 1.5], overbet: 0.15, shove: 0.02, foldBig: 0, noise: 0.06, airMult: 1,
  },
  regular: {
    label: '稳健型', en: 'Regular', emoji: '🎯', color: '#7bd88f',
    blurb: '标准打法：按位置和胜率行动，偶尔诈唬',
    open: 0.19, vpip: 0.27, limp: 0.3, raiseOption: 0.4, defend: 0.29, threeBet: 0.065, fourBet: 0.03, lightThreeBet: 0.08,
    openSize: [2.5, 3, 3.2], threeBetSize: [3, 3.4], pfShove: 0, trapPre: 0.05, posSense: 1,
    margin: 0, fear: 1, betValue: 0.75, betMedium: 0.25, cbet: 0.68, barrel: 0.45, semiBluff: 0.5, bluff: 0.1,
    float: 0.1, raiseValue: 0.6, raiseLight: 0.04, bluffRaise: 0.04, slowplay: 0.18, checkRaise: 0.3, chase: 0,
    sizes: [0.45, 0.6, 0.75], overbet: 0.02, shove: 0, foldBig: 0.2, noise: 0.04, airMult: 0.8,
  },
};
// v2 style names (old saves / tests) map onto the new personalities
export const STYLE_ALIASES = { loose: 'maniac', tight: 'rock', balanced: 'regular' };
export const STYLE_KEYS = ['maniac', 'rock', 'station', 'tricky', 'regular'];
export const resolveStyle = (s) => (PERSONALITIES[s] ? s : STYLE_ALIASES[s] || 'regular');
export const styleInfo = (s) => PERSONALITIES[resolveStyle(s)];
export const BOT_STYLES = PERSONALITIES; // backwards-compatible export

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
const pick = (arr, random) => arr[Math.floor(random() * arr.length) % arr.length];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Opponent model: how loose/aggressive has this player been? (Bayesian prior ≈ a normal player)
export function villainProfile(p) {
  const s = (p && p.stats) || { hands: 0, vpip: 0, pfr: 0, postActs: 0, postAggr: 0 };
  return {
    pfr: (s.pfr + 2) / (s.hands + 12),            // prior ≈ 17%
    vpip: (s.vpip + 3) / (s.hands + 12),          // prior ≈ 25%
    aggr: (s.postAggr + 3) / (s.postActs + 10),   // prior ≈ 30% of postflop actions are bets/raises
  };
}

// Tilt: after losing a big pot a bot plays looser and more aggressively for a few hands.
// Called by the engine at the end of every hand with the player's net result.
export function updateTilt(p, net, bb) {
  let t = (p.tilt || 0) * 0.6;
  // a "big pot" = at least 40 big blinds and 40% of what the player started the hand with
  const big = Math.max(40 * bb, 0.4 * (p.handStart || 0));
  if (net <= -big) t += 0.5 + Math.min(0.4, -net / (150 * bb));
  p.tilt = t < 0.1 ? 0 : Math.min(1, t);
  return p.tilt;
}

// Returns { type, amount?, tag } — tag describes the intent ('value', 'bluff', 'slowplay', 'checkraise', ...)
export function botDecide(game, seat, opts = {}) {
  const random = opts.random || Math.random;
  const p = game.seats[seat];
  const la = game.legal(seat);
  if (!la) return null;
  const base = PERSONALITIES[resolveStyle(p.botStyle)];
  const tilt = opts.tilt ?? (p.tilt || 0);
  // tilted bots: wider ranges, more bluffs, calls lighter
  const st = tilt > 0 ? {
    ...base,
    open: Math.min(0.85, base.open + 0.12 * tilt), vpip: Math.min(0.9, base.vpip + 0.15 * tilt), defend: Math.min(0.85, base.defend + 0.12 * tilt),
    threeBet: base.threeBet + 0.05 * tilt, bluff: base.bluff + 0.12 * tilt, barrel: Math.min(1, base.barrel + 0.15 * tilt),
    margin: base.margin - 0.05 * tilt, fear: base.fear * (1 - 0.3 * tilt), foldBig: base.foldBig * (1 - 0.5 * tilt),
  } : base;
  const unit = game.sb >= 100 ? 100 : 1;
  const pot = game.potTotal();
  const toCall = la.toCall;
  const live = game.liveSeats();
  const nOpp = Math.max(1, live.length - 1);
  const stack = p.chips + p.bet;
  const free = la.canCheck;

  const tagged = (d, tag) => { d.tag = tag; return d; };
  const shove = (tag) => (la.canRaise ? tagged({ type: 'allin' }, tag) : call(tag));
  const sized = (target, tag) => {
    if (!la.canRaise) return call(tag);
    target = roundTo(target, unit);
    target = Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, target));
    if (target >= la.maxRaiseTo * 0.8) return tagged({ type: 'allin' }, tag); // committing most of the stack anyway
    return tagged({ type: 'raise', amount: target }, tag);
  };
  function call(tag = 'call') { return tagged(free ? { type: 'check' } : { type: 'call' }, tag); }
  const check = (tag = 'check') => tagged({ type: 'check' }, tag);
  const foldOrCheck = () => (free ? check() : tagged({ type: 'fold' }, 'fold')); // never fold when checking is free
  const jitter = () => 0.9 + random() * 0.2;

  // ======================= PREFLOP =======================
  if (game.phase === 'preflop') {
    const pct = handPercentile(p.hole) + (random() - 0.5) * st.noise;
    const behind = game.actors().filter((o) => o !== p && !o.acted && o.seat !== seat).length;
    const posAdj = (behind <= 1 ? 0.07 : behind === 2 ? 0.03 : behind >= 4 ? -0.03 : 0) * st.posSense;
    const raiseLevel = game.currentBet / game.bb; // 1 = unraised
    const limpers = live.filter((o) => o !== p && o.bet >= game.bb && o.seat !== game.bbSeat).length;
    const openTo = () => game.bb * (pick(st.openSize, random) * jitter() + limpers);

    if (raiseLevel <= 1) {
      // trappers sometimes just limp/check their monsters
      if (pct < 0.035 && random() < st.trapPre) return call('trap');
      if (la.canRaise && pct < st.pfShove * 0.5 && random() < 0.5) return shove('shove');
      if (pct < st.open + posAdj && la.canRaise) {
        if (free && random() > st.raiseOption + 0.4) return check('check');
        return sized(openTo(), pct < st.open * 0.5 ? 'value' : 'open');
      }
      if (free) {
        if (la.canRaise && random() < st.raiseOption * 0.35 && pct < st.vpip) return sized(openTo(), 'bluff'); // raise the option light
        return check();
      }
      const isSB = seat === game.sbSeat;
      const limpRange = st.vpip + posAdj + (isSB ? 0.1 : 0) + (limpers ? 0.04 : 0);
      if (pct < limpRange) {
        if (la.canRaise && random() > st.limp + (limpers ? 0.25 : 0) && !isSB && pct < st.open + 0.25) return sized(openTo(), 'open');
        return call('limp');
      }
      return foldOrCheck();
    }

    // facing a raise
    const potOdds = toCall / (pot + toCall);
    const sizeSense = st.fear >= 1 ? 1 : st.fear < 0.5 ? 0.45 : 0.8;    // stations ignore raise size
    const shrink = clamp(Math.pow(2.6 / raiseLevel, sizeSense), 0.22, 0.95);
    const vill = villainProfile(game.seats[game.lastAggressor]);
    const loosen = clamp(Math.pow(vill.pfr / 0.17, 0.7), 0.8, 2.2);  // fight back vs. frequent raisers
    let callRange = st.defend * shrink * loosen + posAdj * 0.5;
    if (seat === game.bbSeat && potOdds < 0.36) callRange += 0.06 + (st.callsDown ? 0.1 : 0);
    const reRaise = game.streetRaises >= 2;
    const threeBet = (reRaise ? st.fourBet : st.threeBet) * (raiseLevel > 6 ? 0.6 : 1) * loosen;
    const deep = toCall > stack * 0.35;
    if (la.canRaise && pct < threeBet) {
      if (pct < 0.03 && random() < st.trapPre && !deep) return call('trap'); // flat AA/KK to trap
      if (deep || raiseLevel > 12) return shove('value');
      return sized(game.currentBet * pick(st.threeBetSize, random) * jitter(), 'value');
    }
    if (la.canRaise && !deep && raiseLevel < 6 && pct > callRange && pct < callRange + 0.15 && random() < st.lightThreeBet * (reRaise ? 0.3 : 1)) {
      return sized(game.currentBet * pick(st.threeBetSize, random), 'bluff');
    }
    if (la.canRaise && st.pfShove && !deep && raiseLevel < 5 && pct < 0.3 && random() < st.pfShove) return shove('bluff');
    if (deep) return pct < Math.max(threeBet * 1.6, st.callsDown ? 0.07 : 0.04) ? call() : foldOrCheck();
    if (pct < callRange) return call();
    return foldOrCheck();
  }

  // ======================= POSTFLOP =======================
  const iters = opts.iters ?? (nOpp <= 2 ? 900 : nOpp <= 4 ? 650 : 450);
  // each opponent's likely holdings from how they played preflop, scaled by what we've seen of them
  const ranges = live.filter((o) => o !== p).map((o) => {
    const v = villainProfile(o);
    if (o.seat === game.preflopAggressor) return clamp(v.pfr * 1.4, 0.12, 0.6);
    return o.voluntary ? clamp(v.vpip * 1.4, 0.3, 0.9) : 1;
  });
  const eqRaw = estimateEquity(p.hole, game.board, nOpp, iters, random, ranges);
  const eq = clamp(eqRaw + (random() - 0.5) * st.noise + tilt * 0.04, 0, 1);
  const outs = drawOuts(p.hole, game.board);
  const madeCat = evaluate([...p.hole, ...game.board]) >> 20;
  const boardCat = evaluate(game.board) >> 20;
  const madeHand = madeCat >= 1 && madeCat > boardCat; // pair or better that uses a hole card
  const fair = 1 / (nOpp + 1);
  const valueT = Math.pow(fair, 0.72 - st.margin);   // HU ≈ 0.61, 3-way ≈ 0.45
  const strongT = Math.pow(fair, 0.42 - st.margin);  // HU ≈ 0.75, 3-way ≈ 0.63
  const river = game.phase === 'river';
  const potAfterCall = pot + toCall;
  const betFrac = (frac, tag) => sized(game.currentBet + potAfterCall * frac, tag);
  // personality bet sizing: from its size menu, sometimes overbet / shove
  const betSize = (tag, strong) => {
    const r = random();
    if (strong && r < st.shove) return shove(tag);
    if ((strong || tag === 'bluff') && r < st.shove + st.overbet) return betFrac(1.2 + random() * 0.8, tag);
    return betFrac(pick(st.sizes, random) * jitter(), tag);
  };
  const raiseTo = (mult, tag) => sized(game.currentBet * mult * jitter() + (pot - game.currentBet) * 0.25, tag);
  const checkedThisStreet = p.lastAction === '过牌';
  const headsUp = nOpp === 1;

  if (free) {
    if (!la.canRaise) return check();
    if (eq > strongT) {
      const sp = river ? st.slowplay * 0.45 : st.slowplay;
      if (random() < sp) return check('slowplay');
      return betSize('value', true);
    }
    if (eq > valueT) return random() < st.betValue ? betSize('value', false) : check(st.slowplay > 0.3 ? 'slowplay' : 'check');
    const cbetSpot = game.phase === 'flop' && game.preflopAggressor === seat && game.streetRaises === 0;
    const barrelSpot = !cbetSpot && game.prevAggressor === seat;
    const multiway = headsUp ? 1 : nOpp === 2 ? 0.7 : 0.4;
    const air = madeHand || outs >= 8 ? 1 : st.airMult;
    if (cbetSpot && random() < st.cbet * multiway * air) return betSize(madeHand ? 'cbet' : 'bluff', false);
    if (barrelSpot && random() < st.barrel * multiway * air * (river ? 0.8 : 1)) return betSize(madeHand ? 'barrel' : 'bluff', false);
    if (outs >= 8 && random() < st.semiBluff) return betSize('semibluff', false);
    if (eq > fair * 1.15 && random() < st.betMedium) return betFrac(pick(st.sizes, random) * 0.8, 'thin');
    if ((headsUp || st.bluff > 0.3) && random() < st.bluff * (river ? 0.8 : 1) * multiway) return betSize('bluff', false);
    return check();
  }

  // ---------- facing a bet ----------
  const potOdds = toCall / potAfterCall;
  const pressure = Math.min(1.5, toCall / Math.max(pot - toCall, 1)); // bet size relative to the pot before it
  const raisedAgain = game.streetRaises >= 2;
  const villAggr = villainProfile(game.seats[game.lastAggressor]).aggr;
  const trust = clamp(0.3 / villAggr, 0.25, 1.2);
  // a bettor's range is stronger than his preflop range: discount equity by bet size / re-raises (scaled by fear)
  const eAdj = eq * (1 - (0.15 * pressure + (raisedAgain ? 0.1 : 0)) * Math.min(1, trust) * st.fear);
  const betRange = ((0.08 + (river ? 0.04 : 0)) * trust - (1 - Math.min(1, trust)) * 0.04) * st.fear;
  const drawEq = river ? 0 : Math.min(0.5, outs * (game.phase === 'flop' ? 0.04 : 0.022) + 0.04) + (outs >= 4 ? st.chase : 0);
  const commit = toCall > p.chips * 0.5 ? 0.05 * st.fear : 0;
  const crBoost = checkedThisStreet ? st.checkRaise : 0;

  if (eAdj > strongT) {
    if (raisedAgain && eAdj > 0.8) return st.raiseValue > 0.3 ? shove('value') : call('value');
    // trappers flat the flop with monsters and spring the trap later
    if (!checkedThisStreet && game.phase === 'flop' && random() < st.slowplay * 0.5) return call('slowplay');
    if (!raisedAgain && random() < Math.min(0.95, st.raiseValue + crBoost)) return raiseTo(pick([2.5, 3, 3.5], random) + (st.overbet > 0.15 ? random() : 0), checkedThisStreet ? 'checkraise' : 'value');
    return call('value');
  }
  if (eAdj > valueT && !raisedAgain && random() < st.raiseLight + crBoost * 0.35) {
    return raiseTo(2.6 + random() * 0.8, checkedThisStreet ? 'checkraise' : 'value');
  }
  // tight players give up without a strong hand when the pressure is big
  const bigBet = pressure >= 0.6 || raisedAgain;
  if (bigBet && st.foldBig && eAdj < valueT && random() < st.foldBig && !(outs >= 8 && drawEq >= potOdds)) return tagged({ type: 'fold' }, 'fold');
  if (eAdj >= potOdds + betRange + st.margin + commit) return call();
  if (outs >= 8 && Math.max(drawEq, eAdj) >= potOdds + commit) {
    if (la.canRaise && headsUp && !raisedAgain && random() < st.semiBluff * 0.25 + crBoost * 0.3) return raiseTo(2.8, checkedThisStreet ? 'checkraise' : 'semibluff');
    return call('draw');
  }
  // calling stations: any pair is good enough, and they peel with overcards
  if (st.callsDown && (madeHand || (outs >= 4 && !river)) && pressure <= (madeHand ? 1.25 : 0.6)) return call('station');
  if (st.callsDown && !river && pressure <= 0.4 && random() < st.float) return call('float');
  // float small bets heads-up (bluff-catch / take it away later)
  if (!river && headsUp && pressure <= 0.7 && random() < st.float) return call('float');
  // bluff-raises: maniacs any street, tricksters mostly on the river or as a check-raise
  if (la.canRaise && headsUp && !raisedAgain && pressure <= 0.8) {
    const br = st.bluffRaise * (river ? 1 : st.bluff > 0.3 ? 0.8 : 0.35) + (checkedThisStreet ? st.checkRaise * 0.08 : 0);
    if (random() < br) return raiseTo(2.6 + random(), checkedThisStreet ? 'checkraise' : 'bluff');
  }
  return tagged({ type: 'fold' }, 'fold');
}
