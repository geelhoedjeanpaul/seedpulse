/**
 * SeedPulse RSS proxy — Cloudflare Worker
 * ---------------------------------------------------------------
 * Drop-in replacement for rss2json.com/v1/api.json?rss_url= that:
 *  - Has no per-request item cap (rss2json free tier truncates to 10)
 *  - Has no concurrency rate limit (rss2json free tier ~5 req/s)
 *  - Caches at the edge for 15 min (configurable)
 *  - Returns identical JSON shape so the client is drop-in compatible
 *
 * Usage:
 *   GET https://<your-worker>.workers.dev/?url=<rss-feed-url>
 * Response:
 *   { status: "ok", items: [{ title, link, description, pubDate }, ...] }
 *
 * Deploy:
 *   cd cloudflare-worker
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler deploy
 */

const CACHE_TTL_SECONDS = 15 * 60;        // edge cache: 15 min
const MAX_ITEMS_PER_FEED = 100;           // hard cap to keep responses small
const UPSTREAM_TIMEOUT_MS = 8000;         // give up slow origins fast

const ALLOWED_HOSTS = null; // set to ['news.google.com', ...] to restrict; null = open proxy

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const feedUrl = url.searchParams.get('url') || url.searchParams.get('rss_url');
    if (!feedUrl) {
      return json({ status: 'error', message: 'Missing ?url= param' }, 400);
    }

    // Basic host allowlist (opt-in)
    if (ALLOWED_HOSTS) {
      try {
        const host = new URL(feedUrl).hostname;
        if (!ALLOWED_HOSTS.includes(host)) {
          return json({ status: 'error', message: 'Host not allowed' }, 403);
        }
      } catch { return json({ status: 'error', message: 'Invalid URL' }, 400); }
    }

    // Serve from edge cache when possible
    const cache = caches.default;
    const cacheKey = new Request('https://proxy.cache/' + encodeURIComponent(feedUrl));
    const cached = await cache.match(cacheKey);
    if (cached) return addCors(cached);

    // Fetch upstream with timeout
    let upstream;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
      upstream = await fetch(feedUrl, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SeedPulseRSS/1.0)',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5'
        },
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true }
      });
      clearTimeout(timer);
    } catch (e) {
      return json({ status: 'error', message: 'Upstream fetch failed: ' + (e.message || e) }, 502);
    }

    if (!upstream.ok) {
      return json({ status: 'error', message: 'Upstream ' + upstream.status }, upstream.status);
    }

    const xml = await upstream.text();
    const items = parseFeed(xml).slice(0, MAX_ITEMS_PER_FEED);

    const payload = json({ status: 'ok', items }, 200);
    payload.headers.set('Cache-Control', `public, s-maxage=${CACHE_TTL_SECONDS}`);
    // Store in edge cache (clone so we can return original)
    await cache.put(cacheKey, payload.clone());
    return addCors(payload);
  }
};

/* ------------------------------------------------------------------ */
/* Minimal RSS/Atom parser (regex-based; no dependencies).            */
/* Extracts: title, link, description/content, pubDate/published.    */
/* ------------------------------------------------------------------ */
function parseFeed(xml) {
  const items = [];
  // Try RSS <item>, then Atom <entry>
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[0];
    items.push({
      title:       decodeEntities(stripCdata(extractTag(block, 'title') || '')),
      link:        extractLink(block),
      description: decodeEntities(stripCdata(extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content') || '')),
      pubDate:     extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated') || ''
    });
  }
  return items;
}

function extractTag(block, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function extractLink(block) {
  // RSS: <link>https://...</link>
  const rssLink = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rssLink && rssLink[1] && rssLink[1].trim().startsWith('http')) return rssLink[1].trim();
  // Atom: <link href="https://..." />
  const atomLink = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i);
  if (atomLink) return atomLink[1];
  return '';
}

function stripCdata(s) {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/* ------------------------------------------------------------------ */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
  });
}
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
function addCors(res) {
  const headers = new Headers(res.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
