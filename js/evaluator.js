// Fast 5-7 card poker hand evaluator. Higher score = better hand.
// score = category << 20 | r1 << 16 | r2 << 12 | r3 << 8 | r4 << 4 | r5
// categories: 0 high card, 1 pair, 2 two pair, 3 trips, 4 straight, 5 flush,
//             6 full house, 7 quads, 8 straight flush
export const CATEGORY_NAMES_ZH = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
export const CATEGORY_NAMES_EN = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

function straightHigh(mask) {
  // mask has bit r set for rank r (2..14). Ace also counts as 1 (wheel).
  if (mask & (1 << 14)) mask |= 1 << 1;
  for (let h = 14; h >= 5; h--) {
    if (((mask >> (h - 4)) & 0x1f) === 0x1f) return h;
  }
  return 0;
}

function topRanks(mask, n, exclude = 0) {
  const out = [];
  for (let r = 14; r >= 2 && out.length < n; r--) {
    if ((mask & (1 << r)) && !(exclude & (1 << r))) out.push(r);
  }
  return out;
}

function pack(cat, ranks) {
  let s = cat;
  for (let i = 0; i < 5; i++) s = (s << 4) | (ranks[i] || 0);
  return s;
}

const counts = new Int8Array(15);
const suitMasks = new Int32Array(4);
const suitCounts = new Int8Array(4);

export function evaluate(cards) {
  counts.fill(0); suitMasks.fill(0); suitCounts.fill(0);
  let rankMask = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const r = (c >> 2) + 2, s = c & 3;
    counts[r]++;
    suitMasks[s] |= 1 << r;
    suitCounts[s]++;
    rankMask |= 1 << r;
  }
  let flushMask = 0;
  for (let s = 0; s < 4; s++) if (suitCounts[s] >= 5) flushMask = suitMasks[s];
  if (flushMask) {
    const sf = straightHigh(flushMask);
    if (sf) return pack(8, [sf]);
  }
  let quad = 0; const trips = []; const pairs = [];
  for (let r = 14; r >= 2; r--) {
    const n = counts[r];
    if (n === 4) quad = r;
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
  }
  if (quad) return pack(7, [quad, topRanks(rankMask, 1, 1 << quad)[0]]);
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const t = trips[0];
    const p = Math.max(trips[1] || 0, pairs[0] || 0);
    return pack(6, [t, p]);
  }
  if (flushMask) return pack(5, topRanks(flushMask, 5));
  const st = straightHigh(rankMask);
  if (st) return pack(4, [st]);
  if (trips.length) {
    const t = trips[0];
    return pack(3, [t, ...topRanks(rankMask, 2, 1 << t)]);
  }
  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    return pack(2, [p1, p2, ...topRanks(rankMask, 1, (1 << p1) | (1 << p2))]);
  }
  if (pairs.length === 1) {
    const p = pairs[0];
    return pack(1, [p, ...topRanks(rankMask, 3, 1 << p)]);
  }
  return pack(0, topRanks(rankMask, 5));
}

export const categoryOf = (score) => score >> 20;

const RANK_ZH = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10' };
const rz = (r) => RANK_ZH[r] || String(r);

export function describeScore(score, lang = 'zh') {
  const cat = score >> 20;
  const r = [(score >> 16) & 15, (score >> 12) & 15, (score >> 8) & 15, (score >> 4) & 15, score & 15];
  if (lang !== 'zh') return CATEGORY_NAMES_EN[cat];
  switch (cat) {
    case 8: return r[0] === 14 ? '皇家同花顺' : `同花顺（${rz(r[0])} 高）`;
    case 7: return `四条 ${rz(r[0])}`;
    case 6: return `葫芦（${rz(r[0])} 带 ${rz(r[1])}）`;
    case 5: return `同花（${rz(r[0])} 高）`;
    case 4: return `顺子（${rz(r[0])} 高）`;
    case 3: return `三条 ${rz(r[0])}`;
    case 2: return `两对 ${rz(r[0])} 和 ${rz(r[1])}`;
    case 1: return `一对 ${rz(r[0])}`;
    default: return `高牌 ${rz(r[0])}`;
  }
}
