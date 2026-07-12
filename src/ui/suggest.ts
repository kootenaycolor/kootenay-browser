// URL-suggestion overlay renderer. IIFE-scoped; types from kc.d.ts.
(() => {
const list = document.getElementById('list')!;

kc.on('kc:suggest-rows', (raw) => {
  const rows = raw as { url: string; title: string }[];
  list.textContent = '';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'row';
    let host = r.url;
    try {
      host = new URL(r.url).hostname.replace(/^www\./, '');
    } catch {
      /* keep */
    }
    const ico = document.createElement('img');
    ico.className = 'ico';
    ico.src = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
    ico.onerror = () => (ico.style.visibility = 'hidden');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = r.title;
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = r.url.replace(/^https?:\/\//, '');
    el.append(ico, t, u);
    // mousedown (not click): fires before the urlbar blur that would close us.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      kc.send('kc:suggest-pick', r.url);
    });
    list.appendChild(el);
  }
});
})();
