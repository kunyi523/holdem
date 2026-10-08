// Personality behaviour tests: the AIs must play clearly different, consistent styles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, STARTING_CHIPS } from '../js/engine.js';
import { botDecide, updateTilt, resolveStyle, PERSONALITIES, STYLE_KEYS } from '../js/bot.js';
import { parseCards, seededRandInt } from '../js/cards.js';

const aggressive = (d) => d.type === 'raise' || d.type === 'allin' || d.type === 'bet';

// heads-up spot on the flop. Seat 0 = button/SB, seat 1 = BB (acts first after the flop).
function flopSpot({ heroSeat, heroStyle, villStyle = 'regular', hero, board, villainBet = 0, heroChecked = false, seed = 1 }) {
  const g = new Game({ sb: 500, bb: 1000, randInt: seededRandInt(seed) });
  g.addPlayer(0, { id: 'a', name: 'A', isBot: true, botStyle: heroSeat === 0 ? heroStyle : villStyle });
  g.addPlayer(1, { id: 'b', name: 'B', isBot: true, botStyle: heroSeat === 1 ? heroStyle : villStyle });
  g.startHand();
  g.act(0, { type: 'raise', amount: 2500 }); // button opens, BB calls
  g.act(1, { type: 'call' });
  const used = new Set([...parseCards(hero), ...parseCards(board)]);
  g.seats[heroSeat].hole = parseCards(hero);
  const other = [];
  for (let c = 51; other.length < 2; c--) if (!used.has(c)) other.push(c);
  g.seats[1 - heroSeat].hole = other;
  g.board = parseCards(board);
  g.deck = g.deck.filter((c) => !used.has(c) && !other.includes(c));
  if (heroSeat === 1 && heroChecked) g.act(1, { type: 'check' });
  if (villainBet) {
    if (heroSeat === 0) g.act(1, { type: 'raise', amount: villainBet });
    else g.act(0, { type: 'raise', amount: villainBet });
  }
  assert.equal(g.toAct, heroSeat);
  return g;
}
const freq = (n, fn) => { let k = 0; for (let i = 0; i < n; i++) if (fn(i)) k++; return k / n; };

test('every personality exists, has a Chinese label, and v2 names still work', () => {
  for (const k of STYLE_KEYS) assert.ok(PERSONALITIES[k].label && PERSONALITIES[k].emoji && PERSONALITIES[k].blurb);
  assert.equal(resolveStyle('loose'), 'maniac');
  assert.equal(resolveStyle('tight'), 'rock');
  assert.equal(resolveStyle('balanced'), 'regular');
  assert.equal(resolveStyle('nonsense'), 'regular');
  assert.deepEqual(['maniac', 'rock', 'station', 'tricky'].map((k) => PERSONALITIES[k].label), ['疯狂型', '紧凶型', '跟注站', '诡诈型']);
});

test('table simulation: VPIP / PFR / aggression differ strongly between styles', () => {
  const R = seededRandInt(42).random;
  const g = new Game({ sb: 500, bb: 1000, randInt: seededRandInt(7) });
  const lineup = ['maniac', 'rock', 'station', 'tricky'];
  lineup.forEach((s, i) => g.addPlayer(i, { id: 'b' + i, name: s, isBot: true, botStyle: s }));
  const st = Object.fromEntries(lineup.map((s) => [s, { hands: 0, vpip: 0, pfr: 0, call: 0, raise: 0, dec: 0, postAgg: 0, postCall: 0 }]));
  for (let h = 0; h < 500; h++) {
    for (const p of g.seats) if (p && p.chips < STARTING_CHIPS / 4) g.rebuy(p.seat);
    g.startHand();
    const vp = new Set(), pr = new Set();
    for (const p of g.seats) if (p && p.inHand) st[p.botStyle].hands++;
    while (g.phase !== 'handover') {
      if (g.runout) { g.continueRunout(); continue; }
      const seat = g.toAct, p = g.seats[seat], la = g.legal(seat), s = st[p.botStyle];
      const d = botDecide(g, seat, { iters: 70, random: R });
      if (la.canCheck) assert.notEqual(d.type, 'fold', 'never fold when check is free');
      s.dec++;
      const agg = aggressive(d) && !(d.type === 'allin' && la.maxRaiseTo <= g.currentBet);
      if (agg) s.raise++; else if (d.type === 'call' && !la.canCheck) s.call++;
      if (g.phase === 'preflop') { if (agg || (d.type === 'call' && !la.canCheck)) vp.add(seat); if (agg) pr.add(seat); }
      else if (agg) s.postAgg++; else if (d.type === 'call' && !la.canCheck) s.postCall++;
      assert.ok(g.act(seat, d).ok);
    }
    for (const s of vp) st[g.seats[s].botStyle].vpip++;
    for (const s of pr) st[g.seats[s].botStyle].pfr++;
  }
  const v = (k) => st[k].vpip / st[k].hands, pfr = (k) => st[k].pfr / st[k].hands;
  const af = (k) => st[k].postAgg / Math.max(1, st[k].postCall);
  console.log('VPIP', lineup.map((k) => `${k}=${(v(k) * 100).toFixed(0)}%`).join(' '), 'PFR', lineup.map((k) => `${k}=${(pfr(k) * 100).toFixed(0)}%`).join(' '),
    'AF', lineup.map((k) => `${k}=${af(k).toFixed(2)}`).join(' '));
  assert.ok(v('maniac') > 0.5, 'maniac VPIP > 50%');
  assert.ok(v('rock') < 0.2, 'rock VPIP < 20%');
  assert.ok(v('station') > 0.45 && pfr('station') < 0.12, 'station: loose but rarely raises');
  assert.ok(pfr('maniac') > 2.5 * pfr('rock'));
  assert.ok(af('maniac') > 2 && af('station') < 0.7, 'maniac aggressive, station passive postflop');
  assert.ok(st.station.call / st.station.dec > 2 * (st.rock.call / st.rock.dec), 'station calls far more than rock');
});

test('preflop: maniac plays junk the rock folds', () => {
  const R = seededRandInt(3).random;
  const mk = (style, hole) => {
    const g = new Game({ sb: 500, bb: 1000, randInt: seededRandInt(5) });
    for (let i = 0; i < 6; i++) g.addPlayer(i, { id: 'b' + i, name: 'B' + i, isBot: true, botStyle: style });
    g.startHand();
    g.seats[g.toAct].hole = parseCards(hole);
    return g;
  };
  const playRate = (style, hole) => freq(60, () => { const g = mk(style, hole); return botDecide(g, g.toAct, { random: R }).type !== 'fold'; });
  assert.ok(playRate('maniac', 'Kh 7d') > 0.6, 'maniac opens K7o');
  assert.equal(playRate('rock', 'Kh 7d'), 0, 'rock folds K7o');
  assert.equal(playRate('rock', 'Ah Kd'), 1, 'rock always plays AK');
  assert.ok(playRate('station', 'Th 6h') > 0.6, 'station limps T6s');
});

test('postflop: station is hard to bluff, rock folds to big pressure', () => {
  const R = seededRandInt(11).random;
  // bottom pair facing a pot-sized bet on the flop
  const spot = (style, seed) => flopSpot({ heroSeat: 0, heroStyle: style, hero: '4c 5d', board: 'Kh 9s 4h', villainBet: 5000, seed });
  const callRate = (style) => freq(40, (i) => botDecide(spot(style, i + 1), 0, { iters: 150, random: R }).type !== 'fold');
  const station = callRate('station'), rock = callRate('rock');
  console.log('call pot bet with bottom pair: station', station, 'rock', rock);
  assert.ok(station > 0.85, 'station calls down bottom pair');
  assert.ok(rock < 0.25, 'rock gives up bottom pair to a pot bet');
});

test('trickster slow-plays monsters and check-raises; maniac just bets', () => {
  const R = seededRandInt(21).random;
  const checkRate = (style) => freq(40, (i) => {
    const g = flopSpot({ heroSeat: 1, heroStyle: style, hero: '9c 9d', board: '9h 5s 2c', seed: i + 1 });
    return botDecide(g, 1, { iters: 150, random: R }).type === 'check';
  });
  const tricky = checkRate('tricky'), maniac = checkRate('maniac');
  console.log('check a flopped set: tricky', tricky, 'maniac', maniac);
  assert.ok(tricky > 0.35, 'trickster often checks a set');
  assert.ok(maniac < 0.15, 'maniac bets his set');
  // after checking, facing a bet, the trickster springs the check-raise
  const crRate = freq(40, (i) => {
    const g = flopSpot({ heroSeat: 1, heroStyle: 'tricky', hero: '9c 9d', board: '9h 5s 2c', heroChecked: true, villainBet: 3000, seed: i + 1 });
    const d = botDecide(g, 1, { iters: 150, random: R });
    return aggressive(d) && d.tag === 'checkraise';
  });
  console.log('tricky check-raise with a set', crRate);
  assert.ok(crRate > 0.6);
});

test('bet sizing variety: trickster mixes sizes, station bets small, maniac sometimes overbets/shoves', () => {
  const R = seededRandInt(31).random;
  const sizes = (style) => {
    const out = [];
    for (let i = 0; i < 80; i++) {
      const g = flopSpot({ heroSeat: 1, heroStyle: style, hero: 'Ac Kd', board: 'Ah 8s 3c', seed: i + 1 });
      const pot = g.potTotal();
      const d = botDecide(g, 1, { iters: 120, random: R });
      if (d.type === 'raise') out.push(d.amount / pot);
      if (d.type === 'allin') out.push(99);
    }
    return out;
  };
  const tr = sizes('tricky'), st = sizes('station'), mn = sizes('maniac');
  const buckets = (a) => new Set(a.map((x) => (x >= 99 ? 'allin' : x < 0.35 ? 's' : x < 0.55 ? 'm' : x < 0.85 ? 'l' : x < 1.15 ? 'p' : 'o'))).size;
  console.log('size buckets tricky', buckets(tr), 'station max', Math.max(...st).toFixed(2), 'maniac big', mn.filter((x) => x > 1.1).length);
  assert.ok(buckets(tr) >= 4, 'trickster uses at least 4 different sizings');
  assert.ok(st.length && Math.max(...st) < 0.7, 'station bets small');
  assert.ok(mn.filter((x) => x > 1.1).length >= 3, 'maniac overbets or shoves sometimes');
});

test('tilt: a big loss tilts a bot, which then plays looser; it cools down over a few hands', () => {
  const p = { tilt: 0, handStart: 100000 };
  updateTilt(p, -60000, 1000);
  assert.ok(p.tilt >= 0.5, 'tilted after losing 60bb');
  const t0 = p.tilt;
  updateTilt(p, 0, 1000); assert.ok(p.tilt < t0);
  for (let i = 0; i < 6; i++) updateTilt(p, 0, 1000);
  assert.equal(p.tilt, 0, 'calm again after ~7 hands');
  updateTilt(p, -5000, 1000); assert.equal(p.tilt, 0, 'small losses do not tilt');
  // a tilted rock opens a wider range than a calm rock
  const R = seededRandInt(8).random;
  const openRate = (tilt) => freq(400, (i) => {
    const g = new Game({ sb: 500, bb: 1000, randInt: seededRandInt(100 + i) });
    for (let k = 0; k < 6; k++) g.addPlayer(k, { id: 'b' + k, name: 'B' + k, isBot: true, botStyle: 'rock' });
    g.startHand();
    return botDecide(g, g.toAct, { random: R, tilt }).type !== 'fold';
  });
  const calm = openRate(0), tilted = openRate(1);
  console.log('rock open rate calm', calm, 'tilted', tilted);
  assert.ok(tilted > calm * 1.5);
});

test('engine tracks tilt after a big pot and exposes style/tilt in the view', () => {
  const g = new Game({ sb: 500, bb: 1000, randInt: seededRandInt(2) });
  g.addPlayer(0, { id: 'a', name: '粉哥', isBot: true, botStyle: 'maniac' });
  g.addPlayer(1, { id: 'b', name: 'Me' });
  g.startHand();
  g.seats[0].hole = parseCards('7c 2d');
  g.seats[1].hole = parseCards('Ac Ad');
  g.act(0, { type: 'allin' });
  g.act(1, { type: 'call' });
  g.finishRunout();
  const lost = g.seats[0].chips < STARTING_CHIPS;
  const v = g.view(1);
  assert.equal(v.seats[0].style, 'maniac');
  assert.equal(v.seats[1].style, null);
  if (lost) assert.ok(v.seats[0].tilt >= 0.5, 'bot that lost its stack is tilted');
});
