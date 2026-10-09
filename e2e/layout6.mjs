// Screenshot + overlap audit for every player count on several viewports (solo mode, real hands).
import puppeteer from 'puppeteer-core';
const URL = process.argv[2] || 'http://localhost:8765/';
const OUT = process.env.OUT || '/workspace/holdem-shots/v6';
const COUNTS = (process.env.COUNTS || '2,3,4,5,6,7,8').split(',').map(Number);
const SHOOT = new Set((process.env.SHOOT || '2,3,4,6,8').split(',').map(Number));
const ONLY = process.env.VP ? process.env.VP.split(',') : null;
const VPS0 = [
  { name: 'phone360', w: 360, h: 740, m: true }, { name: 'phone', w: 390, h: 844, m: true, shot: true },
  { name: 'phone430', w: 430, h: 932, m: true }, { name: 'desktop', w: 1280, h: 800, m: false, shot: true },
];
const VPS = ONLY ? VPS0.filter((v) => ONLY.includes(v.name)) : VPS0;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const errors = [];
for (const vp of VPS) for (const n of COUNTS) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${vp.name}/${n}: ${e.message}`));
  await p.setViewport({ width: vp.w, height: vp.h, isMobile: vp.m, hasTouch: vp.m, deviceScaleFactor: vp.shot ? 2 : 1 });
  await p.goto(URL, { waitUntil: 'networkidle2' });
  await p.evaluate((k) => {
    const names = ['粉哥', 'Micheal', 'Grok Bot', '小龙', '阿杰', 'Lucy', '老王'];
    const st = { '粉哥': 'maniac', 'Micheal': 'rock', 'Grok Bot': 'tricky', '小龙': 'station', '阿杰': 'regular', 'Lucy': 'tricky', '老王': 'station' };
    localStorage.setItem('holdem.lineup3', JSON.stringify(names.slice(0, k).map((name) => ({ name, style: st[name] }))));
    localStorage.setItem('holdem.muted', '1');
  }, n - 1);
  await p.reload({ waitUntil: 'networkidle2' });
  await p.type('#nick', 'Kunyi');
  await p.click('#btn-solo');
  // wait for my turn with chips on the table
  const t0 = Date.now();
  let got = false;
  while (Date.now() - t0 < (process.env.FAST ? 0 : 25000)) {
    await sleep(300);
    const ok = await p.evaluate(() => { const v = window.__holdem && window.__holdem.view; return !!(v && v.legal && v.seats.some((s) => s && s.bet > 0)); }).catch(() => false);
    if (ok) { got = true; break; }
  }
  await sleep(process.env.FAST ? 3500 : 900);
  const audit = await p.evaluate(() => {
    const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const items = [];
    const add = (sel, kind, owner) => document.querySelectorAll(sel).forEach((el) => { const r = R(el); if (r.w > 1 && r.h > 1 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0') items.push({ kind, owner: owner(el), r }); });
    const seatOf = (el) => (el.closest('.seat') ? 'S' + el.closest('.seat').dataset.seat : '-');
    add('#seats .seat .plate', 'plate', seatOf);
    add('#seats .seat .avatar-wrap', 'avatar', seatOf);
    add('#seats .seat .hole .card', 'hole', seatOf);
    add('#seats .seat .bubble', 'bubble', seatOf);
    add('#seats .bet', 'bet', (el) => 'B' + el.style.left);
    add('#seats .dealer', 'dealer', () => 'D');
    add('#board .card', 'board', () => 'board');
    add('#pot .stacks, #pot .amt', 'pot', () => 'pot');
    add('.topbar', 'topbar', () => 'top');
    add('#action-bar', 'bar', () => 'bar');
    add('#add-ai', 'addai', () => 'add');
    const ov = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    const bad = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.owner === b.owner) continue;
      if ((a.kind === 'board' && b.kind === 'board') || (a.kind === 'pot' && b.kind === 'pot')) continue;
      if (a.kind === 'bar' && b.kind === 'bar') continue;
      const o = ov(a.r, b.r);
      if (o > 12) bad.push(`${a.kind}(${a.owner})×${b.kind}(${b.owner}) ${Math.round(o)}px²`);
    }
    return bad;
  });
  const tag = `${vp.name === 'phone' ? 'phone390' : vp.name} n=${n}`;
  if (!got) problems.push(`${tag}: never reached my turn`);
  if (audit.length) problems.push(`${tag}: ${audit.join('; ')}`);
  console.log(`${tag}: ${got ? '' : '(no turn) '}${audit.length ? 'OVERLAP ' + audit.join('; ') : 'clean'}`);
  if (process.env.ALLSHOT || (vp.shot && SHOOT.has(n))) await p.screenshot({ path: `${process.env.ALLSHOT ? '/tmp' : OUT}/v6-${vp.name}-${n}p.png` });
  await ctx.close();
}
console.log('PROBLEMS', problems.length, 'errors', JSON.stringify(errors));
await browser.close();
