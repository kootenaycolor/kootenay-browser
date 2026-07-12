import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  screen,
  Menu,
  MenuItemConstructorOptions,
  Notification,
  clipboard,
  shell,
  session,
  dialog,
  protocol,
  net,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
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
  homePage,
  setHomePage,
  bookmarks,
  isBookmarked,
  addBookmark,
  removeBookmark,
  bookmarksBarVisible,
  setBookmarksBarVisible,
  saveSession,
  lastSession,
  saveWindowBounds,
  windowBounds,
} from './settings';
import {
  recordVisit,
  updateTitle,
  searchHistory,
  recentHistory,
  topSites,
  clearHistory,
} from './history';
import { installMenu } from './menu';
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

// Internal pages served from kootenay://<name> (newtab, history, downloads,
// bookmarks). Privileged so the inject preload can expose kcInternal to them.
const INTERNAL_PAGES = new Set(['newtab', 'history', 'downloads', 'bookmarks']);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kootenay',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

function registerInternalProtocol(): void {
  const uiDir = path.join(__dirname, '..', 'ui');
  protocol.handle('kootenay', async (req) => {
    const url = new URL(req.url);
    const host = url.hostname || 'newtab';
    let file: string;
    if (url.pathname && url.pathname !== '/') {
      // asset request (css/js) — resolve within ui/, no traversal
      const base = path.basename(url.pathname);
      file = path.join(uiDir, base);
      if (!file.startsWith(uiDir)) {
        return new Response('forbidden', { status: 403 });
      }
    } else {
      const page = INTERNAL_PAGES.has(host) ? host : 'newtab';
      file = path.join(uiDir, `page-${page}.html`);
    }
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// Sites (Vimeo especially) UA-sniff the Electron token and serve degraded
// players. Present as plain Chrome.
app.whenReady().then(() => {
  const ua = app.userAgentFallback
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(/\skootenay-browser\/[\d.]+/, '');
  app.userAgentFallback = ua;
});

const TOOLBAR_H = 84;
const BOOKMARKS_BAR_H = 32;
const FINDBAR_H = 38;
const DEFAULT_SOURCE: TransferId = 'gamma24';
const NEWTAB_URL = 'kootenay://newtab';

let findBarVisible = false;
let htmlFullscreen = false;

function chromeHeight(): number {
  if (htmlFullscreen) return 0;
  return (
    TOOLBAR_H +
    (bookmarksBarVisible() ? BOOKMARKS_BAR_H : 0) +
    (findBarVisible ? FINDBAR_H : 0)
  );
}

interface Tab {
  id: number;
  view: WebContentsView;
  method: Method;
  source: TransferId;
  favicon?: string;
  audible?: boolean;
  muted?: boolean;
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
      favicon: t.favicon,
      method: t.method,
      source: t.source,
      loading: t.view.webContents.isLoading(),
      audible: !!t.audible,
      muted: !!t.muted,
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
    bookmarks: bookmarks(),
    bookmarksBarVisible: bookmarksBarVisible(),
    currentBookmarked:
      active && /^https?:/.test(active.view.webContents.getURL())
        ? isBookmarked(active.view.webContents.getURL())
        : false,
    security: securityOf(active?.view.webContents.getURL() ?? ''),
  };
}

function securityOf(url: string): 'secure' | 'insecure' | 'internal' {
  if (/^https:/.test(url)) return 'secure';
  if (/^http:/.test(url)) return 'insecure';
  return 'internal';
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
  const ch = chromeHeight();
  popoverView.setBounds({ x: 0, y: ch, width: w, height: h - ch });
}

// ── URL suggestions overlay (topmost, avoids tab-view occlusion) ─────────────

let suggestView: WebContentsView | null = null;

function ensureSuggestView(): void {
  if (suggestView || !win) return;
  suggestView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui-bridge.js'),
      contextIsolation: true,
    },
  });
  suggestView.setBackgroundColor('#00000000');
  suggestView.setVisible(false);
  win.contentView.addChildView(suggestView);
  suggestView.webContents.loadFile(
    path.join(__dirname, '..', 'ui', 'suggest.html'),
  );
}

function showSuggest(rows: { url: string; title: string }[]): void {
  ensureSuggestView();
  if (!suggestView || !win) return;
  if (rows.length === 0) {
    suggestView.setVisible(false);
    return;
  }
  const [w] = win.getContentSize();
  const rowH = 34;
  const height = Math.min(rows.length, 6) * rowH + 8;
  suggestView.setBounds({ x: 148, y: 82, width: w - 148 - 176, height });
  win.contentView.removeChildView(suggestView);
  win.contentView.addChildView(suggestView);
  suggestView.setVisible(true);
  suggestView.webContents.send('kc:suggest-rows', rows);
}

function hideSuggest(): void {
  suggestView?.setVisible(false);
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
  const ch = chromeHeight();
  for (const t of tabs) {
    t.view.setBounds({ x: 0, y: ch, width: w, height: h - ch });
  }
  layoutPopover();
  win.webContents.send('kc:chrome-layout', {
    bookmarksBar: bookmarksBarVisible() && !htmlFullscreen,
    findBar: findBarVisible && !htmlFullscreen,
  });
}

function showTab(id: number): void {
  if (!win) return;
  hideSuggest();
  activeTabId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  layoutTabs();
  raisePopover();
  broadcastState();
}

function createTab(
  url: string,
  opts: { method?: Method; source?: TransferId; background?: boolean } = {},
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
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (!/^https?:|^file:/.test(target)) {
      shell.openExternal(target); // mailto:, ftp:, custom schemes
      return { action: 'deny' };
    }
    // cmd-click / middle-click open in the background; _blank & new-window focus.
    createTab(target, { background: disposition === 'background-tab' });
    return { action: 'deny' };
  });
  wc.on('page-title-updated', (_e, title) => {
    updateTitle(wc.getURL(), title);
    broadcastState();
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = favicons[0];
    broadcastState();
  });
  wc.on('did-start-loading', broadcastState);
  wc.on('did-stop-loading', broadcastState);
  wc.on('audio-state-changed', (evt) => {
    tab.audible = (evt as unknown as { audible: boolean }).audible;
    broadcastState();
  });
  wc.on('update-target-url', (_e, url) => win?.webContents.send('kc:hover-url', url));
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
    recordVisit(wc.getURL(), wc.getTitle());
    pushLut(tab);
    broadcastState();
    scheduleSessionSave();
  });
  wc.on('did-navigate-in-page', () => {
    recordVisit(wc.getURL(), wc.getTitle());
    broadcastState();
    scheduleSessionSave();
  });
  // Re-send the LUT whenever any frame (players live in iframes) loads.
  wc.on('did-frame-finish-load', () => pushLut(tab));

  // Simple styled error page (skip -3 = aborted, e.g. user navigated away).
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || code === 0) return;
    const errUrl =
      'file://' +
      path.join(__dirname, '..', 'ui', 'error.html') +
      `?url=${encodeURIComponent(failedUrl)}&desc=${encodeURIComponent(desc)}`;
    wc.loadURL(errUrl);
  });

  // HTML fullscreen (video players): give the view the whole window.
  wc.on('enter-html-full-screen', () => {
    htmlFullscreen = true;
    layoutTabs();
  });
  wc.on('leave-html-full-screen', () => {
    htmlFullscreen = false;
    layoutTabs();
  });

  wc.on('found-in-page', (_e, result) => {
    win?.webContents.send('kc:find-result', {
      matches: result.matches,
      active: result.activeMatchOrdinal,
    });
  });

  attachContextMenu(tab);

  wc.loadURL(url);
  if (!opts.background) showTab(tab.id);
  else broadcastState();
  return tab;
}

// ── context menu ─────────────────────────────────────────────────────────────

function attachContextMenu(tab: Tab): void {
  const wc = tab.view.webContents;
  wc.on('context-menu', (_e, params) => {
    const items: MenuItemConstructorOptions[] = [];
    if (params.linkURL) {
      items.push(
        {
          label: 'Open Link in New Tab',
          click: () => void createTab(params.linkURL, { background: true }),
        },
        {
          label: 'Copy Link',
          click: () => clipboard.writeText(params.linkURL),
        },
        { type: 'separator' },
      );
    }
    if (params.hasImageContents && params.srcURL) {
      items.push(
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        {
          label: 'Copy Image Address',
          click: () => clipboard.writeText(params.srcURL),
        },
        {
          label: 'Save Image As…',
          click: () => wc.downloadURL(params.srcURL),
        },
        { type: 'separator' },
      );
    }
    if (params.selectionText) {
      items.push(
        { role: 'copy' },
        {
          label: `Search for “${params.selectionText.slice(0, 30)}…”`,
          click: () =>
            void createTab(
              'https://www.google.com/search?q=' +
                encodeURIComponent(params.selectionText),
            ),
        },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      items.push(
        { role: 'undo' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
      );
    }
    items.push(
      {
        label: 'Back',
        enabled: wc.navigationHistory.canGoBack(),
        click: () => wc.navigationHistory.goBack(),
      },
      {
        label: 'Forward',
        enabled: wc.navigationHistory.canGoForward(),
        click: () => wc.navigationHistory.goForward(),
      },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      {
        label: 'Inspect Element',
        click: () => {
          wc.inspectElement(params.x, params.y);
        },
      },
    );
    Menu.buildFromTemplate(items).popup({ window: win! });
  });
}

// ── session persistence ──────────────────────────────────────────────────────

let sessionSaveTimer: NodeJS.Timeout | null = null;

function snapshotSession(): void {
  const urls = tabs
    .map((t) => t.view.webContents.getURL())
    .filter((u) => /^https?:/.test(u));
  const activeIndex = Math.max(
    0,
    tabs.filter((t) => /^https?:/.test(t.view.webContents.getURL()))
      .findIndex((t) => t.id === activeTabId),
  );
  if (urls.length > 0) saveSession({ urls, activeIndex });
  if (win && !win.isDestroyed() && !win.isFullScreen()) {
    saveWindowBounds(win.getBounds());
  }
}

function scheduleSessionSave(): void {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(snapshotSession, 1500);
}

// ── QoL actions ──────────────────────────────────────────────────────────────

function goHome(): void {
  activeTab()?.view.webContents.loadURL(homePage());
}

function toggleBookmark(): void {
  const wc = activeTab()?.view.webContents;
  if (!wc) return;
  const url = wc.getURL();
  if (!/^https?:/.test(url)) return;
  if (isBookmarked(url)) removeBookmark(url);
  else addBookmark(wc.getTitle() || url, url);
  broadcastState();
}

function openFindBar(): void {
  findBarVisible = true;
  layoutTabs();
  win?.webContents.send('kc:find-focus');
}

function zoom(dir: 'in' | 'out' | 'reset'): void {
  const wc = activeTab()?.view.webContents;
  if (!wc) return;
  const cur = wc.getZoomFactor();
  const next =
    dir === 'reset'
      ? 1
      : dir === 'in'
        ? Math.min(3, cur + 0.1)
        : Math.max(0.3, cur - 0.1);
  wc.setZoomFactor(next);
}

function selectTabByIndex(i: number): void {
  if (tabs[i]) showTab(tabs[i].id);
}

function cycleTab(delta: number): void {
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  if (idx === -1) return;
  const next = (idx + delta + tabs.length) % tabs.length;
  showTab(tabs[next].id);
}

const closedTabs: { url: string; index: number }[] = [];

function closeTab(id: number): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  const url = tab.view.webContents.getURL();
  if (/^https?:/.test(url)) {
    closedTabs.push({ url, index: idx });
    if (closedTabs.length > 25) closedTabs.shift();
  }
  win?.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (tabs.length === 0) {
    createTab(NEWTAB_URL);
  } else if (activeTabId === id) {
    showTab(tabs[Math.max(0, idx - 1)].id);
  } else {
    broadcastState();
  }
  scheduleSessionSave();
}

function reopenClosedTab(): void {
  const last = closedTabs.pop();
  if (last) createTab(last.url);
}

function stopOrReload(): void {
  const wc = activeTab()?.view.webContents;
  if (!wc) return;
  if (wc.isLoadingMainFrame()) wc.stop();
  else wc.reload();
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
  ipcMain.on('kc:reload', () => stopOrReload());
  ipcMain.on('kc:new-tab', () => void createTab(NEWTAB_URL));
  ipcMain.on('kc:close-tab', (_e, id: number) => closeTab(id));
  ipcMain.on('kc:select-tab', (_e, id: number) => showTab(id));
  ipcMain.on('kc:toggle-mute', (_e, id: number) => {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    t.muted = !t.muted;
    t.view.webContents.setAudioMuted(t.muted);
    broadcastState();
  });
  ipcMain.on('kc:open-probe', () => void createTab(probeUrl()));
  ipcMain.on('kc:toggle-popover', () => setPopoverOpen(!popoverOpen));
  ipcMain.on('kc:close-popover', () => setPopoverOpen(false));
  ipcMain.on('kc:open-settings', () => openSettingsWindow());
  ipcMain.on('kc:home', () => goHome());

  // bookmarks
  ipcMain.on('kc:bookmark-toggle', () => toggleBookmark());
  ipcMain.on('kc:bookmark-open', (_e, url: string) => {
    const t = activeTab();
    if (t) t.view.webContents.loadURL(url);
  });
  ipcMain.on('kc:bookmark-remove', (_e, url: string) => {
    removeBookmark(url);
    broadcastState();
  });
  ipcMain.on('kc:toggle-bookmarks-bar', () => {
    setBookmarksBarVisible(!bookmarksBarVisible());
    layoutTabs();
    broadcastState();
  });

  // find in page
  ipcMain.on('kc:find', (_e, text: string, forward = true) => {
    if (text) activeTab()?.view.webContents.findInPage(text, { forward });
  });
  ipcMain.on('kc:find-close', () => {
    activeTab()?.view.webContents.stopFindInPage('clearSelection');
    findBarVisible = false;
    layoutTabs();
  });
  ipcMain.on('kc:find-open', () => openFindBar());

  // zoom
  ipcMain.on('kc:zoom', (_e, dir: 'in' | 'out' | 'reset') => zoom(dir));

  // url-bar suggestions from history (rendered in the topmost suggest view)
  ipcMain.on('kc:suggest-query', (_e, query: string) => {
    if (!query.trim()) {
      hideSuggest();
      return;
    }
    showSuggest(
      searchHistory(query, 6).map((h) => ({ url: h.url, title: h.title })),
    );
  });
  ipcMain.on('kc:suggest-close', () => hideSuggest());
  ipcMain.on('kc:suggest-pick', (_e, url: string) => {
    hideSuggest();
    activeTab()?.view.webContents.loadURL(url);
  });

  // internal pages (kootenay://…) request data + drive navigation
  ipcMain.handle('kc:internal-data', (_e, page: string) => {
    if (page === 'newtab') {
      return {
        bookmarks: bookmarks(),
        topSites: topSites(8).map((h) => ({ url: h.url, title: h.title })),
        recent: recentHistory(12).map((h) => ({ url: h.url, title: h.title })),
      };
    }
    if (page === 'history') {
      return {
        entries: recentHistory(400).map((h) => ({
          url: h.url,
          title: h.title,
          visits: h.visits,
          lastVisit: h.lastVisit,
        })),
      };
    }
    if (page === 'bookmarks') return { bookmarks: bookmarks() };
    if (page === 'downloads') return { downloads };
    return {};
  });
  ipcMain.on('kc:internal-navigate', (_e, url: string) => {
    activeTab()?.view.webContents.loadURL(normalizeInput(url));
  });
  ipcMain.on('kc:internal-clear-history', () => {
    clearHistory();
    broadcastState();
  });
  ipcMain.on('kc:internal-remove-bookmark', (_e, url: string) => {
    removeBookmark(url);
    broadcastState();
  });
  ipcMain.on('kc:internal-reveal-download', (_e, p: string) => {
    if (p) shell.showItemInFolder(p);
  });

  // settings General
  ipcMain.handle('kc:get-general', () => ({
    homePage: homePage(),
    bookmarksBarVisible: bookmarksBarVisible(),
  }));
  ipcMain.on('kc:set-home', (_e, url: string) => {
    setHomePage(url.trim() || 'https://vimeo.com');
    broadcastState();
  });
  ipcMain.handle('kc:clear-data', async (_e, opts: { history: boolean; cookies: boolean; cache: boolean }) => {
    if (opts.history) clearHistory();
    if (opts.cache) await session.defaultSession.clearCache();
    if (opts.cookies) {
      await session.defaultSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'],
      });
    }
    broadcastState();
    return { ok: true };
  });

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
  const saved = windowBounds();
  win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 940,
    x: saved?.x,
    y: saved?.y,
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
  ensureSuggestView();
  activeDisplayId = curDisplay()?.id ?? -1;
  win.on('resize', () => {
    layoutTabs();
    scheduleSessionSave();
  });
  win.on('moved', scheduleSessionSave);
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

interface DownloadRec {
  name: string;
  url: string;
  path: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  received: number;
  total: number;
  startedAt: number;
}
const downloads: DownloadRec[] = [];

function setupSecurity(): void {
  // Electron grants every permission by default. Deny the sensitive ones
  // outright (a review browser never needs them), allow only what playback
  // and normal browsing require.
  const ALLOWED = new Set([
    'fullscreen',
    'pointerLock',
    'clipboard-sanitized-write',
  ]);
  const handler = (
    _wc: unknown,
    permission: string,
    cb: (granted: boolean) => void,
  ) => cb(ALLOWED.has(permission));
  session.defaultSession.setPermissionRequestHandler(handler as never);
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) => ALLOWED.has(permission),
  );
}

function setupDownloads(): void {
  session.defaultSession.on('will-download', (_e, item) => {
    const rec: DownloadRec = {
      name: item.getFilename(),
      url: item.getURL(),
      path: '',
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      startedAt: Date.now(),
    };
    downloads.unshift(rec);
    if (downloads.length > 100) downloads.pop();
    const notifyChrome = () => win?.webContents.send('kc:download', rec);
    notifyChrome();
    item.on('updated', () => {
      rec.received = item.getReceivedBytes();
      rec.path = item.getSavePath();
      notifyChrome();
    });
    item.on('done', (_ev, state) => {
      rec.state = state as DownloadRec['state'];
      rec.path = item.getSavePath();
      notifyChrome();
      if (state === 'completed' && Notification.isSupported()) {
        const n = new Notification({ title: 'Download complete', body: rec.name });
        n.on('click', () => shell.showItemInFolder(rec.path));
        n.show();
      }
    });
  });
}

function installAppMenu(): void {
  installMenu({
    newTab: () => void createTab(NEWTAB_URL),
    closeTab: () => activeTabId !== -1 && closeTab(activeTabId),
    reopenTab: reopenClosedTab,
    reload: () => activeTab()?.view.webContents.reload(),
    hardReload: () => activeTab()?.view.webContents.reloadIgnoringCache(),
    back: () => activeTab()?.view.webContents.navigationHistory.goBack(),
    forward: () => activeTab()?.view.webContents.navigationHistory.goForward(),
    home: goHome,
    focusUrlBar: () => win?.webContents.send('kc:focus-urlbar'),
    find: openFindBar,
    bookmarkToggle: toggleBookmark,
    toggleBookmarksBar: () => {
      setBookmarksBarVisible(!bookmarksBarVisible());
      layoutTabs();
      broadcastState();
    },
    zoomIn: () => zoom('in'),
    zoomOut: () => zoom('out'),
    zoomReset: () => zoom('reset'),
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    selectTab: selectTabByIndex,
    openSettings: openSettingsWindow,
    openProbe: () => void createTab(probeUrl()),
    print: () => activeTab()?.view.webContents.print(),
    clearBrowsingData: () => {
      openSettingsWindow();
      settingsWin?.webContents.once('did-finish-load', () =>
        settingsWin?.webContents.send('kc:scroll-to-data'),
      );
    },
    toggleDevTools: () => activeTab()?.view.webContents.toggleDevTools(),
  });
}

function restoreOrHome(): void {
  const s = lastSession();
  if (s && s.urls.length > 0) {
    s.urls.forEach((u) => createTab(u, {}));
    const target = tabs[s.activeIndex] ?? tabs[0];
    if (target) showTab(target.id);
  } else {
    createTab(homePage());
  }
}

app.whenReady().then(async () => {
  registerInternalProtocol();
  setupSecurity();
  wireIpc();
  setupDownloads();
  installAppMenu();
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
  } else if (process.argv.includes('--wizard-check')) {
    // Drive the settings-window probe wizard end-to-end (sim probe): expand,
    // detect, start, wait for completion, dump the wizard's result text.
    try {
      openSettingsWindow();
      await new Promise<void>((r) =>
        settingsWin!.webContents.once('did-finish-load', () => r()),
      );
      await new Promise((r) => setTimeout(r, 600));
      const clicked = await settingsWin!.webContents.executeJavaScript(
        `(() => {
           const btns = [...document.querySelectorAll('button')];
           const hw = btns.find(b => b.textContent.includes('hardware probe'));
           if (!hw) return 'no-hw-button';
           hw.click();
           return 'opened';
         })()`,
      );
      console.log('KC_WIZ open:', clicked);
      await new Promise((r) => setTimeout(r, 2500)); // detect settles
      const status = await settingsWin!.webContents.executeJavaScript(
        `document.querySelector('.probe-status')?.textContent`,
      );
      console.log('KC_WIZ status:', status);
      await settingsWin!.webContents.executeJavaScript(
        `(() => {
           // sim probe is scripted one-sample-per-patch — set avg to 1
           const avg = document.querySelector('.import.open input[type=number]');
           if (avg) avg.value = '1';
           const s = document.querySelector('button.probe-start');
           s.disabled = false; s.click();
         })()`,
      );
      // sim run: 15 reads at 50ms settle... but wizard uses default settle
      // (1s) — poll for the result text.
      let resultText = '';
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        resultText = await settingsWin!.webContents.executeJavaScript(
          `[...document.querySelectorAll('.result')].map(e => e.textContent).join('\\n')`,
        );
        if (resultText.includes('✓ Saved') || resultText.includes('❌')) break;
      }
      console.log('KC_WIZ result:\n' + resultText);
    } catch (err) {
      console.error('KC_WIZ FAILED', err);
      process.exitCode = 1;
    }
    app.quit();
  } else if (process.argv.includes('--newtab-check')) {
    const report: Record<string, unknown> = {};
    try {
      // seed a little history so the page has content
      recordVisit('https://vimeo.com/', 'Vimeo');
      recordVisit('https://frame.io/', 'Frame.io');
      const t = createTab(NEWTAB_URL, {});
      await new Promise<void>((r) =>
        t.view.webContents.once('did-finish-load', () => r()),
      );
      await new Promise((r) => setTimeout(r, 800));
      report.url = t.view.webContents.getURL();
      report.title = t.view.webContents.getTitle();
      report.dom = await t.view.webContents.executeJavaScript(
        `({ hasSearch: !!document.getElementById('search'),
            tiles: document.querySelectorAll('.tile').length,
            recent: document.querySelectorAll('#recent .li').length,
            kcInternal: typeof kcInternal }) `,
      );
    } catch (err) {
      report.error = String(err);
      process.exitCode = 1;
    }
    console.log('KC_NEWTAB ' + JSON.stringify(report, null, 2));
    app.quit();
  } else if (process.argv.includes('--qol-check')) {
    // Exercise the QoL surface headlessly: bookmark, find, suggestions,
    // session snapshot, home. Dumps a JSON report.
    const report: Record<string, unknown> = {};
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const t = createTab('https://example.com/', {});
      await new Promise<void>((r) =>
        t.view.webContents.once('did-finish-load', () => r()),
      );
      await settle(500);
      // bookmark toggle
      toggleBookmark();
      report.bookmarkedAfterAdd = isBookmarked('https://example.com/');
      report.bookmarksCount = bookmarks().length;
      // history recorded → suggestions
      recordVisit('https://example.com/', 'Example Domain');
      report.suggest = searchHistory('example', 5).map((h) => h.url);
      // find in page
      const found = await new Promise<{ matches: number } | null>((resolve) => {
        t.view.webContents.once('found-in-page', (_e, r) => resolve({ matches: r.matches }));
        t.view.webContents.findInPage('example');
        setTimeout(() => resolve(null), 3000);
      });
      report.findMatches = found?.matches ?? 0;
      t.view.webContents.stopFindInPage('clearSelection');
      // session snapshot
      snapshotSession();
      report.savedSession = lastSession();
      // home + zoom
      report.homePage = homePage();
      zoom('in');
      report.zoomFactor = +t.view.webContents.getZoomFactor().toFixed(2);
      // menu installed?
      report.menuInstalled = Menu.getApplicationMenu() !== null;
    } catch (err) {
      report.error = String(err);
      process.exitCode = 1;
    }
    console.log('KC_QOL ' + JSON.stringify(report, null, 2));
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
            JSON.stringify({ x: b.x, y: b.y + chromeHeight(), w: 640, h: 360 }),
        );
      }, 2500);
    });
  } else {
    restoreOrHome();
  }
});

app.on('activate', () => {
  if (!win) {
    createWindow();
    win!.webContents.once('did-finish-load', restoreOrHome);
  }
});

app.on('before-quit', snapshotSession);
app.on('window-all-closed', () => app.quit());
