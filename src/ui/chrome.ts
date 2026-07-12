// Chrome renderer. Types are shared via kc.d.ts. Wrapped in an IIFE so its
// locals don't collide with popover.ts in the shared compilation scope.
(() => {
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const tabsEl = $('tabs');
const urlbar = $<HTMLInputElement>('urlbar');
const backBtn = $<HTMLButtonElement>('back');
const fwdBtn = $<HTMLButtonElement>('forward');
const pipebtn = $('pipebtn');
const pipelabel = $('pipelabel');

let state: KcState | null = null;

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
      (t.method !== 'off' ? ' managed' : '');
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

    const source = state.presets.find((p) => p.id === tab.source);
    if (tab.method === 'off') {
      pipebtn.classList.remove('on');
      pipelabel.textContent = 'Color: Off';
    } else {
      pipebtn.classList.add('on');
      const dest = tab.method === 'simple' ? state.simpleTarget : 'display';
      const destLabel =
        state.presets.find((p) => p.id === dest)?.label ?? dest;
      pipelabel.textContent = `${source?.label ?? tab.source} → ${destLabel}`;
    }
  }
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

pipebtn.onclick = () => kc.send('kc:toggle-popover');
})();
