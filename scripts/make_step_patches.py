#!/usr/bin/env python3
"""Generate the hardware-probe step-patch video.

12 segments x 2 s (24 fps): signal 0..100% in 10% steps ascending (segments
0-10), plus a repeated white segment (11) for the drift check. Each frame is a
centered square patch field covering 20% of the frame area on a #494949
surround (the Custom Probe Measurement player convention — limits ABL and
uniformity error on OLED panels). The measurement window seeks to
`segment*2+1` seconds and pauses, so every patch renders through the real
BT.709 H.264 video pipeline.

Output: src/probe/assets/patch-steps-709.mp4 (libx264 qp 0, yuv420p limited
range, tagged bt709 1-1-1). Verified by decoding one frame per segment and
asserting the patch center is within ±1 code value.
"""
import math
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "src" / "probe" / "assets"

W, H = 1280, 720
FPS = 24
SEG_SECONDS = 2
SURROUND = 0x49  # 73 — ~18% gray surround
FIELD_SIDE = round(math.sqrt(0.20 * W * H))  # 20% of frame area, square

SIGNAL_PCTS = list(range(0, 101, 10))  # 0,10,...,100
LEVELS = [int(p * 255 / 100 + 0.5) for p in SIGNAL_PCTS]
SEGMENTS = LEVELS + [255]  # trailing white for the drift check


def build_frame(level: int) -> bytes:
    x0 = (W - FIELD_SIDE) // 2
    x1 = x0 + FIELD_SIDE
    y0 = (H - FIELD_SIDE) // 2
    y1 = y0 + FIELD_SIDE
    row_surround = bytes((SURROUND, SURROUND, SURROUND)) * W
    row_field = (
        bytes((SURROUND, SURROUND, SURROUND)) * x0
        + bytes((level, level, level)) * (x1 - x0)
        + bytes((SURROUND, SURROUND, SURROUND)) * (W - x1)
    )
    frame = bytearray()
    for y in range(H):
        frame += row_field if y0 <= y < y1 else row_surround
    return bytes(frame)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    out = ASSETS / "patch-steps-709.mp4"

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        concat_lines = []
        for i, level in enumerate(SEGMENTS):
            ppm = tmpdir / f"seg{i:02d}.ppm"
            ppm.write_bytes(b"P6\n%d %d\n255\n" % (W, H) + build_frame(level))
            concat_lines.append(f"file '{ppm}'\nduration {SEG_SECONDS}\n")
        # concat demuxer needs the last file repeated to honor its duration
        concat_lines.append(f"file '{tmpdir / f'seg{len(SEGMENTS)-1:02d}.ppm'}'\n")
        concat_file = tmpdir / "concat.txt"
        concat_file.write_text("".join(concat_lines))

        subprocess.run(
            [
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", str(concat_file),
                "-vf",
                f"fps={FPS},scale=in_range=full:out_range=tv:out_color_matrix=bt709",
                "-c:v", "libx264", "-preset", "slow", "-qp", "0",
                "-pix_fmt", "yuv420p",
                "-color_primaries", "bt709", "-color_trc", "bt709",
                "-colorspace", "bt709", "-color_range", "tv",
                str(out),
            ],
            check=True,
            capture_output=True,
        )

    errors = []
    for i, level in enumerate(SEGMENTS):
        t = i * SEG_SECONDS + 1
        dec = subprocess.run(
            [
                "ffmpeg", "-ss", str(t), "-i", str(out), "-frames:v", "1",
                "-vf", "scale=in_range=tv:out_range=full",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ],
            check=True,
            capture_output=True,
        ).stdout
        off = ((H // 2) * W + W // 2) * 3
        got = dec[off : off + 3]
        ok = all(abs(c - level) <= 1 for c in got)
        print(f"segment {i:2d} level {level:3d} @ {t}s -> {tuple(got)} {'OK' if ok else 'FAIL'}")
        if not ok:
            errors.append((i, level, tuple(got)))
    if errors:
        sys.exit(f"round-trip FAILED: {errors}")
    print(f"OK: {out.name} — {len(SEGMENTS)} segments, field {FIELD_SIDE}px, round-trips ±1")


if __name__ == "__main__":
    main()
