// Downloads page (kootenay://downloads).
(() => {
interface DL {
  name: string;
  url: string;
  path: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  received: number;
  total: number;
  startedAt: number;
}
const $ = (id: string) => document.getElementById(id)!;
const list = $('list');

const fmtBytes = (n: number) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

function render(items: DL[]): void {
  list.textContent = '';
  $('empty').style.display = items.length ? 'none' : 'block';
  for (const d of items) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cursor = d.state === 'completed' ? 'pointer' : 'default';

    const meta = document.createElement('div');
    meta.style.flex = '1';
    meta.style.minWidth = '0';
    const name = document.createElement('div');
    name.className = 'dl-name';
    name.textContent = d.name;
    const sub = document.createElement('div');
    sub.className = 'dl-sub';
    const size =
      d.state === 'progressing' && d.total
        ? `${fmtBytes(d.received)} / ${fmtBytes(d.total)}`
        : fmtBytes(d.total || d.received);
    sub.textContent = `${host(d.url)}${size ? ' · ' + size : ''}`;
    meta.append(name, sub);
    if (d.state === 'progressing' && d.total) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.style.width = `${Math.min(100, (d.received / d.total) * 100)}%`;
      bar.append(fill);
      meta.append(bar);
    }

    const state = document.createElement('span');
    state.className = 'dl-state ' + d.state;
    state.textContent = d.state === 'progressing' ? 'downloading' : d.state;

    row.append(meta, state);
    if (d.state === 'completed') {
      row.onclick = () => kcInternal.revealDownload(d.path);
    }
    list.appendChild(row);
  }
}

function load(): void {
  kcInternal.data('downloads').then((d: { downloads: DL[] }) => render(d.downloads));
}
kcInternal.onUpdate(load);
load();
})();
