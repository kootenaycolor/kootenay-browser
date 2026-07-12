/**
 * Which physical display the window is currently on, so the measured
 * correction follows the window across monitors.
 */

import { BrowserWindow, screen } from 'electron';

export interface DisplayInfo {
  id: number;
  label: string;
  width: number;
  height: number;
}

function labelFor(d: Electron.Display): string {
  // Electron's Display.label is populated on recent macOS; fall back to size.
  const raw = (d as unknown as { label?: string }).label;
  if (raw && raw.trim()) return raw;
  return `Display ${d.id} (${d.size.width}×${d.size.height})`;
}

export function displayInfo(d: Electron.Display): DisplayInfo {
  return { id: d.id, label: labelFor(d), width: d.size.width, height: d.size.height };
}

export function currentDisplay(win: BrowserWindow): DisplayInfo {
  return displayInfo(screen.getDisplayMatching(win.getBounds()));
}

export function allDisplays(): DisplayInfo[] {
  return screen.getAllDisplays().map(displayInfo);
}
