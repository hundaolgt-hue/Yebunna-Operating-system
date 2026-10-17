/* EscaClaim landing page logic. Reads everything from window.ESCACLAIM_CONFIG (config.js). */
(function () {
  'use strict';
  var C = window.ESCACLAIM_CONFIG || {};
  var doc = document;
  var root = doc.documentElement;

  /* ---------- Hero copy variants (Echo v2, DRAFT pending founder review) ---------- */
  var HERO = {
    A: ['የክሌም ኪት፦ ሰነድዎ በፍጥነት ዝግጁ',
        'EscaClaim የኮንትራክተር ሙሉ ኪት፦ ዝግጁ የኤክሴል ሠንጠረዦችና ቅጾች። ክሌምዎን በፍጥነት ያዘጋጁ።'],
    B: ['ያልተከፈለዎትን ገንዘብ በኪቱ ያስመልሱ',
        'EscaClaim የኮንትራክተር ሙሉ ኪት፦ የሚገባዎትን ክፍያ በትክክለኛ ስሌት ጠይቀው ያስመልሱ።'],
    C: ['ክሌምዎ በተደራጀ ማስረጃ፦ EscaClaim ኪት',
        'በEscaClaim የኮንትራክተር ሙሉ ኪት ክሌምዎን በግልጽ ስሌትና በተደራጁ ሰነዶች ያቅርቡ።']
  };
  var v = HERO[C.HERO_VARIANT] ? C.HERO_VARIANT : 'B';
  var h1 = doc.getElementById('hero-title');
  var sub = doc.getElementById('hero-sub');
  if (h1 && v !== h1.getAttribute('data-variant')) { h1.textContent = HERO[v][0]; sub.textContent = HERO[v][1]; h1.setAttribute('data-variant', v); }

  /* ---------- Offer mode + prices ---------- */
  var fmt = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  var kitReady = C.OFFER === 'kit' && typeof C.KIT_PRICE_ETB === 'number' && C.KIT_PRICE_ETB > 0;
  var mode = kitReady ? 'kit' : 'solo';
  root.setAttribute('data-offer', mode);
  doc.querySelectorAll('[data-when]').forEach(function (el) { el.hidden = el.getAttribute('data-when') !== mode; });
  var price = mode === 'kit' ? C.KIT_PRICE_ETB : (C.SOLO_PRICE_ETB || 2500);
  doc.querySelectorAll('[data-price]').forEach(function (el) { el.textContent = fmt(price) + ' ብር'; });
  doc.querySelectorAll('[data-price-num]').forEach(function (el) { el.textContent = fmt(C.SOLO_PRICE_ETB || 2500); });
  if (kitReady) doc.querySelectorAll('[data-kit-price-num]').forEach(function (el) { el.textContent = fmt(C.KIT_PRICE_ETB); });

  /* ---------- Checkout links: one URL from config, visitor utm_* kept ---------- */
  var placeholder = !C.CHECKOUT_URL || /PLACEHOLDER|\.invalid/i.test(C.CHECKOUT_URL);
  function checkoutHref() {
    var url;
    try { url = new URL(C.CHECKOUT_URL); } catch (e) { return '#offer'; }
    var here = new URLSearchParams(location.search);
    here.forEach(function (val, key) {
      if (/^utm_|^fbclid$/i.test(key) && !url.searchParams.has(key)) url.searchParams.set(key, val);
    });
    return url.toString();
  }
  var href = checkoutHref();
  doc.querySelectorAll('[data-cta]').forEach(function (a) {
    a.setAttribute('href', href);
    a.setAttribute('rel', 'noopener');
    a.addEventListener('click', function () { track('InitiateCheckout', { content_name: 'EscaClaim ' + mode, value: price, currency: 'ETB', cta: a.getAttribute('data-cta') }); });
  });

  /* ---------- Review ribbon (always on while the checkout is a placeholder) ---------- */
  var ribbon = doc.getElementById('ribbon');
  if (ribbon && (C.SHOW_DRAFT_RIBBON || placeholder)) ribbon.hidden = false;

  /* ---------- Meta Pixel: inactive stub unless enabled with a numeric ID ---------- */
  var pixelOn = C.PIXEL_ENABLED === true && /^\d{6,20}$/.test(String(C.PIXEL_ID || ''));
  var sent = [];
  function track(event, params) {
    sent.push(event);
    if (pixelOn && window.fbq) { window.fbq('track', event, params || {}); return; }
    if (window.console && console.debug) console.debug('[pixel stub, not sent]', event, params || {});
  }
  window.__escaclaimPixelLog = sent; // for QA only: lists what WOULD have been sent
  if (pixelOn) {
    /* Standard Meta Pixel base code (loads only when PIXEL_ENABLED is true). */
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, doc, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', String(C.PIXEL_ID));
  }
  track('PageView');

  /* ---------- Videos: real <video> only when a src is configured, else the marked slot stays ---------- */
  function mountVideo(fig, src, eager) {
    if (!fig || !src) return;
    var slot = fig.querySelector('[data-slot]');
    var poster = slot && slot.querySelector('img');
    var vid = doc.createElement('video');
    vid.muted = true; vid.defaultMuted = true; vid.loop = true; vid.playsInline = true; vid.autoplay = true;
    ['muted', 'loop', 'playsinline', 'autoplay'].forEach(function (a) { vid.setAttribute(a, ''); });
    vid.setAttribute('preload', eager ? 'auto' : 'none');
    vid.setAttribute('aria-label', fig.getAttribute('aria-label') || 'EscaClaim');
    if (poster) vid.setAttribute('poster', poster.currentSrc || poster.src);
    var start = function () { vid.src = src; vid.play().catch(function () { vid.setAttribute('controls', ''); }); };
    fig.innerHTML = ''; fig.appendChild(vid); fig.classList.add('has-video');
    if (eager) { start(); return; }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { io.disconnect(); start(); } }, { rootMargin: '200px' });
      io.observe(fig);
    } else start();
  }
  var startVideos = function () {
    mountVideo(doc.getElementById('hero-video'), C.VIDEO_60S_SRC, true);
    mountVideo(doc.getElementById('how-video'), C.VIDEO_30S_SRC, false);
  };
  if (doc.readyState === 'complete') startVideos(); else window.addEventListener('load', startVideos);

  /* ---------- ViewContent once the hero is visible ---------- */
  var hero = doc.getElementById('hero');
  var sticky = doc.getElementById('sticky');
  if ('IntersectionObserver' in window && hero) {
    var seen = false;
    new IntersectionObserver(function (es) {
      var e = es[0];
      if (e.isIntersecting && !seen) { seen = true; track('ViewContent', { content_name: 'EscaClaim ' + mode, value: price, currency: 'ETB' }); }
      if (sticky) {
        var show = !e.isIntersecting;
        sticky.classList.toggle('on', show);
        sticky.setAttribute('aria-hidden', show ? 'false' : 'true');
        var a = sticky.querySelector('a'); if (a) a.tabIndex = show ? 0 : -1;
      }
    }, { threshold: 0.15 }).observe(hero);
  }

  /* ---------- Entrances (content is visible without JS; .js adds the travel) ---------- */
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var items = doc.querySelectorAll('.r');
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
  } else {
    var groups = new Map();
    items.forEach(function (el) {
      var sec = el.closest('section') || doc.body;
      var i = groups.get(sec) || 0; groups.set(sec, i + 1);
      el.style.transitionDelay = Math.min(i, 6) * 75 + 'ms';
    });
    var rio = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); rio.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.01 });
    items.forEach(function (el) { rio.observe(el); });
  }

  /* ---------- The number counts up once (signature move) ---------- */
  var num = doc.getElementById('count');
  if (num && !reduce && 'IntersectionObserver' in window) {
    var to = parseFloat(num.getAttribute('data-to'));
    var nio = new IntersectionObserver(function (es) {
      if (!es[0].isIntersecting) return; nio.disconnect();
      var t0 = performance.now(), dur = 1600;
      var ease = function (t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); };
      (function step(now) {
        var t = Math.min(1, (now - t0) / dur), val = to * ease(t);
        num.textContent = val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (t < 1) requestAnimationFrame(step);
      })(t0);
    }, { threshold: 0.6 });
    nio.observe(num);
  }
})();
