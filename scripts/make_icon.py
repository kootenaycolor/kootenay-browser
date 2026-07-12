#!/usr/bin/env python3
"""Generate build/icon.icns — a macOS app icon.

A rounded charcoal tile with a warm-accent gamma curve (the correction the app
applies), rendered at 1024px then compiled to .icns via macOS `iconutil`.
No third-party deps: draws a PNG by hand, builds the iconset, calls iconutil.
"""
import math
import struct
import subprocess
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
S = 1024

BG = (38, 38, 36)        # #262624 charcoal
TILE = (26, 25, 22)      # inner tile
ACCENT = (217, 119, 87)  # #d97757
GRID = (62, 61, 58)


def rounded(x, y, w, h, r):
    """Return True if pixel (x,y) is inside a rounded rect."""
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def build_png() -> bytes:
    px = bytearray(S * S * 4)

    def put(x, y, rgb, a=255):
        if 0 <= x < S and 0 <= y < S:
            o = (y * S + x) * 4
            px[o], px[o + 1], px[o + 2], px[o + 3] = rgb[0], rgb[1], rgb[2], a

    margin = 90
    tile = S - 2 * margin
    radius = 210

    # background rounded tile (full-bleed dark, inner tile slightly darker)
    for y in range(S):
        for x in range(S):
            if rounded(x, y, S, S, 230):
                put(x, y, BG)
    for y in range(margin, margin + tile):
        for x in range(margin, margin + tile):
            if rounded(x - margin, y - margin, tile, tile, radius):
                put(x, y, TILE)

    # faint reference grid + diagonal
    x0, y0 = margin + 120, S - margin - 120
    span = tile - 240
    for f in (0.25, 0.5, 0.75):
        gx = int(x0 + span * f)
        gy = int(y0 - span * f)
        for t in range(span):
            put(x0 + t, gy, GRID)
            put(gx, y0 - t, GRID)

    # gamma curve  y = x^2.4, thick accent stroke
    def curve_y(xf):
        return math.pow(xf, 2.4)

    steps = span * 3
    for i in range(steps + 1):
        xf = i / steps
        cx = x0 + xf * span
        cy = y0 - curve_y(xf) * span
        for dy in range(-9, 10):
            for dx in range(-9, 10):
                if dx * dx + dy * dy <= 81:
                    put(int(cx) + dx, int(cy) + dy, ACCENT)

    # PNG encode
    raw = bytearray()
    for y in range(S):
        raw.append(0)
        raw.extend(px[y * S * 4:(y + 1) * S * 4])

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)
    return (
        sig
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    BUILD.mkdir(exist_ok=True)
    master = BUILD / "icon-1024.png"
    master.write_bytes(build_png())

    iconset = BUILD / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    for s in sizes:
        for scale, suffix in ((1, ""), (2, "@2x")):
            px = s * scale
            if px > 1024:
                continue
            name = f"icon_{s}x{s}{suffix}.png"
            subprocess.run(
                ["sips", "-z", str(px), str(px), str(master), "--out", str(iconset / name)],
                check=True, capture_output=True,
            )
    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")],
        check=True,
    )
    print("wrote", BUILD / "icon.icns")


if __name__ == "__main__":
    main()
