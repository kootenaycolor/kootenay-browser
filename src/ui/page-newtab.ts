// New Tab page renderer (kootenay://newtab). Uses the kcInternal bridge.
(() => {
interface Item {
  url: string;
  title: string;
}
interface NewtabData {
  bookmarks: { url: string; title: string }[];
  topSites: Item[];
  recent: Item[];
}

const $ = (id: string) => document.getElementById(id)!;
const favicon = (url: string): string => {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return '';
  }
};

const search = $('search') as HTMLInputElement;
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && search.value.trim()) kcInternal.navigate(search.value.trim());
});

function tile(it: Item): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tile';
  el.title = it.url;
  const img = document.createElement('img');
  img.src = favicon(it.url);
  img.onerror = () => (img.style.visibility = 'hidden');
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = it.title || new URL(it.url).hostname;
  el.append(img, t);
  el.onclick = () => kcInternal.navigate(it.url);
  return el;
}

function listItem(it: Item): HTMLElement {
  const el = document.createElement('div');
  el.className = 'li';
  el.title = it.url;
  const img = document.createElement('img');
  img.src = favicon(it.url);
  img.onerror = () => (img.style.visibility = 'hidden');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = it.title;
  const u = document.createElement('span');
  u.className = 'u';
  u.textContent = it.url.replace(/^https?:\/\//, '');
  el.append(img, t, u);
  el.onclick = () => kcInternal.navigate(it.url);
  return el;
}

kcInternal.data('newtab').then((d: NewtabData) => {
  if (d.topSites.length) {
    $('topsites-h').style.display = '';
    d.topSites.forEach((s) => $('topsites').appendChild(tile(s)));
  }
  if (d.bookmarks.length) {
    $('bm-h').style.display = '';
    d.bookmarks.slice(0, 12).forEach((b) => $('bookmarks').appendChild(listItem(b)));
  }
  if (d.recent.length) {
    $('recent-h').style.display = '';
    d.recent.forEach((r) => $('recent').appendChild(listItem(r)));
  }
});
})();
