// History page (kootenay://history).
(() => {
interface Entry {
  url: string;
  title: string;
  visits: number;
  lastVisit: number;
}
const $ = (id: string) => document.getElementById(id)!;
const list = $('list');
const search = $('search') as HTMLInputElement;
let entries: Entry[] = [];

const favicon = (url: string) => {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return '';
  }
};
const timeStr = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function render(): void {
  const q = search.value.trim().toLowerCase();
  const shown = q
    ? entries.filter((e) => (e.url + ' ' + e.title).toLowerCase().includes(q))
    : entries;
  list.textContent = '';
  $('empty').style.display = shown.length ? 'none' : 'block';
  for (const e of shown) {
    const row = document.createElement('div');
    row.className = 'row';
    row.title = e.url;
    const img = document.createElement('img');
    img.src = favicon(e.url);
    img.onerror = () => (img.style.visibility = 'hidden');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = e.title;
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = e.url.replace(/^https?:\/\//, '');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = timeStr(e.lastVisit);
    row.append(img, t, u, meta);
    row.onclick = () => kcInternal.navigate(e.url);
    list.appendChild(row);
  }
}

function load(): void {
  kcInternal.data('history').then((d: { entries: Entry[] }) => {
    entries = d.entries;
    render();
  });
}

search.addEventListener('input', render);
$('clear').addEventListener('click', () => {
  if (confirm('Clear all browsing history?')) {
    kcInternal.clearHistory();
    entries = [];
    render();
  }
});
kcInternal.onUpdate(load);
load();
})();
