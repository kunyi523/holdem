// Hand helpers for the UI: best five cards (showdown highlight) and the hero's hand-strength label.
import { evaluate, describeScore } from './evaluator.js?v=6';
import { handPercentile, estimateEquity } from './bot.js?v=6';
import { RANKS } from './cards.js?v=6';

// Best 5-card subset of 5–7 cards. Returns { score, cards } (cards = the five that make the hand).
export function bestFive(cards) {
  const n = cards.length;
  if (n <= 5) return { score: evaluate(cards), cards: [...cards] };
  let best = -1, bestCards = null;
  const pick = new Array(5);
  const rec = (start, k) => {
    if (k === 5) {
      const s = evaluate(pick);
      if (s > best) { best = s; bestCards = [...pick]; }
      return;
    }
    for (let i = start; i <= n - (5 - k); i++) { pick[k] = cards[i]; rec(i + 1, k + 1); }
  };
  rec(0, 0);
  return { score: best, cards: bestCards };
}

// Draws that use at least one hole card (flop / turn only).
export function drawInfo(hole, board) {
  const out = { flush: false, oesd: false, gutshot: false };
  if (board.length < 3 || board.length >= 5) return out;
  const all = [...hole, ...board];
  for (let s = 0; s < 4; s++) {
    const n = all.filter((c) => (c & 3) === s).length;
    if (n === 4 && hole.some((c) => (c & 3) === s)) out.flush = true;
  }
  const bit = (r) => (r === 14 ? (1 << 14) | 2 : 1 << r);
  const mask = (cs) => cs.reduce((acc, c) => acc | bit((c >> 2) + 2), 0);
  const straight = (mm, hm) => { for (let lo = 1; lo <= 10; lo++) { const w = 0x1f << lo; if ((mm & w) === w && (w & hm)) return true; } return false; };
  const m = mask(all), hm = mask(hole);
  if (straight(m, hm)) return { flush: out.flush, oesd: false, gutshot: false }; // already a straight
  let completing = 0;
  for (let r = 2; r <= 14; r++) if (!(m & (1 << r)) && straight(m | bit(r), hm)) completing++;
  if (completing >= 2) out.oesd = true; else if (completing === 1) out.gutshot = true;
  if (out.oesd) out.gutshot = false;
  return out;
}

const rankName = (c) => { const r = RANKS[c >> 2]; return r === 'T' ? '10' : r; };

// { label, sub, tier } — tier 0..4 for colouring (0 weak … 4 monster)
export function heroHandInfo(hole, board) {
  if (!hole || hole.length < 2) return null;
  if (board.length < 3) {
    const [a, b] = hole;
    const pct = handPercentile(hole);
    const hi = (a >> 2) >= (b >> 2) ? a : b, lo = hi === a ? b : a;
    const pair = (a >> 2) === (b >> 2);
    const suited = (a & 3) === (b & 3);
    const name = pair ? `口袋对子 ${rankName(a)}${rankName(b)}` : `${rankName(hi)}${rankName(lo)} ${suited ? '同花' : '杂色'}`;
    const tier = pct < 0.06 ? 4 : pct < 0.16 ? 3 : pct < 0.35 ? 2 : pct < 0.6 ? 1 : 0;
    const sub = ['弱牌', '一般', '可以玩', '强牌', '顶级起手牌'][tier];
    return { label: name, sub, tier };
  }
  const all = [...hole, ...board];
  const score = evaluate(all);
  const cat = score >> 20;
  const boardCat = evaluate(board) >> 20;
  let label = describeScore(score);
  if (cat >= 1 && cat <= boardCat && cat < 4) label += '（公共牌）';
  const d = drawInfo(hole, board);
  const draws = [];
  if (d.flush && cat < 5) draws.push('同花听牌');
  if (d.oesd && cat < 4) draws.push('两头顺听牌');
  if (d.gutshot && cat < 4) draws.push('卡顺听牌');
  const made = cat > boardCat || cat >= 4 ? cat : 0;
  let tier = made >= 4 ? 4 : made === 3 ? 4 : made === 2 ? 3 : made === 1 ? 2 : draws.length ? 1 : 0;
  if (made === 1) { // top pair+ vs weaker pairs
    const pairRank = (score >> 16) & 15;
    const topBoard = Math.max(...board.map((c) => (c >> 2) + 2));
    if (pairRank < topBoard) tier = draws.length ? 2 : 1;
    else if (draws.length) tier = 3;
  }
  return { label, sub: draws.join(' · '), tier };
}

// Rough equity vs `nOpp` random hands (for the strength meter).
export function quickEquity(hole, board, nOpp, iters = 400) {
  return estimateEquity(hole, board, Math.max(1, nOpp), iters);
}
