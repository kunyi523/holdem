import puppeteer from 'puppeteer-core';
const URL = process.argv[2] || 'http://localhost:8765/';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const errors = [];
import fs from 'fs';
const FAKE_SRC = fs.readFileSync('/workspace/holdem-e2e/fakepeer.js', 'utf8');
const mk = async (ctx, tag) => {
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  p.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(tag + ' ' + m.type() + ': ' + m.text()); });
  p.on('dialog', (d) => d.accept());
  if (process.env.FAKE) {
    await p.setBypassServiceWorker(true);
    await p.setRequestInterception(true);
    p.on('request', (r) => r.url().includes('vendor/peerjs') ? r.respond({ status: 200, contentType: 'application/javascript', body: FAKE_SRC }) : r.continue());
  }
  return p;
};
const host = await mk(browser.defaultBrowserContext(), 'HOST');
await host.goto(URL, { waitUntil: 'networkidle0' });
await host.$eval('#nick', (e) => { e.value = ''; }); await host.type('#nick', '房主Kunyi');
await host.click('#btn-host');
await host.waitForSelector('.code-big', { timeout: 20000 });
const code = await host.$eval('.code-big', (e) => e.textContent.trim());
const link = await host.$eval('#inv-link', (e) => e.textContent.trim());
console.log('room code', code, link);
await host.click('.modal-close');

const ctx2 = process.env.FAKE ? browser.defaultBrowserContext() : await browser.createBrowserContext();
const cli = await mk(ctx2, 'CLIENT');
await cli.goto(URL.includes('localhost') ? link.replace(/^https?:\/\/[^/]+\//, URL) : link, { waitUntil: 'networkidle0' });
await cli.$eval('#nick', (e) => { e.value = ''; }); await cli.type('#nick', '朋友A');
await cli.click('#btn-join');
try { await cli.waitForFunction(() => window.__holdem.joined, { timeout: 25000 }); } catch (e) { console.log('JOIN FAIL', await cli.$eval('#lobby-msg', (x) => x.textContent), errors); await browser.close(); process.exit(1); }
console.log('client joined seat', await cli.evaluate(() => window.__holdem.mySeat));
// host adds a bot and starts
await host.evaluate(() => window.__holdem.ctrl.addBot('粉哥'));
await new Promise((r) => setTimeout(r, 800));
await host.evaluate(() => document.querySelector('#btn-start').click());
const t0 = Date.now();
let acted = { HOST: 0, CLIENT: 0 };
let leakCheck = null;
while (Date.now() - t0 < 50000) {
  await new Promise((r) => setTimeout(r, 400));
  for (const [tag, p] of [['HOST', host], ['CLIENT', cli]]) {
    const b = await p.$('[data-act=check],[data-act=call]');
    if (b) { await p.evaluate((el) => el.click(), b).catch(() => {}); acted[tag]++; }
  }
  if (!leakCheck) {
    leakCheck = await cli.evaluate(() => {
      const v = window.__holdem.view; if (!v || !['preflop','flop','turn'].includes(v.phase)) return null;
      return v.seats.filter(Boolean).map((s) => ({ name: s.name, cards: s.cards }));
    });
  }
}
const hostInfo = await host.evaluate(() => { const g = window.__holdem.ctrl.game; return { hands: g.handNo, total: g.totalChips(), seats: g.seats.filter(Boolean).map((p) => `${p.name}:${p.chips}:${p.connected}`) }; });
const cliView = await cli.evaluate(() => { const v = window.__holdem.view; return { hand: v.handNo, phase: v.phase, seats: v.seats.filter(Boolean).map((s) => `${s.name}:${s.chips}`) }; });
await cli.screenshot({ path: '/workspace/shot-client.png' });
// disconnect test: close client page, host should mark offline
await cli.evaluate(() => { window.__holdem.leaving = true; window.__holdem.client.peer.destroy(); });
  /* simulate abrupt network loss: peer destroyed -> conn close */
await new Promise((r) => setTimeout(r, 16000));
const afterDisc = await host.evaluate(() => window.__holdem.ctrl.game.seats.filter(Boolean).map((p) => `${p.name}:${p.connected}`));
await host.screenshot({ path: '/workspace/shot-host.png' });
console.log(JSON.stringify({ acted, hostInfo, cliView, leakCheck, afterDisc, errors: errors.slice(0, 15) }, null, 1));
await browser.close();
