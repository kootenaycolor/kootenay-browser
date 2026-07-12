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

  // Don't rebuild the cards while a wizard/import panel is open — a state
  // broadcast mid-measurement would replace the DOM and wipe live progress.
  if (displaysEl.querySelector('.import.open')) return;

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
    const hw = button('Measure with hardware probe…', 'primary');
    const wizard = renderProbeWizard(card);
    hw.onclick = () => {
      wizard.classList.toggle('open');
      if (wizard.classList.contains('open')) probeDetectInto(wizard);
    };
    const importBtn = button('Import physical measurement');
    const importRow = renderImport(card);
    importBtn.onclick = () => importRow.classList.toggle('open');
    actions.append(hw, importBtn);
    card.append(actions, wizard, importRow);
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
  if (p.verify) subBits.push(`verify RMS ${p.verify.rmsPctError}%`);
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

// ── hardware-probe wizard ────────────────────────────────────────────────────

let probeProgressEl: HTMLElement | null = null;

async function probeDetectInto(wizard: HTMLElement): Promise<void> {
  const statusEl = wizard.querySelector('.probe-status') as HTMLElement;
  statusEl.textContent = 'Detecting probe…';
  const s = (await kc.invoke('kc:probe-detect')) as KcProbeStatus;
  if (s.state === 'ready') {
    statusEl.textContent = `🟢 Probe ready: ${s.device}`;
    (wizard.querySelector('.probe-start') as HTMLButtonElement).disabled = false;
  } else {
    statusEl.textContent = `🔴 ${s.message}`;
    (wizard.querySelector('.probe-start') as HTMLButtonElement).disabled = true;
  }
}

function renderProbeWizard(card: HTMLElement): HTMLElement {
  const wiz = el('div', '', 'import'); // reuse collapsible styling
  wiz.style.flexDirection = 'column';
  wiz.style.alignItems = 'stretch';

  const statusRow = el('div', '', 'row');
  const statusEl = text('span', 'hint probe-status', '');
  const retry = button('Retry');
  retry.onclick = () => probeDetectInto(wiz);
  statusRow.append(statusEl, retry);

  const optsRow = el('div', '', 'row');
  optsRow.style.marginTop = '8px';
  const avgLabel = text('span', 'hint', 'Samples per patch');
  const avgInput = document.createElement('input');
  avgInput.type = 'number';
  avgInput.min = '1';
  avgInput.max = '9';
  avgInput.value = '3';
  avgInput.style.width = '52px';
  optsRow.append(avgLabel, avgInput);

  const corrRow = el('div', '', 'row');
  corrRow.style.marginTop = '8px';
  const corrLabel = text('span', 'hint', 'Probe correction: none');
  let correctionPath: string | null = null;
  const corrBtn = button('Choose…');
  corrBtn.onclick = async () => {
    const p = (await kc.invoke('kc:probe-pick-correction')) as string | null;
    if (p) {
      correctionPath = p;
      corrLabel.textContent = 'Probe correction: ' + p.split('/').pop();
    }
  };
  corrRow.append(corrLabel, corrBtn);

  const startRow = el('div', '', 'row');
  startRow.style.marginTop = '10px';
  const start = button('Start measurement', 'primary probe-start');
  start.classList.add('probe-start');
  start.disabled = true;
  const cancel = button('Cancel');
  cancel.onclick = () => kc.send('kc:probe-cancel');
  startRow.append(start, cancel);

  const hint = text(
    'div',
    'hint',
    'A fullscreen patch window opens on this display. Place the probe on the center patch, then keep still — white ref, 100→0%, drift check, then a verify pass (~2 min).',
  );
  hint.style.marginTop = '8px';

  const progress = el('div', '', 'result');
  const result = el('div', '', 'result');

  start.onclick = async () => {
    start.disabled = true;
    progress.textContent = '';
    result.textContent = '';
    probeProgressEl = progress;
    const res = (await kc.invoke('kc:probe-run', {
      samples: parseInt(avgInput.value, 10) || 3,
      correctionPath,
    })) as KcProbeResult;
    probeProgressEl = null;
    start.disabled = false;
    if (!res.ok) {
      result.textContent = '❌ ' + (res.error ?? 'failed');
      return;
    }
    const v = res.verify!;
    const lines = [
      `✓ Saved: ${res.profileLabel}`,
      `Fitted gamma ${res.fittedGamma} · drift ${res.driftPct}%` +
        (res.driftValid ? '' : '  ⚠ exceeds 2% — consider re-measuring'),
      `Verify (light domain): RMS ${v.rmsPctError}% — ` +
        v.patches.map((p) => `${p.signalPct}%: ${p.pctError > 0 ? '+' : ''}${p.pctError}%`).join('  '),
    ];
    result.textContent = lines.join('\n');
  };

  wiz.append(statusRow, optsRow, corrRow, hint, startRow, progress, result);
  return wiz;
}

kc.on('kc:probe-progress', (raw) => {
  const p = raw as KcProbeProgress;
  if (!probeProgressEl) return;
  const line = p.done
    ? `✓ ${p.label}${p.Y !== undefined ? ` — ${p.Y.toFixed(2)} cd/m²` : ''}`
    : `… ${p.label}`;
  const prev = probeProgressEl.textContent?.split('\n').filter(Boolean) ?? [];
  if (p.done && prev.length && prev[prev.length - 1].startsWith('…')) prev.pop();
  prev.push(line);
  probeProgressEl.textContent = prev.slice(-14).join('\n');
});

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

// ── General section ──────────────────────────────────────────────────────────
const homeInput = $<HTMLInputElement>('homePage');
kc.invoke('kc:get-general').then((g) => {
  const gen = g as { homePage: string };
  homeInput.value = gen.homePage;
});
homeInput.onchange = () => kc.send('kc:set-home', homeInput.value);

$('clearBtn').onclick = async () => {
  const res = $('clr-result');
  res.textContent = 'Clearing…';
  const out = (await kc.invoke('kc:clear-data', {
    history: ($<HTMLInputElement>('clr-history')).checked,
    cookies: ($<HTMLInputElement>('clr-cookies')).checked,
    cache: ($<HTMLInputElement>('clr-cache')).checked,
  })) as { ok: boolean };
  res.textContent = out.ok ? '✓ Cleared.' : 'Failed.';
};

kc.on('kc:scroll-to-data', () => {
  document.querySelector('#clearBtn')?.scrollIntoView({ behavior: 'smooth' });
});

kc.on('kc:settings-state', (s) => render(s as KcSettingsState));
})();
