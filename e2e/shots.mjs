// usage: node shots.mjs <url> <prefix>   -> /workspace/holdem-shots/<prefix>-mobile.png, <prefix>-desktop.png
import puppeteer from 'puppeteer-core';
const [url, prefix] = [process.argv[2], process.argv[3]];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const errors = [];
async function shoot(vp, name) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: `/workspace/holdem-shots/${prefix}-lobby-${name}.png` });
  await page.$eval('#nick', (e) => { e.value = 'Kunyi'; });
  await page.select('#solo-bots', '5');
  await page.evaluate(() => document.querySelector('#btn-solo').click());
  const t0 = Date.now();
  let done = false;
  while (!done && Date.now() - t0 < 180000) {
    await new Promise((r) => setTimeout(r, 300));
    const st = await page.evaluate(() => {
      const v = window.__holdem.view; if (!v) return {};
      const me = v.seats[window.__holdem.mySeat];
      return { board: v.board.length, phase: v.phase, myTurn: !!v.legal, inHand: me && me.inHand && !me.folded, bets: v.seats.filter((s) => s && s.bet > 0).length };
    });
    if (st.myTurn && st.board >= 3 && st.inHand) { await new Promise((r) => setTimeout(r, 900)); done = true; break; }
    if (st.myTurn) {
      // stay in the hand: check or call
      await page.evaluate(() => { const b = document.querySelector('[data-act=check],[data-act=call]'); b && b.click(); });
    }
    const rb = await page.$('#btn-rebuy'); if (rb) await page.evaluate((e) => e.click(), rb);
  }
  await page.screenshot({ path: `/workspace/holdem-shots/${prefix}-${name}.png` });
  console.log(name, done ? 'mid-hand (flop+, my turn)' : 'timeout');
  await page.close();
}
await shoot({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, 'mobile');
await shoot({ width: 1280, height: 800, deviceScaleFactor: 1 }, 'desktop');
console.log('errors', errors);
await browser.close();
