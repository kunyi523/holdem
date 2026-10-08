// node shots3.mjs <url> <prefix>  -> /workspace/holdem-shots/v3/<prefix>-{mobile,desktop}-{lobby,midhand,raise,showdown}.png
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://localhost:8765/';
const prefix = process.argv[3] || 'v3';
const OUT = process.env.OUT || '/workspace/holdem-shots/v3';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shoot(vp, name) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on('pageerror', (e) => errors.push(name + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(900);
  await page.screenshot({ path: `${OUT}/${prefix}-${name}-lobby.png` });
  await page.$eval('#nick', (e) => { e.value = 'Kunyi'; });
  await page.evaluate(() => document.querySelector('#btn-solo').click());
  const t0 = Date.now();
  let mid = false, raise = false, sd = false, overlap = null;
  while (!(mid && sd) && Date.now() - t0 < 240000) {
    await sleep(250);
    const st = await page.evaluate(() => {
      const S = window.__holdem, v = S.view; if (!v) return {};
      const me = v.seats[S.mySeat];
      return { board: v.board.length, phase: v.phase, myTurn: !!v.legal, canRaise: v.legal && v.legal.canRaise, inHand: me && me.inHand && !me.folded,
        sd: v.result && v.result.showdown, meInSd: v.result && v.result.showdown && me && me.inHand && !me.folded,
        bets: v.seats.filter((s) => s && s.bet > 0).length };
    });
    if (!mid && st.myTurn && st.board >= 3 && st.inHand && st.bets >= 1) {
      await sleep(700);
      await page.screenshot({ path: `${OUT}/${prefix}-${name}-midhand.png` });
      overlap = await page.evaluate(() => {
        const top = document.querySelector('.topbar').getBoundingClientRect().bottom;
        let minTop = 1e9, who = '';
        document.querySelectorAll('#seats .seat, #seats .seat *').forEach((el) => { const r = el.getBoundingClientRect(); if (r.height && r.top < minTop) { minTop = r.top; who = el.className; } });
        return { topbarBottom: Math.round(top), highestSeatPixel: Math.round(minTop), el: String(who), overlaps: minTop < top };
      });
      mid = true;
      if (st.canRaise && !raise) {
        if (!(await page.evaluate(() => matchMedia('(min-width: 900px)').matches))) await page.click('#btn-raise');
        await sleep(250);
        await page.click('[data-q]:nth-child(2)');
        await sleep(300);
        await page.screenshot({ path: `${OUT}/${prefix}-${name}-raise.png` });
        raise = true;
      }
    }
    if (st.phase === 'handover' && st.sd && !sd && (st.meInSd || Date.now() - t0 > 120000)) {
      await sleep(1300);
      await page.screenshot({ path: `${OUT}/${prefix}-${name}-showdown.png` });
      sd = true;
    }
    if (st.myTurn) {
      // stay in the hand to reach showdowns: check or call
      await page.evaluate(() => { const b = document.querySelector('[data-act=check],[data-act=call]'); b && b.click(); });
    }
    const rb = await page.$('#btn-rebuy'); if (rb) await page.evaluate((e) => e.click(), rb);
  }
  console.log(name, { mid, raise, sd, overlap });
  await page.close();
}
await shoot({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, 'mobile');
await shoot({ width: 1280, height: 800, deviceScaleFactor: 1 }, 'desktop');
console.log('errors', errors);
await browser.close();
