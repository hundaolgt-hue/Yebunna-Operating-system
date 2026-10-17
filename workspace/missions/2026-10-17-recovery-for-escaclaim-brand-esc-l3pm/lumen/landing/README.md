# EscaClaim landing page (Amharic, DRAFT)

A static page (HTML/CSS/vanilla JS, no build step). Everything you need to change before going live is in **one file: `config.js`**.

```
landing/
  index.html      page markup (Amharic copy, Noto Sans Ethiopic)
  styles.css      design
  app.js          logic: CTA links, Pixel stub, videos, offer mode (reads config.js)
  config.js       THE ONLY FILE TO EDIT before launch
  vercel.json     cache + noindex headers
  assets/img      WebP screenshots (from real workbook crops), cover, share image
  assets/fonts    Noto Sans Ethiopic + Noto Sans, subset to the page's glyphs (WOFF2)
  assets/video    9:16 web cuts (added when Vega's final DRAFT videos pass QC)
  tools/          build_assets.py (images + fonts), compress_videos.py, qa.mjs (not deployed)
```

## 1. Swap the checkout link (one line)

Open `config.js` and replace the placeholder:

```js
CHECKOUT_URL: 'https://CHECKOUT-PLACEHOLDER.invalid',
```

with the real link, for example:

```js
CHECKOUT_URL: 'https://your-real-checkout-link',
```

That's it. Every buy button (nav, hero, offer, final, sticky mobile bar) reads this value at load time. No URL is hard-coded in `index.html` or `app.js`; the HTML fallback is `#offer`.

- The visitor's `utm_*` and `fbclid` parameters are copied onto the checkout link automatically.
- While the URL still contains `PLACEHOLDER` or `.invalid`, an amber "review page" ribbon stays on top. It disappears once the URL is real **and** `SHOW_DRAFT_RIBBON: false`.

## 2. Turn on the Meta Pixel (two lines)

The Pixel is an **inactive stub**. No Meta script loads and no event is sent. To go live:

```js
PIXEL_ID: '123456789012345',   // your numeric Pixel ID
PIXEL_ENABLED: true,
```

Both are required: the base code only loads when `PIXEL_ENABLED` is `true` **and** the ID is 6 to 20 digits. Once live, it sends:

| Event | When |
|---|---|
| `PageView` | page load |
| `ViewContent` | once the hero is on screen |
| `InitiateCheckout` | on any buy-button click, before the redirect (value + `ETB`) |

While it's off, those calls are only logged to the browser console as `[pixel stub, not sent]`.

## 3. Other switches in `config.js`

| Key | Now | Meaning |
|---|---|---|
| `OFFER` | `'solo'` | `'solo'` sells the calculator at `SOLO_PRICE_ETB`. `'kit'` sells the full Kit, but only if `KIT_PRICE_ETB` is a number. |
| `SOLO_PRICE_ETB` | `2500` | Confirmed price. |
| `KIT_PRICE_ETB` | `null` | **TBD by the founder.** While null, no Kit price shows anywhere and the Kit shows as "coming soon". Set it only after the founder confirms the price and the Kit zip is complete. |
| `HERO_VARIANT` | `'B'` | Echo's Kit-led headlines: A (speed), B (recover what you're owed), C (organised proof). |
| `VIDEO_60S_SRC` / `VIDEO_30S_SRC` | see file | Empty = the marked "VIDEO SLOT · PENDING" frame shows instead. |
| `SHOW_DRAFT_RIBBON` | `true` | Set to `false` for launch. |

Before launch, also remove `<meta name="robots" content="noindex, nofollow">` from `index.html` and the `X-Robots-Tag` header from `vercel.json` if you want the page indexed. Both are there on purpose so the draft stays out of search results.

## 4. Redeploy

```bash
cd landing
npx vercel@latest deploy            # preview (default)
# npx vercel@latest deploy --prod   # production: only when the founder says go
```

## 5. If you change Amharic text

The fonts are subset to the characters the page uses, which keeps them about 12 KB each. After you edit any Amharic copy, rebuild them so no glyph is missing:

```bash
python -I tools/build_assets.py fonts
```

## Rules this page follows
- Brand: EscaClaim only. No other store or platform name anywhere (copy, alt text, meta, file names, URLs, code).
- No phone number on the page.
- No testimonials and no invented numbers. The 739,445.60 ብር figure is the workbook's own illustrative example and is labelled as an example on the page.
- Videos: vertical 9:16, muted autoplay, `playsinline`, loop, with a poster frame. No voiceover.
