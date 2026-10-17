/* EscaClaim landing page: the ONLY file to edit before going live.
 * Every buy button on the page reads CHECKOUT_URL from here. Nothing else is hard-coded.
 * See README.md for the exact steps. */
window.ESCACLAIM_CONFIG = {
  // 1) Checkout: replace this one line with the real checkout link.
  CHECKOUT_URL: 'https://CHECKOUT-PLACEHOLDER.invalid',

  // 2) Meta Pixel: inactive stub. Put the numeric ID here AND set PIXEL_ENABLED to true to go live.
  PIXEL_ID: 'PIXEL_ID_PLACEHOLDER',
  PIXEL_ENABLED: false,

  // 3) Offer. 'solo' = sell the calculator (confirmed price). 'kit' = sell the Contractor Complete Kit
  //    (only after the founder confirms the Kit price and the Kit zip is complete).
  OFFER: 'solo',
  SOLO_PRICE_ETB: 2500,
  KIT_PRICE_ETB: null, // TBD by the founder. Stays hidden while null.

  // 4) Hero headline: Echo's variant 'A' (speed), 'B' (recover money) or 'C' (organised proof).
  HERO_VARIANT: 'B',

  // 5) Videos (vertical 9:16, web-compressed). Empty src = the marked PENDING slot is shown.
  VIDEO_60S_SRC: '', // e.g. 'assets/video/escaclaim-60s-9x16.mp4'
  VIDEO_30S_SRC: '', // e.g. 'assets/video/escaclaim-30s-9x16.mp4'
  VIDEO_60S_POSTER: '', // e.g. 'assets/img/escaclaim-60s-9x16-poster.webp' (empty = screenshot poster)
  VIDEO_30S_POSTER: '',

  // 6) Review ribbon at the top of the page. Set to false before going live.
  SHOW_DRAFT_RIBBON: true
};
