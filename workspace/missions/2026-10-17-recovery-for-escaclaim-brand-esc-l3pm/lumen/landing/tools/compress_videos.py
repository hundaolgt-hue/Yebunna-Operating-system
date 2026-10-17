"""Web-compress Vega's 9:16 DRAFT masters for the landing page (read-only on the masters).

Usage (from anywhere):
  python -I tools/compress_videos.py <master.mp4> <stem> [poster_second]
  e.g. python -I tools/compress_videos.py ../../vega/videos/9x16/escaclaim-60s-9x16-DRAFT.mp4 escaclaim-60s-9x16 2.5

Writes:
  assets/video/<stem>.mp4        720x1280, H.264 High, 30 fps, yuv420p, AAC 96k 48 kHz stereo, +faststart,
                                 all source metadata stripped, title 'EscaClaim'
  assets/img/<stem>-poster.webp  720x1280 frame used as the <video> poster
Then checks: ffprobe spec, size budget (60s <= 8 MB, others <= 5 MB), and a byte scan for the phone number
and any non-EscaClaim store name.
"""
from pathlib import Path
import json, re, subprocess, sys

HERE = Path(__file__).resolve().parent.parent  # landing/
VID = HERE / "assets" / "video"
IMG = HERE / "assets" / "img"
BANNED = [rb"0912736754", rb"912736754", rb"yebunna", rb"ye-buna", rb"ye_buna", rb"yebuna"]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.exit(f"FAILED: {' '.join(cmd)}\n{r.stderr[-2000:]}")
    return r.stdout


def encode(src: Path, stem: str, poster_t: float):
    VID.mkdir(parents=True, exist_ok=True)
    IMG.mkdir(parents=True, exist_ok=True)
    dur = float(json.loads(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(src)]))["format"]["duration"])
    budget_mb = 8.0 if dur > 40 else 5.0
    # bitrate cap sized to the budget (leave room for 96k audio + container)
    v_kbps = int((budget_mb * 8 * 1024 * 0.92) / dur - 96)
    out = VID / f"{stem}.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
         "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
         "-vf", "scale=720:1280:flags=lanczos,format=yuv420p", "-r", "30",
         "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "24",
         "-maxrate", f"{v_kbps}k", "-bufsize", f"{v_kbps * 2}k", "-tune", "animation",
         "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2",
         "-metadata", "title=EscaClaim", "-movflags", "+faststart", str(out)])
    poster = IMG / f"{stem}-poster.webp"
    run(["ffmpeg", "-y", "-v", "error", "-ss", str(poster_t), "-i", str(src), "-frames:v", "1",
         "-vf", "scale=720:1280:flags=lanczos", "-c:v", "libwebp", "-quality", "80", str(poster)])
    return out, poster, budget_mb


def check(out: Path, poster: Path, budget_mb: float):
    p = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(out)]))
    v = next(s for s in p["streams"] if s["codec_type"] == "video")
    a = [s for s in p["streams"] if s["codec_type"] == "audio"]
    size_mb = out.stat().st_size / 1048576
    raw = out.read_bytes().lower() + poster.read_bytes().lower()
    hits = [b.decode() for b in BANNED if b in raw]
    head = out.read_bytes()[:4096]
    faststart = head.find(b"moov") != -1 and (head.find(b"mdat") == -1 or head.find(b"moov") < head.find(b"mdat"))
    rows = [
        ("resolution 720x1280 (9:16)", (v["width"], v["height"]) == (720, 1280)),
        ("H.264 High yuv420p", v["codec_name"] == "h264" and v.get("profile") == "High" and v["pix_fmt"] == "yuv420p"),
        ("30 fps", v["r_frame_rate"] in ("30/1", "30000/1000")),
        ("audio AAC 48 kHz stereo present", bool(a) and a[0]["codec_name"] == "aac" and a[0]["sample_rate"] == "48000" and a[0]["channels"] == 2),
        (f"size {size_mb:.2f} MB <= {budget_mb} MB", size_mb <= budget_mb),
        ("faststart (moov first)", faststart),
        ("metadata stripped (title EscaClaim only)", p["format"].get("tags", {}).get("title") == "EscaClaim" and "comment" not in p["format"].get("tags", {})),
        ("byte scan phone/old name: 0 hits", not hits),
        (f"poster {poster.stat().st_size / 1024:.0f} KB", poster.stat().st_size < 150 * 1024),
    ]
    ok = all(r[1] for r in rows)
    print(f"\n{out.relative_to(HERE)}  duration {float(p['format']['duration']):.2f}s")
    for name, good in rows:
        print(f"  [{'x' if good else ' '}] {name}")
    print("  RESULT:", "PASS" if ok else f"FAIL {hits}")
    return ok


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src = Path(sys.argv[1]).resolve()
    t = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
    sys.exit(0 if check(*encode(src, sys.argv[2], t)) else 1)
