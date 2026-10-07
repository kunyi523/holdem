// Simple but reasonable poker AI: Monte-Carlo equity + pot odds + personality + randomness.
import { evaluate } from './evaluator.js';

export const BOT_STYLES = {
  loose: { tight: -0.05, aggr: 0.65, bluff: 0.10 },    // 粉哥: 松凶
  tight: { tight: 0.08, aggr: 0.45, bluff: 0.03 },     // Micheal: 紧
  balanced: { tight: 0.0, aggr: 0.55, bluff: 0.06 },   // Grok Bot: 平衡
};

// Equity of `hole` vs `numOpp` random hands given the current board.
export function estimateEquity(hole, board, numOpp, iters = 300, random = Math.random) {
  const used = new Set([...hole, ...board]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const need = numOpp * 2 + (5 - board.length);
  let score = 0;
  const fullBoard = new Array(5);
  const mine = new Array(7);
  const opp = new Array(7);
  for (let it = 0; it < iters; it++) {
    // partial Fisher-Yates
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(random() * (deck.length - i));
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    let k = 0;
    for (let i = 0; i < 5; i++) fullBoard[i] = i < board.length ? board[i] : deck[k++];
    mine[0] = hole[0]; mine[1] = hole[1];
    for (let i = 0; i < 5; i++) { mine[i + 2] = fullBoard[i]; opp[i + 2] = fullBoard[i]; }
    const my = evaluate(mine);
    let best = 0, ties = 0, lost = false;
    for (let o = 0; o < numOpp; o++) {
      opp[0] = deck[k++]; opp[1] = deck[k++];
      const s = evaluate(opp);
      if (s > my) { lost = true; break; }
      if (s === my) ties++;
      if (s > best) best = s;
    }
    if (!lost) score += ties ? 1 / (ties + 1) : 1;
  }
  return score / iters;
}

function roundChips(x, unit) {
  return Math.max(unit, Math.round(x / unit) * unit);
}

export function botDecide(game, seat, opts = {}) {
  const random = opts.random || Math.random;
  const p = game.seats[seat];
  const la = game.legal(seat);
  if (!la) return null;
  const style = BOT_STYLES[p.botStyle] || BOT_STYLES.balanced;
  const nOpp = Math.max(1, game.liveSeats().length - 1);
  const iters = opts.iters ?? (nOpp <= 2 ? 1000 : nOpp <= 4 ? 700 : 500);
  const eq = estimateEquity(p.hole, game.board, nOpp, iters, random);
  const pot = game.potTotal();
  const toCall = la.toCall;
  const fair = 1 / (nOpp + 1);
  const valueT = Math.pow(fair, 0.69 - style.tight);
  const strongT = Math.pow(fair, 0.415 - style.tight * 0.6);
  const e = eq + (random() - 0.5) * 0.08;
  const r = random();
  const unit = game.sb >= 100 ? 100 : 1;
  const preflop = game.phase === 'preflop';

  const raiseTo = (frac) => {
    let target;
    if (preflop) target = game.currentBet * (2.5 + random() * 1.0) + (game.liveSeats().length > 3 ? game.bb : 0);
    else target = game.currentBet + (pot + toCall) * frac;
    target = roundChips(target, unit);
    target = Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, target));
    // if raising most of our stack anyway, just shove
    if (target >= la.maxRaiseTo * 0.8) return { type: 'allin' };
    return { type: 'raise', amount: target };
  };

  if (toCall === 0) {
    if (la.canRaise && e > strongT && r < 0.85) return raiseTo(0.6 + random() * 0.4);
    if (la.canRaise && e > valueT && r < style.aggr) return raiseTo(0.45 + random() * 0.25);
    if (la.canRaise && !preflop && r < style.bluff) return raiseTo(0.4 + random() * 0.2);
    return { type: 'check' };
  }

  const potOdds = toCall / (pot + toCall);
  // facing a big bet, a random-hand equity overestimates our chances: discount it
  const pressure = Math.min(1, toCall / Math.max(pot, 1));
  const eAdj = e * (1 - 0.18 * pressure);
  if (la.canRaise && e > strongT && r < style.aggr + 0.2) return raiseTo(0.65 + random() * 0.35);
  if (la.canRaise && e > valueT && pressure < 0.6 && r < style.aggr * 0.35) return raiseTo(0.5 + random() * 0.3);
  const commit = toCall >= (p.chips + p.bet) * 0.4 ? 0.06 : 0;
  if (eAdj >= potOdds * (1 + style.tight) + commit) return { type: 'call' };
  // cheap call with small chance (floating)
  if (toCall <= game.bb && pot > 4 * toCall && r < 0.25) return { type: 'call' };
  if (la.canRaise && !preflop && game.phase !== 'river' && r < style.bluff * 0.4) return raiseTo(0.6);
  return { type: 'fold' };
}
