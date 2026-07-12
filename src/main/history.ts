/**
 * Browsing history: one entry per URL with visit count and last-visit time,
 * stored in userData/history.json (separate file so settings.json stays
 * small). Feeds the URL-bar suggestions.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface HistoryEntry {
  url: string;
  title: string;
  visits: number;
  lastVisit: number; // epoch ms
}

const MAX_ENTRIES = 3000;

function historyPath(): string {
  return path.join(app.getPath('userData'), 'history.json');
}

let cache: Map<string, HistoryEntry> | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function load(): Map<string, HistoryEntry> {
  if (!cache) {
    cache = new Map();
    try {
      const arr = JSON.parse(fs.readFileSync(historyPath(), 'utf8')) as HistoryEntry[];
      for (const e of arr) cache.set(e.url, e);
    } catch {
      /* first run */
    }
  }
  return cache;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const entries = [...load().values()].sort((a, b) => b.lastVisit - a.lastVisit);
    const trimmed = entries.slice(0, MAX_ENTRIES);
    if (trimmed.length < entries.length) {
      cache = new Map(trimmed.map((e) => [e.url, e]));
    }
    try {
      fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
      fs.writeFileSync(historyPath(), JSON.stringify(trimmed));
    } catch {
      /* non-fatal */
    }
  }, 2000);
}

export function recordVisit(url: string, title?: string): void {
  if (!/^https?:/.test(url)) return;
  const map = load();
  const prev = map.get(url);
  map.set(url, {
    url,
    title: title || prev?.title || url,
    visits: (prev?.visits ?? 0) + 1,
    lastVisit: Date.now(),
  });
  scheduleSave();
}

export function updateTitle(url: string, title: string): void {
  const e = load().get(url);
  if (e && title) {
    e.title = title;
    scheduleSave();
  }
}

/** Substring match on url+title, ranked by frecency (visits + recency). */
export function searchHistory(query: string, limit = 6): HistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const now = Date.now();
  const scored: { e: HistoryEntry; score: number }[] = [];
  for (const e of load().values()) {
    const hay = (e.url + ' ' + e.title).toLowerCase();
    if (!hay.includes(q)) continue;
    const ageDays = (now - e.lastVisit) / 86_400_000;
    const recency = Math.max(0, 30 - ageDays) / 30;
    const startBonus = e.url.toLowerCase().includes('://' + q) ||
      e.url.toLowerCase().includes('://www.' + q)
      ? 5
      : 0;
    scored.push({ e, score: e.visits + recency * 3 + startBonus });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}

export function clearHistory(): void {
  cache = new Map();
  try {
    fs.rmSync(historyPath(), { force: true });
  } catch {
    /* ok */
  }
}
