// Tiny synthesized sound effects (WebAudio, no audio files). Muted state persists in localStorage.
let ctx = null, master = null;
let muted = localStorage.getItem('holdem.muted') === '1';

function ac() {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// browsers only allow audio after a user gesture: unlock on the first tap
const unlock = () => { if (!muted) ac(); };
window.addEventListener('pointerdown', unlock, { once: true, capture: true });

function tone(freq, { t = 0, dur = 0.12, type = 'sine', vol = 0.3, slide = 0, attack = 0.004 } = {}) {
  const c = ac(); if (!c) return;
  const now = c.currentTime + t;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, now);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), now + dur);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(vol, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  o.connect(g); g.connect(master);
  o.start(now); o.stop(now + dur + 0.02);
}
function noise({ t = 0, dur = 0.08, vol = 0.25, freq = 3000, q = 0.8, type = 'bandpass', sweep = 0 } = {}) {
  const c = ac(); if (!c) return;
  const now = c.currentTime + t;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource(); src.buffer = buf;
  const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, now); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, now + dur);
  const g = c.createGain(); g.gain.setValueAtTime(vol, now); g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(now); src.stop(now + dur + 0.02);
}

const SFX = {
  deal: () => { noise({ dur: 0.07, vol: 0.22, freq: 2400, q: 0.6, sweep: 0.5 }); },
  flip: () => { noise({ dur: 0.05, vol: 0.18, freq: 3800, q: 1.2 }); tone(900, { dur: 0.04, vol: 0.04, type: 'triangle' }); },
  chip: () => { tone(2600, { dur: 0.06, vol: 0.12, type: 'triangle' }); tone(3400, { t: 0.035, dur: 0.07, vol: 0.09, type: 'triangle' }); noise({ t: 0, dur: 0.03, vol: 0.08, freq: 6000, q: 2 }); },
  chips: () => { for (let i = 0; i < 4; i++) { tone(2300 + Math.random() * 1400, { t: i * 0.045, dur: 0.06, vol: 0.09, type: 'triangle' }); } },
  check: () => { tone(180, { dur: 0.07, vol: 0.35, type: 'sine', slide: 0.6 }); tone(170, { t: 0.11, dur: 0.07, vol: 0.3, type: 'sine', slide: 0.6 }); },
  fold: () => { noise({ dur: 0.18, vol: 0.18, freq: 1200, q: 0.5, sweep: 0.3, type: 'lowpass' }); },
  raise: () => { SFX.chips(); tone(520, { t: 0.05, dur: 0.12, vol: 0.06, type: 'triangle', slide: 1.5 }); },
  allin: () => { SFX.chips(); tone(220, { dur: 0.45, vol: 0.12, type: 'sawtooth', slide: 2.2, attack: 0.05 }); tone(330, { t: 0.08, dur: 0.4, vol: 0.08, type: 'square', slide: 2, attack: 0.05 }); },
  turn: () => { tone(880, { dur: 0.18, vol: 0.14 }); tone(1320, { t: 0.1, dur: 0.25, vol: 0.12 }); },
  tick: () => { tone(1500, { dur: 0.03, vol: 0.08, type: 'square' }); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, { t: i * 0.09, dur: 0.32, vol: 0.13, type: 'triangle' })); setTimeout(() => SFX.chips(), 380); },
  lose: () => { tone(330, { dur: 0.25, vol: 0.08, type: 'triangle', slide: 0.75 }); tone(262, { t: 0.18, dur: 0.35, vol: 0.07, type: 'triangle', slide: 0.75 }); },
  click: () => { tone(1200, { dur: 0.025, vol: 0.06, type: 'square' }); },
};

export function play(name) {
  if (muted || document.hidden) return;
  try { const f = SFX[name]; if (f) f(); } catch (e) { /* audio is best-effort */ }
}
export const isMuted = () => muted;
export function setMuted(v) {
  muted = !!v;
  localStorage.setItem('holdem.muted', muted ? '1' : '0');
  if (!muted) { ac(); SFX.click(); }
}
