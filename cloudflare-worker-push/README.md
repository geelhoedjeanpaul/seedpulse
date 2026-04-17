# SeedPulse Push Worker

A Cloudflare Worker that polls RSS feeds on a cron schedule, scores each article
for Germains relevance, and fans out Web Push notifications to subscribed PWA
clients whenever a new high-priority article appears. Uses the "ping-push"
pattern: the push itself is body-less (no RFC 8291 payload encryption), and the
service worker fetches the actual item list from `/latest` when it receives the
push.

Runs comfortably on the **Cloudflare Workers free plan** — KV for state, cron
for scheduling, no Durable Objects required.

---

## Architecture

```
           ┌────────────────────────────────────────────┐
 cron ────▶│ 1. Fetch ~16 RSS feeds (8s timeout each)   │
 */30 min  │ 2. Score each article for Germains fit     │
           │ 3. Diff against "seen" set in KV           │
           │ 4. Store new items as "latest" in KV       │
           │ 5. For each subscriber: send body-less push│
           └────────────────────────────────────────────┘
                            │
                            ▼  (empty push arrives on device)
           ┌────────────────────────────────────────────┐
 service   │ push event → GET /latest → show native     │
 worker    │ notifications (up to 3, dedup by article   │
           │ id). Click → open article URL.             │
           └────────────────────────────────────────────┘
```

---

## Prerequisites

- Node 18+
- A Cloudflare account (free plan is fine)
- `wrangler` CLI:

```bash
npm install -g wrangler
wrangler login
```

---

## Setup

### 1. Create the KV namespace

```bash
cd cloudflare-worker-push
wrangler kv namespace create SUBS
```

Wrangler prints a snippet like:

```
[[kv_namespaces]]
binding = "SUBS"
id = "abc123def456..."
```

Copy the `id` into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 2. Generate VAPID keys

```bash
node generate-vapid.mjs
```

It prints two values:

- `VAPID_PUBLIC_KEY` — 88-char base64url string. Paste into `wrangler.toml`
  under `[vars].VAPID_PUBLIC_KEY`.
- `VAPID_PRIVATE_JWK` — JSON blob. Store as a secret:

```bash
wrangler secret put VAPID_PRIVATE_JWK
# paste the JWK JSON when prompted, press Ctrl-D
```

Keep the private JWK private. Anyone with it can send push as your origin.

### 3. Set the trigger-test key

`/trigger-test` lets you fire the cron manually while testing. Gate it with a
random string:

```bash
wrangler secret put TRIGGER_KEY
# paste any random string, e.g. output of `openssl rand -hex 16`
```

### 4. Deploy

```bash
wrangler deploy
```

Wrangler prints your Worker URL, e.g.
`https://seedpulse-push.your-subdomain.workers.dev`.

### 5. Wire up the client

Open `index.html` in the repo root and set:

```js
var PUSH_WORKER_URL='https://seedpulse-push.your-subdomain.workers.dev';
```

Commit and push. GitHub Pages will redeploy.

---

## Endpoints

| Method | Path                     | Purpose                                   |
|--------|--------------------------|-------------------------------------------|
| GET    | `/vapid-key`             | Returns `{publicKey}` for `subscribe()`   |
| POST   | `/subscribe`             | Store a PushSubscription (body: `{subscription}`) |
| POST   | `/unsubscribe`           | Remove by endpoint (body: `{endpoint}`)   |
| GET    | `/latest`                | Service worker fetches this on push       |
| GET    | `/trigger-test?key=…`    | Manually run the cron job                 |
| GET    | `/stats`                 | `{subscriberCount, latestCount, seenCount}` |

---

## Testing

After deploying and wiring up the client:

1. Install the PWA (browser menu → "Install SeedPulse"). **On iOS 16.4+ the PWA
   MUST be installed to the home screen for push to work — Safari tabs cannot
   receive Web Push.**
2. Tap the bell icon in the app header → grant notification permission.
3. Check `/stats` — `subscriberCount` should be ≥ 1.
4. Fire the cron manually:

```bash
curl "https://seedpulse-push.your-subdomain.workers.dev/trigger-test?key=YOUR_TRIGGER_KEY"
```

You should receive a notification within a few seconds if there are new
priority articles. If there aren't any, the response will say so; wait for the
next cycle or seed some test data.

---

## Rollback

Set `PUSH_WORKER_URL=''` in `index.html`. The app falls back to **local mode**:
foreground-only notifications when the app is open. No code changes needed in
the Worker.

To fully disable: `wrangler delete` removes the Worker. Existing subscriptions
become stale; they'll get 404s and self-expire.

---

## Cost

On the free plan:

- Cron: 1 invocation / 30 min = 1,440/month. Free tier includes 100k/day.
- KV: subscribers + seen-set + latest ≈ a few dozen keys. Free tier: 100k
  reads/day, 1k writes/day.
- Push fan-out: 1 HTTP request per subscriber per cycle. With <100 subscribers
  and a 30-minute cycle, you'll stay well under 5k req/day.

You should stay on the free plan indefinitely unless you scale past a few
hundred subscribers or shorten the cron interval drastically.

---

## Tuning

In `worker.js`:

- `NOTIFY_MIN = 3` — minimum Germains score for a notification.
- `MAX_PER_RUN = 3` — cap notifications per cron cycle to avoid shade spam.
- `FEED_TIMEOUT_MS = 8000` — per-feed fetch timeout.

In `wrangler.toml`:

- `crons = ["*/30 * * * *"]` — every 30 minutes. Free plan allows every minute
  too, but 30 min is plenty for industry news.
