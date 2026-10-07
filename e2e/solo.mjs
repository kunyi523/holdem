import puppeteer from 'puppeteer-core';
const URL = process.argv[2] || 'http://localhost:8765/';
const DUR = Number(process.argv[3] || 60000);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.screenshot({ path: '/workspace/shot-lobby.png' });
await page.type('#nick', 'Kunyi');
await page.select('#solo-bots', '5');
await page.click('#btn-solo');
const t0 = Date.now();
let myActions = 0, shots = 0;
while (Date.now() - t0 < DUR) {
  await new Promise((r) => setTimeout(r, 400));
  const acts = await page.$$('[data-act]');
  if (acts.length) {
    if (shots === 0) { await page.screenshot({ path: '/workspace/shot-myturn.png' }); shots++; }
    const r = Math.random();
    const sel = r < 0.15 ? '[data-act=fold]' : r < 0.8 ? '[data-act=check],[data-act=call]' : '[data-act=raise]';
    const el = await page.$(sel) || await page.$('[data-act=check],[data-act=call]');
    if (sel === '[data-act=raise]' && (await page.$('[data-q="0.5"]'))) await page.click('[data-q="0.5"]');
    await el.click(); myActions++;
  }
  const rb = await page.$('#btn-rebuy'); if (rb) await rb.click();
  const st = await page.evaluate(() => { const v = window.__holdem.view; return v && v.phase; });
  if (st === 'handover' && shots === 1) { await page.screenshot({ path: '/workspace/shot-handover.png' }); shots++; }
}
const info = await page.evaluate(() => {
  const S = window.__holdem; const g = S.ctrl.game;
  return { hands: g.handNo, total: g.totalChips(), seats: g.seats.filter(Boolean).map((p) => `${p.name}:${p.chips}`), log: g.log.slice(-8).map((l) => l.text) };
});
await page.screenshot({ path: '/workspace/shot-end.png' });
console.log(JSON.stringify({ myActions, ...info, errors }, null, 1));
await browser.close();
