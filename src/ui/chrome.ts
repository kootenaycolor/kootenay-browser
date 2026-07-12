// Chrome renderer. Types shared via kc.d.ts. IIFE-scoped.
(() => {
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const tabsEl = $('tabs');
const urlbar = $<HTMLInputElement>('urlbar');
const backBtn = $<HTMLButtonElement>('back');
const fwdBtn = $<HTMLButtonElement>('forward');
const pipebtn = $('pipebtn');
const pipelabel = $('pipelabel');
const star = $('star');
const bmBar = $('bookmarksbar');
const findbar = $('findbar');
const findInput = $<HTMLInputElement>('findinput');
const findCount = $('findcount');

let state: KcState | null = null;

function activeTabState(): KcTabState | undefined {
  return state?.tabs.find((t) => t.id === state!.activeId);
}

function faviconImg(url?: string): HTMLElement {
  const img = document.createElement('img');
  img.className = 'favicon';
  if (url) img.src = url;
  img.onerror = () => (img.style.visibility = 'hidden');
  return img;
}

function render(): void {
  if (!state) return;

  // tabs
  tabsEl.textContent = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className =
      'tab' +
      (t.id === state.activeId ? ' active' : '') +
      (t.method !== 'off' ? ' managed' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const lead = t.loading
      ? Object.assign(document.createElement('span'), { className: 'spinner' })
      : faviconImg(t.favicon);
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
    el.append(dot, lead, title);
    if (t.audible || t.muted) {
      const audio = document.createElement('button');
      audio.className = 'audio';
      audio.textContent = t.muted ? '🔇' : '🔊';
      audio.title = t.muted ? 'Unmute tab' : 'Mute tab';
      audio.onclick = (e) => {
        e.stopPropagation();
        kc.send('kc:toggle-mute', t.id);
      };
      el.append(audio);
    }
    el.append(close);
    el.onclick = () => kc.send('kc:select-tab', t.id);
    el.onauxclick = (e) => {
      if ((e as MouseEvent).button === 1) kc.send('kc:close-tab', t.id);
    };
    tabsEl.appendChild(el);
  }

  const tab = activeTabState();
  if (tab) {
    if (document.activeElement !== urlbar) {
      urlbar.value =
        tab.url.startsWith('file://') || tab.url.startsWith('kootenay:')
          ? ''
          : tab.url;
    }
    backBtn.disabled = !tab.canGoBack;
    fwdBtn.disabled = !tab.canGoForward;
    const reload = $('reload');
    reload.textContent = tab.loading ? '✕' : '⟳';
    reload.title = tab.loading ? 'Stop' : 'Reload (⌘R)';

    const source = state.presets.find((p) => p.id === tab.source);
    if (tab.method === 'off') {
      pipebtn.classList.remove('on');
      pipelabel.textContent = 'Color: Off';
    } else {
      pipebtn.classList.add('on');
      const dest = tab.method === 'simple' ? state.simpleTarget : 'display';
      const destLabel = state.presets.find((p) => p.id === dest)?.label ?? dest;
      pipelabel.textContent = `${source?.label ?? tab.source} → ${destLabel}`;
    }
  }

  star.textContent = state.currentBookmarked ? '★' : '☆';
  star.classList.toggle('on', state.currentBookmarked);
  $('progress').classList.toggle('on', !!tab?.loading);

  const lock = $('lock');
  const editing = document.activeElement === urlbar;
  if (state.security === 'internal' || !tab || editing) {
    lock.className = 'hidden';
    urlbar.classList.add('nolock');
  } else {
    lock.className = state.security === 'secure' ? '' : 'insecure';
    lock.textContent = state.security === 'secure' ? '🔒' : '⚠';
    lock.title = state.security === 'secure' ? 'Secure (HTTPS)' : 'Not secure (HTTP)';
    urlbar.classList.remove('nolock');
  }

  renderBookmarksBar();
}

function renderBookmarksBar(): void {
  if (!state) return;
  bmBar.classList.toggle('show', state.bookmarksBarVisible);
  bmBar.textContent = '';
  if (state.bookmarks.length === 0) {
    const empty = document.createElement('span');
    empty.id = 'bm-empty';
    empty.textContent = 'Bookmark pages with ⌘D — they show up here';
    bmBar.appendChild(empty);
    return;
  }
  for (const b of state.bookmarks) {
    const el = document.createElement('div');
    el.className = 'bm';
    let host = b.url;
    try {
      host = new URL(b.url).hostname.replace(/^www\./, '');
    } catch {
      /* keep url */
    }
    el.append(
      faviconImg(`https://www.google.com/s2/favicons?domain=${host}&sz=32`),
    );
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = b.title || host;
    el.appendChild(t);
    el.title = b.url;
    el.onclick = () => kc.send('kc:bookmark-open', b.url);
    el.onauxclick = (e) => {
      if ((e as MouseEvent).button === 1) kc.send('kc:bookmark-remove', b.url);
    };
    bmBar.appendChild(el);
  }
}

kc.onState((s) => {
  state = s;
  render();
});

// ── url bar + suggestions ────────────────────────────────────────────────────
let suggestTimer: number | undefined;
urlbar.addEventListener('input', () => {
  window.clearTimeout(suggestTimer);
  const q = urlbar.value;
  suggestTimer = window.setTimeout(() => kc.send('kc:suggest-query', q), 90);
});
urlbar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    kc.send('kc:suggest-close');
    kc.send('kc:navigate', urlbar.value);
    urlbar.blur();
  } else if (e.key === 'Escape') {
    kc.send('kc:suggest-close');
    urlbar.blur();
  }
});
urlbar.addEventListener('focus', () => urlbar.select());
urlbar.addEventListener('blur', () => setTimeout(() => kc.send('kc:suggest-close'), 150));

backBtn.onclick = () => kc.send('kc:back');
fwdBtn.onclick = () => kc.send('kc:forward');
$('reload').onclick = () => kc.send('kc:reload');
$('home').onclick = () => kc.send('kc:home');
$('newtab').onclick = () => kc.send('kc:new-tab');
star.onclick = () => kc.send('kc:bookmark-toggle');
pipebtn.onclick = () => kc.send('kc:toggle-popover');

// ── find bar ─────────────────────────────────────────────────────────────────
function runFind(forward = true): void {
  if (findInput.value) kc.send('kc:find', findInput.value, forward);
  else findCount.textContent = '';
}
findInput.addEventListener('input', () => runFind(true));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runFind(!e.shiftKey);
  else if (e.key === 'Escape') closeFind();
});
$('findnext').onclick = () => runFind(true);
$('findprev').onclick = () => runFind(false);
$('findclose').onclick = closeFind;
function closeFind(): void {
  findbar.classList.remove('show');
  findCount.textContent = '';
  findInput.value = '';
  kc.send('kc:find-close');
}

kc.on('kc:find-focus', () => {
  findbar.classList.add('show');
  findInput.focus();
  findInput.select();
});
kc.on('kc:find-result', (raw) => {
  const r = raw as { matches: number; active: number };
  findCount.textContent = r.matches ? `${r.active} / ${r.matches}` : 'No results';
});
kc.on('kc:focus-urlbar', () => {
  urlbar.focus();
  urlbar.select();
});
})();
