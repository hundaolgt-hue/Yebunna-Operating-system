// House skills: the founder's standing standards, written once and given in full to the
// bots they apply to (they are never left out of a prompt). They show up in Skills, where
// the founder can edit them; an edited house skill is never overwritten by an app update.
import { state, save, now } from './store.js';

const CREATIVE = `## The bar
Every image and video must look like a Fortune 500 product launch ad (Apple, Samsung, Nike, Mercedes-Benz):
restrained, confident, expensive. If a frame would not run in a global launch campaign, redo it.
- One idea per frame. Generous negative space. A strict grid and alignment.
- Cinematic light: soft key light, deep shadows, subtle reflections, controlled highlights.
  Clean light backgrounds or matte dark ones, never busy.
- Product hero shots: premium 3D renders or device mockups showing the real product (screens, sheets, files).
- Colour: one base, one accent (two at most), from the brand palette. Subtle film grain or gradients are
  fine; neon, rainbow or clip-art palettes are not.
- Typography: one family, two weights at most, big type, tight tracking on headlines. Never more than ~12
  words on screen at once.
- Never use: stock-photo clichés, emojis, starbursts, "SALE!!!" badges, drop shadows on text, more than one
  font family, crowded layouts, or low-resolution assets.

## Inspiration (study, never copy)
- Motion design: motionin.design (curated motion work: kinetic typography, masked reveals, smooth
  transitions) and Motion Array stock motion graphics (motionarray.com/stock-motion-graphics: modern
  transitions, title reveals, product promo pacing). Motion Array assets are licensed: use it as a
  reference for pacing and transitions only, and never download or reuse its files unless the founder
  says they have a licence.
- Aesthetics: savee.com (curated moodboards: editorial composition, refined colour and typography,
  premium photography).
- The founder's own samples come first: if the task points to files in references/ (or the founder sent
  samples), study every one of them (images with Read; videos frame by frame, see your instructions) and
  match their style, pacing, colour and type closely, while making the content original.
- Before a new campaign, look at a few references (web search, WebFetch or the browser, if you have
  them; some of these sites block bots, so fall back on the principles above). Write 3 lines on what
  you take from them (motion, composition, colour), then create original work.

## Motion (videos)
- Easing: expo or cubic in-out, never linear. Movements are smooth and deliberate: masked text reveals,
  slow push-ins, parallax, light sweeps, clean match cuts.
- Hook in the first 1–2 seconds (the product or the payoff, not a logo). One message per scene.
  3–5 scenes. 15–30 seconds (6–15 s cutdowns for Stories). End card: product + Amharic call to action +
  logo, held 2 s or more.

## Facebook / Instagram ad formats
VIDEOS: vertical only.
- Master 9:16, 1080×1920 (Reels, Stories). Also export a 4:5 1080×1350 cut for Feed when the task is for ads.
- MP4, H.264 High, 30 fps (60 fps for smooth motion graphics), yuv420p, AAC 48 kHz stereo,
  about -14 LUFS, under 100 MB, +faststart.
- Safe zones for 9:16: keep all text, logos and CTAs out of the top 14% (270 px) and the bottom 35%
  (670 px), and 6% (65 px) in from the sides.
IMAGES: always deliver the ad set.
- 1:1 1080×1080 (Feed), 4:5 1080×1350 (Feed, recommended), 9:16 1080×1920 (Stories/Reels, same safe zones).
- Add 1.91:1 1200×628 only when a task asks for link or right-column ads.
- PNG or high-quality JPG, sRGB, under 30 MB. Keep text to about 20% of the image area or less.
- Name files <product>_<format>_<WxH>.<ext>, e.g. profitcheck_feed-4x5_1080x1350.png.

## Language: Amharic
- All on-screen text in videos, and image headlines and CTAs, are in Amharic (Ge'ez script), unless a
  task says otherwise. Keep it short, natural and correct; prices in ብር.
- Never let an AI image or video model draw Amharic text: it comes out garbled. Generate visuals with no
  text, then add the Amharic text yourself as an overlay (HTML/CSS rendered with Playwright, Remotion, or
  ffmpeg drawtext) using Noto Sans Ethiopic, Noto Serif Ethiopic or Abyssinica SIL.
- Check every frame with Amharic text: no empty boxes or broken glyphs, and correct spelling.

## Sound: no voice
- No voiceover, narration, singing or spoken words, in any language.
- Use only sound effects (whooshes, soft risers, clicks, impacts, timed to the motion) and classical music.
- Classical music must be safe to use in ads: a public-domain composition in a public-domain or CC0
  recording (e.g. Musopen, the Internet Archive public-domain collections), or an original classical-style
  piece you generate (e.g. with Higgsfield audio or synthesis). Never use commercial recordings.
  Put the source and licence of every track in your deliverable.
- Mix: music bed under the effects, fade in and out, no clipping.

## Keep the disk clean
Rendering writes thousands of frames. Render frames and temporary files into a temp folder, and delete it
as soon as the MP4 is encoded and checked. Keep only the final videos, images and their sources (HTML,
scripts), never frame dumps, duplicate exports or downloaded models. Delete drafts the task didn't ask for.

## Check before you hand in
Check every file before delivering it: run ffprobe on videos (resolution, fps, codec, duration, audio
present) and use PIL on images (size). Grab 3–4 frames of each video, look at them for quality, safe
zones and Amharic rendering, and fix anything that falls short. List every file with its format and size.`;

const LANDING = `## Goal
A landing page that turns ad clicks into buyers on Ye-Buna. Every buy button sends the visitor to the
product's Ye-Buna checkout page. Never build your own payment form or collect card details.

## Before you build
- Get the exact Ye-Buna checkout URL for the product: from the task, your memory, or the founder. If you
  don't have it, end with "BLOCKED: … | NEED: the Ye-Buna checkout link for <product>". Never guess a link.
- Collect the team's assets for the product: the vertical ad videos and ad images (Vega, Pixel), the
  tutorial video, screenshots of the product, real numbers and copy (Echo). Follow the house creative
  standards for anything visual.

## Page (Amharic first, mobile first)
1. Hero: Amharic headline (the outcome), one-line subhead, the 9:16 ad video (autoplay, muted, loop,
   playsinline, with a poster image), and the primary CTA button.
2. Problem → outcome: 3 short points about the buyer's pain and what changes.
3. Tutorial: "how it works", using the tutorial video (with controls and a poster, lazy-loaded) and 3 steps.
4. Proof: real screenshots, real numbers, sample results. Never invent testimonials or fake numbers.
5. What you get, and the price in ብር, with the CTA.
6. FAQ (4–6 real questions), then a final CTA. On mobile, keep a sticky CTA bar at the bottom.

## Build
- A single static page (HTML/CSS/vanilla JS) in your folder. No framework unless the task asks for one.
  Fast: under 2 s on 4G, images in WebP, hero video under 8 MB, everything below the fold lazy-loaded.
- Fonts: Noto Sans Ethiopic (Amharic) plus one Latin family. Same premium look as the ads: restrained,
  lots of space, one accent colour.
- Every CTA: <a href="<Ye-Buna checkout URL>">, keeping the visitor's utm_* parameters on the link.
- Meta Pixel (when a pixel ID is given): PageView on load, ViewContent once the hero is visible,
  InitiateCheckout when a CTA is clicked, before the redirect.
- Deploy with the Vercel connection when you have it: a preview by default, production only when the
  task says so. Report the URL.

## Check before you hand in
Use the browser or Playwright to screenshot the page at 390 px and 1440 px wide. Click every CTA and
confirm each one opens the Ye-Buna checkout URL. Check that the videos play and the Amharic renders
correctly. List the page URL, the files, and the checkout link used.`;

export const HOUSE_SKILLS = [
  {
    id: 'house_creative_standards',
    version: 3,
    name: 'House creative standards (premium Facebook ads)',
    summary: 'Fortune 500 launch-ad quality; motion and aesthetic references; Facebook ad sizes; vertical video only; Amharic on-screen text; sound effects and classical music only, no voiceover.',
    body: CREATIVE,
    agentIds: ['design', 'creative', 'landing'],
  },
  {
    id: 'house_landing_pages',
    version: 1,
    name: 'Ye-Buna landing page standard',
    summary: 'High-converting Amharic landing pages with the ad and tutorial videos, every CTA going to the Ye-Buna checkout, Meta Pixel events, deployed on Vercel.',
    body: LANDING,
    agentIds: ['landing'],
  },
];

/** Add house skills, and update the ones the founder hasn't edited when a new version ships. */
export function seedHouseSkills() {
  for (const h of HOUSE_SKILLS) {
    const s = state.skills[h.id];
    if (s && (s.edited || (s.houseVersion || 0) >= h.version)) continue;
    state.skills[h.id] = {
      runs: 0,
      createdAt: now(),
      ...s,
      id: h.id,
      name: h.name,
      summary: h.summary,
      body: h.body,
      agentId: null,
      agentIds: s?.ownersEdited ? s.agentIds : h.agentIds,
      status: s?.status === 'draft' ? 'draft' : 'active', // keep it off if the founder turned it off
      source: 'house',
      house: true,
      houseVersion: h.version,
    };
  }
  save();
}
