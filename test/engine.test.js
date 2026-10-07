import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, STARTING_CHIPS } from '../js/engine.js';
import { parseCards, seededRandInt } from '../js/cards.js';
import { botDecide, BOT_STYLES } from '../js/bot.js';

function mkGame(stacks, opts = {}) {
  const g = new Game({ sb: 500, bb: 1000, randInt: seededRandInt(opts.seed ?? 1), ...opts });
  stacks.forEach((c, i) => { if (c != null) g.addPlayer(i, { id: 'p' + i, name: 'P' + i, chips: c }); });
  return g;
}
// Force specific hole cards / board after startHand (deck is popped from the end)
function rig(g, holes, board) {
  const used = new Set();
  holes.forEach((h, seat) => { if (h) { g.seats[seat].hole = parseCards(h); parseCards(h).forEach((c) => used.add(c)); } });
  const b = parseCards(board); b.forEach((c) => used.add(c));
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  // pop order: burn, f1, f2, f3, burn, turn, burn, river
  const order = [rest[0], b[0], b[1], b[2], rest[1], b[3], rest[2], b[4]];
  g.deck = [...rest.slice(3), ...order.reverse()];
}
const act = (g, type, amount) => {
  const r = g.act(g.toAct, { type, amount });
  assert.ok(r.ok, `${type} ${amount ?? ''} failed: ${r.error}`);
};

test('heads-up: button posts small blind and acts first preflop, last postflop', () => {
  const g = mkGame([10000, 10000]);
  g.startHand();
  assert.equal(g.sbSeat, g.button);
  assert.equal(g.toAct, g.button);
  act(g, 'call');
  assert.equal(g.toAct, g.bbSeat); // BB option
  assert.equal(g.legal(g.bbSeat).canCheck, true);
  act(g, 'check');
  assert.equal(g.phase, 'flop');
  assert.equal(g.toAct, g.bbSeat); // BB acts first postflop
});

test('3-handed blinds and first-to-act', () => {
  const g = mkGame([10000, 10000, 10000]);
  g.startHand();
  assert.equal(g.button, 0);
  assert.equal(g.sbSeat, 1);
  assert.equal(g.bbSeat, 2);
  assert.equal(g.toAct, 0);
  assert.equal(g.seats[1].bet, 500);
  assert.equal(g.seats[2].bet, 1000);
  g.handNo; // second hand: button rotates
  act(g, 'fold'); act(g, 'fold');
  assert.equal(g.phase, 'handover');
  assert.equal(g.seats[2].chips, 10500);
  g.startHand();
  assert.equal(g.button, 1);
});

test('min-raise rules', () => {
  const g = mkGame([50000, 50000, 50000]);
  g.startHand();
  let la = g.legal(g.toAct);
  assert.equal(la.minRaiseTo, 2000);
  assert.equal(g.act(g.toAct, { type: 'raise', amount: 1500 }).ok, false);
  act(g, 'raise', 4000); // raise of 3000
  la = g.legal(g.toAct);
  assert.equal(la.minRaiseTo, 7000);
  assert.equal(g.act(g.toAct, { type: 'raise', amount: 6000 }).ok, false);
  act(g, 'raise', 7000);
  la = g.legal(g.toAct);
  assert.equal(la.minRaiseTo, 10000);
});

test('incomplete all-in raise does not reopen betting for players who already acted', () => {
  const g = mkGame([20000, 20000, 4500]); // seat 2 is BB with 4500 total
  g.startHand(); // button 0, sb 1, bb 2
  act(g, 'raise', 3000); // seat 0 raises to 3000
  act(g, 'call');        // seat 1 calls 3000
  act(g, 'allin');       // seat 2 all-in to 4500 (raise of 1500 < min raise 2000)
  assert.equal(g.toAct, 0);
  const la = g.legal(0);
  assert.equal(la.toCall, 1500);
  assert.equal(la.canRaise, false);
  act(g, 'call');
  assert.equal(g.legal(1).canRaise, false);
  act(g, 'call');
  assert.equal(g.phase, 'flop');
});

test('side pots awarded correctly at showdown', () => {
  const g = mkGame([5000, 20000, 20000]);
  g.startHand(); // button 0 (5000), sb 1, bb 2
  rig(g, ['As Ah', 'Ks Kh', 'Qs Qh'], '2c 7d 9h Jc 3s');
  act(g, 'allin');      // seat 0: 5000
  act(g, 'raise', 12000); // seat 1
  act(g, 'call');       // seat 2
  // flop: seats 1 and 2 still have chips
  assert.equal(g.phase, 'flop');
  act(g, 'check'); act(g, 'check');
  act(g, 'check'); act(g, 'check');
  act(g, 'check'); act(g, 'check');
  assert.equal(g.phase, 'handover');
  assert.equal(g.seats[0].chips, 15000); // main pot 3 x 5000
  assert.equal(g.seats[1].chips, 8000 + 14000); // side pot 2 x 7000
  assert.equal(g.seats[2].chips, 8000);
  assert.equal(g.totalChips(), 45000);
});

test('split pot (board plays both) returns chips evenly', () => {
  const g = mkGame([10001, 10000, 10000]);
  g.startHand(); // button 0, sb 1, bb 2
  rig(g, ['2c 3d', 'Ah Kd', 'As Kc'], 'Qs Jh Td 4c 5c');
  act(g, 'fold');
  act(g, 'raise', 2501); // seat 1 total 2501
  act(g, 'call');        // seat 2
  for (let i = 0; i < 6; i++) act(g, 'check');
  assert.equal(g.phase, 'handover');
  // pot 5002 split -> 2501 each
  assert.equal(g.seats[1].chips, 10000);
  assert.equal(g.seats[2].chips, 10000);
});

test('odd chip assignment (split of an odd pot goes to first seat left of button)', () => {
  const g = mkGame([10000, 10000, 10000, 10000], { sb: 333, bb: 1000 });
  g.startHand(); // button 0, sb 1, bb 2, utg 3
  rig(g, ['2c 3d', '7c 8c', 'As Kc', 'Ah Kd'], 'Qs Jh Td 4c 5h');
  act(g, 'call');  // seat 3: 1000
  act(g, 'fold');  // seat 0
  act(g, 'fold');  // seat 1 (sb 333 dead)
  act(g, 'check'); // seat 2 BB
  for (let i = 0; i < 6; i++) act(g, 'check');
  assert.equal(g.phase, 'handover');
  // pot 2333 -> seat 2 (closer to button's left) gets the odd chip
  assert.equal(g.seats[2].chips, 10000 - 1000 + 1167);
  assert.equal(g.seats[3].chips, 10000 - 1000 + 1166);
  assert.equal(g.totalChips(), 40000);
});

test('short blinds all-in and runout', () => {
  const g = mkGame([300, 700]);
  g.startHand(); // button 0 = SB posts 300 all-in, BB posts 700... wait BB is seat 1 posting min(1000,700)
  assert.equal(g.seats[0].allIn, true);
  assert.equal(g.seats[1].allIn, true);
  assert.equal(g.runout, true);
  g.finishRunout();
  assert.equal(g.phase, 'handover');
  assert.equal(g.totalChips(), 1000);
});

test('removing a player mid-hand folds them and keeps chips in pot', () => {
  const g = mkGame([10000, 10000, 10000]);
  g.startHand();
  act(g, 'call'); // seat 0
  g.removePlayer(2); // BB leaves
  assert.equal(g.seats[2].folded, true);
  act(g, 'call'); // seat 1 completes
  assert.equal(g.phase, 'flop');
  while (g.isBetting()) act(g, 'check');
  assert.equal(g.seats[2], null);
});

test('rebuy restores busted player to starting chips', () => {
  const g = mkGame([1000, 10000]);
  g.startHand();
  rig(g, ['2c 3d', 'Ah Ad'], 'As Kh 9d 7c 4d');
  act(g, 'allin'); // all-in for exactly the big blind: BB has nothing left to decide
  if (g.toAct >= 0) act(g, 'call');
  g.finishRunout();
  assert.equal(g.seats[0].chips, 0);
  assert.equal(g.canStart(), false);
  assert.ok(g.rebuy(0));
  assert.equal(g.seats[0].chips, STARTING_CHIPS);
  assert.ok(g.canStart());
});

test('view() only reveals hole cards to their owner until showdown', () => {
  const g = mkGame([10000, 10000, 10000]);
  g.startHand();
  const v1 = g.view(1);
  assert.deepEqual(v1.seats[1].cards, g.seats[1].hole);
  assert.equal(v1.seats[0].cards, null);
  assert.equal(v1.seats[2].cards, null);
  assert.equal(JSON.stringify(g.view(-1)).includes('"cards":['), false);
  assert.equal(g.view(0).legal !== null, true); // seat 0 (button, 3-handed) acts first
  assert.equal(g.view(1).legal, null);
  // play to showdown: all live hands get revealed
  while (g.isBetting()) { const la = g.legal(g.toAct); act(g, la.canCheck ? 'check' : 'call'); }
  assert.equal(g.result.showdown, true);
  const v = g.view(-1);
  assert.ok(v.seats.filter(Boolean).every((s) => s.cards && s.cards.length === 2));
});

test('fuzz: 3000 random hands with random legal actions conserve chips', () => {
  const rnd = seededRandInt(42);
  const R = rnd.random;
  for (let table = 0; table < 30; table++) {
    const n = 2 + Math.floor(R() * 7);
    const stacks = Array.from({ length: 8 }, (_, i) => (i < n ? 500 + Math.floor(R() * 30000) : null));
    const g = mkGame(stacks, { seed: table + 7 });
    const total = g.totalChips();
    for (let h = 0; h < 100; h++) {
      if (!g.canStart()) { g.seats.forEach((p) => p && p.chips === 0 && g.rebuy(p.seat, 5000)); }
      const t0 = g.totalChips();
      if (!g.startHand()) break;
      let guard = 0;
      while (g.phase !== 'handover') {
        assert.ok(guard++ < 500, 'hand did not terminate');
        if (g.runout) { g.continueRunout(); continue; }
        const la = g.legal(g.toAct);
        assert.ok(la, `no legal actions in phase ${g.phase}`);
        const x = R();
        let r;
        if (x < 0.15) r = g.act(g.toAct, { type: 'fold' });
        else if (x < 0.55) r = g.act(g.toAct, { type: la.canCheck ? 'check' : 'call' });
        else if (x < 0.9 && la.canRaise) r = g.act(g.toAct, { type: 'raise', amount: la.minRaiseTo + Math.floor(R() * (la.maxRaiseTo - la.minRaiseTo + 1)) });
        else if (la.canRaise) r = g.act(g.toAct, { type: 'allin' });
        else r = g.act(g.toAct, { type: la.canCheck ? 'check' : 'call' });
        assert.ok(r.ok, r.error);
        assert.equal(g.totalChips(), t0);
        assert.ok(g.seats.every((p) => !p || p.chips >= 0));
      }
      assert.equal(g.totalChips(), t0);
      void total;
    }
  }
});

test('smoke: 200 bot-vs-bot hands, total chips constant', () => {
  const g = new Game({ sb: 500, bb: 1000 }); // real crypto shuffle
  const names = ['粉哥', 'Micheal', 'Grok Bot', '小龙', '阿杰', 'Lucy'];
  const styles = ['loose', 'tight', 'balanced', 'balanced', 'loose', 'tight'];
  names.forEach((name, i) => g.addPlayer(i, { id: 'b' + i, name, isBot: true, botStyle: styles[i] }));
  let expected = g.totalChips();
  assert.equal(expected, 6 * STARTING_CHIPS);
  const stats = { hands: 0, folds: 0, calls: 0, raises: 0, checks: 0, showdowns: 0 };
  for (let h = 0; h < 200; h++) {
    if (!g.canStart()) {
      for (const p of g.seats) if (p && p.chips === 0 && g.rebuy(p.seat)) expected += STARTING_CHIPS;
    }
    assert.ok(g.startHand());
    stats.hands++;
    let guard = 0;
    while (g.phase !== 'handover') {
      assert.ok(guard++ < 500);
      if (g.runout) { g.continueRunout(); continue; }
      const seat = g.toAct;
      const d = botDecide(g, seat, { iters: 120 });
      const r = g.act(seat, d);
      assert.ok(r.ok, `${JSON.stringify(d)} -> ${r.error}`);
      stats[d.type === 'allin' || d.type === 'raise' ? 'raises' : d.type + 's']++;
      assert.equal(g.totalChips(), expected);
    }
    if (g.result.showdown) stats.showdowns++;
    assert.equal(g.totalChips(), expected);
  }
  console.log('bot smoke stats:', JSON.stringify(stats), 'stacks:', g.seats.filter(Boolean).map((p) => `${p.name}=${p.chips}`).join(' '));
  // bots should not just call everything
  assert.ok(stats.folds > 50 && stats.raises > 20 && stats.checks > 20);
  void BOT_STYLES;
});
