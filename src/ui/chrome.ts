// Chrome renderer. No imports/exports — compiled as a plain script.

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

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const tabsEl = $('tabs');
const urlbar = $<HTMLInputElement>('urlbar');
const backBtn = $<HTMLButtonElement>('back');
const fwdBtn = $<HTMLButtonElement>('forward');
const pipebtn = $('pipebtn');
const pipelabel = $('pipelabel');
const popover = $('popover');
const modeSel = $<HTMLSelectElement>('mode');
const gammaSel = $<HTMLSelectElement>('gamma');
const pipeprofile = $('pipeprofile');
const calresult = $('calresult');

let state: KcState | null = null;
let lastGamma = 'gamma24'; // remembered so Mode: Custom restores the pick

function activeTabState(): KcTabState | undefined {
  return state?.tabs.find((t) => t.id === state!.activeId);
}

function render(): void {
  if (!state) return;
  tabsEl.textContent = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className =
      'tab' +
      (t.id === state.activeId ? ' active' : '') +
      (t.gamma !== 'off' ? ' managed' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.onclick = (e) => {
      e.stopPropagation();
      kc.send('kc:close-tab', t.id);
    };
    el.append(dot, title, close);
    el.onclick = () => kc.send('kc:select-tab', t.id);
    tabsEl.appendChild(el);
  }

  const tab = activeTabState();
  if (tab) {
    if (document.activeElement !== urlbar) {
      urlbar.value = tab.url.startsWith('file://') ? 'probe' : tab.url;
    }
    backBtn.disabled = !tab.canGoBack;
    fwdBtn.disabled = !tab.canGoForward;

    const preset = state.presets.find((p) => p.id === tab.gamma);
    if (tab.gamma === 'off') {
      pipebtn.classList.remove('on');
      pipelabel.textContent = 'Color: Off';
      modeSel.value = 'off';
    } else {
      pipebtn.classList.add('on');
      pipelabel.textContent = (preset?.label ?? tab.gamma) + ' → display';
      modeSel.value = 'custom';
      lastGamma = tab.gamma;
    }
    gammaSel.disabled = tab.gamma === 'off';
    if (gammaSel.options.length === 0) {
      for (const p of state.presets) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label;
        gammaSel.appendChild(o);
      }
    }
    gammaSel.value = tab.gamma === 'off' ? lastGamma : tab.gamma;
  }
  pipeprofile.textContent = state.pipeline.label;
}

kc.onState((s) => {
  state = s;
  render();
});

urlbar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    kc.send('kc:navigate', urlbar.value);
    urlbar.blur();
  }
});
backBtn.onclick = () => kc.send('kc:back');
fwdBtn.onclick = () => kc.send('kc:forward');
$('reload').onclick = () => kc.send('kc:reload');
$('newtab').onclick = () => kc.send('kc:new-tab');

pipebtn.onclick = () => popover.classList.toggle('open');
document.addEventListener('click', (e) => {
  if (
    popover.classList.contains('open') &&
    !popover.contains(e.target as Node) &&
    !pipebtn.contains(e.target as Node)
  ) {
    popover.classList.remove('open');
  }
});

modeSel.onchange = () => {
  kc.send('kc:set-gamma', modeSel.value === 'off' ? 'off' : lastGamma);
};
gammaSel.onchange = () => {
  lastGamma = gammaSel.value;
  kc.send('kc:set-gamma', gammaSel.value);
};

$('calibrate').onclick = async () => {
  calresult.textContent = 'Measuring… (a probe tab will open briefly)';
  try {
    const summary = (await kc.invoke('kc:calibrate')) as {
      rmsUncorrected: number;
      rmsCorrected: number;
      effectiveInterpGamma: number;
    };
    calresult.textContent =
      `Interpretation gamma: ${summary.effectiveInterpGamma}\n` +
      `RMS uncorrected: ${summary.rmsUncorrected}\n` +
      `RMS corrected:  ${summary.rmsCorrected}`;
  } catch (err) {
    calresult.textContent = 'Calibration failed: ' + String(err);
  }
};
