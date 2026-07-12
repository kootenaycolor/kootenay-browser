/**
 * In-app pipeline measurement (white paper Method B, automated).
 *
 * Loads the bundled BT.709 patch/gradient video in a real tab, captures the
 * rendered output at three stages — no filter, identity table filter, and a
 * corrected Gamma 2.4 filter — then:
 *   - derives the identity curve C (what the OS/browser pipeline does to
 *     authored code values) from the 256-step gradient strip,
 *   - bakes it as the machine calibration profile,
 *   - verifies the correction hits the white paper's sRGB display targets
 *     (188/147/40 for the 75/60/30% patches) and reports RMS error.
 *
 * capturePage samples Chromium's output surface. The Display P3 panel uses
 * the sRGB transfer curve, so gray-axis values here match what Digital
 * Color Meter reads from the framebuffer.
 */

import { WebContentsView } from 'electron';
import { eotf } from '../color/transfer';
import {
  LUT_TAPS,
  identityLut,
  buildCorrectionLut,
  lutToTableValues,
} from '../color/lut';
import { PipelineProfile } from '../color/presets';

interface HostTab {
  id: number;
  view: WebContentsView;
}

export interface MeasureHost {
  createTab: (url: string, opts?: { gamma?: 'off' }) => HostTab;
  closeTab: (id: number) => void;
  probeUrl: string;
  sendLut: (tab: HostTab, values: string | null) => void;
  display?: { id: number; label: string };
}

// Source-video geometry (must match make_patches.py and probe.html).
const SRC_W = 1280;
const CSS_W = 640;
const CSS_H = 360;
const PATCHES = [0, 51, 153, 191, 255];
const GRADIENT_SRC_Y = 660; // inside the gradient strip (y >= 600)
const PATCH_SRC_Y = 300;

export interface StageSample {
  patches: number[]; // measured 0-255 at the five patch centers
  gradient: number[]; // measured normalized values for authored codes 0..255
}

export interface MeasurementResult {
  profile: PipelineProfile;
  summary: {
    unfilteredPatches: number[];
    identityPatches: number[];
    correctedPatches: number[];
    targets: number[];
    rmsUncorrected: number;
    rmsCorrected: number;
    effectiveInterpGamma: number;
  };
  stages: Record<string, StageSample>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForVideo(tab: HostTab): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await tab.view.webContents.executeJavaScript(
      `(() => { const v = document.querySelector('video');
         return !!v && v.readyState >= 2 && v.currentTime > 0.2; })()`,
    );
    if (ok) return;
    await sleep(200);
  }
  throw new Error('probe video never started playing');
}

async function captureStage(tab: HostTab): Promise<StageSample> {
  await sleep(600); // let the filter/compositor settle
  const img = await tab.view.webContents.capturePage({
    x: 0,
    y: 0,
    width: CSS_W,
    height: CSS_H,
  });
  const size = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const dps = size.width / SRC_W; // device px per source px

  const px = (sx: number, sy: number): number => {
    const x = Math.min(size.width - 1, Math.round(sx * dps));
    const y = Math.min(size.height - 1, Math.round(sy * dps));
    const off = (y * size.width + x) * 4;
    // gray patches: average B,G,R
    return (bmp[off] + bmp[off + 1] + bmp[off + 2]) / 3;
  };

  const patches = PATCHES.map((_, i) => px(i * 256 + 128, PATCH_SRC_Y));

  // Gradient: authored code at column x is round(x*255/(SRC_W-1)).
  // Collect the middle column for each code value.
  const columnsForCode: number[][] = Array.from({ length: 256 }, () => []);
  for (let x = 0; x < SRC_W; x++) {
    columnsForCode[Math.round((x * 255) / (SRC_W - 1))].push(x);
  }
  const gradient: number[] = new Array(256);
  for (let v = 0; v < 256; v++) {
    const cols = columnsForCode[v];
    const mid = cols[cols.length >> 1];
    gradient[v] = px(mid, GRADIENT_SRC_Y) / 255;
  }
  return { patches, gradient };
}

function enforceMonotonic(curve: number[]): number[] {
  const out = curve.slice();
  for (let i = 1; i < out.length; i++) {
    if (out[i] < out[i - 1]) out[i] = out[i - 1];
  }
  return out;
}

function rms(measured: number[], targets: number[]): number {
  const n = measured.length;
  return Math.sqrt(
    measured.reduce((s, m, i) => s + (m - targets[i]) ** 2, 0) / n,
  );
}

/** Fit measured identity curve to srgbOetf(v^g) and return g. */
function fitInterpGamma(gradient: number[]): number {
  let sum = 0;
  let count = 0;
  for (let v = 16; v < 240; v++) {
    const input = v / 255;
    const m = gradient[v];
    if (m <= 0 || m >= 1) continue;
    // invert the sRGB encode, then solve light = input^g
    const light =
      m <= 0.04045 ? m / 12.92 : Math.pow((m + 0.055) / 1.055, 2.4);
    if (light <= 0) continue;
    sum += Math.log(light) / Math.log(input);
    count++;
  }
  return count ? sum / count : NaN;
}

export async function runMeasurement(
  host: MeasureHost,
): Promise<MeasurementResult> {
  const tab = host.createTab(host.probeUrl, { gamma: 'off' });
  try {
    await waitForVideo(tab);

    host.sendLut(tab, null);
    const unfiltered = await captureStage(tab);

    host.sendLut(tab, lutToTableValues(identityLut(LUT_TAPS)));
    const identity = await captureStage(tab);

    const identityCurve = enforceMonotonic(identity.gradient);
    const effectiveGamma = +fitInterpGamma(identityCurve).toFixed(3);
    const profile: PipelineProfile = {
      id: 'fb-' + Date.now(),
      label: `${host.display?.label ?? 'This display'} — probe γ ${effectiveGamma}`,
      kind: 'framebuffer',
      identityCurve,
      effectiveGamma,
      displayId: host.display?.id,
      displayLabel: host.display?.label,
      measuredAt: new Date().toISOString(),
    };
    const correctionLut = buildCorrectionLut('gamma24', profile, LUT_TAPS);
    host.sendLut(tab, lutToTableValues(correctionLut));
    const corrected = await captureStage(tab);

    // White paper targets: srgbOetf(v^2.4) per patch → 0/40/147/188/255.
    const targets = PATCHES.map(
      (v) =>
        255 *
        (() => {
          const l = eotf('gamma24', v / 255);
          return l <= 0.0031308
            ? l * 12.92
            : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
        })(),
    );

    return {
      profile,
      summary: {
        unfilteredPatches: unfiltered.patches.map((v) => +v.toFixed(1)),
        identityPatches: identity.patches.map((v) => +v.toFixed(1)),
        correctedPatches: corrected.patches.map((v) => +v.toFixed(1)),
        targets: targets.map((v) => +v.toFixed(1)),
        rmsUncorrected: +rms(identity.patches, targets).toFixed(2),
        rmsCorrected: +rms(corrected.patches, targets).toFixed(2),
        effectiveInterpGamma: effectiveGamma,
      },
      stages: { unfiltered, identity, corrected },
    };
  } finally {
    host.closeTab(tab.id);
  }
}
