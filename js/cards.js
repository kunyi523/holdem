// Cards are integers 0..51: rank index = c >> 2 (0 = '2' ... 12 = 'A'), suit = c & 3.
export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc'; // spades, hearts, diamonds, clubs
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];

export const rankOf = (c) => (c >> 2) + 2; // 2..14
export const suitOf = (c) => c & 3;

export function parseCard(str) {
  const r = RANKS.indexOf(str[0].toUpperCase());
  const s = SUITS.indexOf(str[1].toLowerCase());
  if (r < 0 || s < 0) throw new Error('Bad card: ' + str);
  return (r << 2) | s;
}
export const parseCards = (s) => s.trim().split(/\s+/).filter(Boolean).map(parseCard);
export const cardToString = (c) => RANKS[c >> 2] + SUITS[c & 3];

export function newDeck() {
  const d = [];
  for (let i = 0; i < 52; i++) d.push(i);
  return d;
}

// Unbiased random integer in [0, n) using the Web Crypto API (browser + Node >= 19 / 20).
const buf = new Uint32Array(1);
export function cryptoRandInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  let x;
  do {
    globalThis.crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % n;
}

// Fisher-Yates shuffle (in place). randInt(n) must return an integer in [0, n).
export function shuffle(arr, randInt = cryptoRandInt) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Deterministic PRNG (mulberry32) for tests.
export function seededRandInt(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randInt = (n) => Math.floor(next() * n);
  randInt.random = next;
  return randInt;
}
