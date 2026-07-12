// Shared ambient types for the renderer scripts. Both chrome.ts and
// popover.ts load as plain <script>s into separate WebContentsViews but
// share one TS compilation scope, so the `kc` bridge and state shapes live
// here once.

interface KcTabState {
  id: number;
  title: string;
  url: string;
  gamma: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface KcState {
  tabs: KcTabState[];
  activeId: number;
  presets: { id: string; label: string }[];
  pipeline: { label: string; measured: boolean };
}

interface KcBridge {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  onState(cb: (state: KcState) => void): void;
}

declare const kc: KcBridge;
