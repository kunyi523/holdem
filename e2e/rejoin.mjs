// Rejoin scenarios. SCEN=reload,drop,freeze,turn,newdevice,host  DROP=45 (seconds)
import puppeteer from 'puppeteer-core';
const URL = process.argv[2] || 'http://localhost:8765/';
const SCEN = (process.env.SCEN || 'reload,drop,freeze,turn,newdevice,host').split(',');
const DROP = Number(process.env.DROP || 45) * 1000;
const SHOTS = process.env.SHOTS || '';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
async function mk(tag) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 2 : 1 });
  p.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|PeerJS|WebSocket connection|Failed to load resource/.test(m.text())) errors.push(tag + ': ' + m.text().slice(0, 160)); });
  p.on('dialog', (d) => d.accept());
  p.cdp = await p.createCDPSession();
  await p.cdp.send('Network.enable');
  p.tag = tag;
  return p;
}
const host = await mk('HOST');
await host.goto(URL, { waitUntil: 'networkidle2' });
await host.type('#nick', '房主');
await host.click('#btn-host');
await host.waitForSelector('#inv-link', { timeout: 30000 });
const link = await host.$eval('#inv-link', (e) => e.textContent.trim());
await host.click('.modal-close');
const target = URL.includes('localhost') ? link.replace(/^https?:\/\/[^/]+\/(holdem\/)?/, URL) : link;
async function join(p, name) {
  await p.goto(target, { waitUntil: 'networkidle2' });
  if (!(await p.evaluate(() => window.__holdem.mode))) {
    await p.$eval('#nick', (e) => { e.value = ''; }); await p.type('#nick', name);
    await p.click('#btn-join');
  }
  await p.waitForFunction(() => window.__holdem.joined && window.__holdem.netState === 'ok', { timeout: 40000 });
}
const A = await mk('阿杰'), B = await mk('小美');
await join(A, '阿杰'); await join(B, '小美');
log('joined', await B.evaluate(() => [window.__holdem.mySeat, window.__holdem.transport]));
await A.evaluate(() => document.querySelector('#btn-ready') && document.querySelector('#btn-ready').click());
await sleep(800);
if (SHOTS) { await host.screenshot({ path: SHOTS + '/v5-mobile-waitroom-host.png' }); }
await host.evaluate(() => window.__holdem.ctrl.addBot('粉哥'));
await host.evaluate(() => { const c = window.__holdem.ctrl; const o = c.handleAction.bind(c); window.__acts = []; c.handleAction = (seat, a) => { window.__acts.push([seat, c.game.handNo, c.game.phase]); return o(seat, a); }; });
await sleep(500);
await host.evaluate(() => document.querySelector('#btn-start').click());
const autoplay = new Set([host, A, B]);
let stop = false;
const buys = {};
(async () => { while (!stop) { await sleep(400); for (const p of [...autoplay]) { try {
  const b = await p.$('[data-act=check],[data-act=call]'); if (b) await p.evaluate((el) => el.click(), b);
  // busted → buy back in through the dialog (exercises the multiplayer buy-in path)
  if (await p.$('#btn-buy-big')) { await p.evaluate(() => { document.querySelector('#btn-buy-big').click(); }); await sleep(300); await p.evaluate(() => { const x = document.querySelector('[data-buy="100000"]'); x && x.click(); const g = document.querySelector('#buy-go'); g && g.click(); }); buys[p.tag] = (buys[p.tag] || 0) + 1; }
} catch (e) { /* reloading */ } } } })();
const hostSeat = async (name) => host.evaluate((n) => { const g = window.__holdem.ctrl.game; const p = g.seats.find((s) => s && s.name === n); return p && { seat: p.seat, chips: p.chips, connected: p.connected, sittingOut: p.sittingOut, inHand: p.inHand, folded: p.folded, hole: p.hole.slice(), toAct: g.toAct, hand: g.handNo, phase: g.phase, n: g.seats.filter(Boolean).length }; }, name);
async function verify(p, name, label) {
  const t0 = Date.now();
  let ok = false, st;
  while (Date.now() - t0 < 120000) {
    st = await p.evaluate(() => { const S = window.__holdem; const v = S.view; const me = v && v.seats[S.mySeat]; return { net: S.netState, joined: S.joined, seat: S.mySeat, chips: me && me.chips, cards: me && me.cards, hand: v && v.handNo, lastMsgAgo: Date.now() - S.lastMsgAt }; }).catch((e) => ({ err: e.message }));
    if (st.net === 'ok' && st.lastMsgAgo < 4000 && st.hand != null) break;
    await sleep(400);
  }
  ok = st.net === 'ok';
  // compare against host once both are on the same hand
  let h, same = false;
  for (let k = 0; k < 20 && !same; k++) {
    h = await hostSeat(name);
    st = await p.evaluate(() => { const S = window.__holdem; const v = S.view; const me = v && v.seats[S.mySeat]; return { net: S.netState, seat: S.mySeat, chips: me && me.chips, cards: me && me.cards, hand: v && v.handNo, phase: v && v.phase }; });
    same = st.hand === h.hand && st.phase === h.phase && st.chips === h.chips;
    if (!same) await sleep(250);
  }
  const cardsOk = !(h.inHand && !h.folded) || JSON.stringify(st.cards) === JSON.stringify(h.hole);
  const pass = ok && same && st.seat === h.seat && cardsOk && h.connected && h.n === 4;
  log(`${pass ? 'PASS' : 'FAIL'} [${label}] back in ${Date.now() - t0}ms · seat ${st.seat}/${h.seat} chips ${st.chips}/${h.chips} hand ${st.hand}/${h.hand} ${st.phase} cards ${JSON.stringify(st.cards)} vs ${JSON.stringify(h.inHand && !h.folded ? h.hole : '-')} connected=${h.connected} seats=${h.n}`);
  return pass;
}
const results = {};
const blackhole = (p) => p.evaluate(() => { const c = window.__holdem.client && window.__holdem.client.conn; if (c && c._mq) { c._mq.ws.onmessage = null; c._mq.ws.send = () => {}; return 'relay'; } if (c && c.peerConnection) { c.peerConnection.close(); return 'direct'; } return 'none'; });
const offline = (p, v) => p.cdp.send('Network.emulateNetworkConditions', { offline: v, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const waitFor = async (fn, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; };
await sleep(4000);
for (const s of SCEN) {
  if (s === 'reload') {
    await waitFor(async () => { const h = await hostSeat('小美'); return h.inHand && !h.folded && h.phase !== 'handover'; });
    log('--- reload 小美 mid-hand', JSON.stringify(await hostSeat('小美')));
    autoplay.delete(B);
    await B.reload({ waitUntil: 'networkidle2' });
    log('after reload: auto-rejoin started =', await B.evaluate(() => window.__holdem.mode === 'client'));
    autoplay.add(B);
    results.reload = await verify(B, '小美', 'reload mid-hand (no taps)');
  } else if (s === 'drop') {
    log(`--- drop 小美 network for ${DROP / 1000}s`);
    autoplay.delete(B);
    const h0 = await hostSeat('小美');
    await offline(B, true); log('blackhole', await blackhole(B));
    await sleep(Math.min(20000, DROP));
    if (SHOTS) { await host.screenshot({ path: SHOTS + '/v5-mobile-disconnected-seat.png' }); await B.screenshot({ path: SHOTS + '/v5-mobile-reconnecting.png' }); }
    await sleep(Math.max(0, DROP - 20000));
    const h1 = await hostSeat('小美');
    log('host while away:', JSON.stringify(h1), 'hands played meanwhile', h1.hand - h0.hand);
    await offline(B, false);
    autoplay.add(B);
    results['drop' + DROP / 1000] = (await verify(B, '小美', `drop ${DROP / 1000}s`)) && h1.hand > h0.hand;
  } else if (s === 'freeze') {
    log('--- freeze 小美 page (background) 40s');
    await B.cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await sleep(40000);
    await B.cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await B.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    results.freeze = await verify(B, '小美', 'background 40s');
  } else if (s === 'turn') {
    log('--- 阿杰 drops while it is his turn, comes back during the grace period');
    autoplay.delete(A);
    const got = await waitFor(async () => { const h = await hostSeat('阿杰'); return h.toAct === h.seat && h.connected; });
    const h0 = await hostSeat('阿杰');
    await offline(A, true); await blackhole(A);
    log('dropped on his turn:', got, 'hand', h0.hand, h0.phase);
    await waitFor(async () => !(await hostSeat('阿杰')).connected, 30000);
    const graceSeen = await host.evaluate(() => { const v = window.__holdem.view; return v.toAct >= 0 && v.seats[v.toAct].connected === false ? Math.round(v.turnRemainingMs / 1000) : -1; });
    log('host marked him offline; grace countdown on his seat:', graceSeen, 's; seat bubble:', await host.evaluate(() => (document.querySelector('.bubble.offline') || {}).textContent));
    if (SHOTS) await host.screenshot({ path: SHOTS + '/v5-mobile-offline-turn-countdown.png' });
    await sleep(2000);
    await offline(A, false);
    autoplay.add(A);
    const ok = await verify(A, '阿杰', 'rejoin on own turn');
    await sleep(3000);
    const acted = await host.evaluate((h) => window.__acts.filter((x) => x[1] === h).map((x) => x[0]), h0.hand);
    log('actions in that hand by seat:', JSON.stringify(acted), '阿杰 acted himself after coming back:', acted.includes(h0.seat));
    results.turn = ok && acted.includes(h0.seat);
  } else if (s === 'newdevice') {
    log('--- 小美 loses her phone session; opens the link in a brand-new browser');
    autoplay.delete(B);
    const h0 = await hostSeat('小美');
    await offline(B, true); await blackhole(B);
    await waitFor(async () => !(await hostSeat('小美')).connected, 30000);
    await B.browserContext().close();
    const B2 = await mk('小美2');
    await join(B2, '小美');
    autoplay.add(B2);
    results.newdevice = await verify(B2, '小美', 'new browser, same name → same seat');
    const h1 = await hostSeat('小美');
    log('seat kept:', h0.seat === h1.seat, 'players', h1.n);
  } else if (s === 'host') {
    log('--- host page frozen 25s');
    await host.cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await sleep(25000);
    await host.cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await host.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const a = await verify(A, '阿杰', 'host back A');
    const bb = [...autoplay].find((p) => p.tag.startsWith('小美'));
    const b = await verify(bb, '小美', 'host back B');
    results.host = a && b;
  }
  await sleep(2500);
}
stop = true;
const audit = await host.evaluate(() => window.__holdem.ctrl.chipAudit());
log('RESULTS', JSON.stringify(results), 'buy-ins via dialog', JSON.stringify(buys), 'ledger', JSON.stringify(await host.evaluate(() => window.__holdem.view.ledger.map((r) => `${r.name}:${r.bought}/${r.stack}/${r.net}`))), 'audit', JSON.stringify(audit), 'errors', JSON.stringify(errors.slice(0, 10)));
await browser.close();
process.exit(Object.values(results).every(Boolean) && audit.ok ? 0 : 1);
