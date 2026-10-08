import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(process.argv[2] || 'http://localhost:8765/', { waitUntil: 'networkidle0' });
await page.evaluate(() => { localStorage.setItem('holdem.lineup3', JSON.stringify([{style:'maniac'},{style:'rock'},{style:'tricky'},{style:'station'},{style:'regular'},{style:'tricky'},{style:'maniac'}])); });
await page.reload({ waitUntil: 'networkidle0' });
await page.$eval('#nick', (e) => { e.value = 'Kunyi'; });
await page.evaluate(() => document.querySelector('#btn-solo').click());
const t0 = Date.now(); let shot = false;
while (!shot && Date.now() - t0 < 120000) {
  await new Promise((r) => setTimeout(r, 250));
  const st = await page.evaluate(() => { const S = window.__holdem, v = S.view; const me = v.seats[S.mySeat]; return { my: !!v.legal, b: v.board.length, inHand: me.inHand && !me.folded }; });
  if (st.my && st.b >= 3 && st.inHand) { await page.screenshot({ path: '/workspace/holdem-shots/v3/v3-small-8max-reduced-motion.png' }); shot = true; }
  else if (st.my) await page.evaluate(() => { const b = document.querySelector('[data-act=check],[data-act=call]'); b && b.click(); });
}
const ov = await page.evaluate(() => { const out = []; document.querySelectorAll('#seats .seat').forEach((el) => { const r = el.getBoundingClientRect(); if (r.left < -2 || r.right > innerWidth + 2) out.push(el.className + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }); return out; });
console.log({ shot, offscreen: ov, errors });
await browser.close();
