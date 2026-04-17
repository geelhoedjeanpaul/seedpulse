// SeedPulse service worker v4 — stale-while-revalidate + separate API cache
const SHELL_CACHE = 'seedpulse-shell-v4';
const API_CACHE   = 'seedpulse-api-v4';
const SHELL = [
  '/seedpulse/',
  '/seedpulse/index.html',
  '/seedpulse/manifest.json',
  '/seedpulse/icon-192.svg',
  '/seedpulse/icon-512.svg',
  '/seedpulse/icon-maskable.svg'
];

// API cache max age (ms) — reuse cached RSS responses for this long offline
const API_MAX_AGE = 60 * 60 * 1000; // 1 hour

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== API_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // RSS API → stale-while-revalidate with time-bounded reuse
  if (url.hostname === 'api.rss2json.com') {
    e.respondWith(handleApi(e.request));
    return;
  }

  // Same-origin shell → stale-while-revalidate
  if (url.origin === self.location.origin) {
    e.respondWith(handleShell(e.request));
  }
});

async function handleShell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fetchPromise;
}

async function handleApi(req) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(req);
  // Return cached immediately if fresh; revalidate in the background
  if (cached) {
    const dateHeader = cached.headers.get('sw-cached-at');
    const age = dateHeader ? Date.now() - parseInt(dateHeader, 10) : Infinity;
    if (age < API_MAX_AGE) {
      // Refresh in background, return cached now
      fetch(req).then(r => { if (r && r.ok) putWithTimestamp(cache, req, r); }).catch(()=>{});
      return cached;
    }
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) putWithTimestamp(cache, req, res.clone());
    return res;
  } catch (e) {
    // Offline — fall back to any cached copy, stale or not
    return cached || new Response(JSON.stringify({status:'error',items:[]}), {headers:{'content-type':'application/json'}});
  }
}

function putWithTimestamp(cache, req, res) {
  // Wrap the response with a custom header so we can read its age later
  res.clone().blob().then(body => {
    const headers = new Headers(res.headers);
    headers.set('sw-cached-at', String(Date.now()));
    cache.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers }));
  });
}
