/**
 * SeedPulse Push Worker — server-initiated Web Push for Germains-priority articles
 * -------------------------------------------------------------------------------
 *
 * Architecture (ping-push pattern):
 *   1. A cron trigger (every 30 min) fetches the same RSS feeds as the app,
 *      scores each article for Germains relevance, and detects new items
 *      with score >= NOTIFY_MIN that haven't been pushed before.
 *   2. Those items are stored in KV under the key "latest".
 *   3. A body-less Web Push is sent to every registered subscription.
 *   4. The app's service worker receives the push, GETs /latest from this
 *      Worker, and shows a native notification for each new article.
 *
 * Why "body-less"?  Sending an encrypted payload requires the full RFC 8291
 * pipeline (ECDH + HKDF + AES-128-GCM). Using a ping push instead lets us
 * get away with only VAPID JWT signing (~50 lines of ECDSA-P256), which is
 * all the Web Crypto API gives us in Workers.
 *
 * Endpoints:
 *   GET  /vapid-key    → { publicKey }             (browser needs this to subscribe)
 *   POST /subscribe    { subscription }            → stores it in KV
 *   POST /unsubscribe  { endpoint }                → removes it
 *   GET  /latest       → { items: [...] }          (SW fetches this on push)
 *   GET  /trigger-test → fires a manual push       (dev helper — remove in prod)
 *
 * Scheduled:
 *   Every 30 min — feed check + fan-out push
 *
 * Bindings required (wrangler.toml):
 *   - KV namespace "SUBS" — stores subscriptions, seen IDs, latest items
 *   - secret VAPID_PRIVATE_JWK — JSON string of the ECDSA P-256 private JWK
 *   - var VAPID_PUBLIC_KEY   — 65-byte raw uncompressed P-256 point, base64url
 *   - var VAPID_SUBJECT      — mailto: contact (required by push services)
 */

/* ═══════════════════════ Config ═══════════════════════ */
const NOTIFY_MIN = 3;          // minimum Germains score to fire a push
const MAX_PER_RUN = 3;         // never push more than N items per cron tick
const MAX_SEEN = 2000;         // cap seen-ids in KV
const FEED_TIMEOUT_MS = 8000;

// Same feed list as the app (subset — we only need discovery, not completeness here)
const GN = 'https://news.google.com/rss/search?hl=en&gl=US&ceid=US:en&num=100&q=';
const FEEDS = [
  'https://www.european-seed.com/feed/',
  'https://worldseed.org/feed/',
  'https://agfundernews.com/feed',
  'https://www.sciencedaily.com/rss/plants_animals/seeds.xml',
  'https://phys.org/rss-feed/biology-news/plants/',
  GN + 'site:hortidaily.com',
  GN + 'site:freshplaza.com',
  GN + 'site:seedworld.com',
  GN + 'site:igrownews.com',
  GN + '%22seed+treatment%22+OR+%22seed+coating%22+when:30d',
  GN + '%22seed+priming%22+OR+%22seed+pelleting%22+OR+%22film+coating%22+when:30d',
  GN + '%22seed+enhancement%22+OR+%22seed+vigour%22+when:30d',
  GN + 'microplastic+seed+coating+OR+%22seed+treatment%22+when:30d',
  GN + 'biologicals+biocontrol+seed+biostimulant+when:30d',
  GN + 'Syngenta+OR+%22Rijk+Zwaan%22+OR+%22Enza+Zaden%22+seed+news+when:30d',
  GN + 'germains+seed+technology+when:30d'
];

const CAT_KW_GERMAINS = ['priming','pelleting','film coat','filmcoat','film-coat','seed hygiene','seed sanitation','hydro priming','osmo priming','drum priming','solid matrix priming','biopriming','matrix priming','abiotic stress','biotic stress','stress tolerance','stress resistance','germination uniformity','stand establishment','seedling vigour','emergence rate','seed vigour','seed performance','sugar beet','sugarbeet','beet seed','fodder beet','wheat seed','winter wheat','spring wheat','barley seed','winter barley','spring barley','oilseed rape','osr','canola seed','sorghum seed','sunflower seed','maize seed','corn seed','carrot seed','onion seed','leek seed','spinach seed','lettuce seed','celery seed','fennel seed','parsnip seed','parsley seed','beetroot seed','swiss chard','beet seedling','germains'];
const GERMAINS_CORE = ['priming','pelleting','film coat','filmcoat','film-coat','germains','seed hygiene','seed sanitation','abiotic stress','biotic stress','stress tolerance','stress resistance','germination uniformity','seedling vigour','seed vigour','seed performance','stand establishment','emergence rate','encrust','biopriming','matrix priming','osmopriming','hydropriming','hydro priming','osmo priming','drum priming','solid matrix priming'];

/* ═══════════════════════ HTTP routes ═══════════════════════ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    try {
      if (url.pathname === '/vapid-key' && request.method === 'GET') {
        return cors(json({ publicKey: env.VAPID_PUBLIC_KEY }));
      }

      if (url.pathname === '/subscribe' && request.method === 'POST') {
        const body = await request.json();
        if (!body?.subscription?.endpoint) return cors(json({ error: 'Missing subscription' }, 400));
        const key = 'sub:' + await hashStr(body.subscription.endpoint);
        await env.SUBS.put(key, JSON.stringify({
          sub: body.subscription,
          addedAt: Date.now(),
          ua: request.headers.get('user-agent') || ''
        }));
        return cors(json({ ok: true, key }));
      }

      if (url.pathname === '/unsubscribe' && request.method === 'POST') {
        const body = await request.json();
        if (!body?.endpoint) return cors(json({ error: 'Missing endpoint' }, 400));
        const key = 'sub:' + await hashStr(body.endpoint);
        await env.SUBS.delete(key);
        return cors(json({ ok: true }));
      }

      if (url.pathname === '/latest' && request.method === 'GET') {
        const raw = await env.SUBS.get('latest');
        return cors(json(raw ? JSON.parse(raw) : { items: [] }));
      }

      // Dev helper: triggers a check immediately. Protect or remove in prod.
      if (url.pathname === '/trigger-test' && request.method === 'GET') {
        if (url.searchParams.get('key') !== env.TRIGGER_KEY) return cors(json({ error: 'forbidden' }, 403));
        ctx.waitUntil(runCheck(env));
        return cors(json({ ok: true, msg: 'Check queued' }));
      }

      if (url.pathname === '/stats' && request.method === 'GET') {
        // Anonymous counts — no sub data
        const list = await env.SUBS.list({ prefix: 'sub:', limit: 1000 });
        return cors(json({ subscribers: list.keys.length }));
      }

      return cors(new Response('SeedPulse Push Worker — see /vapid-key, /subscribe, /unsubscribe, /latest', { status: 200 }));
    } catch (e) {
      return cors(json({ error: String(e?.message || e) }, 500));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  }
};

/* ═══════════════════════ Cron: feed check + fan-out ═══════════════════════ */
async function runCheck(env) {
  // 1. Fetch all feeds in parallel with per-feed timeout
  const results = await Promise.all(FEEDS.map(fetchFeedSafe));
  const articles = results.flat();

  // 2. Dedupe, score, filter to high-priority
  const byId = new Map();
  for (const a of articles) if (!byId.has(a.id)) byId.set(a.id, a);
  const scored = [...byId.values()]
    .map(a => ({ ...a, gs: germainsScore(a.t, a.s) }))
    .filter(a => a.gs >= NOTIFY_MIN);

  // 3. Load seen set, determine what's new
  const seenRaw = await env.SUBS.get('__seen');
  const seen = seenRaw ? JSON.parse(seenRaw) : {};
  const now = Date.now();

  const newItems = scored
    .filter(a => !seen[a.id])
    .sort((a, b) => b.gs - a.gs)
    .slice(0, MAX_PER_RUN);

  if (newItems.length === 0) {
    // Nothing new — still update 'latest' so /latest is never stale when SW checks
    await env.SUBS.put('latest', JSON.stringify({
      items: scored.sort((a, b) => (b.iso || '').localeCompare(a.iso || '')).slice(0, 10),
      updated: now
    }));
    return;
  }

  // 4. Publish what the service worker will show
  await env.SUBS.put('latest', JSON.stringify({
    items: newItems,
    updated: now
  }));

  // 5. Fan-out push to every subscriber
  const subKeys = await env.SUBS.list({ prefix: 'sub:', limit: 1000 });
  const keys = await loadVapidKeys(env);
  let delivered = 0, gone = 0;
  for (const k of subKeys.keys) {
    const raw = await env.SUBS.get(k.name);
    if (!raw) continue;
    const { sub } = JSON.parse(raw);
    try {
      const res = await sendPush(sub, keys, env.VAPID_SUBJECT);
      if (res.status === 404 || res.status === 410) { await env.SUBS.delete(k.name); gone++; }
      else if (res.ok) { delivered++; }
    } catch (e) {
      // network or crypto error — leave sub in place, try again next cron
    }
  }

  // 6. Mark these items as seen, cap list
  for (const a of newItems) seen[a.id] = now;
  const seenKeys = Object.keys(seen);
  if (seenKeys.length > MAX_SEEN) {
    seenKeys.sort((a, b) => seen[a] - seen[b])
      .slice(0, seenKeys.length - MAX_SEEN)
      .forEach(k => delete seen[k]);
  }
  await env.SUBS.put('__seen', JSON.stringify(seen));

  console.log(`SeedPulse push: ${newItems.length} items → ${delivered} delivered, ${gone} cleaned`);
}

/* ═══════════════════════ VAPID / Web Push ═══════════════════════ */
async function loadVapidKeys(env) {
  const jwkJson = env.VAPID_PRIVATE_JWK;
  if (!jwkJson) throw new Error('VAPID_PRIVATE_JWK secret not set — run `wrangler secret put VAPID_PRIVATE_JWK`');
  const jwk = JSON.parse(jwkJson);
  const privateKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  return { privateKey, publicKey: env.VAPID_PUBLIC_KEY };
}

async function sendPush(subscription, keys, subject) {
  const endpoint = subscription.endpoint;
  const audience = new URL(endpoint).origin;
  const jwt = await signVapidJwt(audience, subject, keys);
  // Body-less ping push — SW will fetch /latest on its own.
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'TTL': '86400',
      'Urgency': 'normal',
      'Authorization': `vapid t=${jwt}, k=${keys.publicKey}`,
      'Content-Length': '0'
    }
  });
}

async function signVapidJwt(audience, subject, keys) {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // 12 h — within VAPID spec cap of 24 h
    sub: subject || 'mailto:admin@example.com'
  })));
  const toSign = enc.encode(header + '.' + payload);
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    toSign
  );
  // Web Crypto returns raw r||s (64 bytes) — exactly what JWS ES256 wants (unlike DER).
  return header + '.' + payload + '.' + b64url(new Uint8Array(sigBuf));
}

/* ═══════════════════════ RSS fetching + parsing ═══════════════════════ */
async function fetchFeedSafe(feedUrl) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
    const res = await fetch(feedUrl, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SeedPulsePush/1.0)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5'
      },
      cf: { cacheTtl: 900, cacheEverything: true }
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const xml = await res.text();
    return parseFeed(xml, feedUrl);
  } catch {
    return [];
  }
}

function parseFeed(xml, srcUrl) {
  const items = [];
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[0];
    const title = decodeEntities(stripCdata(extractTag(block, 'title') || ''));
    const desc = decodeEntities(stripCdata(
      extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content') || ''
    )).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 280);
    const link = extractLink(block);
    const pub = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated') || '';
    const iso = (new Date(pub || Date.now())).toISOString().split('T')[0];
    items.push({ id: articleId(title, link), t: title, s: desc, u: link, iso, src: hostname(srcUrl) });
  }
  return items;
}

function extractTag(block, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}
function extractLink(block) {
  const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rss && rss[1] && rss[1].trim().startsWith('http')) return rss[1].trim();
  const atom = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i);
  return atom ? atom[1] : '';
}
function stripCdata(s) { return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim(); }
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function hostname(u) { try { return new URL(u).hostname; } catch { return ''; } }

/* ═══════════════════════ Helpers ═══════════════════════ */
const enc = new TextEncoder();

function germainsScore(title, desc) {
  const txt = (title + ' ' + desc).toLowerCase();
  let score = 0;
  for (const k of CAT_KW_GERMAINS) {
    if (txt.indexOf(k) >= 0) score += GERMAINS_CORE.indexOf(k) >= 0 ? 3 : 1;
  }
  return score;
}

function articleId(title, link) {
  const base = (link || title || '').toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 64);
  return base || String(Date.now());
}

async function hashStr(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
