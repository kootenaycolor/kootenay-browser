# Kootenay Browser

**A Mac browser that makes web video look right.**

When you send a review link — Vimeo, Frame.io, YouTube — the image usually comes
back **washed out**: lifted shadows, flat contrast, not what you graded. That's
not your grade. macOS misinterprets the color of web video, and every browser on
the Mac shows it wrong. There's nothing the viewer can do about it… in a normal
browser.

Kootenay Browser fixes it. Tell it how a clip was graded and it cancels the
shift, so what you see matches what left the suite.

---

## Install

1. Download **Kootenay-Browser.dmg** from the
   [latest release](https://github.com/kootenaycolor/kootenay-browser/releases/latest).
2. Open the DMG and drag **Kootenay Browser** onto **Applications**.
3. The first time you open it, **right-click the app → Open** (macOS warns
   because the app isn't from the App Store — this is expected). After that it
   opens normally.

Works on any Mac — Apple Silicon or Intel.

---

## Using it

Browse to your review link like you would in any browser. Then set the color:

1. Click the **color button** at the top-right of the toolbar.
2. Set **Method → Simple** and pick the **Source Gamma** the file was graded at
   (for most professional deliveries that's **Gamma 2.4**).
3. The image corrects instantly. Your choice is **remembered per site**, so
   every link from that platform is corrected from then on.

That's it for day-to-day use.

### Simple vs. Measured

- **Simple** — no setup, works on any display. It targets the standard web
  gamma (2.2), which gets you close to the grade on essentially any monitor.
  Use this by default.
- **Measured** — for a reference display you want to match *exactly*. It uses a
  hardware-probe reading (or measurements you import) to cancel that specific
  monitor's behavior precisely. See below.

The color button shows what's active (e.g. *"Gamma 2.4 → display"*), and a small
badge marks tabs that are being corrected.

---

## Matching a display exactly (optional, needs a probe)

If you have an **i1 Display Pro Plus** and want a reference-accurate match on a
calibrated monitor:

1. Install the free measurement tool once: open Terminal and run
   `brew install argyll` (this is the only extra thing Kootenay ever needs, and
   only for this feature).
2. In **Color Settings → Measure with hardware probe…**, place the probe on the
   on-screen patch and start. A fullscreen sequence reads your display, shows
   live progress on the side, saves a profile for that monitor, and drops back
   out on its own.
3. Switch **Method → Measured** and that display is now matched exactly.

Profiles are per-monitor and follow the window when you move it between screens.
A built-in correction (i1 Display Pro Plus → PA32UCDM, referenced to a CR-300)
is included and selected by default.

---

## Updates

**Automatic.** The app checks for new versions on its own and updates itself when
one is available — you don't download anything again. You can also trigger a
check any time from **Kootenay Browser → Check for Updates…** in the menu bar.

---

## Good to know

- It's a full browser — tabs, bookmarks, history, downloads, find-in-page,
  a start page, session restore. Use it as your review browser.
- **Netflix and other DRM video won't play** (it can't decode protected
  streams). Vimeo, Frame.io, YouTube, and normal web video all work.
- Your logins and cookies are kept between sessions, like any browser.
- For privacy, sites can't access your camera, mic, or location.

---

## The short version of why this happens

Professional SDR video is mastered at Gamma 2.4. macOS reads the standard web
video tag as a *different* curve and lifts everything, so browsers show your
grade washed out. Kootenay applies the exact inverse correction to the video as
it plays. Based on the research paper *Gamma Encoding for Accurate Web Delivery*
(N. Regier, 2026).

Building from source or publishing updates? See
[DEVELOPING.md](DEVELOPING.md).
