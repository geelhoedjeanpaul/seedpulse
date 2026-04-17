# SeedPulse RSS Proxy (Cloudflare Worker)

A tiny, zero-dependency Cloudflare Worker that proxies RSS/Atom feeds and
returns rss2json-compatible JSON. Removes the free-tier limits that the
hosted rss2json.com service imposes:

| Limit                        | rss2json free tier | This Worker           |
|------------------------------|--------------------|-----------------------|
| Items returned per feed      | 10                 | 100 (configurable)    |
| Concurrent requests          | ~5                 | Unlimited             |
| Monthly request budget       | 10k                | 100k / day (free plan)|
| Credit card required         | No                 | No                    |
| Dependencies                 | —                  | None                  |

The SeedPulse app is drop-in compatible: just set `PROXY_URL` in
`index.html` to this Worker's URL and feed fetching goes through it
instead of rss2json.

## Deploy in 3 minutes

1. Install the Cloudflare CLI:
   ```sh
   npm install -g wrangler
   ```

2. Log in (opens a browser; free account is fine):
   ```sh
   wrangler login
   ```

3. Deploy from this folder:
   ```sh
   cd cloudflare-worker
   wrangler deploy
   ```

   You'll get a URL like `https://seedpulse-rss.<your-subdomain>.workers.dev`.

4. In the parent `index.html`, set:
   ```js
   var PROXY_URL = 'https://seedpulse-rss.<your-subdomain>.workers.dev/?url=';
   ```
   Commit, push — feeds now flow through your Worker.

## Testing

```sh
# Quick smoke test
curl "https://seedpulse-rss.<you>.workers.dev/?url=https://worldseed.org/feed/"
```

Expected shape:
```json
{ "status": "ok", "items": [ { "title": "...", "link": "...", "description": "...", "pubDate": "..." }, ... ] }
```

## Tuning

Edit `worker.js`:

- `CACHE_TTL_SECONDS` — how long the edge caches each feed (default 15 min).
- `MAX_ITEMS_PER_FEED` — cap items returned per feed (default 100).
- `UPSTREAM_TIMEOUT_MS` — give up on slow origins (default 8 s).
- `ALLOWED_HOSTS` — set to an array to restrict which hosts the proxy will fetch.
  Leave `null` for an open proxy (fine for personal use).

## Security note

The Worker is an open proxy by default (any URL passed via `?url=`). Since
each deploy has a unique subdomain, abuse risk is very low. To lock it down,
populate `ALLOWED_HOSTS` with the domains SeedPulse actually uses:

```js
const ALLOWED_HOSTS = [
  'news.google.com',
  'worldseed.org',
  'agfundernews.com',
  'sciencedaily.com',
  'phys.org',
  'wur.nl',
  'european-seed.com',
  'biobasedpress.eu',
  'allianceforscience.org'
];
```

## Rollback

If anything goes wrong, set `PROXY_URL = ''` in `index.html` — the app
falls back to rss2json automatically.
