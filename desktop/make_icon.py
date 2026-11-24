"""Generates desktop/StemForge.ico (amber rounded square with stem 'waveform' bars).
Pure-Python (no Pillow): draws RGBA pixels and writes PNG-compressed ICO entries."""
import struct, zlib, sys
from pathlib import Path

def render(size):
    px = bytearray(size * size * 4)
    r = size * 0.22  # corner radius
    bars = [0.35, 0.7, 0.5, 0.9, 0.6, 0.8, 0.4]
    colors = [(244, 63, 94), (245, 158, 11), (56, 189, 248), (167, 139, 250), (52, 211, 153), (245, 158, 11), (244, 63, 94)]
    n = len(bars); pad = size * 0.16; gap = size * 0.035
    bw = (size - 2 * pad - gap * (n - 1)) / n
    for y in range(size):
        for x in range(size):
            cx = min(max(x + 0.5, r), size - r); cy = min(max(y + 0.5, r), size - r)
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
            a = max(0.0, min(1.0, r - d + 0.5))
            if a <= 0: continue
            col = (19, 22, 28)
            for i, h in enumerate(bars):
                x0 = pad + i * (bw + gap); hh = h * (size - 2 * pad)
                y0 = (size - hh) / 2
                if x0 <= x + 0.5 <= x0 + bw and y0 <= y + 0.5 <= y0 + hh:
                    col = colors[i]; break
            o = (y * size + x) * 4
            px[o:o + 4] = bytes((*col, int(a * 255)))
    return px

def png(size, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

sizes = [16, 24, 32, 48, 64, 128, 256]
images = [png(s, render(s)) for s in sizes]
out = struct.pack("<HHH", 0, 1, len(sizes)); offset = 6 + 16 * len(sizes)
for s, img in zip(sizes, images):
    out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(img), offset); offset += len(img)
out += b"".join(images)
dest = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("StemForge.ico"))
dest.write_bytes(out); print("wrote", dest, len(out), "bytes")
