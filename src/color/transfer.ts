/**
 * Transfer functions for the correction pipeline.
 *
 * Conventions: all signals normalized to [0,1]. `eotf` maps a code value to
 * relative luminance; `oetf` is its exact inverse. BT.1886 with zero black
 * offset is a pure 2.4 power law, so `gamma24` covers the mastering case.
 */

export type TransferId =
  | 'gamma196'
  | 'gamma22'
  | 'gamma24'
  | 'gamma26'
  | 'srgb'
  | 'linear';

export interface SourcePreset {
  id: TransferId;
  label: string;
}

/** Picker order mirrors the Screen app's custom-pipeline menu. */
export const SOURCE_PRESETS: SourcePreset[] = [
  { id: 'gamma196', label: 'Gamma 1.96' },
  { id: 'gamma22', label: 'Gamma 2.2' },
  { id: 'gamma24', label: 'Gamma 2.4' },
  { id: 'gamma26', label: 'Gamma 2.6' },
  { id: 'srgb', label: 'sRGB' },
  { id: 'linear', label: 'Linear' },
];

const POWER: Partial<Record<TransferId, number>> = {
  gamma196: 1.96,
  gamma22: 2.2,
  gamma24: 2.4,
  gamma26: 2.6,
};

export function srgbEotf(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function srgbOetf(l: number): number {
  return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

export function eotf(id: TransferId, v: number): number {
  v = Math.min(1, Math.max(0, v));
  if (id === 'linear') return v;
  if (id === 'srgb') return srgbEotf(v);
  return Math.pow(v, POWER[id]!);
}

export function oetf(id: TransferId, l: number): number {
  l = Math.min(1, Math.max(0, l));
  if (id === 'linear') return l;
  if (id === 'srgb') return srgbOetf(l);
  return Math.pow(l, 1 / POWER[id]!);
}
