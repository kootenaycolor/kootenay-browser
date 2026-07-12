/**
 * Per-frame preload: maintains an SVG feComponentTransfer table filter in
 * the page and applies it to every <video> element while a correction is
 * active. Receives ready-made tableValues strings from the main process
 * over IPC ('kc:lut'), so no color math lives here.
 *
 * color-interpolation-filters="sRGB" is load-bearing: the table must remap
 * the nonlinear code values directly, not a linearized version of them.
 */

import { ipcRenderer } from 'electron';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILTER_ID = 'kc-gamma-filter';
const HOST_ID = 'kc-gamma-host';
const MARK = 'kcGammaManaged';

let tableValues: string | null = null;

function ensureFilter(): void {
  if (!document.documentElement) return;
  let host = document.getElementById(HOST_ID) as unknown as SVGSVGElement | null;
  if (!host) {
    host = document.createElementNS(SVG_NS, 'svg');
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.id = FILTER_ID;
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const xfer = document.createElementNS(SVG_NS, 'feComponentTransfer');
    for (const ch of ['feFuncR', 'feFuncG', 'feFuncB'] as const) {
      const fn = document.createElementNS(SVG_NS, ch);
      fn.setAttribute('type', 'table');
      xfer.appendChild(fn);
    }
    filter.appendChild(xfer);
    host.appendChild(filter);
    document.documentElement.appendChild(host);
  }
  for (const fn of host.querySelectorAll('feFuncR, feFuncG, feFuncB')) {
    fn.setAttribute('tableValues', tableValues ?? '');
  }
}

function applyToVideo(video: HTMLVideoElement): void {
  if (tableValues) {
    video.style.setProperty('filter', `url("#${FILTER_ID}")`, 'important');
    video.disablePictureInPicture = true;
    (video.dataset as Record<string, string>)[MARK] = '1';
  } else if ((video.dataset as Record<string, string>)[MARK]) {
    video.style.removeProperty('filter');
    delete (video.dataset as Record<string, string>)[MARK];
  }
}

function applyAll(): void {
  if (!document.documentElement) return;
  if (tableValues) ensureFilter();
  for (const v of document.querySelectorAll('video')) {
    applyToVideo(v as HTMLVideoElement);
  }
}

let scheduled = false;
function scheduleApply(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    applyAll();
  });
}

ipcRenderer.on('kc:lut', (_evt, values: string | null) => {
  tableValues = values;
  applyAll();
});

function start(): void {
  applyAll();
  const observer = new MutationObserver((mutations) => {
    if (!tableValues) return;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        scheduleApply();
        return;
      }
      // Player scripts that rewrite style can wipe our filter; restore it.
      if (
        m.type === 'attributes' &&
        m.target instanceof HTMLVideoElement &&
        !m.target.style.filter.includes(FILTER_ID)
      ) {
        scheduleApply();
        return;
      }
    }
  });
  const observe = () =>
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe, { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
