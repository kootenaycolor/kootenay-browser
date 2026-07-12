/**
 * Correction LUT construction.
 *
 * Model of the filtered-video path in Chromium/macOS, established by the
 * gamma white paper (Method B) and the in-app measurement harness:
 *
 *   authored code v ──decode+tag interpretation──▶ intermediate x = C(v)
 *                 ──our filter LUT f──▶ framebuffer m = f(x)
 *                 ──display EOTF (sRGB-curve P3 panel)──▶ light
 *
 * C is the measured "identity curve": framebuffer values observed with an
 * identity filter applied. The display's gray-axis transfer is the sRGB
 * curve (Display P3 uses the sRGB TRC), so to reproduce the mastering
 * intent — light = EOTF_source(v) — the framebuffer target is
 *   m*(v) = srgbOetf(eotf(source, v))
 * and the filter must be
 *   f = m* ∘ C⁻¹
 */

import { TransferId, eotf, srgbOetf } from './transfer';

export const LUT_TAPS = 256;

/** Identity table (also used to force the video off the overlay path). */
export function identityLut(taps: number = LUT_TAPS): number[] {
  return Array.from({ length: taps }, (_, i) => i / (taps - 1));
}

/**
 * Invert a monotonically increasing curve given as uniform samples on [0,1].
 * Returns a function mapping curve output back to curve input.
 */
export function invertCurve(samples: number[]): (y: number) => number {
  const n = samples.length;
  return (y: number) => {
    if (y <= samples[0]) return 0;
    if (y >= samples[n - 1]) return 1;
    // binary search for the bracketing segment
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid] <= y) lo = mid;
      else hi = mid;
    }
    const span = samples[hi] - samples[lo];
    const t = span > 0 ? (y - samples[lo]) / span : 0;
    return (lo + t) / (n - 1);
  };
}

/**
 * Build the correction LUT for a declared source transfer, given the
 * measured (or modeled) identity curve C sampled at LUT_TAPS points.
 */
export function buildCorrectionLut(
  source: TransferId,
  identityCurve: number[],
  taps: number = LUT_TAPS,
): number[] {
  const cInv = invertCurve(identityCurve);
  const lut: number[] = new Array(taps);
  for (let i = 0; i < taps; i++) {
    const x = i / (taps - 1); // intermediate value entering the filter
    const v = cInv(x); // authored code value that produced it
    lut[i] = srgbOetf(eotf(source, v));
  }
  return lut;
}

/** Serialize for feFuncX tableValues. */
export function lutToTableValues(lut: number[]): string {
  return lut.map((v) => v.toFixed(6)).join(' ');
}
