// Shared ambient types for the renderer scripts. chrome.ts, popover.ts and
// settings.ts load as plain <script>s into separate WebContentsViews/windows
// but share one TS compilation scope, so the `kc` bridge and state shapes
// live here once.

type KcMethod = 'off' | 'simple' | 'measured';

interface KcTabState {
  id: number;
  title: string;
  url: string;
  method: KcMethod;
  source: string;
  canGoBack: boolean;
  canGoForward: boolean;
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
}

interface KcProfile {
  id: string;
  label: string;
  kind: string;
  effectiveGamma?: number;
  measuredAt?: string;
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
