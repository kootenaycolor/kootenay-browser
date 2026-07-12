// Pipeline popover renderer. Runs in its own WebContentsView above the tab.
// Types shared via kc.d.ts; IIFE-wrapped to avoid clashing with chrome.ts.
(() => {
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const modeSel = $<HTMLSelectElement>('mode');
const gammaSel = $<HTMLSelectElement>('gamma');
const pipeprofile = $('pipeprofile');
const calresult = $('calresult');

let lastGamma = 'gamma24';

function render(state: KcState): void {
  const tab = state.tabs.find((t) => t.id === state.activeId);
  if (gammaSel.options.length === 0) {
    for (const p of state.presets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      gammaSel.appendChild(o);
    }
  }
  if (tab) {
    if (tab.gamma === 'off') {
      modeSel.value = 'off';
      gammaSel.disabled = true;
      gammaSel.value = lastGamma;
    } else {
      modeSel.value = 'custom';
      gammaSel.disabled = false;
      gammaSel.value = tab.gamma;
      lastGamma = tab.gamma;
    }
  }
  pipeprofile.textContent = state.pipeline.label;
}

kc.onState(render);

modeSel.onchange = () => {
  kc.send('kc:set-gamma', modeSel.value === 'off' ? 'off' : lastGamma);
};
gammaSel.onchange = () => {
  lastGamma = gammaSel.value;
  kc.send('kc:set-gamma', gammaSel.value);
};

$('backdrop').onclick = () => kc.send('kc:close-popover');

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
})();
