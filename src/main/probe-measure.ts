/**
 * Hardware-probe measurement orchestration (physical-light Method B, live).
 *
 * Displays the step-patch video fullscreen on the display being profiled,
 * with an IDENTITY LUT applied — forcing the same filtered-video path the
 * correction runs in — and reads each patch with the colorimeter:
 *
 *   white_ref → 100%..0% descending → white_drift_check
 *
 * Then: ±2% white-drift gate, optional probe-correction (Y_factor by signal,
 * from the Custom Probe Measurement correction-profile JSON), light-profile
 * fit, and a physical VERIFY pass: the real Gamma 2.4 correction LUT is
 * pushed and 75/60/30% patches are re-read against target (v)^2.4.
 *
 * Known assumption (empirically validated by the verify pass): the LUT table
 * is indexed by authored code value; valid because the measured tag
 * interpretation (~2.2) ≈ the sRGB raster encode, so filter input ≈ authored
 * code.
 */

import { Spotread, XYZ } from './spotread';
import {
  PipelineProfile,
  lightProfileFromPoints,
} from '../color/presets';
import {
  LUT_TAPS,
  identityLut,
  buildCorrectionLut,
  lutToTableValues,
} from '../color/lut';

export const SEG_SECONDS = 2;
export const SIGNAL_PCTS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
export const DRIFT_SEGMENT = 11; // trailing white segment in the video
export const Y_DRIFT_THRESHOLD_PCT = 2.0;
const DEFAULT_SETTLE_MS = 1000;
const VERIFY_PCTS = [75, 60, 30];

export interface ProbeProgress {
  phase: 'measure' | 'drift' | 'verify';
  label: string;
  index: number;
  total: number;
  Y?: number;
  done?: boolean;
}

export interface CorrectionPoint {
  signal_pct: number;
  Y_factor: number;
  dx?: number;
  dy?: number;
}

/** Host surface provided by main.ts — window/LUT/seek plumbing. */
export interface ProbeHost {
  /** Seek the fullscreen patch video so `segment` is displayed (paused). */
  showSegment(segment: number): Promise<void>;
  /** Show/instruct via HUD; empty string hides it. */
  hud(text: string): Promise<void>;
  /** Push a LUT (tableValues string) to the patch window. */
  sendLut(values: string): void;
  onProgress(p: ProbeProgress): void;
  isCancelled(): boolean;
  display: { id: number; label: string };
}

export interface ProbeRunResult {
  profile: PipelineProfile;
  driftPct: number;
  driftValid: boolean;
  fittedGamma: number;
  readings: { signalPct: number; Y: number; x: number | null; y: number | null }[];
  verify: {
    patches: { signalPct: number; targetRel: number; achievedRel: number; pctError: number }[];
    rmsPctError: number;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Their correction-profile JSON: array of points or {points:[...]}. */
export function parseCorrectionProfile(json: unknown): CorrectionPoint[] {
  const arr = Array.isArray(json)
    ? json
    : (json as { points?: unknown[] })?.points;
  if (!Array.isArray(arr)) throw new Error('unrecognized correction profile format');
  const pts = arr
    .map((p) => p as CorrectionPoint)
    .filter((p) => typeof p?.signal_pct === 'number' && typeof p?.Y_factor === 'number')
    .sort((a, b) => a.signal_pct - b.signal_pct);
  if (pts.length === 0) throw new Error('correction profile has no usable points');
  return pts;
}

/** Linear interpolation of Y_factor by signal_pct (their _apply_correction). */
export function correctionFactor(points: CorrectionPoint[], signalPct: number): number {
  if (signalPct <= points[0].signal_pct) return points[0].Y_factor;
  const last = points[points.length - 1];
  if (signalPct >= last.signal_pct) return last.Y_factor;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (signalPct >= a.signal_pct && signalPct <= b.signal_pct) {
      const t = (signalPct - a.signal_pct) / (b.signal_pct - a.signal_pct);
      return a.Y_factor + (b.Y_factor - a.Y_factor) * t;
    }
  }
  return 1;
}

/** Effective gamma via log-log mean over mid-range points (10-90%). */
export function fitEffectiveGamma(
  points: { input: number; luminance: number }[],
): number {
  const white = points.find((p) => p.input >= 0.999)?.luminance ?? 1;
  let sum = 0;
  let n = 0;
  for (const p of points) {
    if (p.input < 0.1 || p.input > 0.9) continue;
    const rel = p.luminance / white;
    if (rel <= 0) continue;
    sum += Math.log(rel) / Math.log(p.input);
    n++;
  }
  return n ? sum / n : NaN;
}

/**
 * Segment index in patch-steps-709.mp4 for a signal percent. Non-decade
 * verify targets (75%) fall between segments; we use the video's exact decade
 * patches for measuring and interpolate targets instead — so verify uses the
 * nearest decades 80/60/30 unless pct is a decade already.
 */
export function segmentForPct(pct: number): number {
  return Math.round(pct / 10);
}

export async function runProbeMeasurement(
  host: ProbeHost,
  probe: Spotread,
  opts: {
    samplesPerPatch?: number;
    correction?: CorrectionPoint[] | null;
    sourceGammaForVerify?: number;
    settleMs?: number;
  } = {},
): Promise<ProbeRunResult> {
  const samples = opts.samplesPerPatch ?? 3;
  const correction = opts.correction ?? null;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;

  const applyCorrection = (pct: number, xyz: XYZ): number =>
    correction ? xyz.Y * correctionFactor(correction, pct) : xyz.Y;

  const checkCancel = () => {
    if (host.isCancelled()) throw new Error('cancelled');
  };

  const readAt = async (segment: number): Promise<XYZ> => {
    checkCancel();
    await host.showSegment(segment);
    await sleep(settleMs);
    return probe.readPatch(samples);
  };

  // ── measurement pass (identity LUT = raw pipeline response) ──────────────
  host.sendLut(lutToTableValues(identityLut(LUT_TAPS)));
  await host.hud('');

  const sequence = [100, ...[...SIGNAL_PCTS].reverse().filter((p) => p !== 100)];
  // → white_ref, 100 handled once: white_ref IS the 100% reading
  const total = sequence.length + 1; // + drift check
  const readings: ProbeRunResult['readings'] = [];
  let whiteRefY = 0;

  for (let i = 0; i < sequence.length; i++) {
    const pct = sequence[i];
    const label = i === 0 ? 'White ref (100%)' : `${pct}%`;
    host.onProgress({ phase: 'measure', label, index: i, total });
    const xyz = await readAt(segmentForPct(pct));
    const Y = applyCorrection(pct, xyz);
    if (i === 0) whiteRefY = Y;
    readings.push({ signalPct: pct, Y, x: xyz.x, y: xyz.y });
    host.onProgress({ phase: 'measure', label, index: i, total, Y, done: true });
  }

  // ── drift check ───────────────────────────────────────────────────────────
  host.onProgress({ phase: 'drift', label: 'White drift check', index: total - 1, total });
  const driftXyz = await readAt(DRIFT_SEGMENT);
  const driftY = applyCorrection(100, driftXyz);
  const driftPct = whiteRefY > 0 ? (Math.abs(driftY - whiteRefY) / whiteRefY) * 100 : 100;
  const driftValid = driftPct <= Y_DRIFT_THRESHOLD_PCT;
  host.onProgress({
    phase: 'drift',
    label: `Drift ${driftPct.toFixed(2)}%`,
    index: total - 1,
    total,
    Y: driftY,
    done: true,
  });

  // ── fit + profile ──────────────────────────────────────────────────────────
  const points = readings
    .map((r) => ({ input: r.signalPct / 100, luminance: r.Y }))
    .sort((a, b) => a.input - b.input);
  const fittedGamma = +fitEffectiveGamma(points).toFixed(3);
  const profile = lightProfileFromPoints(points, {
    displayId: host.display.id,
    displayLabel: host.display.label,
  });
  profile.label = `${host.display.label} — i1 probe γ ${fittedGamma}`;
  profile.effectiveGamma = fittedGamma;

  // ── physical verify pass ───────────────────────────────────────────────────
  const srcGamma = opts.sourceGammaForVerify ?? 2.4;
  host.sendLut(lutToTableValues(buildCorrectionLut('gamma24', profile, LUT_TAPS)));
  const verifyPatches: ProbeRunResult['verify']['patches'] = [];
  const verifyPcts = VERIFY_PCTS.map((p) => Math.round(p / 10) * 10); // decades on the video
  const uniquePcts = [...new Set(verifyPcts)];
  for (let i = 0; i < uniquePcts.length; i++) {
    const pct = uniquePcts[i];
    host.onProgress({
      phase: 'verify',
      label: `Verify ${pct}%`,
      index: i,
      total: uniquePcts.length,
    });
    const xyz = await readAt(segmentForPct(pct));
    const Y = applyCorrection(pct, xyz);
    const achievedRel = whiteRefY > 0 ? Y / whiteRefY : 0;
    const targetRel = Math.pow(pct / 100, srcGamma);
    const pctError = targetRel > 0 ? ((achievedRel - targetRel) / targetRel) * 100 : 0;
    verifyPatches.push({
      signalPct: pct,
      targetRel: +targetRel.toFixed(4),
      achievedRel: +achievedRel.toFixed(4),
      pctError: +pctError.toFixed(2),
    });
    host.onProgress({
      phase: 'verify',
      label: `Verify ${pct}%`,
      index: i,
      total: uniquePcts.length,
      Y,
      done: true,
    });
  }
  const rmsPctError = +Math.sqrt(
    verifyPatches.reduce((s, p) => s + p.pctError ** 2, 0) / verifyPatches.length,
  ).toFixed(2);

  profile.verify = { rmsPctError, patches: verifyPatches, driftPct: +driftPct.toFixed(2) };

  return {
    profile,
    driftPct: +driftPct.toFixed(2),
    driftValid,
    fittedGamma,
    readings,
    verify: { patches: verifyPatches, rmsPctError },
  };
}
