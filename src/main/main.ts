import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron';
import * as path from 'path';
import { TransferId, SOURCE_PRESETS } from '../color/transfer';
import { LUT_TAPS, buildCorrectionLut, lutToTableValues } from '../color/lut';
import {
  activePipelineProfile,
  saveCalibration,
  domainDefault,
  setDomainDefault,
  normalizeHost,
} from './settings';
import { runMeasurement } from './calibration';

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

export type GammaSetting = TransferId | 'off';

interface Tab {
  id: number;
  view: WebContentsView;
  gamma: GammaSetting;
}

let win: BrowserWindow | null = null;
const tabs: Tab[] = [];
let activeTabId = -1;
let nextTabId = 1;

function probeUrl(): string {
  return (
    'file://' + path.join(__dirname, '..', 'probe', 'probe.html')
  );
}

function tableValuesFor(gamma: GammaSetting): string | null {
  if (gamma === 'off') return null;
  const profile = activePipelineProfile();
  return lutToTableValues(buildCorrectionLut(gamma, profile.identityCurve, LUT_TAPS));
}

function pushLut(tab: Tab): void {
  tab.view.webContents.send('kc:lut', tableValuesFor(tab.gamma));
}

function activeTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeTabId);
}

function broadcastState(): void {
  if (!win) return;
  const profile = activePipelineProfile();
  win.webContents.send('kc:state', {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.view.webContents.getTitle() || 'New Tab',
      url: t.view.webContents.getURL(),
      gamma: t.gamma,
      canGoBack: t.view.webContents.navigationHistory.canGoBack(),
      canGoForward: t.view.webContents.navigationHistory.canGoForward(),
    })),
    activeId: activeTabId,
    presets: SOURCE_PRESETS,
    pipeline: { label: profile.label, measured: profile.measured },
  });
}

function layoutTabs(): void {
  if (!win) return;
  const [w, h] = win.getContentSize();
  for (const t of tabs) {
    t.view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: h - TOOLBAR_H });
  }
}

function showTab(id: number): void {
  if (!win) return;
  activeTabId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  layoutTabs();
  broadcastState();
}

function createTab(url: string, opts: { gamma?: GammaSetting } = {}): Tab {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'inject.js'),
      contextIsolation: true,
      nodeIntegrationInSubFrames: true,
      backgroundThrottling: false,
    },
  });
  const tab: Tab = { id: nextTabId++, view, gamma: opts.gamma ?? 'off' };
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
      if (def !== undefined) tab.gamma = def;
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
  ipcMain.on('kc:set-gamma', (_e, gamma: GammaSetting) => {
    const tab = activeTab();
    if (!tab) return;
    tab.gamma = gamma;
    pushLut(tab);
    try {
      const host = normalizeHost(
        new URL(tab.view.webContents.getURL()).hostname,
      );
      if (host) setDomainDefault(host, gamma);
    } catch {
      /* non-http urls */
    }
    broadcastState();
  });
  ipcMain.handle('kc:calibrate', async () => {
    const result = await runMeasurement({
      createTab,
      closeTab,
      probeUrl: probeUrl(),
      sendLut: (tab, values) => tab.view.webContents.send('kc:lut', values),
    });
    saveCalibration(result.profile);
    for (const t of tabs) pushLut(t);
    broadcastState();
    return result.summary;
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
  win.on('resize', layoutTabs);
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
        const result = await runMeasurement({
          createTab,
          closeTab,
          probeUrl: probeUrl(),
          sendLut: (tab, values) => tab.view.webContents.send('kc:lut', values),
        });
        saveCalibration(result.profile);
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
      const tab = createTab(url, { gamma: 'off' });
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
      tab.gamma = 'gamma24';
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
        gamma: 'off',
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
    const tab = createTab('https://vimeo.com', { gamma: 'off' });
    await new Promise<void>((resolve) =>
      tab.view.webContents.once('did-finish-load', () => resolve()),
    );
    await new Promise((r) => setTimeout(r, 1500));
    await win!.webContents.executeJavaScript(
      `document.getElementById('pipebtn').click();
       document.getElementById('mode').value = 'custom';
       document.getElementById('mode').dispatchEvent(new Event('change'));
       document.getElementById('gamma').value = 'gamma24';
       document.getElementById('gamma').dispatchEvent(new Event('change'));`,
    );
    await new Promise((r) => setTimeout(r, 800));
    const badge = await win!.webContents.executeJavaScript(
      `document.getElementById('pipelabel').textContent`,
    );
    const filter = await tab.view.webContents.executeJavaScript(
      `(() => { const v = document.querySelector('video');
         return v ? getComputedStyle(v).filter : 'no-video-on-page'; })()`,
    );
    const shot = await win!.webContents.capturePage();
    fs.writeFileSync(outDir + '/ui-check.png', shot.toPNG());
    console.log('KC_UI ' + JSON.stringify({ badge, filter, gamma: tab.gamma }));
    } catch (err) {
      console.log('KC_UI ' + JSON.stringify({ error: String(err) }));
      process.exitCode = 1;
    }
    app.quit();
  } else if (process.argv.includes('--verify-screen')) {
    // Open the probe with the Gamma 2.4 correction active and report where
    // the video sits on screen, so an external screencapture can read the
    // post-ColorSync framebuffer (white paper Probe 2).
    win!.setPosition(40, 40);
    const tab = createTab(probeUrl(), { gamma: 'gamma24' });
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
