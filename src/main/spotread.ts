/**
 * ArgyllCMS `spotread` driver — the hardware interface to the colorimeter
 * (i1 Display Pro Plus). Protocol ported from the user's Custom Probe
 * Measurement app (measure.py:803-1037):
 *
 *   - spawn a single persistent `spotread -v` (default emissive spot mode),
 *   - one reading = write "1\n" to stdin, scan merged stdout/stderr for
 *     `XYZ: <X> <Y> <Z>`, 15 s timeout,
 *   - a patch reading averages N samples (arithmetic mean of X, Y, Z),
 *   - kill() to stop — spotread has no graceful quit in this usage.
 *
 * The binary path is injectable so tests and --probe-sim can substitute a
 * scripted stand-in.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';

export const XYZ_RE = /XYZ:\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/;

export interface XYZ {
  X: number;
  Y: number;
  Z: number;
  x: number | null;
  y: number | null;
}

export type ProbeStatus =
  | { state: 'ready'; device: string }
  | { state: 'argyll-missing'; message: string }
  | { state: 'no-probe'; message: string };

export function parseXyzLine(line: string): { X: number; Y: number; Z: number } | null {
  const m = XYZ_RE.exec(line);
  return m ? { X: +m[1], Y: +m[2], Z: +m[3] } : null;
}

export function toXyz(X: number, Y: number, Z: number): XYZ {
  const d = X + Y + Z;
  return { X, Y, Z, x: d > 0 ? X / d : null, y: d > 0 ? Y / d : null };
}

export function meanXyz(samples: { X: number; Y: number; Z: number }[]): XYZ {
  const n = samples.length;
  const s = samples.reduce(
    (a, b) => ({ X: a.X + b.X, Y: a.Y + b.Y, Z: a.Z + b.Z }),
    { X: 0, Y: 0, Z: 0 },
  );
  return toXyz(s.X / n, s.Y / n, s.Z / n);
}

export function findSpotread(candidates?: string[]): string | null {
  const paths = candidates ?? [
    '/opt/homebrew/bin/spotread',
    '/usr/local/bin/spotread',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  if (candidates) return null;
  // PATH lookup: rely on spawn resolution; report the bare name if plausible.
  const pathDirs = (process.env.PATH ?? '').split(':');
  for (const dir of pathDirs) {
    if (dir && fs.existsSync(dir + '/spotread')) return dir + '/spotread';
  }
  return null;
}

const READ_TIMEOUT_MS = 15_000;
const DETECT_SETTLE_MS = 1_500;

export class Spotread {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private lineWaiters: ((line: string) => boolean)[] = [];
  private allOutput = '';

  constructor(
    private readonly binary: string,
    private readonly extraArgs: string[] = [],
  ) {}

  private ensureProc(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    this.buffer = '';
    this.allOutput = '';
    this.proc = spawn(this.binary, ['-v', ...this.extraArgs]);
    const onData = (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.allOutput += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.lineWaiters = this.lineWaiters.filter((w) => !w(line));
      }
    };
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);
    this.proc.on('error', () => {
      /* surfaced via detect()/read timeouts */
    });
    return this.proc;
  }

  /** Start (or reuse) the process and classify readiness. */
  async detect(): Promise<ProbeStatus> {
    if (!fs.existsSync(this.binary)) {
      return {
        state: 'argyll-missing',
        message: 'ArgyllCMS not found — install via: brew install argyll',
      };
    }
    const proc = this.ensureProc();
    await new Promise((r) => setTimeout(r, DETECT_SETTLE_MS));
    const out = this.allOutput;
    if (
      proc.exitCode !== null ||
      /No suitable/i.test(out) ||
      /no instrument/i.test(out)
    ) {
      this.dispose();
      return {
        state: 'no-probe',
        message: 'No probe detected — connect i1 Display Pro Plus and retry',
      };
    }
    const m = /Instrument Type:?\s*(.+)/i.exec(out);
    return { state: 'ready', device: m?.[1]?.trim() || 'i1 Display Pro Plus' };
  }

  /** One trigger → one XYZ sample. */
  private readSample(): Promise<{ X: number; Y: number; Z: number }> {
    const proc = this.ensureProc();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lineWaiters = this.lineWaiters.filter((w) => w !== waiter);
        reject(new Error('Reading timed out — probe placed on display?'));
      }, READ_TIMEOUT_MS);
      const waiter = (line: string): boolean => {
        const xyz = parseXyzLine(line);
        if (!xyz) return false;
        clearTimeout(timer);
        resolve(xyz);
        return true; // remove waiter
      };
      this.lineWaiters.push(waiter);
      proc.stdin.write('1\n');
    });
  }

  /** N samples averaged (default 3), like the Tkinter app's Avg mode. */
  async readPatch(samples = 3): Promise<XYZ> {
    const acc: { X: number; Y: number; Z: number }[] = [];
    for (let i = 0; i < samples; i++) {
      acc.push(await this.readSample());
    }
    return meanXyz(acc);
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
    this.lineWaiters = [];
  }
}
