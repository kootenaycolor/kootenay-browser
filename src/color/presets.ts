/**
 * Pipeline presets: what the browser/OS does to tagged BT.709 video before
 * our filter sees it.
 *
 * The white paper established that platform (Vimeo, Frame.io, Louper,
 * YouTube) and codec make zero measurable difference — Vimeo strips NCLC
 * tags to 1-1-1 and Frame.io ignores them at playback — so the identity
 * curve depends only on the OS/browser pipeline. The analytic default
 * models macOS ColorSync/Chromium interpreting the BT.709 transfer tag as
 * an effective ~1.96 power law and re-encoding into the sRGB-TRC surface:
 *
 *   C(v) = srgbOetf(v^1.96)
 *
 * A machine-specific measured curve (written by the calibration harness to
 * userData/calibration.json) overrides the model when present.
 */

import { srgbOetf } from './transfer';
import { LUT_TAPS } from './lut';

export interface PipelineProfile {
  id: string;
  label: string;
  /** Identity curve C sampled at LUT_TAPS points on [0,1]. */
  identityCurve: number[];
  measured: boolean;
}

export function analyticCurve(interpGamma: number, taps: number = LUT_TAPS): number[] {
  return Array.from({ length: taps }, (_, i) =>
    srgbOetf(Math.pow(i / (taps - 1), interpGamma)),
  );
}

/** Chromium passes video through untouched (straight sRGB surface). */
export function passthroughCurve(taps: number = LUT_TAPS): number[] {
  return Array.from({ length: taps }, (_, i) => i / (taps - 1));
}

export const MACOS_DEFAULT: PipelineProfile = {
  id: 'macos-analytic-196',
  label: 'macOS (modeled, BT.709 → ~1.96)',
  identityCurve: analyticCurve(1.96),
  measured: false,
};

export const PASSTHROUGH: PipelineProfile = {
  id: 'passthrough',
  label: 'Passthrough (no OS interpretation)',
  identityCurve: passthroughCurve(),
  measured: false,
};
