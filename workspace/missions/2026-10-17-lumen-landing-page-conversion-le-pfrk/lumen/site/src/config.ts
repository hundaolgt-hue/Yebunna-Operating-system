/**
 * SINGLE SOURCE OF TRUTH for the checkout destination and the Meta Pixel ID.
 * Nothing else in the project may contain a checkout link or a pixel ID.
 * See missions/.../lumen/CHECKOUT-SWAP.md for the swap steps.
 */
export const CHECKOUT_URL = '{{CHECKOUT_URL}}';
export const PIXEL_ID = '{{PIXEL_ID}}';

/** True while a placeholder is still in place (derived; do not edit). */
export const CHECKOUT_PENDING = CHECKOUT_URL.includes('{{');
export const PIXEL_PENDING = PIXEL_ID.includes('{{');
