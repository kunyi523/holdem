import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.goto('http://localhost:8765/', { waitUntil: 'networkidle0' });
await page.screenshot({ path: '/workspace/holdem-shots/after-lobby-mobile.png' });
await page.$eval('#nick', (e) => { e.value = 'Kunyi'; });
await page.select('#solo-bots', '4');
await page.evaluate(() => document.querySelector('#btn-solo').click());
const t0 = Date.now(); let got = false; let betShot = false;
while (Date.now() - t0 < 150000 && !got) {
  await new Promise((r) => setTimeout(r, 200));
  const st = await page.evaluate(() => { const v = window.__holdem.view; return { phase: v.phase, sd: v.result && v.result.showdown, bets: v.seats.filter((s) => s && s.bet > 0).length, my: !!v.legal }; });
  if (!betShot && st.bets >= 2 && st.phase !== 'preflop') { await page.screenshot({ path: '/workspace/holdem-shots/after-mobile-bets.png' }); betShot = true; }
  if (st.phase === 'handover' && st.sd) { await new Promise((r) => setTimeout(r, 700)); await page.screenshot({ path: '/workspace/holdem-shots/after-mobile-showdown.png' }); got = true; }
  if (st.my) await page.evaluate(() => { const b = document.querySelector('[data-act=check],[data-act=call]'); b && b.click(); });
}
console.log('showdown captured', got, 'bets', betShot);
await browser.close();
