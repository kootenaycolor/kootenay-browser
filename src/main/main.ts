import { app, BrowserWindow, WebContentsView, ipcMain, screen } from 'electron';
import * as path from 'path';
import { TransferId, SOURCE_PRESETS } from '../color/transfer';
import { LUT_TAPS, buildCorrectionLut, lutToTableValues } from '../color/lut';
import {
  Method,
  DomainDefault,
  domainDefault,
  setDomainDefault,
  simpleTarget,
  setSimpleTarget,
  profilesForDisplay,
  activeProfileId,
  addProfileForDisplay,
  setActiveProfile,
  deleteProfile,
  resolveProfile,
  normalizeHost,
} from './settings';
import { lightProfileFromGamma, lightProfileFromPoints } from '../color/presets';
import { currentDisplay, allDisplays, DisplayInfo } from './displays';
import { runMeasurement } from './calibration';
import { Spotread, findSpotread, ProbeStatus } from './spotread';
import {
  runProbeMeasurement,
  parseCorrectionProfile,
  CorrectionPoint,
  ProbeHost,
} from './probe-measure';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Sites (Vimeo especially) UA-sniff the Electron token and serve degraded
// players. Present as plain Chrome.
app.whenReady().then(() => {
  const ua = app.userAgentFallback
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(/\skootenay-browser\/[\d.]+/, '');
  app.userAgentFallback = ua;
});

const TOOLBAR_H = 84;
const HOME_URL = 'https://vimeo.com';
const DEFAULT_SOURCE: TransferId = 'gamma24';

interface Tab {
  id: number;
  view: WebContentsView;
  method: Method;
  source: TransferId;
}

let win: BrowserWindow | null = null;
let popoverView: WebContentsView | null = null;
let popoverOpen = false;
let settingsWin: BrowserWindow | null = null;
let activeDisplayId = -1;
const tabs: Tab[] = [];
let activeTabId = -1;
let nextTabId = 1;

function probeUrl(): string {
  return 'file://' + path.join(__dirname, '..', 'probe', 'probe.html');
}

function curDisplay(): DisplayInfo | null {
  return win ? currentDisplay(win) : null;
}

function tableValuesFor(tab: Tab): string | null {
  if (tab.method === 'off') return null;
  const displayId = curDisplay()?.id ?? activeDisplayId;
  const { profile } = resolveProfile(tab.method, displayId);
  return lutToTableValues(buildCorrectionLut(tab.source, profile, LUT_TAPS));
}

/**
 * Deliver the LUT to EVERY frame, not just the main one. Platform embeds
 * (a Vimeo/YouTube/etc. player iframe on a third-party site) put the <video>
 * in a cross-origin subframe; webContents.send reaches only the main frame,
 * so those embeds would go uncorrected. The preload runs in subframes
 * (nodeIntegrationInSubFrames), so we fan the message out to all of them.
 */
function sendLutToAllFrames(wc: Electron.WebContents, values: string | null): void {
  const main = wc.mainFrame;
  if (!main) {
    wc.send('kc:lut', values);
    return;
  }
  for (const frame of main.framesInSubtree) {
    try {
      frame.send('kc:lut', values);
    } catch {
      /* frame detached mid-navigation */
    }
  }
}

function pushLut(tab: Tab): void {
  sendLutToAllFrames(tab.view.webContents, tableValuesFor(tab));
}

function pushAllLuts(): void {
  for (const t of tabs) pushLut(t);
}

function activeTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeTabId);
}

function buildState() {
  const display = curDisplay();
  const active = activeTab();
  const resolved =
    active && active.method !== 'off' && display
      ? resolveProfile(active.method, display.id)
      : null;
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.view.webContents.getTitle() || 'New Tab',
      url: t.view.webContents.getURL(),
      method: t.method,
      source: t.source,
      canGoBack: t.view.webContents.navigationHistory.canGoBack(),
      canGoForward: t.view.webContents.navigationHistory.canGoForward(),
    })),
    activeId: activeTabId,
    presets: SOURCE_PRESETS,
    simpleTarget: simpleTarget(),
    display: display ? { id: display.id, label: display.label } : null,
    activeProfile: resolved
      ? { label: resolved.profile.label, kind: resolved.profile.kind, fellBack: resolved.fellBack }
      : null,
  };
}

function broadcastState(): void {
  if (!win) return;
  const state = buildState();
  win.webContents.send('kc:state', state);
  popoverView?.webContents.send('kc:state', state);
  settingsWin?.webContents.send('kc:settings-state', buildSettingsState());
}

function buildSettingsState() {
  const display = curDisplay();
  return {
    presets: SOURCE_PRESETS,
    simpleTarget: simpleTarget(),
    displays: allDisplays().map((d) => ({
      ...d,
      current: d.id === display?.id,
      profiles: profilesForDisplay(d.id),
      activeId: activeProfileId(d.id),
    })),
    currentDisplayId: display?.id ?? null,
  };
}

/**
 * The pipeline popover lives in its own WebContentsView so it renders ABOVE
 * the active tab view (base-window HTML is always occluded by child views).
 * It covers the content area as a transparent backdrop; the card is anchored
 * top-right inside popover.html. Hidden when closed so the page stays
 * interactive.
 */
function ensurePopoverView(): void {
  if (popoverView || !win) return;
  popoverView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui-bridge.js'),
      contextIsolation: true,
    },
  });
  popoverView.setBackgroundColor('#00000000');
  popoverView.setVisible(false);
  win.contentView.addChildView(popoverView);
  popoverView.webContents.loadFile(
    path.join(__dirname, '..', 'ui', 'popover.html'),
  );
}

function layoutPopover(): void {
  if (!win || !popoverView) return;
  const [w, h] = win.getContentSize();
  popoverView.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: h - TOOLBAR_H });
}

/** Keep the popover topmost after tab views are (re)added. */
function raisePopover(): void {
  if (!win || !popoverView) return;
  win.contentView.removeChildView(popoverView);
  win.contentView.addChildView(popoverView);
}

function setPopoverOpen(open: boolean): void {
  ensurePopoverView();
  popoverOpen = open;
  if (!popoverView) return;
  if (open) {
    layoutPopover();
    raisePopover();
    popoverView.setVisible(true);
    broadcastState();
  } else {
    popoverView.setVisible(false);
  }
}

function layoutTabs(): void {
  if (!win) return;
  const [w, h] = win.getContentSize();
  for (const t of tabs) {
    t.view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: h - TOOLBAR_H });
  }
  layoutPopover();
}

function showTab(id: number): void {
  if (!win) return;
  activeTabId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  layoutTabs();
  raisePopover();
  broadcastState();
}

function createTab(
  url: string,
  opts: { method?: Method; source?: TransferId } = {},
): Tab {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'inject.js'),
      contextIsolation: true,
      nodeIntegrationInSubFrames: true,
      backgroundThrottling: false,
    },
  });
  const tab: Tab = {
    id: nextTabId++,
    view,
    method: opts.method ?? 'off',
    source: opts.source ?? DEFAULT_SOURCE,
  };
  tabs.push(tab);
  win!.contentView.addChildView(view);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: target }) => {
    const t = createTab(target);
    showTab(t.id);
    return { action: 'deny' };
  });
  wc.on('page-title-updated', broadcastState);
  wc.on('did-navigate', () => {
    // Apply the per-domain default when entering a new site.
    try {
      const host = normalizeHost(new URL(wc.getURL()).hostname);
      const def = domainDefault(host);
      if (def) {
        tab.method = def.method;
        tab.source = def.source;
      }
    } catch {
      /* non-http urls */
    }
    pushLut(tab);
    broadcastState();
  });
  wc.on('did-navigate-in-page', broadcastState);
  // Re-send the LUT whenever any frame (players live in iframes) loads.
  wc.on('did-frame-finish-load', () => pushLut(tab));

  wc.loadURL(url);
  showTab(tab.id);
  return tab;
}

function closeTab(id: number): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  win?.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (tabs.length === 0) {
    createTab(HOME_URL);
  } else if (activeTabId === id) {
    showTab(tabs[Math.max(0, idx - 1)].id);
  } else {
    broadcastState();
  }
}

function normalizeInput(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
  if (trimmed === 'probe') return probeUrl();
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return 'https://' + trimmed;
  return 'https://www.google.com/search?q=' + encodeURIComponent(trimmed);
}

function wireIpc(): void {
  ipcMain.on('kc:navigate', (_e, url: string) => {
    activeTab()?.view.webContents.loadURL(normalizeInput(url));
  });
  ipcMain.on('kc:back', () =>
    activeTab()?.view.webContents.navigationHistory.goBack(),
  );
  ipcMain.on('kc:forward', () =>
    activeTab()?.view.webContents.navigationHistory.goForward(),
  );
  ipcMain.on('kc:reload', () => activeTab()?.view.webContents.reload());
  ipcMain.on('kc:new-tab', () => void createTab(HOME_URL));
  ipcMain.on('kc:close-tab', (_e, id: number) => closeTab(id));
  ipcMain.on('kc:select-tab', (_e, id: number) => showTab(id));
  ipcMain.on('kc:open-probe', () => void createTab(probeUrl()));
  ipcMain.on('kc:toggle-popover', () => setPopoverOpen(!popoverOpen));
  ipcMain.on('kc:close-popover', () => setPopoverOpen(false));
  ipcMain.on('kc:open-settings', () => openSettingsWindow());

  const persistTabDefault = (tab: Tab) => {
    try {
      const host = normalizeHost(new URL(tab.view.webContents.getURL()).hostname);
      if (host) setDomainDefault(host, { method: tab.method, source: tab.source });
    } catch {
      /* non-http urls */
    }
  };

  ipcMain.on('kc:set-method', (_e, method: Method) => {
    const tab = activeTab();
    if (!tab) return;
    tab.method = method;
    pushLut(tab);
    persistTabDefault(tab);
    broadcastState();
  });
  ipcMain.on('kc:set-source', (_e, source: TransferId) => {
    const tab = activeTab();
    if (!tab) return;
    tab.source = source;
    pushLut(tab);
    persistTabDefault(tab);
    broadcastState();
  });
  ipcMain.on('kc:set-simple-target', (_e, target: TransferId) => {
    setSimpleTarget(target);
    pushAllLuts();
    broadcastState();
  });

  ipcMain.handle('kc:calibrate', async () => {
    const display = curDisplay() ?? undefined;
    const result = await runMeasurement({
      createTab: (url) => createTab(url, { method: 'off' }),
      closeTab,
      probeUrl: probeUrl(),
      sendLut: (tab, values) => tab.view.webContents.send('kc:lut', values),
      display,
    });
    if (display) addProfileForDisplay(display.id, result.profile);
    pushAllLuts();
    broadcastState();
    return result.summary;
  });

  // Physical-light import: quick (effective gamma) or full (patch points).
  ipcMain.handle(
    'kc:import-light',
    (
      _e,
      arg: { gamma?: number; points?: { input: number; luminance: number }[] },
    ) => {
      const display = curDisplay();
      if (!display) return { ok: false, error: 'no display' };
      const opts = { displayId: display.id, displayLabel: display.label };
      const profile =
        arg.points && arg.points.length >= 2
          ? lightProfileFromPoints(arg.points, opts)
          : arg.gamma
            ? lightProfileFromGamma(arg.gamma, opts)
            : null;
      if (!profile) return { ok: false, error: 'need gamma or ≥2 points' };
      addProfileForDisplay(display.id, profile);
      pushAllLuts();
      broadcastState();
      return { ok: true, id: profile.id };
    },
  );

  ipcMain.handle('kc:probe-detect', () => probeDetect());
  ipcMain.handle(
    'kc:probe-run',
    async (_e, opts: { samples?: number; correctionPath?: string | null }) => {
      try {
        return await runHardwareProbe(opts ?? {});
      } catch (err) {
        return { ok: false, error: String((err as Error).message ?? err) };
      }
    },
  );
  ipcMain.on('kc:probe-cancel', () => {
    probeCancelled = true;
  });
  ipcMain.handle('kc:probe-pick-correction', async () => {
    const { dialog } = require('electron') as typeof import('electron');
    const res = await dialog.showOpenDialog(settingsWin ?? win!, {
      title: 'Choose probe correction profile',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.on('kc:set-active-profile', (_e, displayId: number, id: string) => {
    setActiveProfile(displayId, id);
    pushAllLuts();
    broadcastState();
  });
  ipcMain.on('kc:delete-profile', (_e, displayId: number, id: string) => {
    deleteProfile(displayId, id);
    pushAllLuts();
    broadcastState();
  });
}

// ── hardware probe (spotread) ────────────────────────────────────────────────

let probeWin: BrowserWindow | null = null;
let probeInstance: Spotread | null = null;
let probeCancelled = false;

function spotreadBinary(): string | null {
  // --probe-sim (or env) substitutes the scripted simulator.
  if (process.argv.includes('--probe-sim') || process.env.KC_PROBE_SIM) {
    return path.join(__dirname, '..', '..', 'scripts', 'spotread-sim.js');
  }
  return findSpotread();
}

function getProbe(): Spotread | null {
  const bin = spotreadBinary();
  if (!bin) return null;
  if (!probeInstance) probeInstance = new Spotread(bin);
  return probeInstance;
}

async function probeDetect(): Promise<ProbeStatus> {
  const probe = getProbe();
  if (!probe) {
    return {
      state: 'argyll-missing',
      message: 'ArgyllCMS not found — install via: brew install argyll',
    };
  }
  return probe.detect();
}

function openProbeWindow(display: DisplayInfo): Promise<BrowserWindow> {
  const d = screen.getAllDisplays().find((x) => x.id === display.id);
  const w = new BrowserWindow({
    x: d?.bounds.x ?? 0,
    y: d?.bounds.y ?? 0,
    width: d?.bounds.width ?? 1280,
    height: d?.bounds.height ?? 720,
    frame: false,
    fullscreen: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'inject.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  w.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'Escape') probeCancelled = true;
  });
  w.on('closed', () => {
    if (probeWin === w) probeWin = null;
    probeCancelled = true;
  });
  w.loadFile(path.join(__dirname, '..', 'probe', 'probe-hw.html'));
  return new Promise((resolve) =>
    w.webContents.once('did-finish-load', () => resolve(w)),
  );
}

async function runHardwareProbe(opts: {
  samples?: number;
  correctionPath?: string | null;
  settleMs?: number;
  progress?: (p: unknown) => void;
}): Promise<unknown> {
  const display = curDisplay();
  if (!display) throw new Error('no display');
  const probe = getProbe();
  if (!probe) throw new Error('ArgyllCMS not found — brew install argyll');

  let correction: CorrectionPoint[] | null = null;
  if (opts.correctionPath) {
    const fs = require('fs') as typeof import('fs');
    correction = parseCorrectionProfile(
      JSON.parse(fs.readFileSync(opts.correctionPath, 'utf8')),
    );
  }

  probeCancelled = false;
  probeWin = await openProbeWindow(display);
  const w = probeWin;
  const host: ProbeHost = {
    showSegment: async (segment) => {
      await w.webContents.executeJavaScript(`window.kcShowSegment(${segment})`);
    },
    hud: async (text) => {
      await w.webContents.executeJavaScript(
        `window.kcHud(${JSON.stringify(text)})`,
      );
    },
    sendLut: (values) => w.webContents.send('kc:lut', values),
    onProgress: (p) => {
      opts.progress?.(p);
      settingsWin?.webContents.send('kc:probe-progress', p);
    },
    isCancelled: () => probeCancelled,
    display: { id: display.id, label: display.label },
  };

  try {
    const result = await runProbeMeasurement(host, probe, {
      samplesPerPatch: opts.samples ?? 3,
      correction,
      settleMs: opts.settleMs,
    });
    addProfileForDisplay(display.id, result.profile);
    pushAllLuts();
    broadcastState();
    return {
      ok: true,
      fittedGamma: result.fittedGamma,
      driftPct: result.driftPct,
      driftValid: result.driftValid,
      verify: result.verify,
      readings: result.readings,
      profileLabel: result.profile.label,
    };
  } finally {
    probe.dispose();
    probeInstance = null;
    if (probeWin && !probeWin.isDestroyed()) probeWin.close();
    probeWin = null;
  }
}

function openSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 680,
    title: 'Color Settings',
    parent: win ?? undefined,
    backgroundColor: '#262624',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui-bridge.js'),
      contextIsolation: true,
    },
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'ui', 'settings.html'));
  settingsWin.webContents.on('did-finish-load', () =>
    settingsWin?.webContents.send('kc:settings-state', buildSettingsState()),
  );
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#1f1e1b',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui-bridge.js'),
      contextIsolation: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'chrome.html'));
  ensurePopoverView();
  activeDisplayId = curDisplay()?.id ?? -1;
  win.on('resize', layoutTabs);
  // When the window crosses to another monitor, the measured correction for
  // that display takes over.
  const onMaybeDisplayChange = () => {
    const id = curDisplay()?.id ?? -1;
    if (id !== activeDisplayId) {
      activeDisplayId = id;
      pushAllLuts();
      broadcastState();
    }
  };
  win.on('move', onMaybeDisplayChange);
  win.on('moved', onMaybeDisplayChange);
  screen.on('display-metrics-changed', onMaybeDisplayChange);
  win.webContents.on('did-finish-load', broadcastState);
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  wireIpc();
  createWindow();

  if (process.argv.includes('--measure')) {
    // Headless-ish self-test: measure the pipeline, bake calibration, exit.
    win!.webContents.once('did-finish-load', async () => {
      try {
        const display = curDisplay() ?? undefined;
        const result = await runMeasurement({
          createTab: (url) => createTab(url, { method: 'off' }),
          closeTab,
          probeUrl: probeUrl(),
          sendLut: (tab, values) => tab.view.webContents.send('kc:lut', values),
          display,
        });
        if (display) addProfileForDisplay(display.id, result.profile);
        console.log(JSON.stringify(result.summary, null, 2));
        const out = process.argv
          .find((a) => a.startsWith('--out='))
          ?.slice('--out='.length);
        if (out) {
          require('fs').writeFileSync(out, JSON.stringify(result, null, 2));
        }
      } catch (err) {
        console.error('MEASUREMENT FAILED:', err);
        process.exitCode = 1;
      }
      app.quit();
    });
  } else if (process.argv.includes('--smoke')) {
    // End-to-end smoke test: load a real Vimeo video, apply the 2.4
    // correction, confirm the preload attached the filter, and dump PNGs of
    // the chrome and the corrected page for inspection.
    const outDir =
      process.argv.find((a) => a.startsWith('--shots='))?.slice(8) ?? '.';
    const fs = require('fs') as typeof import('fs');
    const report: Record<string, unknown> = {};
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const loadAndCheck = async (name: string, url: string) => {
      const tab = createTab(url, { method: 'off' });
      await new Promise<void>((resolve) =>
        tab.view.webContents.once('did-finish-load', () => resolve()),
      );
      await settle(6000);
      const entry: Record<string, unknown> = {
        url: tab.view.webContents.getURL(),
      };
      entry.video = await tab.view.webContents.executeJavaScript(
        `(() => { const v = document.querySelector('video');
           return v ? { readyState: v.readyState, t: v.currentTime } : null; })()`,
      );
      tab.method = 'simple';
      pushLut(tab);
      await settle(1500);
      entry.filter = await tab.view.webContents.executeJavaScript(
        `(() => { const v = document.querySelector('video');
           return v ? getComputedStyle(v).filter : 'no-video'; })()`,
      );
      const shot = await tab.view.webContents.capturePage();
      fs.writeFileSync(`${outDir}/smoke-${name}.png`, shot.toPNG());
      report[name] = entry;
      return tab;
    };
    try {
      // Vimeo: land on staff picks, follow the first video link.
      const vTab = createTab('https://vimeo.com/channels/staffpicks', {
        method: 'off',
      });
      await new Promise<void>((resolve) =>
        vTab.view.webContents.once('did-finish-load', () => resolve()),
      );
      await settle(4000);
      const firstVideo = await vTab.view.webContents.executeJavaScript(
        `(() => { const hrefs = [...document.querySelectorAll('a[href]')]
             .map(a => a.href);
           return hrefs.find(h =>
             /^https:\\/\\/vimeo\\.com\\/\\d{6,}$/.test(h)) ?? null; })()`,
      );
      report.firstVimeoLink = firstVideo;
      closeTab(vTab.id);
      if (firstVideo) await loadAndCheck('vimeo', firstVideo);
      await loadAndCheck(
        'youtube',
        'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      );
      const chromeShot = await win!.webContents.capturePage();
      fs.writeFileSync(outDir + '/smoke-chrome.png', chromeShot.toPNG());
    } catch (err) {
      report.error = String(err);
      process.exitCode = 1;
    }
    console.log('KC_SMOKE ' + JSON.stringify(report, null, 2));
    app.quit();
  } else if (process.argv.includes('--ui-check')) {
    // Exercise the popover UI end-to-end: open it, pick Gamma 2.4 through
    // the real select handler, confirm the badge + domain persistence, and
    // dump a PNG of the chrome for visual review.
    const outDir =
      process.argv.find((a) => a.startsWith('--shots='))?.slice(8) ?? '.';
    const fs = require('fs') as typeof import('fs');
    try {
    if (win!.webContents.isLoading()) {
      await new Promise<void>((resolve) =>
        win!.webContents.once('did-finish-load', () => resolve()),
      );
    }
    const tab = createTab('https://vimeo.com', { method: 'off' });
    await new Promise<void>((resolve) =>
      tab.view.webContents.once('did-finish-load', () => resolve()),
    );
    await new Promise((r) => setTimeout(r, 1500));

    // Click the toolbar button (base layer) → main opens the popover view.
    await win!.webContents.executeJavaScript(
      `document.getElementById('pipebtn').click()`,
    );
    await new Promise((r) => setTimeout(r, 400));

    // The fix under test: popover view must be VISIBLE and TOPMOST (above the
    // tab view), not occluded like the old base-layer popover.
    const children = win!.contentView.children;
    const popoverVisible = popoverView?.getVisible() ?? false;
    const popoverTopmost = children[children.length - 1] === popoverView;

    // Drive the real controls inside the popover view's own document.
    await popoverView!.webContents.executeJavaScript(
      `document.getElementById('method').value = 'simple';
       document.getElementById('method').dispatchEvent(new Event('change'));
       document.getElementById('source').value = 'gamma24';
       document.getElementById('source').dispatchEvent(new Event('change'));`,
    );
    await new Promise((r) => setTimeout(r, 800));
    const badge = await win!.webContents.executeJavaScript(
      `document.getElementById('pipelabel').textContent`,
    );
    const filter = await tab.view.webContents.executeJavaScript(
      `(() => { const v = document.querySelector('video');
         return v ? getComputedStyle(v).filter : 'no-video-on-page'; })()`,
    );
    console.log(
      'KC_UI ' +
        JSON.stringify({
          popoverVisible,
          popoverTopmost,
          badge,
          filter,
          method: tab.method,
          source: tab.source,
        }),
    );
    } catch (err) {
      console.log('KC_UI ' + JSON.stringify({ error: String(err) }));
      process.exitCode = 1;
    }
    app.quit();
  } else if (process.argv.includes('--probe-sim')) {
    // End-to-end hardware-probe flow against the scripted spotread simulator:
    // detect → fullscreen patch window → 12 reads → drift gate → light profile
    // → physical verify pass. Proves the whole pipeline without an instrument.
    try {
      const status = await probeDetect();
      console.log('KC_PROBE_DETECT ' + JSON.stringify(status));
      if (status.state !== 'ready') throw new Error(status.state);
      const result = await runHardwareProbe({
        samples: 1,
        settleMs: 50,
        progress: (p) => console.log('KC_PROBE_PROGRESS ' + JSON.stringify(p)),
      });
      console.log('KC_PROBE_RESULT ' + JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('KC_PROBE_FAILED', err);
      process.exitCode = 1;
    }
    app.quit();
  } else if (process.argv.includes('--embed-check')) {
    // Prove the cross-origin iframe embed path: load a file:// page whose
    // <video> lives inside a youtube.com iframe, apply Simple, and confirm the
    // filter reaches the subframe's video (webContents.send would not).
    const embedUrl =
      'file://' + path.join(__dirname, '..', 'probe', 'embed-test.html');
    const report: Record<string, unknown> = {};
    try {
      const tab = createTab(embedUrl, { method: 'off' });
      await new Promise<void>((resolve) =>
        tab.view.webContents.once('did-finish-load', () => resolve()),
      );
      await new Promise((r) => setTimeout(r, 6000));
      tab.method = 'simple';
      pushLut(tab);
      await new Promise((r) => setTimeout(r, 1500));

      const frames = tab.view.webContents.mainFrame.framesInSubtree;
      report.frameCount = frames.length;
      const results: unknown[] = [];
      for (const f of frames) {
        try {
          const r = await f.executeJavaScript(
            `(() => { const v = document.querySelector('video');
               return v ? { origin: location.origin,
                 filter: getComputedStyle(v).filter } : null; })()`,
          );
          if (r) results.push(r);
        } catch {
          /* frame gone */
        }
      }
      report.videoFrames = results;
    } catch (err) {
      report.error = String(err);
      process.exitCode = 1;
    }
    console.log('KC_EMBED ' + JSON.stringify(report, null, 2));
    app.quit();
  } else if (process.argv.includes('--verify-screen')) {
    // Open the probe with the Gamma 2.4 correction active and report where
    // the video sits on screen, so an external screencapture can read the
    // post-ColorSync framebuffer (white paper Probe 2).
    win!.setPosition(40, 40);
    const tab = createTab(probeUrl(), { method: 'measured', source: 'gamma24' });
    tab.view.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const b = win!.getContentBounds();
        console.log(
          'KC_VIDEO_RECT ' +
            JSON.stringify({ x: b.x, y: b.y + TOOLBAR_H, w: 640, h: 360 }),
        );
      }, 2500);
    });
  } else {
    createTab(HOME_URL);
  }
});

app.on('window-all-closed', () => app.quit());
