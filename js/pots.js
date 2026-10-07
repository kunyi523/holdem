// Side-pot computation.
// contribs: [{ seat, amount, folded }] where amount = total chips put in this hand.
// Returns [{ amount, eligible: [seat,...] }] from main pot to last side pot.
// Folded players' chips go into pots but they are never eligible to win.
export function computePots(contribs) {
  const work = contribs.filter((c) => c.amount > 0).map((c) => ({ ...c }));
  const pots = [];
  while (work.some((c) => c.amount > 0)) {
    const live = work.filter((c) => !c.folded && c.amount > 0);
    if (live.length === 0) {
      // Only folded money left (folded player put in more than any live player): add to last pot.
      const rest = work.reduce((s, c) => s + c.amount, 0);
      work.forEach((c) => { c.amount = 0; });
      if (pots.length) pots[pots.length - 1].amount += rest;
      else pots.push({ amount: rest, eligible: [] });
      break;
    }
    const level = Math.min(...live.map((c) => c.amount));
    const pot = { amount: 0, eligible: live.map((c) => c.seat).sort((a, b) => a - b) };
    for (const c of work) {
      const take = Math.min(c.amount, level);
      pot.amount += take;
      c.amount -= take;
    }
    const prev = pots[pots.length - 1];
    if (prev && prev.eligible.length === pot.eligible.length && prev.eligible.every((s, i) => s === pot.eligible[i])) {
      prev.amount += pot.amount;
    } else {
      pots.push(pot);
    }
  }
  return pots;
}

// Split `amount` among winners (seat numbers already ordered by priority for odd chips,
// i.e. first seat left of the button first). Returns Map seat -> chips.
export function splitPot(amount, orderedWinners) {
  const n = orderedWinners.length;
  const share = Math.floor(amount / n);
  let rem = amount - share * n;
  const out = new Map();
  for (const s of orderedWinners) {
    out.set(s, share + (rem > 0 ? 1 : 0));
    if (rem > 0) rem--;
  }
  return out;
}
