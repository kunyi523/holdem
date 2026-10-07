import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePots, splitPot } from '../js/pots.js';

test('single pot when everyone contributes equally', () => {
  const pots = computePots([
    { seat: 0, amount: 1000, folded: false },
    { seat: 1, amount: 1000, folded: false },
    { seat: 2, amount: 1000, folded: false },
  ]);
  assert.deepEqual(pots, [{ amount: 3000, eligible: [0, 1, 2] }]);
});

test('three-way all-in with different stacks creates side pots', () => {
  const pots = computePots([
    { seat: 0, amount: 500, folded: false },
    { seat: 1, amount: 2000, folded: false },
    { seat: 2, amount: 5000, folded: false },
  ]);
  assert.deepEqual(pots, [
    { amount: 1500, eligible: [0, 1, 2] },
    { amount: 3000, eligible: [1, 2] },
    { amount: 3000, eligible: [2] }, // uncalled excess returns to seat 2
  ]);
});

test('folded players contribute but are not eligible', () => {
  const pots = computePots([
    { seat: 0, amount: 3000, folded: true },
    { seat: 1, amount: 1000, folded: false },
    { seat: 2, amount: 5000, folded: false },
    { seat: 3, amount: 5000, folded: false },
  ]);
  assert.deepEqual(pots, [
    { amount: 4000, eligible: [1, 2, 3] },
    { amount: 10000, eligible: [2, 3] },
  ]);
  const total = pots.reduce((s, p) => s + p.amount, 0);
  assert.equal(total, 14000);
});

test('folded player who put in more than every live player', () => {
  const pots = computePots([
    { seat: 0, amount: 8000, folded: true },
    { seat: 1, amount: 2000, folded: false },
    { seat: 2, amount: 2000, folded: false },
  ]);
  assert.equal(pots.reduce((s, p) => s + p.amount, 0), 12000);
  assert.deepEqual(pots, [{ amount: 12000, eligible: [1, 2] }]);
});

test('equal all-ins merge into one pot level', () => {
  const pots = computePots([
    { seat: 0, amount: 2000, folded: false },
    { seat: 1, amount: 2000, folded: false },
    { seat: 2, amount: 6000, folded: false },
    { seat: 3, amount: 6000, folded: false },
    { seat: 4, amount: 0, folded: true },
  ]);
  assert.deepEqual(pots, [
    { amount: 8000, eligible: [0, 1, 2, 3] },
    { amount: 8000, eligible: [2, 3] },
  ]);
});

test('splitPot gives odd chips to earliest seats in order', () => {
  const m = splitPot(1001, [5, 2]);
  assert.equal(m.get(5), 501);
  assert.equal(m.get(2), 500);
  const m3 = splitPot(1000, [1, 2, 3]);
  assert.deepEqual([m3.get(1), m3.get(2), m3.get(3)], [334, 333, 333]);
});
