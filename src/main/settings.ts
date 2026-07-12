/**
 * JSON-backed store in userData. Holds:
 *  - per-domain defaults (correction method + source gamma),
 *  - global mode defaults (simple target),
 *  - per-display measured profiles (framebuffer + light), keyed by display id.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { TransferId } from '../color/transfer';
import {
  PipelineProfile,
  simpleProfile,
  MACOS_DEFAULT,
} from '../color/presets';

export type Method = 'off' | 'simple' | 'measured';

export interface DomainDefault {
  method: Method;
  source: TransferId;
}

interface DisplayEntry {
  activeId: string | null;
  profiles: PipelineProfile[];
}

interface StoreShape {
  domainDefaults: Record<string, DomainDefault>;
  simpleTarget: TransferId;
  displays: Record<string, DisplayEntry>;
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
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
  if (!cache) {
    cache = readJson<StoreShape>(storePath()) ?? {
      domainDefaults: {},
      simpleTarget: 'gamma22',
      displays: {},
    };
    cache.domainDefaults ??= {};
    cache.simpleTarget ??= 'gamma22';
    cache.displays ??= {};
  }
  return cache;
}

function persist(): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store(), null, 2));
}

export function normalizeHost(host: string): string {
  return host.replace(/^www\./, '').toLowerCase();
}

// ── per-domain defaults ────────────────────────────────────────────────────

export function domainDefault(host: string): DomainDefault | undefined {
  return store().domainDefaults[normalizeHost(host)];
}

export function setDomainDefault(host: string, value: DomainDefault): void {
  store().domainDefaults[normalizeHost(host)] = value;
  persist();
}

// ── simple-mode target ──────────────────────────────────────────────────────

export function simpleTarget(): TransferId {
  return store().simpleTarget;
}

export function setSimpleTarget(target: TransferId): void {
  store().simpleTarget = target;
  persist();
}

// ── per-display measured profiles ───────────────────────────────────────────

function displayEntry(displayId: number): DisplayEntry {
  const key = String(displayId);
  return (store().displays[key] ??= { activeId: null, profiles: [] });
}

export function profilesForDisplay(displayId: number): PipelineProfile[] {
  return displayEntry(displayId).profiles;
}

export function activeProfileId(displayId: number): string | null {
  return store().displays[String(displayId)]?.activeId ?? null;
}

export function addProfileForDisplay(
  displayId: number,
  profile: PipelineProfile,
): void {
  const entry = displayEntry(displayId);
  entry.profiles = entry.profiles.filter((p) => p.id !== profile.id);
  entry.profiles.push(profile);
  entry.activeId = profile.id; // newest measurement becomes active
  persist();
}

export function setActiveProfile(displayId: number, profileId: string): void {
  displayEntry(displayId).activeId = profileId;
  persist();
}

export function deleteProfile(displayId: number, profileId: string): void {
  const entry = displayEntry(displayId);
  entry.profiles = entry.profiles.filter((p) => p.id !== profileId);
  if (entry.activeId === profileId) {
    entry.activeId = entry.profiles.at(-1)?.id ?? null;
  }
  persist();
}

export function activeMeasuredProfile(
  displayId: number,
): PipelineProfile | undefined {
  const entry = store().displays[String(displayId)];
  if (!entry) return undefined;
  return entry.profiles.find((p) => p.id === entry.activeId);
}

/**
 * Resolve the pipeline profile to use for a given method + display.
 * Measured with no profile for this display falls back to Simple so the user
 * still gets a reasonable correction (flagged via `fellBack`).
 */
export function resolveProfile(
  method: Method,
  displayId: number,
): { profile: PipelineProfile; fellBack: boolean } {
  if (method === 'simple') {
    return { profile: simpleProfile(simpleTarget()), fellBack: false };
  }
  const measured = activeMeasuredProfile(displayId);
  if (measured) return { profile: measured, fellBack: false };
  return { profile: simpleProfile(simpleTarget()), fellBack: true };
}

/** Legacy analytic fallback (used only if a display has no profile at all). */
export { MACOS_DEFAULT };
