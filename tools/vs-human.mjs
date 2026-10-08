// How do bots react to an active "human" style player? node tools/vs-human.mjs [hands=1000]
// Seat 0 = scripted human: opens 3x preflop with any hand when unraised (calls raises), bets ~60% pot
// whenever checked to postflop, calls bets. 5 bots in the other seats. Measures how often bots fold vs him.
import { Game, STARTING_CHIPS } from '../js/engine.js';
const { botDecide } = await import(process.env.BOT || '../js/bot.js');
const HANDS = Number(process.argv[2] || 1000);
const g = new Game({ sb: 500, bb: 1000 });
g.addPlayer(0, { id: 'h', name: 'Human' });
[['粉哥', 'maniac'], ['Micheal', 'rock'], ['Grok Bot', 'tricky'], ['小龙', 'station'], ['阿杰', 'regular']].forEach(([n, s], i) => g.addPlayer(i + 1, { id: 'b' + i, name: n, isBot: true, botStyle: s }));
const S = {};
const st = (k) => (S[k] = S[k] || { pfVsRaise: 0, pfFold: 0, postVsBet: 0, postFold: 0, free: 0, freeFold: 0 });
let humanWon = 0, humanHands = 0, uncontested = 0;
for (let h = 0; h < HANDS; h++) {
  for (const p of g.seats) if (p && p.chips < STARTING_CHIPS / 4) g.rebuy(p.seat);
  g.startHand();
  humanHands++;
  let lastBettor = -1;
  while (g.phase !== 'handover') {
    if (g.runout) { g.continueRunout(); continue; }
    const seat = g.toAct, p = g.seats[seat], la = g.legal(seat);
    let d;
    if (seat === 0) {
      if (g.phase === 'preflop') d = g.currentBet <= g.bb && la.canRaise ? { type: 'raise', amount: 3000 } : { type: 'call' };
      else d = la.canCheck && la.canRaise ? { type: 'raise', amount: Math.max(la.minRaiseTo, Math.round(g.potTotal() * 0.6 / 100) * 100) } : { type: 'call' };
    } else {
      d = botDecide(g, seat);
      const s = st(p.botStyle);
      const facingHuman = lastBettor === 0 && la.toCall > 0;
      if (facingHuman && g.phase === 'preflop') { s.pfVsRaise++; if (d.type === 'fold') s.pfFold++; }
      if (facingHuman && g.phase !== 'preflop') { s.postVsBet++; if (d.type === 'fold') s.postFold++; }
      if (la.canCheck) { s.free++; if (d.type === 'fold') s.freeFold++; }
    }
    const before = g.currentBet;
    const r = g.act(seat, d);
    if (!r.ok) throw new Error(r.error);
    if (g.currentBet > before) lastBettor = seat;
    if (g.phase !== 'preflop' && g.currentBet === 0) lastBettor = -1;
  }
  if (g.result.winners.some((w) => w.seat === 0)) humanWon++;
  if (!g.result.showdown && g.result.winners[0].seat === 0) uncontested++;
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
console.table(Object.entries(S).map(([k, s]) => ({ style: k, 'fold vs human preflop raise': pct(s.pfFold, s.pfVsRaise), 'fold vs human postflop bet': pct(s.postFold, s.postVsBet), 'fold when check free': s.freeFold })));
console.log(`human (raises every hand, bets every street) won ${pct(humanWon, humanHands)} of hands, ${pct(uncontested, humanHands)} uncontested (everyone folded)`);
