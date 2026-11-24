"""
Generates desktop/StemForge.ico and public/ PNG icons from the StemForge logo (same design as
public/favicon.svg): a glowing amber guitar pick (the "forge") on a dark rounded tile, with five
separated "stem" bars cut out of it. Small sizes use three wider bars so the mark stays legible.

Pure numpy (no Pillow / cairo): 4x4 supersampled rasterizer + PNG-compressed ICO entries.
usage: python make_icon.py [out.ico]
"""

import struct
import sys
import zlib
from pathlib import Path

import numpy as np

SS = 4  # supersampling per axis


def hexrgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255.0


def cubic(p0, p1, p2, p3, n=48):
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t**2 * p2 + t**3 * p3


# pick outline (same path as favicon.svg)
P = [np.array(p, dtype=np.float64) for p in (
    (128, 226), (101, 199), (46, 139), (46, 93),
    (46, 55), (84, 32), (128, 32),
    (172, 32), (210, 55), (210, 93),
    (210, 139), (155, 199), (128, 226),
)]
PICK = np.vstack([cubic(P[0], P[1], P[2], P[3]), cubic(P[3], P[4], P[5], P[6]), cubic(P[6], P[7], P[8], P[9]), cubic(P[9], P[10], P[11], P[12])])

BARS_FULL = [(77, 98, 14, 44), (98, 74, 14, 92), (121, 60, 14, 128), (144, 80, 14, 80), (165, 102, 14, 36)]
BARS_SMALL = [(92, 86, 22, 70), (117, 58, 22, 126), (142, 92, 22, 58)]
BARS_TINY = [(86, 84, 26, 64), (115, 54, 26, 124), (144, 90, 26, 52)]


def inside_polygon(x, y, poly):
    """Even-odd point-in-polygon for arrays of points."""
    inside = np.zeros(x.shape, dtype=bool)
    xs, ys = poly[:, 0], poly[:, 1]
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi, xj, yj = xs[i], ys[i], xs[j], ys[j]
        cond = (yi > y) != (yj > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi
        inside ^= cond & (x < xint)
        j = i
    return inside


def inside_rrect(x, y, x0, y0, w, h, r):
    cx = np.clip(x, x0 + r, x0 + w - r)
    cy = np.clip(y, y0 + r, y0 + h - r)
    return (x >= x0) & (x <= x0 + w) & (y >= y0) & (y <= y0 + h) & ((x - cx) ** 2 + (y - cy) ** 2 <= r * r)


def gradient(t, stops):
    t = np.clip(t, 0, 1)
    out = np.zeros(t.shape + (3,))
    for (a, ca), (b, cb) in zip(stops[:-1], stops[1:]):
        m = (t >= a) & (t <= b)
        u = ((t[m] - a) / (b - a))[:, None]
        out[m] = (1 - u) * ca + u * cb
    return out


def render(size: int) -> np.ndarray:
    n = size * SS
    s = (np.arange(n) + 0.5) / n * 256.0
    x, y = np.meshgrid(s, s)
    rgb = np.zeros((n, n, 3))
    alpha = np.zeros((n, n))

    tile = inside_rrect(x, y, 0, 0, 256, 256, 58)
    rgb[tile] = gradient(y[tile] / 256.0, [(0, hexrgb("#262B35")), (1, hexrgb("#0B0D10"))])
    alpha[tile] = 1.0
    if size >= 48:  # faint rim light
        rim = tile & ~inside_rrect(x, y, 4, 4, 248, 248, 54)
        rgb[rim] = rgb[rim] * 0.93 + 0.07
    # tiny icons: the pick fills more of the tile so it stays readable
    z = 1.22 if size <= 20 else 1.0
    x = 128 + (x - 128) / z
    y = 129 + (y - 129) / z
    # forge glow (radial, clipped to the tile)
    d = np.sqrt((x - 128) ** 2 + (y - 178) ** 2) / 118.0
    ga = np.where(tile, 0.35 * np.clip(1 - d, 0, 1), 0)[..., None]
    rgb = rgb * (1 - ga) + hexrgb("#F59E0B") * ga

    pick = inside_polygon(x, y, PICK)
    p0, p1 = np.array([78.8, 32.0]), np.array([169.0, 226.0])
    v = p1 - p0
    t = ((x - p0[0]) * v[0] + (y - p0[1]) * v[1]) / float(v @ v)
    heat = gradient(t[pick], [(0, hexrgb("#FDE68A")), (0.45, hexrgb("#F59E0B")), (1, hexrgb("#DC2626"))])
    rgb[pick] = heat
    alpha[pick] = 1.0

    bars = BARS_TINY if size <= 20 else BARS_SMALL if size <= 24 else BARS_FULL
    cut = np.zeros_like(pick)
    for bx, by, bw, bh in bars:
        cut |= inside_rrect(x, y, bx, by, bw, bh, bw / 2)
    rgb[cut] = hexrgb("#14171D")

    # downsample (premultiplied)
    pre = rgb * alpha[..., None]
    pre = pre.reshape(size, SS, size, SS, 3).mean(axis=(1, 3))
    a = alpha.reshape(size, SS, size, SS).mean(axis=(1, 3))
    col = np.where(a[..., None] > 0, pre / np.maximum(a[..., None], 1e-9), 0)
    out = np.dstack([np.clip(col * 255 + 0.5, 0, 255), np.clip(a * 255 + 0.5, 0, 255)]).astype(np.uint8)
    return out


def png(img: np.ndarray) -> bytes:
    h, w = img.shape[:2]
    raw = b"".join(b"\x00" + img[r].tobytes() for r in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main() -> None:
    here = Path(__file__).resolve().parent
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "StemForge.ico"
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    images = [png(render(s)) for s in sizes]
    out = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    for s, img in zip(sizes, images):
        out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(img), offset)
        offset += len(img)
    out += b"".join(images)
    dest.write_bytes(out)
    print("wrote", dest, len(out), "bytes")
    public = here.parent / "public"
    if public.is_dir():
        (public / "favicon.ico").write_bytes(out)
        for s, name in ((180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")):
            (public / name).write_bytes(png(render(s)))
        print("wrote public/favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png")


if __name__ == "__main__":
    main()
