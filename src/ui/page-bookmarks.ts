// Bookmarks manager page (kootenay://bookmarks).
(() => {
interface BM {
  url: string;
  title: string;
  addedAt: string;
}
const $ = (id: string) => document.getElementById(id)!;
const list = $('list');
const search = $('search') as HTMLInputElement;
let items: BM[] = [];

const favicon = (url: string) => {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return '';
  }
};

function render(): void {
  const q = search.value.trim().toLowerCase();
  const shown = q
    ? items.filter((b) => (b.url + ' ' + b.title).toLowerCase().includes(q))
    : items;
  list.textContent = '';
  $('empty').style.display = shown.length ? 'none' : 'block';
  for (const b of shown) {
    const row = document.createElement('div');
    row.className = 'row';
    row.title = b.url;
    const img = document.createElement('img');
    img.src = favicon(b.url);
    img.onerror = () => (img.style.visibility = 'hidden');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = b.title;
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = b.url.replace(/^https?:\/\//, '');
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Remove';
    x.onclick = (e) => {
      e.stopPropagation();
      kcInternal.removeBookmark(b.url);
      items = items.filter((i) => i.url !== b.url);
      render();
    };
    row.append(img, t, u, x);
    row.onclick = () => kcInternal.navigate(b.url);
    list.appendChild(row);
  }
}

function load(): void {
  kcInternal.data('bookmarks').then((d: { bookmarks: BM[] }) => {
    items = d.bookmarks;
    render();
  });
}

search.addEventListener('input', render);
kcInternal.onUpdate(load);
load();
})();
