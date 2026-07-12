// Color Settings window renderer. IIFE-scoped; types from kc.d.ts.
(() => {
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const simpleTargetSel = $<HTMLSelectElement>('simpleTarget');
const displaysEl = $('displays');
let state: KcSettingsState | null = null;

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function render(s: KcSettingsState): void {
  state = s;

  if (simpleTargetSel.options.length === 0) {
    for (const p of s.presets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      simpleTargetSel.appendChild(o);
    }
  }
  simpleTargetSel.value = s.simpleTarget;

  displaysEl.textContent = '';
  for (const d of s.displays) {
    displaysEl.appendChild(renderDisplay(d, s));
  }
}

function renderDisplay(d: KcDisplayState, s: KcSettingsState): HTMLElement {
  const card = el('div', 'card display-card');
  const head = el('div', '', 'display-head');
  head.append(
    text('span', 'name', d.label),
    text('span', 'res', `${d.width}×${d.height}`),
  );
  if (d.current) head.append(text('span', 'badge-current', 'browser is here'));
  card.append(head);

  if (d.profiles.length === 0) {
    card.append(text('div', 'empty', 'No measurements yet.'));
  }
  for (const p of d.profiles) {
    card.append(renderProfile(d, p, s));
  }

  const actions = el('div', '', 'actions');
  if (d.current) {
    const measure = button('Measure with probe', 'primary');
    measure.onclick = () => runMeasure(measure, card);
    const importBtn = button('Import physical measurement');
    const importRow = renderImport(card);
    importBtn.onclick = () => importRow.classList.toggle('open');
    actions.append(measure, importBtn);
    card.append(actions, importRow);
  } else {
    actions.append(
      text('span', 'hint', 'Move the browser window to this display to measure it.'),
    );
    card.append(actions);
  }
  return card;
}

function renderProfile(
  d: KcDisplayState,
  p: KcProfile,
  s: KcSettingsState,
): HTMLElement {
  const row = el('div', '', 'profile');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = `active-${d.id}`;
  radio.checked = isActive(d, p);
  radio.onchange = () => kc.send('kc:set-active-profile', d.id, p.id);

  const meta = el('div', '', 'meta');
  meta.append(text('div', '', p.label));
  const subBits: string[] = [];
  if (p.effectiveGamma) subBits.push(`γ ${p.effectiveGamma}`);
  if (p.measuredAt) subBits.push(fmtDate(p.measuredAt));
  if (subBits.length) meta.append(text('div', 'sub', subBits.join(' · ')));

  const kindtag = text('span', `kindtag ${p.kind}`, p.kind === 'light' ? 'light' : 'probe');
  const del = button('✕', 'del');
  del.classList.add('del');
  del.onclick = () => kc.send('kc:delete-profile', d.id, p.id);

  row.append(radio, meta, kindtag, del);
  return row;
}

function isActive(d: KcDisplayState, p: KcProfile): boolean {
  return d.activeId === p.id;
}

function renderImport(card: HTMLElement): HTMLElement {
  const row = el('div', '', 'import');
  const label = text('span', 'hint', 'Measured effective gamma:');
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.01';
  input.min = '1';
  input.max = '3';
  input.placeholder = '2.35';
  input.style.width = '80px';
  const go = button('Save profile', 'primary');
  const result = el('div', '', 'result');
  go.onclick = async () => {
    const gamma = parseFloat(input.value);
    if (!gamma) {
      result.textContent = 'Enter a gamma value.';
      return;
    }
    result.textContent = 'Saving…';
    const res = (await kc.invoke('kc:import-light', { gamma })) as {
      ok: boolean;
      error?: string;
    };
    result.textContent = res.ok ? 'Saved. Now active for this display.' : `Failed: ${res.error}`;
  };
  row.append(label, input, go, result);
  return row;
}

async function runMeasure(btn: HTMLButtonElement, card: HTMLElement): Promise<void> {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Measuring…';
  const result = el('div', '', 'result');
  card.append(result);
  result.textContent = 'A probe tab opens briefly…';
  try {
    const s = (await kc.invoke('kc:calibrate')) as {
      effectiveInterpGamma: number;
      rmsUncorrected: number;
      rmsCorrected: number;
    };
    result.textContent =
      `Interpretation gamma ${s.effectiveInterpGamma} · ` +
      `RMS ${s.rmsUncorrected} → ${s.rmsCorrected}`;
  } catch (err) {
    result.textContent = 'Measurement failed: ' + String(err);
  }
  btn.disabled = false;
  btn.textContent = prev;
}

// ── tiny DOM helpers ────────────────────────────────────────────────────────
function el(tag: string, className = '', extra = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = [className, extra].filter(Boolean).join(' ');
  return e;
}
function text(tag: string, className: string, content: string): HTMLElement {
  const e = el(tag, className);
  e.textContent = content;
  return e;
}
function button(label: string, className = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  return b;
}

simpleTargetSel.onchange = () =>
  kc.send('kc:set-simple-target', simpleTargetSel.value);

kc.on('kc:settings-state', (s) => render(s as KcSettingsState));
})();
