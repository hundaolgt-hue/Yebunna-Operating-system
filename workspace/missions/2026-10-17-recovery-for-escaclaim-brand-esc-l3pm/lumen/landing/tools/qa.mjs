// EscaClaim landing QA: screenshots (390 / 1440), every CTA -> CHECKOUT_URL, utm passthrough,
// no third-party requests (Pixel stub inactive), videos/slots, fonts. Writes lumen/qa/*.png + qa-report.json.
// Usage: node tools/qa.mjs <base-url> <out-dir> <node_modules-package.json>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [base, outDir, pkg] = process.argv.slice(2);
const require = createRequire(path.resolve(pkg));
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH;
fs.mkdirSync(outDir, { recursive: true });

const cfgSrc = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const CHECKOUT = /CHECKOUT_URL:\s*'([^']+)'/.exec(cfgSrc)[1];
const norm = (u) => new URL(u).toString();
const report = { checkout_config: CHECKOUT, runs: [] };
let fail = 0;
const check = (run, name, ok, detail) => { run.checks.push({ name, ok, detail }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${run.name}] ${name}${detail ? '  ' + detail : ''}`); };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });

for (const vp of [{ name: 'mobile-390', width: 390, height: 844, mobile: true }, { name: 'desktop-1440', width: 1440, height: 900, mobile: false }]) {
  const run = { name: vp.name, checks: [] };
  report.runs.push(run);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile });
  const page = await ctx.newPage();
  const requests = []; const consoleErr = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => { if (m.type() === 'error') consoleErr.push(m.text()); });
  page.on('pageerror', (e) => consoleErr.push(String(e)));

  // 1) plain load, first viewport (motion on)
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(outDir, `${vp.name}-hero.png`) });

  // 2) full page with every section revealed
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 80)); } window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(outDir, `${vp.name}-full.png`), fullPage: true });

  // mid-page viewport (sticky CTA bar on mobile)
  await page.evaluate(() => window.scrollTo({ top: document.getElementById('proof').offsetTop, behavior: 'instant' }));
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir, `${vp.name}-mid.png`) });
  if (vp.mobile) check(run, 'sticky CTA bar visible mid-page', await page.locator('#sticky.on').count() === 1, '');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  // fonts: the Ethiopic face is actually used
  const fontsOk = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'EC' && f.status === 'loaded').length; });
  check(run, 'EC (Noto Sans Ethiopic/Noto Sans) faces loaded', fontsOk >= 2, `${fontsOk} faces`);

  // CTAs
  const ctas = await page.$$eval('[data-cta]', (as) => as.map((a) => ({ id: a.dataset.cta, href: a.href, visible: !!(a.offsetWidth || a.offsetHeight) })));
  check(run, 'CTA count >= 5', ctas.length >= 5, ctas.map((c) => c.id).join(','));
  for (const c of ctas) check(run, `CTA ${c.id} href == CHECKOUT_URL`, c.href === norm(CHECKOUT), c.href);
  const allLinks = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
  const stray = allLinks.filter((h) => /^https?:/i.test(h) && !norm(h).startsWith(norm(CHECKOUT)));
  check(run, 'no other external links in the page', stray.length === 0, stray.join(' '));

  // click each visible CTA: the navigation goes to the checkout URL (intercepted: .invalid never resolves)
  let navOk = 0, navTried = 0;
  for (const c of ctas) {
    const p2 = await ctx.newPage();
    await p2.route('**/*', (route) => { const u = route.request().url(); if (u.includes('checkout-placeholder.invalid')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>checkout stub</title>' }); return route.continue(); });
    await p2.goto(base + '/', { waitUntil: 'networkidle' });
    const sel = `[data-cta="${c.id}"]`;
    if (c.id === 'sticky') { await p2.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)); await p2.waitForTimeout(700); }
    else {
      const hidden = await p2.$eval(sel, (a) => !!a.closest('[hidden]'));
      if (hidden) { await p2.close(); continue; }
      await p2.$eval(sel, (a) => a.scrollIntoView({ block: 'center' }));
    }
    await p2.waitForTimeout(900);
    const vis = await p2.locator(sel).isVisible();
    if (!vis) { await p2.close(); continue; }
    navTried++;
    const [nav] = await Promise.all([p2.waitForURL(/checkout-placeholder\.invalid/, { timeout: 5000 }).then(() => p2.url()).catch(() => null), p2.locator(sel).click()]);
    const log = await p2.evaluate(() => window.__escaclaimPixelLog || []).catch(() => ['(navigated)']);
    if (nav && nav.startsWith(norm(CHECKOUT))) navOk++;
    check(run, `click ${c.id} -> checkout`, !!nav && nav.startsWith(norm(CHECKOUT)), nav || 'no navigation');
    await p2.close();
  }
  check(run, 'every visible CTA navigates to the checkout', navTried > 0 && navOk === navTried, `${navOk}/${navTried}`);

  // utm passthrough
  const p3 = await ctx.newPage();
  await p3.goto(base + '/?utm_source=facebook&utm_campaign=escaclaim_test&fbclid=abc&other=1', { waitUntil: 'networkidle' });
  const hrefs = await p3.$$eval('[data-cta]', (as) => as.map((a) => a.href));
  check(run, 'utm_* + fbclid kept on every CTA, other params dropped', hrefs.every((h) => h.includes('utm_source=facebook') && h.includes('utm_campaign=escaclaim_test') && h.includes('fbclid=abc') && !h.includes('other=')), hrefs[0]);
  const pixLog = await p3.evaluate(() => window.__escaclaimPixelLog);
  check(run, 'pixel stub would log PageView + ViewContent (not sent)', pixLog.includes('PageView') && pixLog.includes('ViewContent'), pixLog.join(','));
  await p3.close();

  // network: same-origin only, nothing to facebook
  const third = requests.filter((u) => !u.startsWith(base) && !u.startsWith('data:'));
  check(run, 'no third-party requests (no live Pixel)', third.length === 0, third.slice(0, 3).join(' '));
  check(run, 'no console errors', consoleErr.length === 0, consoleErr.slice(0, 2).join(' | '));

  // video slots / videos
  const vids = await page.evaluate(() => [...document.querySelectorAll('[data-video]')].map((f) => { const v = f.querySelector('video'); return { id: f.id, video: !!v, src: v ? v.currentSrc : '', muted: v ? v.muted : null, playsInline: v ? v.playsInline : null, paused: v ? v.paused : null, t: v ? v.currentTime : 0, slot: !!f.querySelector('[data-slot]') }; }));
  for (const v of vids) check(run, `video ${v.id}: ${v.video ? 'mounted' : 'PENDING slot shown'}`, v.video ? (v.muted && v.playsInline) : v.slot, JSON.stringify(v));
  report.runs[report.runs.length - 1].videos = vids;

  // horizontal overflow
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(run, 'no horizontal overflow', overflow <= 0, `${overflow}px`);
  await ctx.close();
}
await browser.close();
report.fail = fail;
fs.writeFileSync(path.join(outDir, 'qa-report.json'), JSON.stringify(report, null, 2));
console.log(fail ? `QA: ${fail} FAIL` : 'QA: ALL PASS');
process.exit(fail ? 1 : 0);
