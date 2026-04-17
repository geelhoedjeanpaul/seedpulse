// SeedPulse service worker v6 — SWR caches + notifications + Web Push
const SHELL_CACHE = 'seedpulse-shell-v6';
const API_CACHE   = 'seedpulse-api-v6';

// Push Worker URL — set at build/deploy time; empty means push disabled.
// The index.html writes this into a property on the SW registration after
// registration so we don't have to hardcode it here. Fallback: read from
// a /seedpulse/push-config.json if present.
let PUSH_WORKER_URL = '';

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SET_PUSH_URL') {
    PUSH_WORKER_URL = event.data.url || '';
  }
});
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

// ═══════════ Web Push: body-less ping → fetch /latest → show notifications ═══════════
// The push worker sends an empty push. We fetch the actual items from its
// /latest endpoint and show one native notification per new article.
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    try {
      // Fall back to reading push URL from a config file if the page hasn't
      // postMessage'd it yet (e.g. push arrived before any page is open).
      if (!PUSH_WORKER_URL) {
        try {
          const cfg = await fetch('/seedpulse/push-config.json', { cache: 'no-store' });
          if (cfg.ok) PUSH_WORKER_URL = (await cfg.json()).pushWorkerUrl || '';
        } catch {}
      }
      if (!PUSH_WORKER_URL) {
        // No URL configured — show a generic notification so the user isn't left guessing
        await self.registration.showNotification('SeedPulse', {
          body: 'New Germains-priority article. Open the app to see it.',
          icon: '/seedpulse/icon-192.svg',
          badge: '/seedpulse/icon-192.svg',
          tag: 'seedpulse-generic'
        });
        return;
      }

      const res = await fetch(PUSH_WORKER_URL.replace(/\/$/, '') + '/latest', { cache: 'no-store' });
      if (!res.ok) throw new Error('latest fetch failed');
      const { items = [] } = await res.json();
      if (!items.length) return;

      // Show up to 3 — avoid spamming the user's notification shade
      const shown = await self.registration.getNotifications();
      const shownTags = new Set(shown.map(n => n.tag));
      let count = 0;
      for (const a of items.slice(0, 3)) {
        const tag = 'seedpulse-' + a.id;
        if (shownTags.has(tag)) continue;
        await self.registration.showNotification('SeedPulse: ' + a.t, {
          body: (a.s || '').substring(0, 140),
          icon: '/seedpulse/icon-192.svg',
          badge: '/seedpulse/icon-192.svg',
          tag,
          data: { url: a.u || '/seedpulse/' },
          renotify: false
        });
        count++;
      }
      if (count === 0) {
        // All already in the shade — skip, don't spam
      }
    } catch (e) {
      // Last-resort generic notification so the push isn't silently dropped
      await self.registration.showNotification('SeedPulse', {
        body: 'New Germains-priority article detected.',
        icon: '/seedpulse/icon-192.svg',
        badge: '/seedpulse/icon-192.svg',
        tag: 'seedpulse-fallback'
      });
    }
  })());
});

// Notification click → open the article URL (or focus an existing tab)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/seedpulse/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an existing SeedPulse tab if open, then navigate it
    for (const c of allClients) {
      if (c.url.includes('/seedpulse/')) {
        await c.focus();
        if ('navigate' in c && url && !c.url.includes(url)) {
          try { await c.navigate(url); } catch {}
        }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

function putWithTimestamp(cache, req, res) {
  // Wrap the response with a custom header so we can read its age later
  res.clone().blob().then(body => {
    const headers = new Headers(res.headers);
    headers.set('sw-cached-at', String(Date.now()));
    cache.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers }));
  });
}
