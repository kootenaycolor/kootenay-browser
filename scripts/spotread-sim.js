#!/usr/bin/env node
/**
 * Simulated ArgyllCMS spotread for --probe-sim and driver tests.
 *
 * Speaks just enough of the protocol: announces an instrument on startup,
 * and answers each "1\n" trigger with an "XYZ: X Y Z" line.
 *
 * Readings come from KC_SIM_YS (JSON array of Y values, consumed in order,
 * last value repeats) or default to a gamma-1.9 panel at 100 cd/m² white for
 * the 12-read measure pass, then near-target values for the verify pass.
 */

const DEFAULT_SEQ = (() => {
  const g = 1.9;
  const white = 100;
  const measurePcts = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
  const seq = measurePcts.map((p) => white * Math.pow(p / 100, g));
  seq.push(white * 0.999); // drift check ~0.1%
  // verify 80/60/30 with correction active → close to (v)^2.4 targets
  for (const p of [80, 60, 30]) {
    seq.push(white * Math.pow(p / 100, 2.4) * 1.005);
  }
  return seq;
})();

const seq = process.env.KC_SIM_YS ? JSON.parse(process.env.KC_SIM_YS) : DEFAULT_SEQ;
let i = 0;

process.stdout.write('spotread: Simulated instrument driver\n');
process.stdout.write('Instrument Type: Simulated i1 Display Pro Plus\n');
process.stdout.write('Place instrument on spot to be measured,\n');

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line === '1') {
      const Y = seq[Math.min(i, seq.length - 1)];
      i++;
      const X = Y * 0.9505;
      const Z = Y * 1.089;
      setTimeout(() => {
        process.stdout.write(
          ` Result is XYZ: ${X.toFixed(6)} ${Y.toFixed(6)} ${Z.toFixed(6)}, D50 Lab: 0 0 0\n`,
        );
      }, 30);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
