import { test } from 'node:test';
import * as assert from 'node:assert';
import { eotf, oetf, srgbEotf, srgbOetf, TransferId } from '../color/transfer';
import {
  buildCorrectionLut,
  identityLut,
  invertCurve,
  LUT_TAPS,
} from '../color/lut';
import {
  simpleProfile,
  powerCurve,
  analyticFramebufferCurve,
  lightProfileFromGamma,
  lightProfileFromPoints,
  PipelineProfile,
} from '../color/presets';

const IDS: TransferId[] = ['gamma196', 'gamma22', 'gamma24', 'gamma26', 'srgb', 'linear'];

/** Linear-interpolate a [0,1]-sampled curve at x. */
function sampleCurve(curve: number[], x: number): number {
  const pos = Math.min(1, Math.max(0, x)) * (curve.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(curve.length - 1, lo + 1);
  return curve[lo] + (curve[hi] - curve[lo]) * (pos - lo);
}
const applyLut = sampleCurve;

test('eotf/oetf round-trip within 1e-9', () => {
  for (const id of IDS) {
    for (let i = 0; i <= 100; i++) {
      const v = i / 100;
      assert.ok(Math.abs(oetf(id, eotf(id, v)) - v) < 1e-9, `${id} @ ${v}`);
    }
  }
});

test('sRGB anchor values (white paper targets, ±1)', () => {
  assert.ok(Math.abs(srgbOetf(srgbEotf(0.5)) - 0.5) < 1e-12);
  const target = (v: number) => 255 * srgbOetf(Math.pow(v / 255, 2.4));
  assert.ok(Math.abs(target(191) - 188) <= 1);
  assert.ok(Math.abs(target(153) - 147) <= 1);
  assert.ok(Math.abs(target(51) - 40) <= 1);
});

test('invertCurve inverts a monotonic curve', () => {
  const curve = powerCurve(1 / 1.8);
  const inv = invertCurve(curve);
  for (let i = 0; i <= 50; i++) {
    const v = i / 50;
    assert.ok(Math.abs(inv(Math.pow(v, 1 / 1.8)) - v) < 1e-3, `v=${v}`);
  }
});

test('simple mode transcodes source→target (2.4→2.2 power push)', () => {
  const lut = buildCorrectionLut('gamma24', simpleProfile('gamma22'));
  for (const v of [0.2, 0.5, 0.8]) {
    const want = oetf('gamma22', eotf('gamma24', v));
    assert.ok(Math.abs(applyLut(lut, v) - want) < 1 / 255, `v=${v}`);
  }
});

test('simple mode with source==target is a no-op LUT', () => {
  const lut = buildCorrectionLut('srgb', simpleProfile('srgb'));
  const id = identityLut();
  for (let i = 0; i < LUT_TAPS; i++) {
    assert.ok(Math.abs(lut[i] - id[i]) < 1e-6, `tap ${i}`);
  }
});

test('framebuffer correction lands on sRGB targets through the measured curve', () => {
  const C = analyticFramebufferCurve(1.96); // non-power (sRGB encode of x^1.96)
  const profile: PipelineProfile = {
    id: 't',
    label: 't',
    kind: 'framebuffer',
    identityCurve: C,
  };
  const lut = buildCorrectionLut('gamma24', profile);
  for (const authored of [51, 153, 191]) {
    const v = authored / 255;
    // End-to-end: framebuffer = C(f(v)) must equal m*(v) = srgbOetf(v^2.4).
    const framebuffer = applyLut(C, applyLut(lut, v)) * 255;
    const target = 255 * srgbOetf(Math.pow(v, 2.4));
    assert.ok(
      Math.abs(framebuffer - target) < 0.5,
      `authored ${authored}: got ${framebuffer.toFixed(2)}, want ${target.toFixed(2)}`,
    );
  }
});

test('composition direction: f(v)=R⁻¹(T(v)), NOT T(R⁻¹(v)), on a non-power curve', () => {
  // A deliberately non-power, non-commuting response: a gamma with a lifted
  // toe. The backwards composition m*(C⁻¹(v)) fails this; the correct one holds.
  const C = Array.from({ length: LUT_TAPS }, (_, i) => {
    const x = i / (LUT_TAPS - 1);
    return 0.05 + 0.95 * Math.pow(x, 2.3); // additive toe → not a pure power
  });
  const profile: PipelineProfile = {
    id: 't',
    label: 't',
    kind: 'framebuffer',
    identityCurve: C,
  };
  const lut = buildCorrectionLut('gamma24', profile);
  for (const v of [0.15, 0.4, 0.7, 0.9]) {
    const framebuffer = applyLut(C, applyLut(lut, v));
    const target = srgbOetf(Math.pow(v, 2.4));
    assert.ok(
      Math.abs(framebuffer - target) < 0.004,
      `v=${v}: framebuffer ${framebuffer.toFixed(4)} vs target ${target.toFixed(4)}`,
    );
  }
});

test('light profile from effective gamma cancels exactly to intent', () => {
  // Display+OS net gamma 1.80; a 2.4 grade should reach the eye as 2.4 light.
  const profile = lightProfileFromGamma(1.8);
  const L = profile.identityCurve!;
  const lut = buildCorrectionLut('gamma24', profile);
  for (const v of [0.1, 0.3, 0.6, 0.9]) {
    const light = applyLut(L, applyLut(lut, v));
    const intended = Math.pow(v, 2.4);
    assert.ok(Math.abs(light - intended) < 0.003, `v=${v}`);
  }
});

test('light profile from measured points interpolates and normalizes', () => {
  const profile = lightProfileFromPoints([
    { input: 0, luminance: 0 },
    { input: 0.5, luminance: 0.18 },
    { input: 1, luminance: 1 },
  ]);
  const L = profile.identityCurve!;
  assert.ok(Math.abs(L[0] - 0) < 1e-6);
  assert.ok(Math.abs(L[LUT_TAPS - 1] - 1) < 1e-6);
  assert.ok(Math.abs(sampleCurve(L, 0.5) - 0.18) < 0.01);
});
