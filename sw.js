const CACHE = 'speak-v1';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.json',
  'js/db.js', 'js/settings.js', 'js/groq.js', 'js/ui.js', 'js/session.js',
  'js/results.js', 'js/words.js', 'js/backup.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
/* network first so updates arrive; cache is the offline fallback. AI calls are never cached. */
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.includes('groq.com')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && (u.origin === location.origin || u.hostname.includes('fonts.g'))) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});