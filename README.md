# Kootenay Browser

A color-managed review browser for macOS. Declare how a video was graded
("this file was uploaded in Gamma 2.4") and the browser applies a per-channel
correction so Vimeo, YouTube, and Frame.io playback matches the mastering
intent — cancelling the gamma shift macOS applies to tagged BT.709 video.

Built on the findings of *Gamma Encoding for Accurate Web Delivery*
(N. Regier, 2026): platforms are color-neutral (Vimeo strips NCLC tags,
Frame.io ignores them), so the entire shift is OS/browser interpretation and
can be measured once and cancelled exactly.

## How it works

- A preload script attaches an SVG `feComponentTransfer` table filter
  (256-tap per-channel LUT) to every `<video>` element. GPU-composited, no
  pixel readback, works on top of any site's player.
- The LUT is `f = m* ∘ C⁻¹`: `C` is the measured identity curve of the
  filtered-video path (what the pipeline does to authored code values), and
  `m*(v) = srgbOetf(EOTF_source(v))` is the framebuffer value that reproduces
  the mastering luminance on the sRGB-TRC display.
- **Measured on this machine:** Chromium interprets the BT.709 transfer tag
  at an effective γ ≈ 2.21 on the filtered path (not the ~1.96 overlay-path
  value). Correction verified at RMS 0.41/255 against the white paper's
  display targets (uncorrected: 6.6).

## Use

```
npm install
npm start
```

Pick a gamma in the **Color Pipeline** popover (top right). The choice is
remembered per domain. Type `probe` in the URL bar for the test-patch page;
"Calibrate this display…" in the popover re-measures the pipeline and bakes a
machine profile (`userData/calibration.json`).

## Install

- **From the DMG** (`npm run dmg` → `out/Kootenay-Browser.dmg`): open it, drag
  **Kootenay Browser** onto **Applications**. Universal binary — runs on both
  Apple Silicon and Intel Macs. Electron is bundled; the browser and all
  color-correction features (Simple, Measured via screen probe or imported
  data) need **no external dependencies**.
- First launch on another Mac: it's ad-hoc signed, not Apple-notarized, so
  Gatekeeper will ask — **right-click the app → Open** once (or run
  `xattr -cr "/Applications/Kootenay Browser.app"`). After that it opens
  normally.
- Dev install to /Applications without a DMG: `npm run install-app`.

The **only** feature needing an external dependency is the optional i1 hardware
probe, which uses ArgyllCMS (`brew install argyll`). Everything else is
self-contained.

## Hardware probe (i1 Display Pro Plus)

Color Settings → current display → **Measure with hardware probe…** Requires
ArgyllCMS (`brew install argyll`) and the probe on the panel being profiled.
A fullscreen BT.709 patch video runs white-ref → 100→0% → drift check (±2%
gate), optionally applies a probe-correction JSON (Custom Probe Measurement
format), saves a physical-light profile for that display, then re-measures
with the correction live and reports light-domain % error vs the Gamma 2.4
intent.

## Dev

```
npm test                    # color math + probe driver unit tests
npm run measure             # framebuffer pipeline measurement, prints RMS
npx electron . --smoke      # loads Vimeo + YouTube, verifies filter attachment
npx electron . --probe-sim  # full hardware-probe flow vs scripted simulator
python3 scripts/make_patches.py       # regenerate the BT.709 probe video
python3 scripts/make_step_patches.py  # regenerate the probe step video
```

## Browser features

Tabs with favicons, loading spinners, audio 🔊/🔇 mute, middle-click close, and
a right-click menu (duplicate / close others / close-to-right / reopen). Full
app menu with standard shortcuts (⌘T/W/⇧T/R/L/F/D/Y, ⌘±, ⌘[ ], ⌘1–9).
**Session + window restore**, **bookmarks** (⌘D star + bar + manager page),
**history** (⌘Y page + frecency URL-bar suggestions), **find in page** (⌘F),
right-click page **context menus**, **downloads** (⌘⇧J page with progress +
completion notifications), a **New Tab page** (kootenay://newtab: search, top
sites, bookmarks, recent), **home page** setting, **per-site zoom** memory,
styled **error pages**, a loading progress bar, an HTTPS 🔒 / ⚠ security
indicator, HTML-fullscreen video, cmd/middle-click → background tab, and **Clear
Browsing Data** in Settings. Cookies/localStorage persist across launches.

**Security:** all browser permissions (camera, mic, geolocation, USB, …) are
denied by default — only fullscreen, pointer-lock, and sanitized clipboard-write
are allowed, which is all video review needs.

## Known limitations

- No Widevine: DRM content (Netflix etc.) won't play. Vimeo/YouTube/Frame.io
  review workflows are unaffected.
- Correction operates in 8-bit compositing; a LUT with strong slope can band
  on long gradients. For review purposes this is below noticeable.
- Picture-in-picture is disabled on corrected videos (PiP drops CSS filters).
