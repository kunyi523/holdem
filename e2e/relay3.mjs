// 3 real browsers (separate incognito contexts): host + 2 friends join via the invite link,
// play hands to showdown. Checks: transport used, chips conserved, no hole-card leak,
// WebSocket frames carry only ciphertext, and a friend recovers from a network drop.
import puppeteer from 'puppeteer-core';
const URL = process.argv[2] || 'http://localhost:8765/';
const HANDS = Number(process.env.HANDS || 5);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const errors = [], frames = { n: 0, plain: 0, bytes: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mk(tag) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  p.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(tag + ': ' + m.text().slice(0, 200)); });
  p.on('dialog', (d) => d.accept());
  const cdp = await p.createCDPSession();
  await cdp.send('Network.enable');
  const onFrame = (e) => {
    if (!/mqtt|shiftr|hivemq|emqx|mosquitto/.test(e.url || '') && e.response.opcode !== 2) return;
    frames.n++; frames.bytes += e.response.payloadData.length;
    // binary frames arrive base64; decode and look for plaintext game data
    const txt = e.response.opcode === 2 ? Buffer.from(e.response.payloadData, 'base64').toString('latin1') : e.response.payloadData;
    if (/"t":"|"cards"|welcome|"view"/.test(txt)) frames.plain++;
  };
  cdp.on('Network.webSocketFrameReceived', onFrame);
  cdp.on('Network.webSocketFrameSent', onFrame);
  p.tag = tag; p.cdp = cdp;
  return p;
}
const t00 = Date.now();
const host = await mk('HOST');
await host.goto(URL, { waitUntil: 'networkidle2' });
await host.type('#nick', '房主');
await host.click('#btn-host');
await host.waitForSelector('#inv-link', { timeout: 30000 });
const link = await host.$eval('#inv-link', (e) => e.textContent.trim());
const hostNet = await host.evaluate(() => window.__holdem.net);
console.log('room ready in', Date.now() - t00, 'ms', link.replace(/#k=.*/, '#k=<key>'), JSON.stringify(hostNet));
await host.click('.modal-close');
const target = URL.includes('localhost') ? link.replace(/^https?:\/\/[^/]+\/(holdem\/)?/, URL) : link;

const friends = [];
for (const name of ['阿杰', '小美']) {
  const p = await mk(name);
  await p.goto(target, { waitUntil: 'networkidle2' });
  await p.type('#nick', name);
  const t0 = Date.now();
  await p.click('#btn-join');
  try { await p.waitForFunction(() => window.__holdem.joined, { timeout: 30000 }); } catch (e) {
    console.log('JOIN FAIL', name, await p.$eval('#lobby-msg', (x) => x.textContent), errors); await browser.close(); process.exit(1);
  }
  const st = await p.evaluate(() => ({ seat: window.__holdem.mySeat, transport: window.__holdem.transport, pill: document.querySelector('#net-dot').textContent }));
  console.log(`${name} joined in ${Date.now() - t0} ms`, JSON.stringify(st));
  friends.push(p);
}
const all = [host, ...friends];
await sleep(600);
await host.evaluate(() => document.querySelector('#btn-start').click());

const TOTAL = 300000;
let lastNet = 'ok', leaks = 0, chipErr = 0, polls = 0, showdowns = new Set(), dropped = false, recovered = null;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  await sleep(350);
  for (const p of all) {
    const b = await p.$('[data-act=check],[data-act=call]');
    if (b) await p.evaluate((el) => el.click(), b).catch(() => {});
  }
  for (const p of friends) {
    const r = await p.evaluate(() => {
      const v = window.__holdem.view; if (!v) return null;
      const seats = v.seats.filter(Boolean);
      const sum = seats.reduce((a, s) => a + s.chips + (s.bet || 0), 0) + (v.pot || 0);
      const others = seats.filter((s, i) => s.cards && s.cards.length && s.cards[0] && v.seats.indexOf(s) !== window.__holdem.mySeat);
      return { phase: v.phase, hand: v.handNo, sum, others: others.length, betting: ['preflop', 'flop', 'turn', 'river'].includes(v.phase), net: window.__holdem.netState };
    });
    if (!r) continue;
    polls++;
    if (r.betting && r.others > 0) leaks++;
    if (r.phase === 'handover' && r.others > 0) showdowns.add(r.hand);
    if (p === friends[1] && r.net !== lastNet) { console.log('   小美 netState:', r.net, 'hand', r.hand); lastNet = r.net; }
    if (r.betting && r.sum !== TOTAL) chipErr++;
  }
  const hand = await host.evaluate(() => window.__holdem.ctrl.game.handNo);
  // after hand 2: simulate friend 2 losing network for 15 s (WebSockets/WebRTC cut)
  if (!dropped && hand >= 2) {
    dropped = true;
    const f = friends[1];
    await f.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    // dead radio: the existing socket silently stops delivering anything (no close event), and new sockets fail while offline
    await f.evaluate(() => { const c = window.__holdem.client && window.__holdem.client.conn; if (c && c._mq) { c._mq.ws.onmessage = null; c._mq.ws.send = () => {}; } });
    console.log('-- 小美 offline at hand', hand);
    setTimeout(async () => {
      await f.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      console.log('-- 小美 back online');
      const tBack = Date.now();
      f.waitForFunction(() => window.__holdem.netState === 'ok' && Date.now() - window.__holdem.lastMsgAt < 4000, { timeout: 90000, polling: 500 })
        .then(async () => { recovered = { ms: Date.now() - tBack, st: await f.evaluate(() => ({ net: window.__holdem.netState, tr: window.__holdem.transport, tries: window.__holdem.reconnectTries })) }; console.log('-- 小美 recovered', JSON.stringify(recovered)); })
        .catch(() => { recovered = false; console.log('-- 小美 did NOT recover'); });
    }, 15000);
  }
  if (hand > HANDS && recovered !== null) break;
}
const hostInfo = await host.evaluate(() => { const g = window.__holdem.ctrl.game; return { hands: g.handNo, total: g.totalChips(), seats: g.seats.filter(Boolean).map((p) => `${p.name}:${p.chips}:${p.connected ? 'on' : 'off'}`) }; });
const views = await Promise.all(friends.map((p) => p.evaluate(() => ({ hand: window.__holdem.view.handNo, pill: document.querySelector('#net-dot').textContent }))));
await host.screenshot({ path: '/workspace/holdem-shots/v4-host.png' });
await friends[0].screenshot({ path: '/workspace/holdem-shots/v4-friend.png' });
const res = { hostInfo, views, showdowns: [...showdowns], polls, leaks, chipErr, frames, recovered, errors: errors.slice(0, 12) };
console.log(JSON.stringify(res, null, 1));
const ok = hostInfo.total === TOTAL && leaks === 0 && chipErr === 0 && frames.plain === 0 && showdowns.size >= 2 && recovered && hostInfo.hands > HANDS;
console.log(ok ? 'PASS' : 'FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
