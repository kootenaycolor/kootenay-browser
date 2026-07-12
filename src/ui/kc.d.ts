// Shared ambient types for the renderer scripts. chrome.ts, popover.ts and
// settings.ts load as plain <script>s into separate WebContentsViews/windows
// but share one TS compilation scope, so the `kc` bridge and state shapes
// live here once.

type KcMethod = 'off' | 'simple' | 'measured';

interface KcTabState {
  id: number;
  title: string;
  url: string;
  favicon?: string;
  method: KcMethod;
  source: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface KcBookmark {
  title: string;
  url: string;
  addedAt: string;
}

interface KcActiveProfile {
  label: string;
  kind: string;
  fellBack: boolean;
}

interface KcState {
  tabs: KcTabState[];
  activeId: number;
  presets: { id: string; label: string }[];
  simpleTarget: string;
  display: { id: number; label: string } | null;
  activeProfile: KcActiveProfile | null;
  bookmarks: KcBookmark[];
  bookmarksBarVisible: boolean;
  currentBookmarked: boolean;
}

interface KcProfile {
  id: string;
  label: string;
  kind: string;
  effectiveGamma?: number;
  measuredAt?: string;
  verify?: {
    rmsPctError: number;
    driftPct: number;
    patches: { signalPct: number; pctError: number }[];
  };
}

interface KcProbeStatus {
  state: 'ready' | 'argyll-missing' | 'no-probe';
  device?: string;
  message?: string;
}

interface KcProbeProgress {
  phase: 'measure' | 'drift' | 'verify';
  label: string;
  index: number;
  total: number;
  Y?: number;
  done?: boolean;
}

interface KcProbeResult {
  ok: boolean;
  error?: string;
  fittedGamma?: number;
  driftPct?: number;
  driftValid?: boolean;
  profileLabel?: string;
  verify?: {
    rmsPctError: number;
    patches: { signalPct: number; targetRel: number; achievedRel: number; pctError: number }[];
  };
}

interface KcDisplayState {
  id: number;
  label: string;
  width: number;
  height: number;
  current: boolean;
  profiles: KcProfile[];
  activeId: string | null;
}

interface KcSettingsState {
  presets: { id: string; label: string }[];
  simpleTarget: string;
  displays: KcDisplayState[];
  currentDisplayId: number | null;
}

interface KcBridge {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  onState(cb: (state: KcState) => void): void;
  on(channel: string, cb: (payload: unknown) => void): void;
}

declare const kc: KcBridge;

// Bridge exposed to internal kootenay:// pages (by the inject preload).
interface KcInternalBridge {
  data(page: string): Promise<any>;
  navigate(url: string): void;
  clearHistory(): void;
  removeBookmark(url: string): void;
  revealDownload(path: string): void;
  onUpdate(cb: () => void): void;
}
declare const kcInternal: KcInternalBridge;
