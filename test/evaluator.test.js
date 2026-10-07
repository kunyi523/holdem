import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, categoryOf, describeScore } from '../js/evaluator.js';
import { parseCards } from '../js/cards.js';

const ev = (s) => evaluate(parseCards(s));
const cat = (s) => categoryOf(ev(s));

test('categories are detected (7 cards)', () => {
  assert.equal(cat('As Ks Qs Js Ts 2d 3c'), 8); // royal
  assert.equal(describeScore(ev('As Ks Qs Js Ts 2d 3c')), '皇家同花顺');
  assert.equal(cat('9h 8h 7h 6h 5h Ad Ac'), 8);
  assert.equal(cat('Ah 2h 3h 4h 5h Kd Kc'), 8); // steel wheel
  assert.equal(cat('7s 7h 7d 7c 2d 3c 9h'), 7);
  assert.equal(cat('Ks Kh Kd 2c 2d 3c 9h'), 6);
  assert.equal(cat('Ks Kh Kd 2c 2d 2h 9h'), 6); // two trips -> full house
  assert.equal(cat('2s 9s Js Ks 4s Ad Ac'), 5);
  assert.equal(cat('As 2d 3c 4h 5s Kd Qc'), 4); // wheel
  assert.equal(cat('Ts Jd Qc Kh As 2d 3c'), 4); // broadway
  assert.equal(cat('Qs Ah Kd 2c 3d 4h 9h'), 0);
  assert.equal(cat('7s 7h 7d 2c 4d 9c Jh'), 3);
  assert.equal(cat('7s 7h 9d 9c 4d 2c Jh'), 2);
  assert.equal(cat('7s 7h 9d Tc 4d 2c Jh'), 1);
  assert.equal(cat('As Kh 9d 7c 4d 3c 2h'), 0);
});

test('straight ordering: wheel is lowest straight, no wrap-around', () => {
  assert.ok(ev('2s 3d 4c 5h 6s Kd Kc') > ev('As 2d 3c 4h 5s Kd Qc'));
  assert.ok(ev('Ts Jd Qc Kh As 2d 3c') > ev('9s Td Jc Qh Ks 2d 3c'));
  assert.notEqual(cat('Qs Kd Ac 2h 3s 8d 9c'), 4); // Q-K-A-2-3 is not a straight
  assert.equal(describeScore(ev('As 2d 3c 4h 5s Kd Qc')), '顺子（5 高）');
});

test('six-card straight uses highest', () => {
  assert.ok(ev('4s 5d 6c 7h 8s 9d 2c') > ev('3s 4d 5c 6h 7s 8d 2c'));
});

test('kickers decide pairs, two pair, trips, high card', () => {
  assert.ok(ev('As Ad Kc 7h 4s 3d 2c') > ev('Ah Ac Qc 7d 4h 3s 2d')); // pair A, K kicker > Q kicker
  assert.ok(ev('Ks Kd 9c 9h As 3d 2c') > ev('Kh Kc 9d 9s Qs 3h 2d')); // two pair, kicker A > Q
  assert.ok(ev('Ks Kd 9c 9h 4s 4d Ac') > ev('Kh Kc 9d 9s 4h 4c Qd')); // three pairs: best two + kicker
  assert.equal(ev('Ks Kd 9c 9h 4s 4d 2c'), ev('Kh Kc 9d 9s 4h 3c 2d')); // 4 is the kicker in both
  assert.ok(ev('7s 7h 7d Ac 4d 2c 3h') > ev('7c 7h 7d Kc 4d 2c 3h'));
  assert.ok(ev('As Qd 9c 7h 5s 3d 2c') > ev('Ah Qc 9d 7s 4h 3c 2d'));
  assert.equal(ev('As Qd 9c 7h 5s 3d 2c'), ev('Ah Qc 9d 7s 5h 3c 2d'));
});

test('flush compares all five cards', () => {
  assert.ok(ev('As 9s 7s 5s 3s Kd Kh') > ev('Ah 9h 7h 5h 2h Kd Kc'));
  assert.ok(ev('As Ks 7s 5s 3s 2s Qd') > ev('As Ks 7s 5s 2s 4d Qd')); // six spades: best five counted
});

test('full house and quads comparisons', () => {
  assert.ok(ev('3s 3h 3d 2c 2d 9c Jh') < ev('4s 4h 4d 2c 2d 9c Jh'));
  assert.ok(ev('As Ah 3d 3c 3h Kc Kh') > ev('Qs Qh 3d 3c 3h Jc Jh')); // 3s full of A > 3s full of Q
  assert.ok(ev('9s 9h 9d 9c Ad 2c 3h') > ev('9s 9h 9d 9c Kd 2c 3h'));
  assert.ok(ev('2s 2h 2d 2c 3d 4c 5h') < ev('3s 3h 3d 3c 2d 4c 5h'));
});

test('board plays -> exact tie (split pot)', () => {
  // board: A K Q J T rainbow-ish straight, both players' hole cards irrelevant
  const board = 'As Kd Qc Jh Ts';
  assert.equal(ev(`2c 3d ${board}`), ev(`4h 5c ${board}`));
});

test('category beats any kicker', () => {
  assert.ok(ev('2s 2d 3c 3h 4s 9d 8c') > ev('As Ad Kc Qh Js 9d 8c'));
  assert.ok(ev('2s 3s 4s 5s 7s Kd 8c') > ev('Ts Jd Qc Kh As 2d 3c')); // flush > straight
});

test('works for 5 and 6 cards', () => {
  assert.equal(cat('As Ks Qs Js Ts'), 8);
  assert.equal(cat('As Ad Kc Qh Js 9d'), 1);
});
