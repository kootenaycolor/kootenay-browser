/**
 * Tiny JSON-backed store in userData: per-domain source-gamma defaults and
 * the machine calibration profile written by the measurement harness.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { TransferId } from '../color/transfer';
import { PipelineProfile, MACOS_DEFAULT } from '../color/presets';

interface StoreShape {
  domainDefaults: Record<string, TransferId | 'off'>;
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function calibrationPath(): string {
  return path.join(app.getPath('userData'), 'calibration.json');
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

let cache: StoreShape | null = null;

function store(): StoreShape {
  if (!cache) cache = readJson<StoreShape>(storePath()) ?? { domainDefaults: {} };
  return cache;
}

function persist(): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store(), null, 2));
}

export function domainDefault(host: string): TransferId | 'off' | undefined {
  return store().domainDefaults[normalizeHost(host)];
}

export function setDomainDefault(host: string, value: TransferId | 'off'): void {
  store().domainDefaults[normalizeHost(host)] = value;
  persist();
}

export function normalizeHost(host: string): string {
  return host.replace(/^www\./, '').toLowerCase();
}

/** Measured machine profile if calibration has run, else the analytic model. */
export function activePipelineProfile(): PipelineProfile {
  const measured = readJson<PipelineProfile>(calibrationPath());
  if (measured && Array.isArray(measured.identityCurve)) return measured;
  return MACOS_DEFAULT;
}

export function saveCalibration(profile: PipelineProfile): void {
  fs.mkdirSync(path.dirname(calibrationPath()), { recursive: true });
  fs.writeFileSync(calibrationPath(), JSON.stringify(profile, null, 2));
}
