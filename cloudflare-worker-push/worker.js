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

      // AI-powered executive summary (feature #10)
      // Body: { context?: string, items: [{t, s, u, src, cat}] }
      // Uses Cloudflare Workers AI (Llama 3.1 8B). Requires [ai] binding.
      if (url.pathname === '/ai-summary' && request.method === 'POST') {
        if (!env.AI) return cors(json({ error: 'AI binding not configured' }, 503));
        const body = await request.json().catch(() => ({}));
        const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
        if (items.length === 0) return cors(json({ error: 'No items provided' }, 400));
        const context = (body.context || '').toString().slice(0, 500);
        const bulletList = items.map((a, i) =>
          `${i + 1}. [${a.cat || '?'}] ${String(a.t || '').slice(0, 200)}` +
          (a.s ? ` — ${String(a.s).slice(0, 200)}` : '') +
          (a.src ? ` (${a.src})` : '')
        ).join('\n');
        const sys = 'You are a senior industry analyst at Germains Seed Technology, a global leader in seed priming, pelleting, film coating, and seed hygiene. You write crisp, executive-level briefings for the Germains leadership team. Focus on what matters commercially: competitive moves, new treatment/coating technology, regulatory shifts, market demand signals, M&A, and scientific advances in priming/coating/biologicals. Be specific; name companies and technologies. Never invent facts.';
        const user = `Summarise the following ${items.length} articles into a 4-6 sentence executive briefing for Germains. Highlight (a) the single most important item for Germains' business, (b) any competitive threat or opportunity, and (c) one recommended action. Plain prose, no bullet points, no headings.${context ? `\n\nExtra context: ${context}` : ''}\n\nArticles:\n${bulletList}`;
        try {
          const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: user }
            ],
            max_tokens: 400
          });
          const summary = (out?.response || out?.result?.response || '').trim();
          if (!summary) return cors(json({ error: 'Empty AI response' }, 502));
          return cors(json({ summary, model: '@cf/meta/llama-3.1-8b-instruct', count: items.length }));
        } catch (e) {
          return cors(json({ error: 'AI error: ' + String(e?.message || e) }, 502));
        }
      }

      // Per-article annotation (feature #1): returns {impact, soWhat} for each id.
      // Body: { items: [{id,t,s,src,cat,comp,ang,gs}] }
      // Response: { annotations: { [id]: {impact, soWhat} } }
      // Uses KV as a 30-day cache so repeat calls are near-free.
      if (url.pathname === '/annotate' && request.method === 'POST') {
        if (!env.AI) return cors(json({ error: 'AI binding not configured' }, 503));
        const body = await request.json().catch(() => ({}));
        const items = Array.isArray(body?.items) ? body.items.slice(0, 30) : [];
        if (items.length === 0) return cors(json({ annotations: {} }));

        const out = {};
        const toAnnotate = [];

        // 1. Check KV cache first
        for (const it of items) {
          if (!it?.id) continue;
          const cached = await env.SUBS.get('ann:' + it.id);
          if (cached) { try { out[it.id] = JSON.parse(cached); } catch {} }
          else toAnnotate.push(it);
        }

        // 2. Batch uncached items in groups of 5 to keep token counts small
        const BATCH = 5;
        for (let i = 0; i < toAnnotate.length; i += BATCH) {
          const batch = toAnnotate.slice(i, i + BATCH);
          const list = batch.map((a, idx) =>
            `ARTICLE_${idx + 1}_ID: ${a.id}\nTITLE: ${String(a.t || '').slice(0, 200)}\nSUMMARY: ${String(a.s || '').slice(0, 220)}\nCOMPETITORS: ${(a.comp || []).join(', ') || 'none'}\nANGLES: ${(a.ang || []).join(', ') || 'none'}\nGERMAINS_SCORE: ${a.gs || 0}`
          ).join('\n---\n');

          const sys = 'You are a commercial analyst at Germains Seed Technology. For each article, classify commercial impact and write ONE sharp sentence on what it means for Germains. Germains sells seed priming, film coating, pelleting, seed hygiene and seed analytics. Be decisive and specific.';
          const user = `For each of the ${batch.length} articles below, respond with a JSON array: [{"id":"...","impact":"opportunity|threat|watch|info","soWhat":"one sentence, max 25 words, no hedging"}]. Classify:\n- "opportunity": directly creates a sales/partnership angle for Germains\n- "threat": competitor move, regulation, or market shift that hurts us\n- "watch": relevant but developing, monitor it\n- "info": interesting context, low action value\n\nReturn ONLY the JSON array, no prose, no markdown fences.\n\n${list}`;

          try {
            const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: user }
              ],
              max_tokens: 600
            });
            const txt = (r?.response || r?.result?.response || '').trim();
            // Extract JSON array from possibly messy output
            const m = txt.match(/\[[\s\S]*\]/);
            if (!m) continue;
            let arr;
            try { arr = JSON.parse(m[0]); } catch { continue; }
            if (!Array.isArray(arr)) continue;

            for (const rec of arr) {
              if (!rec?.id) continue;
              const match = batch.find(b => String(b.id) === String(rec.id));
              if (!match) continue;
              const impact = ['opportunity', 'threat', 'watch', 'info'].includes(rec.impact) ? rec.impact : 'info';
              const soWhat = String(rec.soWhat || '').slice(0, 300);
              if (!soWhat) continue;
              const ann = { impact, soWhat };
              out[match.id] = ann;
              // Cache for 30 days
              await env.SUBS.put('ann:' + match.id, JSON.stringify(ann), { expirationTtl: 60 * 60 * 24 * 30 });
            }
          } catch (e) {
            // skip batch on error, client will retry next load
          }
        }

        return cors(json({ annotations: out, cached: items.length - toAnnotate.length, generated: Object.keys(out).length - (items.length - toAnnotate.length) }));
      }

      // Dev helper: manually fire the daily digest email (requires TRIGGER_KEY).
      if (url.pathname === '/trigger-digest' && request.method === 'GET') {
        if (url.searchParams.get('key') !== env.TRIGGER_KEY) return cors(json({ error: 'forbidden' }, 403));
        ctx.waitUntil(runDailyDigest(env));
        return cors(json({ ok: true, msg: 'Digest queued' }));
      }

      return cors(new Response('SeedPulse Push Worker — see /vapid-key, /subscribe, /unsubscribe, /latest, /ai-summary', { status: 200 }));
    } catch (e) {
      return cors(json({ error: String(e?.message || e) }, 500));
    }
  },

  async scheduled(event, env, ctx) {
    // Two cron schedules are configured in wrangler.toml:
    //   "*/30 * * * *"  → feed check + push fan-out
    //   "0 7 * * *"     → daily digest email (07:00 UTC ≈ 08:00 CET / 09:00 CEST)
    if (event.cron === '0 7 * * *') {
      ctx.waitUntil(runDailyDigest(env));
    } else {
      ctx.waitUntil(runCheck(env));
    }
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

/* ═══════════════════════ Daily digest email (feature #5) ═══════════════════════
 * Sends a morning executive briefing to DIGEST_TO_EMAIL via Resend.
 * Requires:
 *   - env.RESEND_API_KEY   (secret)  → https://resend.com/api-keys
 *   - env.DIGEST_TO_EMAIL  (var)     → comma-separated recipient list
 *   - env.DIGEST_FROM_EMAIL (var, optional) → verified sender, defaults to
 *     "SeedPulse <seedpulse@resend.dev>" (works on the free Resend sandbox).
 * Silently no-ops if RESEND_API_KEY or DIGEST_TO_EMAIL aren't set, so you can
 * deploy the Worker before wiring up email.
 */
async function runDailyDigest(env) {
  if (!env.RESEND_API_KEY || !env.DIGEST_TO_EMAIL) {
    console.log('Daily digest skipped: RESEND_API_KEY or DIGEST_TO_EMAIL not configured');
    return;
  }

  // Monday (UTC) gets the longer weekly one-pager; other days get the daily.
  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  const lookbackDays = isMonday ? 7 : 2;
  const topN = isMonday ? 25 : 15;

  // 1. Fetch + score feeds (reuse same pipeline as runCheck)
  const results = await Promise.all(FEEDS.map(fetchFeedSafe));
  const articles = results.flat();
  const byId = new Map();
  for (const a of articles) if (!byId.has(a.id)) byId.set(a.id, a);
  const cutoffIso = new Date(Date.now() - lookbackDays * 86400_000).toISOString().slice(0, 10);
  const scored = [...byId.values()]
    .map(a => ({ ...a, gs: germainsScore(a.t, a.s) }))
    .filter(a => a.gs > 0 && (a.iso || '') >= cutoffIso)
    .sort((a, b) => b.gs - a.gs || (b.iso || '').localeCompare(a.iso || ''))
    .slice(0, topN);

  if (scored.length === 0) {
    console.log('Daily digest skipped: no scoring articles today');
    return;
  }

  // 2. Optionally enrich with an AI executive summary
  let aiSummary = '';
  if (env.AI) {
    try {
      const bulletList = scored.slice(0, 12).map((a, i) =>
        `${i + 1}. ${String(a.t || '').slice(0, 200)}${a.s ? ' — ' + String(a.s).slice(0, 160) : ''}`
      ).join('\n');
      const windowLbl = isMonday ? 'this past week' : 'today';
      const len = isMonday ? '5-7 sentences' : '3-5 sentences';
      const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: 'You are a senior industry analyst at Germains Seed Technology. Write a crisp executive briefing for the commercial director. No headings, no bullets, no hedging.' },
          { role: 'user', content: `Summarise ${windowLbl}'s top seed-industry news for Germains leadership. Call out the single highest-impact item, any competitive moves, and one recommended action. ${len}.\n\n${bulletList}` }
        ],
        max_tokens: isMonday ? 500 : 320
      });
      aiSummary = (out?.response || out?.result?.response || '').trim();
    } catch (e) {
      console.log('Daily digest: AI summary failed, continuing without:', e?.message || e);
    }
  }

  // 3. Build the HTML email — weekly (Monday) is richer
  const html = isMonday ? buildWeeklyDigestHtml(scored, aiSummary) : buildDigestHtml(scored, aiSummary);
  const today = new Date().toISOString().slice(0, 10);
  const subject = isMonday
    ? `SeedPulse Weekly — ${today} — ${scored.length} stories, top score ${scored[0].gs}`
    : `SeedPulse Daily — ${today} — ${scored.length} items (top score ${scored[0].gs})`;

  // 4. Send via Resend
  const recipients = env.DIGEST_TO_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  const from = env.DIGEST_FROM_EMAIL || 'SeedPulse <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: recipients, subject, html })
    });
    const txt = await res.text();
    console.log(`Daily digest: Resend status ${res.status} — ${txt.slice(0, 200)}`);
  } catch (e) {
    console.log('Daily digest: send error', e?.message || e);
  }
}

function buildDigestHtml(items, aiSummary) {
  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
  const SERIF = "'Georgia','Times New Roman',serif";
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const rows = items.map(a => `
    <tr><td style="padding:14px 20px;border-bottom:1px solid #e8ddc9;">
      <div style="font-family:${SERIF};font-size:16px;font-weight:700;color:#0A4A2A;line-height:1.35;">
        <a href="${esc(a.u)}" style="color:#0A4A2A;text-decoration:none;">${esc(a.t)}</a>
      </div>
      <div style="font-family:${SANS};font-size:13px;color:#5b5244;margin-top:6px;line-height:1.45;">${esc((a.s || '').slice(0, 260))}</div>
      <div style="font-family:${SANS};font-size:11px;color:#8a7f6c;margin-top:6px;">
        <span style="display:inline-block;background-color:#0A4A2A;color:#fff;padding:2px 8px;border-radius:10px;font-weight:600;margin-right:6px;">Germains ${a.gs}</span>
        ${esc(a.src || '')} &middot; ${esc(a.iso || '')}
      </div>
    </td></tr>`).join('');

  const aiBlock = aiSummary ? `
    <tr><td style="padding:18px 20px;background-color:#f5efe1;border-bottom:1px solid #e8ddc9;">
      <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:1px;color:#8a6b2e;text-transform:uppercase;margin-bottom:6px;">AI Executive Briefing</div>
      <div style="font-family:${SERIF};font-size:14px;color:#2a2418;line-height:1.55;">${esc(aiSummary)}</div>
    </td></tr>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#faf6ec;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf6ec;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background-color:#fffaf0;border:1px solid #e8ddc9;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:20px 20px 12px 20px;background-color:#0A4A2A;">
          <div style="font-family:${SERIF};font-size:22px;font-weight:700;color:#fffaf0;">SeedPulse Daily</div>
          <div style="font-family:${SANS};font-size:12px;color:#c9e0d4;margin-top:2px;">Germains seed-industry briefing &middot; ${new Date().toISOString().slice(0, 10)}</div>
        </td></tr>
        ${aiBlock}
        ${rows}
        <tr><td style="padding:14px 20px;font-family:${SANS};font-size:11px;color:#8a7f6c;text-align:center;">
          Auto-generated by the SeedPulse Cloudflare Worker &middot; scored against Germains keyword dictionary.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/* ═══════════════════════ Weekly digest email (feature #10) ═══════════════════════
 * Triggered on Mondays from the same cron slot. Richer layout: top 10 of the
 * week, per-competitor mention tallies, and a longer AI executive briefing.
 * Same email infra (Resend); different template.
 */
function buildWeeklyDigestHtml(items, aiSummary) {
  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
  const SERIF = "'Georgia','Times New Roman',serif";
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Tally competitor mentions across the week
  const compTally = {};
  items.forEach(a => {
    const txt = ((a.t || '') + ' ' + (a.s || '')).toLowerCase();
    ['Incotec','Croda','Syngenta','Bayer','BASF','Rijk Zwaan','Enza Zaden','Bejo','Sakata','Takii','Limagrain','Nunhems','Corteva','Vilmorin','Hazera','Advanta','East-West']
      .forEach(c => { if (txt.indexOf(c.toLowerCase()) >= 0) compTally[c] = (compTally[c] || 0) + 1; });
  });
  const topComp = Object.entries(compTally).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const compBars = topComp.map(([name, n]) => {
    const pct = Math.min(100, Math.round(n / Math.max(1, topComp[0][1]) * 100));
    return `<tr><td style="padding:4px 0;font-family:${SANS};font-size:12px;color:#2a2418;width:110px;">${esc(name)}</td>
      <td style="padding:4px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="background-color:#0A4A2A;height:10px;width:${pct}%;border-radius:2px;">&nbsp;</td>
          <td style="padding-left:6px;font-family:${SANS};font-size:11px;color:#5b5244;white-space:nowrap;">${n}×</td>
        </tr></table>
      </td></tr>`;
  }).join('');

  const top10 = items.slice(0, 10);
  const rows = top10.map((a, i) => `
    <tr><td style="padding:14px 20px;border-bottom:1px solid #e8ddc9;">
      <div style="font-family:${SERIF};font-size:11px;color:#8a6b2e;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">#${i + 1} &middot; Germains score ${a.gs}</div>
      <div style="font-family:${SERIF};font-size:17px;font-weight:700;color:#0A4A2A;line-height:1.35;">
        <a href="${esc(a.u)}" style="color:#0A4A2A;text-decoration:none;">${esc(a.t)}</a>
      </div>
      <div style="font-family:${SANS};font-size:13px;color:#5b5244;margin-top:6px;line-height:1.5;">${esc((a.s || '').slice(0, 280))}</div>
      <div style="font-family:${SANS};font-size:11px;color:#8a7f6c;margin-top:6px;">${esc(a.src || '')} &middot; ${esc(a.iso || '')}</div>
    </td></tr>`).join('');

  const aiBlock = aiSummary ? `
    <tr><td style="padding:22px 20px;background-color:#f5efe1;border-bottom:2px solid #0A4A2A;">
      <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:1px;color:#8a6b2e;text-transform:uppercase;margin-bottom:8px;">Executive Briefing — The Week Ahead</div>
      <div style="font-family:${SERIF};font-size:15px;color:#2a2418;line-height:1.6;">${esc(aiSummary)}</div>
    </td></tr>` : '';

  const compBlock = compBars ? `
    <tr><td style="padding:20px 20px;background-color:#fffaf0;border-bottom:1px solid #e8ddc9;">
      <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:1px;color:#8a6b2e;text-transform:uppercase;margin-bottom:10px;">Competitor Mentions This Week</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${compBars}</table>
    </td></tr>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#faf6ec;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf6ec;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background-color:#fffaf0;border:1px solid #e8ddc9;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 20px 14px 20px;background-color:#0A4A2A;">
          <div style="font-family:${SERIF};font-size:11px;font-weight:700;letter-spacing:2px;color:#c9e0d4;text-transform:uppercase;">Monday One-Pager</div>
          <div style="font-family:${SERIF};font-size:26px;font-weight:700;color:#fffaf0;margin-top:4px;">SeedPulse Weekly</div>
          <div style="font-family:${SANS};font-size:12px;color:#c9e0d4;margin-top:4px;">${items.length} stories scored &middot; ${new Date().toISOString().slice(0, 10)}</div>
        </td></tr>
        ${aiBlock}
        ${compBlock}
        <tr><td style="padding:14px 20px 4px 20px;background-color:#fffaf0;">
          <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:1px;color:#8a6b2e;text-transform:uppercase;">Top 10 Stories of the Week</div>
        </td></tr>
        ${rows}
        <tr><td style="padding:14px 20px;font-family:${SANS};font-size:11px;color:#8a7f6c;text-align:center;">
          Auto-generated by the SeedPulse Cloudflare Worker &middot; Monday one-pager for Germains leadership.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

