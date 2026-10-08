// Bot behaviour statistics: node tools/botstats.mjs [hands=2000] [iters]
//   LINEUP="粉哥:maniac,Micheal:rock,Grok Bot:tricky,小龙:station"  (name:style, comma separated; default below)
//   BOT=/path/to/other/bot.js   (compare another AI implementation)
// Every bot keeps its own row so personalities can be compared side by side.
import { Game, STARTING_CHIPS } from '../js/engine.js';
import { evaluate } from '../js/evaluator.js';
const { botDecide } = await import(process.env.BOT || '../js/bot.js');

const HANDS = Number(process.argv[2] || 2000);
const ITERS = process.argv[3] ? Number(process.argv[3]) : undefined;
const LINEUP = (process.env.LINEUP || '粉哥:maniac,Micheal:rock,Grok Bot:tricky,小龙:station,阿杰:regular')
  .split(',').map((s) => s.split(':'));
const g = new Game({ sb: 500, bb: 1000 });
LINEUP.forEach(([name, style], i) => g.addPlayer(i, { id: 'b' + i, name, isBot: true, botStyle: style }));

const blank = () => ({
  hands: 0, vpip: 0, pfr: 0, dec: 0, fold: 0, check: 0, call: 0, raise: 0, foldFree: 0,
  tbOpp: 0, tb: 0, postBR: 0, postCall: 0, cbetSpots: 0, cbets: 0, fcbOpp: 0, fcb: 0,
  crOpp: 0, cr: 0, sawFlop: 0, wtsd: 0, wsd: 0, air: 0, strongFree: 0, strongCheck: 0,
  overbets: 0, sizes: [], net: 0, tilted: 0, shoves: 0, facePost: 0, foldPost: 0, bigPressure: 0, foldBigPressure: 0,
});
const S = new Map(LINEUP.map(([name, style]) => [name, { style, ...blank() }]));
const T = { hands: 0, showdowns: 0, flops: 0 };
const cat = (cards) => evaluate(cards) >> 20;
// "air" = hole cards add nothing: no pair or better made with a hole card (draws count as air)
const isAir = (hole, board) => { const c = cat([...hole, ...board]); return c === 0 || c <= cat(board); };
const isStrong = (hole, board) => { const c = cat([...hole, ...board]); return c >= 2 && c > cat(board); };
const t0 = Date.now();
for (let h = 0; h < HANDS; h++) {
  for (const p of g.seats) if (p && p.chips < STARTING_CHIPS / 4) g.rebuy(p.seat);
  const before = new Map(g.seats.filter(Boolean).map((p) => [p.seat, p.chips]));
  g.startHand();
  T.hands++;
  const vp = new Set(), pr = new Set(), checked = new Set();
  let flopCounted = false, street = 'preflop';
  for (const p of g.seats) if (p && p.inHand) { S.get(p.name).hands++; if ((p.tilt || 0) >= 0.3) S.get(p.name).tilted++; }
  while (g.phase !== 'handover') {
    if (g.runout) { g.continueRunout(); continue; }
    if (g.phase !== street) { street = g.phase; checked.clear(); }
    const seat = g.toAct, p = g.seats[seat], st = S.get(p.name);
    const la = g.legal(seat);
    const d = botDecide(g, seat, ITERS ? { iters: ITERS } : {});
    const target = d.type === 'allin' ? la.maxRaiseTo : d.amount;
    const type = d.type === 'allin' ? (la.maxRaiseTo <= g.currentBet ? 'call' : 'raise') : d.type === 'bet' ? 'raise' : (d.type === 'call' && la.canCheck ? 'check' : d.type);
    st.dec++; st[type]++;
    if (type === 'fold' && la.canCheck) st.foldFree++;
    const pre = g.phase === 'preflop';
    if (pre) {
      if (type === 'call' || type === 'raise') vp.add(seat);
      if (type === 'raise') pr.add(seat);
      if (g.streetRaises === 1 && la.canRaise) { st.tbOpp++; if (type === 'raise') st.tb++; }
    } else {
      const potBefore = g.potTotal();
      if (type === 'raise') { st.postBR++; if (isAir(p.hole, g.board)) st.air++; const frac = (target - g.currentBet) / Math.max(1, potBefore + la.toCall); if (d.type === 'allin') st.shoves++; else { st.sizes.push(frac); if (frac >= 0.99) st.overbets++; } }
      if (type === 'call') st.postCall++;
      if (la.canCheck && la.canRaise && isStrong(p.hole, g.board)) { st.strongFree++; if (type === 'check') st.strongCheck++; }
      if (g.phase === 'flop' && la.canCheck && g.preflopAggressor === seat && g.streetRaises === 0) { st.cbetSpots++; if (type === 'raise') st.cbets++; }
      if (g.phase === 'flop' && la.toCall > 0 && g.streetRaises === 1 && g.lastAggressor === g.preflopAggressor && g.preflopAggressor !== seat) { st.fcbOpp++; if (type === 'fold') st.fcb++; }
      if (la.toCall > 0 && checked.has(seat) && la.canRaise) { st.crOpp++; if (type === 'raise') st.cr++; }
      if (la.toCall > 0) {
        st.facePost++; if (type === 'fold') st.foldPost++;
        if (la.toCall >= 0.75 * Math.max(1, potBefore - la.toCall)) { st.bigPressure++; if (type === 'fold') st.foldBigPressure++; }
      }
      if (type === 'check') checked.add(seat);
    }
    const r = g.act(seat, d);
    if (!r.ok) throw new Error('illegal bot action ' + JSON.stringify(d) + ' ' + r.error);
    if (!flopCounted && g.board.length >= 3) { flopCounted = true; for (const o of g.liveSeats()) S.get(o.name).sawFlop++; }
  }
  if (flopCounted) T.flops++;
  if (g.result.showdown) {
    T.showdowns++;
    const winners = new Set(g.result.winners.map((w) => w.seat));
    for (const o of g.seats) if (o && o.inHand && !o.folded) { S.get(o.name).wtsd++; if (winners.has(o.seat)) S.get(o.name).wsd++; }
  }
  for (const s of vp) S.get(g.seats[s].name).vpip++;
  for (const s of pr) S.get(g.seats[s].name).pfr++;
  for (const p of g.seats) if (p && before.has(p.seat)) S.get(p.name).net += p.chips - before.get(p.seat);
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
const rows = [...S.entries()].map(([name, s]) => {
  const q = (f) => { if (!s.sizes.length) return 0; const a = [...s.sizes].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(f * a.length))]; };
  return {
    bot: name, style: s.style, VPIP: pct(s.vpip, s.hands), PFR: pct(s.pfr, s.hands), '3bet': pct(s.tb, s.tbOpp),
    AF: s.postCall ? (s.postBR / s.postCall).toFixed(2) : '∞',
    'call%': pct(s.call, s.dec), 'raise%': pct(s.raise, s.dec), 'fold%': pct(s.fold, s.dec),
    'cbet': pct(s.cbets, s.cbetSpots), 'foldToCbet': pct(s.fcb, s.fcbOpp), 'foldVsBigBet': pct(s.foldBigPressure, s.bigPressure),
    'chkRaise': pct(s.cr, s.crOpp), 'slowplay': pct(s.strongCheck, s.strongFree),
    WTSD: pct(s.wtsd, s.sawFlop), 'W$SD': pct(s.wsd, s.wtsd), 'bluff%': pct(s.air, s.postBR),
    'betSize p10/50/90': `${Math.round(q(0.1) * 100)}/${Math.round(q(0.5) * 100)}/${Math.round(q(0.9) * 100)}%`, 'overbet': pct(s.overbets, s.postBR), 'allin': pct(s.shoves, s.postBR),
    'tilted': pct(s.tilted, s.hands), 'bb/100': ((s.net / g.bb) / Math.max(1, s.hands) * 100).toFixed(1), 'freeFold': s.foldFree,
  };
});
const cols = Object.keys(rows[0]);
const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => [...String(r[c])].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0))));
const padTo = (s, n) => { s = String(s); const len = [...s].reduce((k, ch) => k + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, n - len)); };
console.log(cols.map((c, i) => padTo(c, w[i])).join(' | '));
console.log(w.map((n) => '-'.repeat(n)).join('-|-'));
for (const r of rows) console.log(cols.map((c, i) => padTo(r[c], w[i])).join(' | '));
console.log(`hands=${T.hands} players=${LINEUP.length} flop seen ${pct(T.flops, T.hands)}, showdown ${pct(T.showdowns, T.hands)}, chips conserved ✔, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (process.env.JSON) console.log(JSON.stringify(rows));
