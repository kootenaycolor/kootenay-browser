// Pipeline popover renderer. Runs in its own WebContentsView above the tab.
// Types shared via kc.d.ts; IIFE-wrapped to avoid clashing with chrome.ts.
(() => {
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const methodSel = $<HTMLSelectElement>('method');
const sourceSel = $<HTMLSelectElement>('source');
const noteLine = $('note-line');

let lastSource = 'gamma24';

function render(state: KcState): void {
  const tab = state.tabs.find((t) => t.id === state.activeId);
  if (sourceSel.options.length === 0) {
    for (const p of state.presets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      sourceSel.appendChild(o);
    }
  }
  if (tab) {
    methodSel.value = tab.method;
    sourceSel.disabled = tab.method === 'off';
    sourceSel.value = tab.source;
    lastSource = tab.source;
  }

  // Contextual note under the controls.
  if (!tab || tab.method === 'off') {
    noteLine.textContent = 'No correction applied.';
  } else if (tab.method === 'simple') {
    noteLine.textContent = `Display-blind. Targeting ${labelFor(
      state,
      state.simpleTarget,
    )}. Close on most displays, exact on none.`;
  } else {
    const d = state.display?.label ?? 'this display';
    if (state.activeProfile && !state.activeProfile.fellBack) {
      noteLine.textContent = `Using measured profile for ${d}: ${state.activeProfile.label}.`;
    } else {
      noteLine.innerHTML = `<span class="warn">No measurement for ${d} — falling back to Simple. Measure it in Color settings.</span>`;
    }
  }
}

function labelFor(state: KcState, id: string): string {
  return state.presets.find((p) => p.id === id)?.label ?? id;
}

kc.onState(render);

methodSel.onchange = () => kc.send('kc:set-method', methodSel.value);
sourceSel.onchange = () => {
  lastSource = sourceSel.value;
  kc.send('kc:set-source', sourceSel.value);
};
$('opensettings').onclick = () => kc.send('kc:open-settings');
$('backdrop').onclick = () => kc.send('kc:close-popover');
})();
