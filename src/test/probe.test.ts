import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseXyzLine, meanXyz, findSpotread } from '../main/spotread';
import {
  parseCorrectionProfile,
  correctionFactor,
  fitEffectiveGamma,
  segmentForPct,
} from '../main/probe-measure';
import { lightProfileFromPoints } from '../color/presets';
import { buildCorrectionLut } from '../color/lut';

test('parseXyzLine handles real spotread output', () => {
  // shapes seen from spotread -v (measure.py regex compatibility)
  const line = ' Result is XYZ: 95.047123 100.000000 108.883000, D50 Lab: 100 0 0';
  const xyz = parseXyzLine(line)!;
  assert.ok(Math.abs(xyz.X - 95.047123) < 1e-6);
  assert.ok(Math.abs(xyz.Y - 100.0) < 1e-6);
  assert.ok(Math.abs(xyz.Z - 108.883) < 1e-6);
  assert.strictEqual(parseXyzLine('Instrument Type: i1 Display Pro Plus'), null);
  assert.strictEqual(parseXyzLine('Place instrument on spot'), null);
});

test('meanXyz averages and derives chromaticity', () => {
  const m = meanXyz([
    { X: 10, Y: 20, Z: 30 },
    { X: 20, Y: 40, Z: 60 },
  ]);
  assert.strictEqual(m.Y, 30);
  assert.ok(Math.abs(m.x! - 15 / 90) < 1e-9);
  assert.ok(Math.abs(m.y! - 30 / 90) < 1e-9);
});

test('findSpotread returns null for nonexistent candidates', () => {
  assert.strictEqual(findSpotread(['/definitely/not/here/spotread']), null);
});

test('correction profile: parse + interpolate Y_factor by signal', () => {
  const pts = parseCorrectionProfile({
    points: [
      { signal_pct: 10, Y_factor: 1.10, dx: 0.001, dy: -0.002 },
      { signal_pct: 50, Y_factor: 1.02 },
      { signal_pct: 100, Y_factor: 1.0 },
    ],
  });
  assert.strictEqual(pts.length, 3);
  assert.ok(Math.abs(correctionFactor(pts, 10) - 1.1) < 1e-9);
  assert.ok(Math.abs(correctionFactor(pts, 30) - 1.06) < 1e-9); // midpoint 10-50
  assert.ok(Math.abs(correctionFactor(pts, 100) - 1.0) < 1e-9);
  assert.ok(Math.abs(correctionFactor(pts, 0) - 1.1) < 1e-9); // clamps below
  // bare-array format also accepted
  assert.strictEqual(
    parseCorrectionProfile([{ signal_pct: 0, Y_factor: 1 }]).length,
    1,
  );
  assert.throws(() => parseCorrectionProfile({ nope: true }));
});

test('fitEffectiveGamma recovers a known 1.8-gamma panel within ±0.02', () => {
  const points = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((p) => ({
    input: p / 100,
    luminance: 100 * Math.pow(p / 100, 1.8),
  }));
  const g = fitEffectiveGamma(points);
  assert.ok(Math.abs(g - 1.8) < 0.02, `fitted ${g}`);
});

test('probe points → light profile → correction cancels to 2.4 intent', () => {
  // Simulated panel: net light response gamma 1.9 (like the sim script).
  const points = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((p) => ({
    input: p / 100,
    luminance: 100 * Math.pow(p / 100, 1.9),
  }));
  const profile = lightProfileFromPoints(points);
  const lut = buildCorrectionLut('gamma24', profile);
  const L = profile.identityCurve!;
  const sample = (curve: number[], x: number) => {
    const pos = Math.min(1, Math.max(0, x)) * (curve.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(curve.length - 1, lo + 1);
    return curve[lo] + (curve[hi] - curve[lo]) * (pos - lo);
  };
  for (const v of [0.3, 0.6, 0.8]) {
    const light = sample(L, sample(lut, v));
    const intended = Math.pow(v, 2.4);
    assert.ok(
      Math.abs(light - intended) < 0.004,
      `v=${v}: ${light.toFixed(4)} vs ${intended.toFixed(4)}`,
    );
  }
});

test('segmentForPct maps decades to video segments', () => {
  assert.strictEqual(segmentForPct(0), 0);
  assert.strictEqual(segmentForPct(30), 3);
  assert.strictEqual(segmentForPct(100), 10);
});
