/**
 * Pipeline profiles: a model of what the browser/OS/display does to the
 * declared source signal, and therefore what our filter must invert.
 *
 * Three kinds, matching the two correction methods:
 *  - 'simple'      — display-blind. No measurement; transcode the source to a
 *                    fixed target curve (Gamma 2.2 by default, per the gamma
 *                    white paper's web-delivery recommendation). Gets close on
 *                    most displays, exact on none.
 *  - 'framebuffer' — measured via the in-app probe (capturePage). identityCurve
 *                    maps authored code → framebuffer code. Trusts the display
 *                    ICC (assumes the panel renders the framebuffer faithfully).
 *  - 'light'       — measured via a hardware probe / white-paper physical-light
 *                    data. identityCurve maps authored code → normalized panel
 *                    luminance. Captures the whole chain, so it can cancel the
 *                    per-display gamma shift exactly.
 *
 * framebuffer/light profiles are keyed to a display so the correction follows
 * the window across monitors.
 */

import { TransferId, srgbOetf } from './transfer';
import { LUT_TAPS } from './lut';

export type ProfileKind = 'simple' | 'framebuffer' | 'light';

export interface PipelineProfile {
  id: string;
  label: string;
  kind: ProfileKind;
  /** For 'simple': the fixed target curve to transcode toward. */
  target?: TransferId;
  /** For 'framebuffer'/'light': the measured response, LUT_TAPS samples. */
  identityCurve?: number[];
  /** Display this measurement belongs to (framebuffer/light only). */
  displayId?: number;
  displayLabel?: string;
  /** Fitted effective gamma, for display in the UI. */
  effectiveGamma?: number;
  measuredAt?: string;
}

/** A pure-power light response x^gamma sampled over input [0,1]. */
export function powerCurve(gamma: number, taps: number = LUT_TAPS): number[] {
  return Array.from({ length: taps }, (_, i) => Math.pow(i / (taps - 1), gamma));
}

/** srgbOetf(x^gamma) — models a framebuffer whose interpretation gamma is g. */
export function analyticFramebufferCurve(
  interpGamma: number,
  taps: number = LUT_TAPS,
): number[] {
  return Array.from({ length: taps }, (_, i) =>
    srgbOetf(Math.pow(i / (taps - 1), interpGamma)),
  );
}

/** The display-blind Simple profile: transcode source → target (default 2.2). */
export function simpleProfile(target: TransferId = 'gamma22'): PipelineProfile {
  return { id: 'simple', label: `Simple → ${target}`, kind: 'simple', target };
}

/** Build a physical-light profile from a single measured effective gamma. */
export function lightProfileFromGamma(
  gamma: number,
  opts: { displayId?: number; displayLabel?: string } = {},
): PipelineProfile {
  return {
    id: 'light-' + Date.now(),
    label: `${opts.displayLabel ?? 'Display'} — measured γ ${gamma.toFixed(2)}`,
    kind: 'light',
    identityCurve: powerCurve(gamma),
    effectiveGamma: gamma,
    displayId: opts.displayId,
    displayLabel: opts.displayLabel,
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Build a physical-light profile from measured (input%, luminance%) points.
 * Points need not be uniform; the curve is piecewise-linear-interpolated and
 * normalized so white = 1.
 */
export function lightProfileFromPoints(
  points: { input: number; luminance: number }[],
  opts: { displayId?: number; displayLabel?: string } = {},
  taps: number = LUT_TAPS,
): PipelineProfile {
  const pts = [...points].sort((a, b) => a.input - b.input);
  const maxL = pts[pts.length - 1].luminance || 1;
  const curve = new Array(taps);
  for (let i = 0; i < taps; i++) {
    const x = i / (taps - 1);
    // find bracketing points on input axis (0..1)
    let lo = pts[0];
    let hi = pts[pts.length - 1];
    for (let k = 0; k < pts.length - 1; k++) {
      if (x >= pts[k].input && x <= pts[k + 1].input) {
        lo = pts[k];
        hi = pts[k + 1];
        break;
      }
    }
    const span = hi.input - lo.input;
    const t = span > 0 ? (x - lo.input) / span : 0;
    curve[i] = (lo.luminance + (hi.luminance - lo.luminance) * t) / maxL;
  }
  curve[0] = Math.max(0, curve[0]);
  return {
    id: 'light-' + Date.now(),
    label: `${opts.displayLabel ?? 'Display'} — measured (${pts.length} pts)`,
    kind: 'light',
    identityCurve: curve,
    displayId: opts.displayId,
    displayLabel: opts.displayLabel,
    measuredAt: new Date().toISOString(),
  };
}

/** Fallback when nothing is measured: model macOS BT.709 → ~1.96 framebuffer. */
export const MACOS_DEFAULT: PipelineProfile = {
  id: 'macos-analytic-196',
  label: 'macOS (modeled, BT.709 → ~1.96)',
  kind: 'framebuffer',
  identityCurve: analyticFramebufferCurve(1.96),
};
