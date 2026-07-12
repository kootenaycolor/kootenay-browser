# Developing Kootenay Browser

Maintainer/build notes. End-user docs are in [README.md](README.md).

## Run from source

```
npm install
npm start
```

## How the correction works

- A preload attaches an SVG `feComponentTransfer` table filter (256-tap
  per-channel LUT) to every `<video>` element, delivered to **all frames** so
  cross-origin player embeds are corrected too. GPU-composited, no pixel
  readback, no CORS taint.
- LUT = `f = R⁻¹ ∘ T`, where `R` is the response being inverted and `T` the
  target:
  - **Simple** — display-blind transcode to a fixed target (Gamma 2.2 default):
    `f(v) = oetf(target, eotf(source, v))`.
  - **Measured** — invert the display's measured response to hit the mastering
    intent. Framebuffer profiles trust the display ICC; **light** profiles
    (hardware probe / imported physical-light data) capture the whole chain.
- Measured γ on the filtered video path is ≈2.2 (not the ~1.96 overlay-path
  value — applying a CSS filter forces the deterministic raster path).

There is intentionally **no screen-only "quick measure"**: `capturePage` reads
the framebuffer, not panel light, so its result is physically blind and its
self-verification circular. Measured mode is hardware-probe or import only.

## Hardware probe

`Measure with hardware probe…` drives an i1 Display Pro Plus via ArgyllCMS
`spotread` (protocol ported from the Custom Probe Measurement app). Fullscreen
BT.709 patch video: white-ref → 100→0% → drift check (±2% gate), optional
probe-correction (`Y_factor` by signal), saves a per-display light profile, then
a physical **verify pass** re-reads 80/60/30% under the correction vs `(v)^2.4`.
Requires `brew install argyll`.

## Build & distribute

```
npm run dmg          # universal (Intel + Apple Silicon) DMG → out/
npm run install-app  # build + copy to /Applications (arm64, dev convenience)
```

The DMG is ad-hoc signed (no Apple Developer ID). First launch on another Mac
needs right-click → Open; auto-updates strip quarantine so subsequent launches
don't prompt.

## Publishing an update (self-update to all installs)

```
npm run publish -- 0.2.0 "What changed"
```

Bumps `package.json` to the tag, builds the universal app + DMG, zips the `.app`,
and creates the GitHub release with both assets. Installed copies auto-update
(`updater.ts` polls `updateRepo` in package.json → downloads the zip → strips
quarantine → swaps the bundle in /Applications → relaunches; falls back to
opening the release page). The version and tag **must** match or the updater
re-offers the same build — the script enforces this.

macOS's built-in Squirrel updater is not used: it requires an Apple Developer ID
signature, which an ad-hoc build lacks. Getting a Developer ID would let us
switch to notarized Squirrel updates and drop the DIY swap + first-launch prompt.

## Tests & harnesses

```
npm test                     # color math, probe parsing, updater semver
npx electron . --smoke       # Vimeo + YouTube playback + filter attach
npx electron . --embed-check # filter reaches a cross-origin iframe video
npx electron . --probe-sim   # full hardware-probe flow vs scripted simulator
npx electron . --update-check# live GitHub release lookup
python3 scripts/make_patches.py       # regenerate the BT.709 probe video
python3 scripts/make_step_patches.py  # regenerate the probe step video
python3 scripts/make_icon.py          # regenerate the app icon
```

Other dev flags in `src/main/main.ts`: `--ui-check`, `--wizard-check`,
`--pages-check`, `--newtab-check`, `--panel-check`, `--qol-check`,
`--measure`, `--verify-screen`, `--probe-sim --with-correction`.

## Known limitations

- No Widevine → DRM video (Netflix, etc.) won't play.
- Correction is 8-bit; a strong-slope LUT can band on long gradients (below
  noticeable for review).
- Picture-in-picture is disabled on corrected videos (PiP drops CSS filters).
- Transfer/gamma only — gamut/primaries mapping stays ColorSync's job.
