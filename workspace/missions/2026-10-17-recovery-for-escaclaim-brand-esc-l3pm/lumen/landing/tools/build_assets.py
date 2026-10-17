"""Build the compressed page assets from Orion's handoff kit (read-only on the kit).

- Screenshots -> WebP at 2 widths (sharp on phones and on desktop).
- Solo cover  -> WebP.
- Fonts       -> WOFF2 subsets: Noto Sans Ethiopic (only the glyphs the page uses) + Noto Sans Latin basic.

Run from anywhere:  python -I tools/build_assets.py
"""
from pathlib import Path
import re, sys
from PIL import Image
from fontTools import subset

HERE = Path(__file__).resolve().parent.parent            # landing/
KIT = HERE.parent.parent / "orion-the-producer" / "handoff-to-lumen"
OUT_IMG = HERE / "assets" / "img"
OUT_FONT = HERE / "assets" / "fonts"
OUT_IMG.mkdir(parents=True, exist_ok=True)
OUT_FONT.mkdir(parents=True, exist_ok=True)

# source file -> (output stem, widths)
SHOTS = {
    "screenshots/escaclaim_1_claim_summary.png": ("claim-summary", (640, 1200)),
    "screenshots/escaclaim_03_checks_ready_to_print.png": ("checks", (800, 1600)),
    "screenshots/escaclaim_3_claim_letter.png": ("claim-letter", (640, 1200)),
    "screenshots/escaclaim_4_start_here.png": ("start-here", (640, 1200)),
    "screenshots/escaclaim_04_setup_coefficients.png": ("setup-coefficients", (800, 1600)),
    "screenshots/escaclaim_02_net_amount_claimed.png": ("net-amount", (800, 1600)),
    "covers/cover_square.png": ("cover-solo", (600, 1000)),
}

def build_images():
    for src, (stem, widths) in SHOTS.items():
        im = Image.open(KIT / src).convert("RGB")
        for w in widths:
            w2 = min(w, im.width)
            h2 = round(im.height * w2 / im.width)
            out = OUT_IMG / f"{stem}-{w}.webp"
            im.resize((w2, h2), Image.LANCZOS).save(out, "WEBP", quality=82, method=6)
            print(f"{out.relative_to(HERE)}  {w2}x{h2}  {out.stat().st_size/1024:.0f} KB")

def page_text():
    txt = ""
    for p in [HERE / "index.html", HERE / "config.js", HERE / "app.js"]:
        if p.exists():
            txt += p.read_text(encoding="utf-8")
    return txt

def build_fonts():
    fonts_src = HERE.parent.parent / "pixel-the-marketing-" / "fonts"
    latin_src = Path("C:/Windows/Fonts")
    text = page_text()
    ethi = sorted({c for c in text if 0x1200 <= ord(c) <= 0x139F or 0x2D80 <= ord(c) <= 0x2DDF})
    # always keep the Ethiopic punctuation + digits used in prices
    ethi_txt = "".join(ethi) + "።፣፤፥፦፧፨"
    latin_txt = "".join(chr(c) for c in range(0x20, 0x7F)) + "–—‘’“”•·×→←↓"
    jobs = [
        (fonts_src / "NotoSansEthiopic-Regular.ttf", "ethiopic-400.woff2", ethi_txt),
        (fonts_src / "NotoSansEthiopic-Bold.ttf", "ethiopic-700.woff2", ethi_txt),
        (latin_src / "NotoSans-Regular.ttf", "latin-400.woff2", latin_txt),
        (latin_src / "NotoSans-Bold.ttf", "latin-700.woff2", latin_txt),
    ]
    for src, name, chars in jobs:
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        f = subset.load_font(str(src), opts)
        s = subset.Subsetter(opts)
        s.populate(text=chars)
        s.subset(f)
        out = OUT_FONT / name
        subset.save_font(f, str(out), opts)
        print(f"{out.relative_to(HERE)}  {out.stat().st_size/1024:.1f} KB  ({len(set(chars))} chars)")
    return ethi

if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("all", "img"):
        build_images()
    if what in ("all", "fonts"):
        e = build_fonts()
        print("Ethiopic glyphs used on page:", len(e))
