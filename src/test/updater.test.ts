import { test } from 'node:test';
import * as assert from 'node:assert';
import { cmpVersions } from '../main/updater';

test('cmpVersions orders semver correctly', () => {
  assert.strictEqual(cmpVersions('0.2.0', '0.1.0') > 0, true);
  assert.strictEqual(cmpVersions('v0.2.0', '0.2.0'), 0);
  assert.strictEqual(cmpVersions('0.1.0', '0.1.1') < 0, true);
  assert.strictEqual(cmpVersions('1.0.0', '0.9.9') > 0, true);
  assert.strictEqual(cmpVersions('0.2', '0.2.0'), 0); // missing patch = 0
  assert.strictEqual(cmpVersions('0.10.0', '0.9.0') > 0, true); // numeric, not lexical
});
