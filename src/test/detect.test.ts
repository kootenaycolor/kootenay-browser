import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import { Spotread } from '../main/spotread';

const SIM = path.join(__dirname, '..', '..', 'scripts', 'spotread-sim.js');
const NOPROBE = path.join(__dirname, '..', '..', 'scripts', 'spotread-noprobe.js');

test('detect() reports ready only with a positive instrument signal', async () => {
  const s = new Spotread(SIM);
  const status = await s.detect();
  s.dispose();
  assert.strictEqual(status.state, 'ready');
});

test('detect() reports no-probe when spotread errors (no instrument)', async () => {
  const s = new Spotread(NOPROBE);
  const status = await s.detect();
  s.dispose();
  assert.strictEqual(status.state, 'no-probe');
});

test('detect() reports argyll-missing when the binary is absent', async () => {
  const s = new Spotread('/definitely/not/here/spotread');
  const status = await s.detect();
  assert.strictEqual(status.state, 'argyll-missing');
});
