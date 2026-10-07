// Bot behaviour statistics: node tools/botstats.mjs [hands=1000] [iters]
// Runs a 6-max table of bots (2 of each style) and reports per-style VPIP / PFR / action mix.
import { Game, STARTING_CHIPS } from '../js/engine.js';
const { botDecide } = await import(process.env.BOT || '../js/bot.js');

const HANDS = Number(process.argv[2] || 1000);
const ITERS = process.argv[3] ? Number(process.argv[3]) : undefined;
const bots = [
  ['粉哥', 'loose'], ['Micheal', 'tight'], ['Grok Bot', 'balanced'],
  ['阿杰', 'loose'], ['Lucy', 'tight'], ['小龙', 'balanced'],
];
const g = new Game({ sb: 500, bb: 1000 });
bots.forEach(([name, style], i) => g.addPlayer(i, { id: 'b' + i, name, isBot: true, botStyle: style }));
const blank = () => ({ hands: 0, vpip: 0, pfr: 0, fold: 0, check: 0, call: 0, raise: 0, foldFree: 0, pfFold: 0, pfDecisions: 0, postFold: 0, postDecisions: 0, facingBet: 0, foldFacingBet: 0, postFacing: 0, postFoldFacing: 0, cbetSpots: 0, cbets: 0, vsRaise: 0, foldVsRaise: 0, sawFlop: 0, wtsd: 0 });
const S = { loose: blank(), tight: blank(), balanced: blank() };
const T = { hands: 0, showdowns: 0, flops: 0, uncontestedPreflop: 0 };
let expected = g.totalChips();
const t0 = Date.now();
for (let h = 0; h < HANDS; h++) {
  for (const p of g.seats) if (p && p.chips < STARTING_CHIPS / 4 && g.rebuy(p.seat)) expected += STARTING_CHIPS - 0; // top up short/busted stacks
  expected = g.totalChips();
  g.startHand();
  T.hands++;
  const vp = new Set(), pr = new Set();
  for (const p of g.seats) if (p && p.inHand) S[p.botStyle].hands++;
  let sawFlop = false;
  let pfAgg = -1, flopCounted = false;
  while (g.phase !== 'handover') {
    if (g.runout) { g.continueRunout(); continue; }
    const seat = g.toAct, p = g.seats[seat], st = S[p.botStyle];
    const la = g.legal(seat);
    const d = botDecide(g, seat, ITERS ? { iters: ITERS } : {});
    const type = d.type === 'allin' ? (la.toCall >= p.chips ? 'call' : 'raise') : d.type === 'bet' ? 'raise' : d.type;
    st[type === 'check' ? 'check' : type]++;
    if (type === 'fold' && la.canCheck) st.foldFree++;
    if (la.toCall > 0) { st.facingBet++; if (type === 'fold') st.foldFacingBet++; }
    if (la.toCall > 0 && g.phase !== 'preflop') { st.postFacing++; if (type === 'fold') st.postFoldFacing++; }
    if (g.phase === 'flop' && la.canCheck && pfAgg === seat && !g.seats.some((o) => o && o.bet > 0)) { st.cbetSpots++; if (type === 'raise') st.cbets++; }
    if (g.phase === 'preflop') {
      st.pfDecisions++;
      if (g.currentBet > g.bb) { st.vsRaise++; if (type === 'fold') st.foldVsRaise++; }
      if (type === 'fold') st.pfFold++;
      if (type === 'call' || type === 'raise') vp.add(seat);
      if (type === 'raise') pr.add(seat);
    } else { st.postDecisions++; if (type === 'fold') st.postFold++; sawFlop = true; }
    const phaseBefore = g.phase;
    const r = g.act(seat, d);
    if (phaseBefore === 'preflop' && type === 'raise') pfAgg = seat;
    if (!flopCounted && g.phase !== 'preflop' && g.board.length >= 3) { flopCounted = true; for (const o of g.liveSeats()) S[o.botStyle].sawFlop++; }
    if (!r.ok) throw new Error('illegal bot action ' + JSON.stringify(d) + ' ' + r.error);
    if (g.totalChips() !== expected) throw new Error('chip conservation broken');
  }
  if (g.board.length >= 3 || sawFlop) T.flops++;
  if (g.result.showdown) { T.showdowns++; for (const o of g.seats) if (o && o.inHand && !o.folded) S[o.botStyle].wtsd++; }
  for (const s of vp) S[g.seats[s] ? g.seats[s].botStyle : 'balanced'].vpip++;
  for (const s of pr) S[g.seats[s] ? g.seats[s].botStyle : 'balanced'].pfr++;
  if (g.totalChips() !== expected) throw new Error('chip conservation broken (end of hand)');
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
const rows = Object.entries(S).map(([style, s]) => {
  const n = s.fold + s.check + s.call + s.raise;
  return {
    style, hands: s.hands, VPIP: pct(s.vpip, s.hands), PFR: pct(s.pfr, s.hands),
    'fold%': pct(s.fold, n), 'check%': pct(s.check, n), 'call%': pct(s.call, n), 'raise%': pct(s.raise, n),
    'preflop fold%': pct(s.pfFold, s.pfDecisions), 'postflop fold%': pct(s.postFold, s.postDecisions),
    'preflop fold vs raise%': pct(s.foldVsRaise, s.vsRaise), 'postflop fold vs bet%': pct(s.postFoldFacing, s.postFacing),
    'flop c-bet%': pct(s.cbets, s.cbetSpots), 'WTSD%': pct(s.wtsd, s.sawFlop), 'fold when check free': s.foldFree,
  };
});
console.table(rows);
console.log(`hands=${T.hands} flop seen in ${pct(T.flops, T.hands)} of hands, showdown ${pct(T.showdowns, T.hands)}, chips conserved ✔, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
