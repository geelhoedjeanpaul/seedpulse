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
  GN + 'germains+seed+technology+when:30d',
  // R&D Developments — peer-reviewed and applied research
  'https://www.frontiersin.org/journals/plant-science/rss',
  'https://www.nature.com/nplants.rss',
  'https://www.mdpi.com/journal/agronomy/rss',
  GN + '%22CRISPR%22+OR+%22prime+editing%22+plant+OR+crop+when:30d',
  GN + '%22high-throughput+phenotyping%22+OR+%22digital+phenotyping%22+when:30d',
  GN + '%22machine+learning%22+seed+OR+crop+when:30d',
  GN + '%22climate+resilient%22+crop+OR+%22drought+tolerant%22+variety+when:30d',
  GN + '%22plant+microbiome%22+OR+%22rhizosphere%22+research+when:30d'
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

      // Full article pool — populated every 30 min by runCheck. The client
      // pulls this on app open INSTEAD of fetching 70+ RSS feeds direct,
      // so first paint is ~300-500 ms instead of 8-30 s. Falls back to
      // direct RSS fetch in the client if this is empty (cold worker).
      if (url.pathname === '/articles' && request.method === 'GET') {
        const raw = await env.SUBS.get('articles');
        if (!raw) return cors(json({ items: [], updatedAt: 0, count: 0, cold: true }));
        // Forward as-is. Edge cache for 60 s so multiple page loads in
        // quick succession don't all hit KV.
        const res = new Response(raw, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60'
          }
        });
        return cors(res);
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

      // ─── Per-user settings sync (relationships + watchlist) ────────────
      // The client owns a `clientId` (UUID v4, generated once and persisted
      // in localStorage). It's the only identifier we keep; no email, no
      // login. KV stores `prefs:<clientId>` → { relationships, watchlist,
      // updatedAt }. Quotas are trivial (under 1 KB per user).
      //
      // GET  /relationships?clientId=…  → { relationships, watchlist, updatedAt }
      // PUT  /relationships             → { clientId, relationships, watchlist }
      //                                   → { ok:true, updatedAt }
      if (url.pathname === '/relationships' && request.method === 'GET') {
        const clientId = url.searchParams.get('clientId') || '';
        if (!isValidClientId(clientId)) return cors(json({ error: 'missing/invalid clientId' }, 400));
        const raw = await env.SUBS.get('prefs:' + clientId);
        return cors(json(raw ? JSON.parse(raw) : { relationships: {}, watchlist: [], updatedAt: 0 }));
      }
      if (url.pathname === '/relationships' && (request.method === 'PUT' || request.method === 'POST')) {
        const body = await request.json().catch(() => ({}));
        const clientId = String(body?.clientId || '');
        if (!isValidClientId(clientId)) return cors(json({ error: 'missing/invalid clientId' }, 400));
        // Drop unrecognised relationship values to keep the blob clean
        const allowed = new Set(['customer', 'partner', 'prospect', 'competitor']);
        const inRel = body?.relationships && typeof body.relationships === 'object' ? body.relationships : {};
        const relationships = {};
        for (const k of Object.keys(inRel).slice(0, 500)) {
          if (allowed.has(inRel[k])) relationships[String(k).slice(0, 80)] = inRel[k];
        }
        // Watchlist: array of strings (each ≤ 60 chars), max 50 items
        const wlIn = Array.isArray(body?.watchlist) ? body.watchlist : [];
        const watchlist = wlIn.slice(0, 50).map(x => String(x).slice(0, 60)).filter(Boolean);
        const updatedAt = Date.now();
        const payload = { relationships, watchlist, updatedAt };
        // KV writes are ~10 ms; ctx.waitUntil lets us return immediately
        ctx.waitUntil(env.SUBS.put('prefs:' + clientId, JSON.stringify(payload), {
          // No expiry — user prefs should outlive any cache pruning
        }));
        return cors(json({ ok: true, updatedAt }));
      }

      // AI-powered executive summary (feature #10)
      // Body: { context?: string, items: [{t, s, u, src, cat}] }
      // Uses Cloudflare Workers AI (Llama 3.1 8B). Requires [ai] binding.
      if (url.pathname === '/ai-summary' && request.method === 'POST') {
        if (!env.AI) return cors(json({ error: 'AI binding not configured' }, 503));
        const body = await request.json().catch(() => ({}));
        // Cap at 15 — the model only needs enough breadth to identify the
        // top item + a competitive angle; extra rows lengthen the prompt
        // without improving the summary.
        const items = Array.isArray(body?.items) ? body.items.slice(0, 15) : [];
        if (items.length === 0) return cors(json({ error: 'No items provided' }, 400));
        const context = (body.context || '').toString().slice(0, 400);
        // Tighter prompt — fewer tokens per article, less work for the model.
        const bulletList = items.map((a, i) =>
          `${i + 1}. [${a.cat || '?'}] ${String(a.t || '').slice(0, 160)}` +
          (a.s ? ` — ${String(a.s).slice(0, 140)}` : '') +
          (a.src ? ` (${a.src})` : '')
        ).join('\n');
        const sys = 'You are a senior analyst at Germains Seed Technology (seed priming, pelleting, film coating, seed hygiene). Write crisp executive briefings for the leadership team. Be specific; name companies and technologies. Never invent facts.';
        const user = `Write a 4-5 sentence executive briefing from these ${items.length} articles. Cover (a) the single most important item for Germains, (b) a competitive threat or opportunity, (c) one recommended action. Plain prose, no bullets, no headings.${context ? `\n\nContext: ${context}` : ''}\n\nArticles:\n${bulletList}`;
        try {
          const out = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: user }
            ],
            // 260 tokens ≈ 5 dense sentences. Lower cap = faster TTFT and
            // forces the model to be concise.
            max_tokens: 260
          });
          const summary = (out?.response || out?.result?.response || '').trim();
          if (!summary) return cors(json({ error: 'Empty AI response' }, 502));
          return cors(json({ summary, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', count: items.length }));
        } catch (e) {
          return cors(json({ error: 'AI error: ' + String(e?.message || e) }, 502));
        }
      }

      // Per-article annotation (feature #1): returns {impact, soWhat, action}
      // Body: { items: [{id,t,s,src,cat,comp,ang,gs}] }
      // Response: { annotations: { [id]: {impact, soWhat, action} } }
      // Uses KV as a 30-day cache so repeat calls are near-free.
      //
      // KV prefix is "ann2:" — bumped from "ann:" because the response
      // shape grew (added `action`) and old cached records would render
      // without the suggested-action line. Old "ann:" keys expire on
      // their TTL and get garbage-collected.
      if (url.pathname === '/annotate' && request.method === 'POST') {
        if (!env.AI) return cors(json({ error: 'AI binding not configured' }, 503));
        const body = await request.json().catch(() => ({}));
        const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
        if (items.length === 0) return cors(json({ annotations: {} }));

        const out = {};
        const errors = []; // surfaced in response for debugging

        // 1. Parallel KV cache lookup
        const validItems = items.filter(it => it?.id);
        const cachedRaw = await Promise.all(
          validItems.map(it => env.SUBS.get('ann2:' + it.id))
        );
        const toAnnotate = [];
        for (let i = 0; i < validItems.length; i++) {
          const raw = cachedRaw[i];
          if (raw) { try { out[validItems[i].id] = JSON.parse(raw); } catch {} }
          else toAnnotate.push(validItems[i]);
        }

        // 2. Single-item AI calls run in PARALLEL. Switched from batched
        //    JSON arrays because the model frequently dropped or
        //    misformatted IDs in array output, leaving the placeholder
        //    stuck on "Generating commercial briefing…". One item per
        //    call → simpler schema, more reliable JSON, easier to debug.
        const sys = 'You are a senior commercial analyst at Germains Seed Technology — a global leader in seed priming, film coating, pelleting, seed hygiene, and seed analytics. You write decisive, plain-prose briefings for the commercial director. Never invent facts. Name specific companies and technologies. No hedging.';

        const annResults = await Promise.all(toAnnotate.map(async (a) => {
          // Single-item JSON-only prompt. Three concrete fields the model
          // can fill in independently — much easier to produce than a
          // batched array of objects keyed by id.
          const user =
`Classify this article and write a brief commercial briefing for Germains.

Article title: ${String(a.t || '').slice(0, 220)}
Summary: ${String(a.s || '').slice(0, 280)}
Source: ${a.src || 'unknown'}
Competitors mentioned: ${(a.comp || []).join(', ') || 'none'}
Germains relevance score: ${a.gs || 0}/10

Respond with ONLY a JSON object, no markdown fences, no prose around it:
{
  "impact": "opportunity" | "threat" | "watch" | "info",
  "soWhat": "1-2 short sentences (<=40 words) on what this means specifically for Germains' commercial position",
  "action": "1 short sentence (<=25 words) starting with a verb suggesting a concrete action Germains should take"
}

Impact definitions:
- opportunity: directly creates a sales, partnership, or product angle for Germains
- threat: a competitor move, regulation, or market shift that hurts Germains
- watch: relevant trend, monitor; not actionable yet
- info: context only

Return the JSON object now.`;

          try {
            const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: user }
              ],
              max_tokens: 220
            });
            // Workers AI response shape varies by model and version. Cover
            // every plausible field, coerce to string, then look for JSON.
            const txt = String(
              (r && typeof r.response === 'string' && r.response) ||
              (r && r.result && typeof r.result.response === 'string' && r.result.response) ||
              (r && typeof r.text === 'string' && r.text) ||
              (r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) ||
              ''
            ).trim();
            if (!txt) {
              errors.push({ id: a.id, err: 'no-text', shape: Object.keys(r || {}).join(',') });
              return null;
            }
            // Tolerate ```json fences or leading/trailing prose
            const m = txt.match(/\{[\s\S]*\}/);
            if (!m) { errors.push({ id: a.id, err: 'no-json', preview: txt.slice(0, 80) }); return null; }
            let obj;
            try { obj = JSON.parse(m[0]); }
            catch (e) { errors.push({ id: a.id, err: 'parse-fail', preview: m[0].slice(0, 80) }); return null; }
            const impact = ['opportunity', 'threat', 'watch', 'info'].includes(obj.impact) ? obj.impact : 'info';
            const soWhat = String(obj.soWhat || '').trim().slice(0, 320);
            const action = String(obj.action || '').trim().slice(0, 180);
            if (!soWhat) { errors.push({ id: a.id, err: 'empty-soWhat' }); return null; }
            return { id: a.id, ann: { impact, soWhat, action } };
          } catch (e) {
            errors.push({ id: a.id, err: 'ai-error', msg: String(e?.message || e).slice(0, 120) });
            return null;
          }
        }));

        // 3. Collect annotations and queue KV writes
        const kvWrites = [];
        for (const r of annResults) {
          if (!r) continue;
          out[r.id] = r.ann;
          kvWrites.push(env.SUBS.put('ann2:' + r.id, JSON.stringify(r.ann), { expirationTtl: 60 * 60 * 24 * 30 }));
        }
        // Defer KV writes so the HTTP response returns immediately — the
        // client doesn't care whether persistence has flushed yet.
        if (kvWrites.length) ctx.waitUntil(Promise.all(kvWrites));

        return cors(json({
          annotations: out,
          cached: validItems.length - toAnnotate.length,
          generated: kvWrites.length,
          errors: errors.length ? errors : undefined
        }));
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

  // 2. Dedupe + score every article (not just the high-priority ones).
  //    The full pool gets stored in KV under 'articles' so the client
  //    can pull one fast JSON blob instead of fetching 70+ RSS feeds.
  const byId = new Map();
  for (const a of articles) if (!byId.has(a.id)) byId.set(a.id, a);
  const allScored = [...byId.values()]
    .map(a => ({ ...a, gs: germainsScore(a.t, a.s) }))
    .sort((a, b) => (b.iso || '').localeCompare(a.iso || ''));
  // Persist the top 600 by recency — covers ~weekly window for 70+ feeds
  // and stays well under KV's value-size limit. Stored under 'articles'.
  const articlesPayload = {
    items: allScored.slice(0, 600),
    updatedAt: Date.now(),
    count: allScored.length
  };
  // Fire-and-forget; don't block scoring/push on this write.
  // (runCheck has no ctx.waitUntil access since it's called from the
  // scheduled handler — but the awaited put below is fine, KV is fast.)
  await env.SUBS.put('articles', JSON.stringify(articlesPayload));

  // 3. High-priority filter for notifications
  const scored = allScored.filter(a => a.gs >= NOTIFY_MIN);

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

// Restrict client identifiers to UUID v4-like strings so the prefs:<id>
// KV namespace can't be polluted with arbitrary keys.
function isValidClientId(s) {
  return typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
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
      const out = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
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

