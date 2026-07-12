import { test } from 'node:test';
import * as assert from 'node:assert';
import { eotf, oetf, srgbEotf, srgbOetf, TransferId } from '../color/transfer';
import {
  buildCorrectionLut,
  identityLut,
  invertCurve,
  LUT_TAPS,
} from '../color/lut';
import { analyticCurve, passthroughCurve } from '../color/presets';

const IDS: TransferId[] = ['gamma196', 'gamma22', 'gamma24', 'gamma26', 'srgb', 'linear'];

test('eotf/oetf round-trip within 1e-9', () => {
  for (const id of IDS) {
    for (let i = 0; i <= 100; i++) {
      const v = i / 100;
      assert.ok(Math.abs(oetf(id, eotf(id, v)) - v) < 1e-9, `${id} @ ${v}`);
    }
  }
});

test('sRGB anchor values', () => {
  assert.ok(Math.abs(srgbOetf(srgbEotf(0.5)) - 0.5) < 1e-12);
  // white paper targets: srgbOetf(v^2.4)*255 for authored 191/153/51
  // (paper rounds 187.5 up; allow ±1 code value)
  const target = (v: number) => 255 * srgbOetf(Math.pow(v / 255, 2.4));
  assert.ok(Math.abs(target(191) - 188) <= 1);
  assert.ok(Math.abs(target(153) - 147) <= 1);
  assert.ok(Math.abs(target(51) - 40) <= 1);
});

test('invertCurve inverts a monotonic curve', () => {
  const curve = Array.from({ length: LUT_TAPS }, (_, i) =>
    Math.pow(i / (LUT_TAPS - 1), 1 / 1.8),
  );
  const inv = invertCurve(curve);
  for (let i = 0; i <= 50; i++) {
    const v = i / 50;
    assert.ok(Math.abs(inv(Math.pow(v, 1 / 1.8)) - v) < 1e-3, `v=${v}`);
  }
});

test('correction through modeled macOS pipeline lands on targets within 0.5/255', () => {
  // Pipeline: authored v -> intermediate srgbOetf(v^1.96) -> LUT -> framebuffer.
  const pipeline = analyticCurve(1.96);
  const lut = buildCorrectionLut('gamma24', pipeline);
  const applyLut = (x: number) => {
    const pos = Math.min(1, Math.max(0, x)) * (lut.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lut.length - 1, lo + 1);
    return lut[lo] + (lut[hi] - lut[lo]) * (pos - lo);
  };
  for (const authored of [51, 153, 191]) {
    const v = authored / 255;
    const intermediate = srgbOetf(Math.pow(v, 1.96));
    const framebuffer = applyLut(intermediate) * 255;
    const target = 255 * srgbOetf(Math.pow(v, 2.4));
    assert.ok(
      Math.abs(framebuffer - target) < 0.5,
      `authored ${authored}: got ${framebuffer.toFixed(2)}, want ${target.toFixed(2)}`,
    );
  }
});

test('passthrough pipeline + srgb source is a no-op LUT', () => {
  const lut = buildCorrectionLut('srgb', passthroughCurve());
  const id = identityLut();
  for (let i = 0; i < LUT_TAPS; i++) {
    assert.ok(Math.abs(lut[i] - id[i]) < 1e-6, `tap ${i}`);
  }
});
