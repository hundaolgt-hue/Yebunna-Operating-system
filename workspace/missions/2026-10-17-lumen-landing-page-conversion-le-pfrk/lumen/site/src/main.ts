import './style.css';
import { CHECKOUT_URL, CHECKOUT_PENDING, PIXEL_ID, PIXEL_PENDING } from './config';

declare global {
  interface Window { fbq?: (...args: unknown[]) => void; _fbq?: unknown }
}

/* ---------- Meta Pixel (loads only once PIXEL_ID is a real ID) ---------- */
function initPixel(): void {
  if (PIXEL_PENDING) return;
  /* eslint-disable */
  (function (f: any, b: Document, e: string, v: string) {
    if (f.fbq) return;
    const n: any = (f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); });
    if (!f._fbq) f._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    const t = b.createElement(e) as HTMLScriptElement; t.async = true; t.src = v;
    const s = b.getElementsByTagName(e)[0]; s.parentNode!.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */
  window.fbq!('init', PIXEL_ID);
  window.fbq!('track', 'PageView');
}
function track(event: string, data?: Record<string, unknown>): void {
  if (!PIXEL_PENDING && window.fbq) window.fbq('track', event, data);
}
initPixel();

/* ---------- Buy buttons: every one reads CHECKOUT_URL from config.ts ---------- */
function withUtm(base: string): string {
  try {
    const target = new URL(base);
    new URLSearchParams(location.search).forEach((v, k) => {
      if (k.startsWith('utm_') || k === 'fbclid') target.searchParams.set(k, v);
    });
    return target.toString();
  } catch { return base; }
}
const buyLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-buy]'));
buyLinks.forEach((a) => {
  if (CHECKOUT_PENDING) {
    // Inert: no navigation, no 404. Visible state for the preview.
    a.setAttribute('href', '#checkout-pending');
    a.dataset.inert = 'true';
    a.setAttribute('aria-disabled', 'true');
    a.addEventListener('click', (e) => e.preventDefault());
  } else {
    a.href = withUtm(CHECKOUT_URL);
    a.rel = 'noopener';
    a.addEventListener('click', () => {
      track('InitiateCheckout', { content_name: 'EscaClaim', value: 2500, currency: 'ETB' });
    });
  }
});

/* ---------- Dev-only notice: preview builds + placeholder only ---------- */
if (__PREVIEW_BUILD__ && CHECKOUT_PENDING) {
  const note = document.createElement('div');
  note.className = 'pending-notice';
  note.textContent = 'dev: checkout link pending';
  document.body.appendChild(note);
}

/* ---------- Reveal on scroll (fires once) ---------- */
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const io = new IntersectionObserver((entries) => {
  entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
}, { threshold: 0.2, rootMargin: '0px 0px -10% 0px' });
document.querySelectorAll('.reveal').forEach((el) => (reduce ? el.classList.add('is-in') : io.observe(el)));

/* ---------- ViewContent once the hero is visible ---------- */
const hero = document.getElementById('hero')!;
const vc = new IntersectionObserver((en) => {
  if (en[0].isIntersecting) { track('ViewContent', { content_name: 'EscaClaim' }); vc.disconnect(); }
}, { threshold: 0.4 });
vc.observe(hero);

/* ---------- Hero video: sound toggle, reduced motion, pause when off-screen ---------- */
const hv = document.getElementById('hero-video') as HTMLVideoElement;
const snd = document.getElementById('sound') as HTMLButtonElement;
if (reduce) { hv.removeAttribute('autoplay'); hv.pause(); hv.controls = true; }
snd.addEventListener('click', () => {
  hv.muted = !hv.muted;
  snd.setAttribute('aria-pressed', String(!hv.muted));
  if (!hv.muted) hv.play().catch(() => undefined);
});
new IntersectionObserver((en) => {
  if (reduce) return;
  en[0].isIntersecting ? hv.play().catch(() => undefined) : hv.pause();
}, { threshold: 0.25 }).observe(hv);

/* ---------- Sticky bar: shows once the hero CTA leaves view, hides near final CTA ---------- */
const sticky = document.getElementById('sticky')!;
const heroCta = hero.querySelector('.cta-row')!;
const finalSec = document.getElementById('final')!;
let heroOut = false, finalIn = false;
const upd = () => {
  const on = heroOut && !finalIn;
  sticky.classList.toggle('show', on);
  sticky.setAttribute('aria-hidden', String(!on));
  sticky.querySelector('a')!.tabIndex = on ? 0 : -1;
};
new IntersectionObserver((en) => { heroOut = !en[0].isIntersecting; upd(); }).observe(heroCta);
new IntersectionObserver((en) => { finalIn = en[0].isIntersecting; upd(); }).observe(finalSec);

/* ---------- Header hides on scroll down ---------- */
const header = document.querySelector<HTMLElement>('.site-header')!;
let lastY = 0;
addEventListener('scroll', () => {
  const y = scrollY; header.classList.toggle('hide', y > lastY && y > 200); lastY = y;
}, { passive: true });
