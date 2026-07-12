/**
 * Correction LUT construction.
 *
 * The filter is a per-channel table applied to the video in content space,
 * upstream of macOS compositing/ColorSync. A profile describes what the rest
 * of the chain does; we invert it so the intended mastering luminance is what
 * reaches the eye.
 *
 * Pixel path:  authored v ──▶ [our LUT f] ──▶ downstream ──▶ observed
 *
 * Let R be the downstream response measured with an identity filter (observed
 * as a function of the value entering it). To hit a target observation T(v):
 *     R(f(v)) = T(v)   ⇒   f(v) = R⁻¹(T(v))
 *
 * By kind:
 *   simple      — no R to invert; transcode source→target directly:
 *                   f(v) = oetf(target, eotf(source, v))
 *   framebuffer — R = identityCurve maps entering value → framebuffer code;
 *                 target is the sRGB-encoded intended luminance:
 *                   f(v) = R⁻¹( srgbOetf(eotf(source, v)) )
 *   light       — R = identityCurve maps entering value → panel luminance;
 *                 target is the intended luminance itself:
 *                   f(v) = R⁻¹( eotf(source, v) )
 */

import { TransferId, eotf, oetf, srgbOetf } from './transfer';
import { PipelineProfile } from './presets';

export const LUT_TAPS = 256;

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

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Build the correction LUT for a declared source transfer and a profile. */
export function buildCorrectionLut(
  source: TransferId,
  profile: PipelineProfile,
  taps: number = LUT_TAPS,
): number[] {
  const rInv =
    profile.kind === 'simple'
      ? null
      : invertCurve(profile.identityCurve ?? identityLut(taps));
  const target: TransferId = profile.target ?? 'gamma22';

  const lut = new Array<number>(taps);
  for (let i = 0; i < taps; i++) {
    const v = i / (taps - 1);
    const intendedLight = eotf(source, v);
    let f: number;
    if (profile.kind === 'simple') {
      f = oetf(target, intendedLight);
    } else if (profile.kind === 'light') {
      f = rInv!(intendedLight);
    } else {
      f = rInv!(srgbOetf(intendedLight));
    }
    lut[i] = clamp01(f);
  }
  return lut;
}

/** Serialize for feFuncX tableValues. */
export function lutToTableValues(lut: number[]): string {
  return lut.map((v) => v.toFixed(6)).join(' ');
}
