# EscaClaim: swap in the real checkout link and Pixel ID

Both values live in **one file**: `lumen/site/src/config.ts`. Nothing else in the project may hold a checkout link or Pixel ID. Every buy button (header, hero, price, final CTA, sticky bar) and the Pixel `InitiateCheckout` event read from it.

1. **Get the two values.** The exact checkout URL for EscaClaim (from the founder; never guess it) and the numeric Meta Pixel ID (Events Manager).
2. **Edit `lumen/site/src/config.ts`** on a new branch. Replace only the two strings:
   ```ts
   export const CHECKOUT_URL = 'https://<the real checkout link>';
   export const PIXEL_ID = '<numeric pixel id>';
   ```
   Replacing `{{CHECKOUT_URL}}` turns the buttons live and removes the "checkout link pending" notice. Replacing `{{PIXEL_ID}}` turns on PageView, ViewContent and InitiateCheckout. Do not touch `index.html` or `main.ts`.
3. **Check locally** from `lumen/site`: `npm run build && npm run leakscan`. The scan must say `PASS: 0 findings` (the only checkout URL allowed is the one in `config.ts`; it may only appear in the built JS).
4. **Redeploy a preview** from `lumen/site`: `npx vercel@latest deploy` (no `--prod`; the project already exists, so this makes a preview). Previews sit behind Vercel login, so sign in first. Open the preview URL, click each buy button (header, hero, price, final, sticky) and confirm each opens the checkout. Confirm the three Pixel events in Meta Pixel Helper or Test Events.
5. **Commit and open a PR** (do not merge). Production (`--prod`) only after the founder approves the Amharic copy and this preview.
