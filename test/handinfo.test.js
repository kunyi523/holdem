import test from 'node:test';
import assert from 'node:assert/strict';
import { bestFive, drawInfo, heroHandInfo } from '../js/handinfo.js';
import { evaluate } from '../js/evaluator.js';
import { parseCards, cardToString } from '../js/cards.js';

const s = (cards) => cards.map(cardToString).sort().join(' ');

test('bestFive picks the five cards that make the hand', () => {
  const seven = parseCards('Ah Kh 2h 7h Kc 9h 3s');
  const bf = bestFive(seven);
  assert.equal(bf.score, evaluate(seven));
  assert.equal(s(bf.cards), s(parseCards('Ah Kh 2h 7h 9h'))); // the flush, not the pair of kings
  const fh = bestFive(parseCards('Qs Qd 5c 5h 5s 2d 9c'));
  assert.equal(s(fh.cards), s(parseCards('5c 5h 5s Qs Qd')));
});

test('draw detection: flush draw, open-ender, gutshot, wheel draw is one-ended', () => {
  assert.deepEqual(drawInfo(parseCards('Ah Kh'), parseCards('2h 7h Kc')), { flush: true, oesd: false, gutshot: false });
  assert.equal(drawInfo(parseCards('9c 8d'), parseCards('7h 6s 2c')).oesd, true);
  assert.equal(drawInfo(parseCards('9c 5d'), parseCards('7h 6s 2c')).gutshot, true);
  assert.equal(drawInfo(parseCards('Ac 2d'), parseCards('3h 4s 9c')).oesd, false);
  assert.equal(drawInfo(parseCards('Ac 2d'), parseCards('3h 4s 9c')).gutshot, true);
});

test('hero hand label', () => {
  assert.equal(heroHandInfo(parseCards('Qs Qd'), []).label, '口袋对子 QQ');
  assert.equal(heroHandInfo(parseCards('Qs Qd'), []).tier, 4);
  const h = heroHandInfo(parseCards('Ah Kh'), parseCards('2h 7h Kc'));
  assert.equal(h.label, '一对 K');
  assert.equal(h.sub, '同花听牌');
  assert.match(heroHandInfo(parseCards('Ac 2d'), parseCards('7h 7s 3c 4d')).label, /公共牌/);
});
