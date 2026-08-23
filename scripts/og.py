#!/usr/bin/env python3
"""Draw the social card and the favicon.

Both are artwork, not build output: they are rendered once, committed,
and served as static files. This script exists so that "once" is
repeatable — the framing, the type and the ink are parameters here
rather than a memory of what was done in an image editor.

    python3 scripts/og.py --out public

Needs Pillow and numpy, and the typeface (see FONT below). Neither is a
dependency of the worker; nothing at request time runs this.

The card is a paint-sumi render of the Bay of Naples with the title set
in the water. Two choices in it are worth keeping:

  framing   the field is fetched at z12 and *downsampled* to 1200x630,
            not fetched at z11. The bay and Vesuvio's pine forest do not
            both fit in a z12 screenful, and z11 draws the coast too
            coarsely to read at card size. Supersampling buys the wider
            field at the finer zoom's detail.

  type      the title is drawn a glyph at a time, because Pillow has no
            letter-spacing — and a glyph at a time throws away the
            kerning that raqm would otherwise apply. So the pair
            adjustments are measured back out of the font and re-applied
            by hand before the track is added. Without that, `Re` and
            `Pa` sit apart and the whole thing reads as a default.
"""

import argparse
import math
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# --- the card ---------------------------------------------------------

BASE = "https://papers.reearth.land"
STYLE = "paint-sumi"
TILE = 512

# Bay of Naples. Centre and field are in tandem: the field is what gets
# downsampled to 1200x630, so widening it zooms out without coarsening.
CENTRE = (40.810, 14.340)
ZOOM = 12
FIELD = (1740, 913)
CARD = (1200, 630)

# EB Garamond (SIL OFL 1.1), from Google Fonts. Only its rasterised
# output ships here, so nothing is redistributed — but the file has to
# be present to redraw the card.
FONT = os.environ.get("OG_FONT", "EB_Garamond.ttf")
TITLE = "Re:Earth Papers"
SIZE, TRACK = 112, 3.0        # px, and extra px between glyphs
ORIGIN = (52, 545)            # left edge, baseline
INK = (46, 42, 36)


def tile_xy(lat, lon, z):
    n = 2**z
    return ((lon + 180.0) / 360.0 * n,
            (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)


def field(cache):
    """Fetch and stitch FIELD pixels of tiles around CENTRE."""
    w, h = FIELD
    fx, fy = tile_xy(*CENTRE, ZOOM)
    left, top = fx * TILE - w / 2, fy * TILE - h / 2
    x0, x1 = math.floor(left / TILE), math.floor((left + w - 1) / TILE)
    y0, y1 = math.floor(top / TILE), math.floor((top + h - 1) / TILE)

    def get(xy):
        x, y = xy
        path = os.path.join(cache, f"{ZOOM}_{x}_{y}.png")
        if not os.path.exists(path):
            url = f"{BASE}/styles/{STYLE}/tile/{ZOOM}/{x}/{y}.png"
            req = urllib.request.Request(url, headers={"User-Agent": "papers-og"})
            with urllib.request.urlopen(req, timeout=180) as r:
                open(path, "wb").write(r.read())
        return xy, Image.open(path).convert("RGB")

    os.makedirs(cache, exist_ok=True)
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    canvas = Image.new("RGB", ((x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE))
    with ThreadPoolExecutor(8) as ex:
        for (x, y), im in ex.map(get, jobs):
            canvas.paste(im, ((x - x0) * TILE, (y - y0) * TILE))
    ox, oy = int(left - x0 * TILE), int(top - y0 * TILE)
    return canvas.crop((ox, oy, ox + w, oy + h)).resize(CARD, Image.LANCZOS)


def draw_title(im, text, font_path, size, track, origin, fill=INK):
    """Set `text` with the font's own kerning, then track it out.

    kern(a, b) = len(a + b) - len(a) - len(b) recovers the pair
    adjustment that a whole-string draw would have applied, which
    drawing a glyph at a time otherwise discards.
    """
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(font_path, size, layout_engine=ImageFont.Layout.RAQM)
    x, y = origin
    for i, ch in enumerate(text):
        d.text((x, y), ch, font=f, fill=fill, anchor="ls")
        adv = d.textlength(ch, font=f)
        if i + 1 < len(text):
            nxt = text[i + 1]
            adv += d.textlength(ch + nxt, font=f) - adv - d.textlength(nxt, font=f)
        x += adv + track
    return x - track - origin[0]


# --- the favicon ------------------------------------------------------
#
# 墨の一点 — one ink dot, bled into paper. An airbrushed disc is not what
# ink does; three things separate the two, and each is one-dimensional in
# polar coordinates, which is why the mark is built there:
#
#   edge    the boundary wanders with the brush, so the core radius is a
#           smooth function of angle rather than a constant
#   fibres  paper wicks along its grain, so the halo runs in radial
#           streaks — high frequency around the circle, low along it
#   rim     the wash retreats and leaves pigment behind, so the ink is
#           darkest just inside the edge, not at the centre
#
# Drawn at N and downsampled, so the 16px icon is a shrunken drawing and
# not a drawn 16px square.

N = 1024
PAPER = np.array([243, 240, 231], dtype=np.float32)
DOT_INK = np.array([32, 29, 25], dtype=np.float32)

# The chosen blot. Seed and shape are fixed rather than random: this is a
# logo, and it has to come back the same every time.
BLOT = dict(seed=3, core=0.29, bleed=0.055, wobble=0.17, rim=0.75)


def _polar_noise(n_theta, n_r, seed):
    """Noise over (theta, r), upscaled to NxN. Periodic around theta."""
    g = np.random.default_rng(seed).random((n_r, n_theta + 1))
    g[:, -1] = g[:, 0]                       # close the seam
    im = Image.fromarray((g * 255).astype(np.uint8)).resize((N, N), Image.BICUBIC)
    return np.asarray(im, dtype=np.float32) / 255.0


def _ring_noise(n, seed):
    """1-D periodic noise around the circle, as a length-N lookup."""
    g = np.empty((1, n + 1))
    g[0, :-1] = np.random.default_rng(seed).random(n)
    g[0, -1] = g[0, 0]
    im = Image.fromarray((g * 255).astype(np.uint8)).resize((N, 1), Image.BICUBIC)
    return np.asarray(im, dtype=np.float32)[0] / 255.0


def blot(seed, core, bleed, wobble, rim):
    y, x = np.mgrid[0:N, 0:N].astype(np.float32) / N
    dx, dy = x - 0.5, y - 0.5
    r = np.hypot(dx, dy)
    ti = np.clip(((np.arctan2(dy, dx) / (2 * np.pi)) % 1.0 * N).astype(np.int32), 0, N - 1)

    k = core * (1.0 + wobble * (_ring_noise(9, seed) - 0.5) * 2.0)[ti]
    b = bleed * (0.45 + 1.1 * _ring_noise(13, seed + 5)[ti])
    t = np.clip((r - k) / np.maximum(b, 1e-6), 0.0, 1.0)
    halo = (1.0 - t) ** 2.4

    fib = _polar_noise(110, 4, seed + 11)[
        np.clip(r / (core + bleed) * (N - 1), 0, N - 1).astype(np.int32), ti]
    halo *= 1.0 + (0.85 * fib - 0.42) * np.clip((t - 0.15) / 0.85, 0.0, 1.0)

    a = np.where(r <= k, 1.0, np.clip(halo, 0.0, 1.0))
    a = np.clip(a + np.exp(-((r - k) / (core * 0.10)) ** 2) * (r <= k) * rim * 0.35, 0, 1)

    mottle = np.asarray(
        Image.fromarray((np.random.default_rng(seed + 3).random((9, 9)) * 255)
                        .astype(np.uint8)).resize((N, N), Image.BICUBIC),
        dtype=np.float32) / 255.0
    return np.where(r <= k, a * (0.92 + 0.08 * mottle), a)


def favicon():
    a = blot(**BLOT)
    img = PAPER * (1 - a[..., None]) + DOT_INK * a[..., None]
    return Image.fromarray(img.astype(np.uint8), "RGB").filter(
        ImageFilter.GaussianBlur(N * 0.0015))


# --- ------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="public")
    ap.add_argument("--cache", default=".og-tiles", help="tile cache dir")
    ap.add_argument("--font", default=FONT)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    card = field(args.cache)
    draw_title(card, TITLE, args.font, SIZE, TRACK, ORIGIN)
    # Quantised: the render is warm grey almost everywhere, so 256
    # adaptive colours are visually identical and cost 40% less on the
    # wire. JPEG is smaller still but eats the paper grain in the water,
    # which on a card about paper is the wrong thing to lose.
    card.quantize(colors=256, dither=Image.FLOYDSTEINBERG).save(
        os.path.join(args.out, "og.png"), optimize=True)
    print("og.png")

    dot = favicon()
    # 180 is the apple-touch-icon; the .ico carries the sizes a browser
    # tab actually asks for.
    for size, name in ((512, "icon-512.png"), (180, "apple-touch-icon.png")):
        dot.resize((size, size), Image.LANCZOS).save(os.path.join(args.out, name))
        print(name)
    dot.resize((64, 64), Image.LANCZOS).save(
        os.path.join(args.out, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    print("favicon.ico")


if __name__ == "__main__":
    main()
