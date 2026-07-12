#!/usr/bin/env python3
"""Generate the probe test-patch video used for pipeline gamma measurement.

Patch values mirror the white paper's Method B stimuli: authored code values
from a Rec.709 Gamma 2.4 export read 191/153/51 at 75/60/30% gray, plus black,
white, and a horizontal gradient strip for banding evaluation.

Output: src/probe/assets/patches-709.mp4 (H.264, yuv420p limited range,
tagged bt709/bt709/bt709 = NCLC 1-1-1), and patches.ppm reference frame.

The encode is verified by decoding back to RGB and asserting every patch
center is within ±1 code value of the authored value.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "src" / "probe" / "assets"

W, H = 1280, 720
PATCHES = [0, 51, 153, 191, 255]  # black, 30%, 60%, 75%, white
GRAD_TOP = 600  # gradient strip occupies y >= GRAD_TOP


def build_frame() -> bytes:
    row_patches = bytearray()
    col_w = W // len(PATCHES)
    for x in range(W):
        v = PATCHES[min(x // col_w, len(PATCHES) - 1)]
        row_patches += bytes((v, v, v))
    row_grad = bytearray()
    for x in range(W):
        v = round(x * 255 / (W - 1))
        row_grad += bytes((v, v, v))
    frame = bytearray()
    for y in range(H):
        frame += row_grad if y >= GRAD_TOP else row_patches
    return bytes(frame)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    frame = build_frame()
    ppm = ASSETS / "patches.ppm"
    ppm.write_bytes(b"P6\n%d %d\n255\n" % (W, H) + frame)

    out = ASSETS / "patches-709.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loop", "1", "-i", str(ppm),
            "-t", "60", "-r", "24",
            "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709",
            "-c:v", "libx264", "-preset", "slow", "-qp", "0",
            "-pix_fmt", "yuv420p",
            "-color_primaries", "bt709", "-color_trc", "bt709",
            "-colorspace", "bt709", "-color_range", "tv",
            str(out),
        ],
        check=True,
        capture_output=True,
    )

    # Round-trip verification: decode first frame back to full-range RGB.
    dec = subprocess.run(
        [
            "ffmpeg", "-i", str(out), "-frames:v", "1",
            "-vf", "scale=in_range=tv:out_range=full",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ],
        check=True,
        capture_output=True,
    ).stdout

    col_w = W // len(PATCHES)
    y_mid = GRAD_TOP // 2
    errors = []
    for i, want in enumerate(PATCHES):
        x_mid = i * col_w + col_w // 2
        off = (y_mid * W + x_mid) * 3
        got = dec[off : off + 3]
        if any(abs(c - want) > 1 for c in got):
            errors.append((want, tuple(got)))
        print(f"patch {want:3d} -> decoded {tuple(got)}")
    if errors:
        sys.exit(f"round-trip FAILED: {errors}")
    print(f"OK: {out.name} round-trips within ±1 code value")


if __name__ == "__main__":
    main()
