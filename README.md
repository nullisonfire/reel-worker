# reels-worker

A single-file Cloudflare Worker that resolves an Instagram or Facebook reel URL
into direct CDN media URLs plus metadata.

```bash
curl -X POST https://reels.zonal8731.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.instagram.com/reel/Dbup0HNT0lJ/"}'
```

## Deploy

```bash
npm i -g wrangler
wrangler login
wrangler deploy
```

No dependencies and no build step — you can also paste `src/worker.js` straight
into the Cloudflare dashboard editor.

## API

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | POST | `{"url": "...", "refresh": false}` |
| `/` | GET | `?url=...&refresh=1` — same thing, browser-friendly |
| `/health` | GET | liveness + which optional features are configured |
| `/media` | GET | signed CDN passthrough (only when `PROXY_SECRET` is set) |

Accepted input: `/reel/`, `/reels/`, `/p/`, `/tv/`, `/username/reel/`,
`instagram.com/share/...`, `facebook.com/reel/`, `/videos/`, `/watch/?v=`,
`fb.watch/...`, and share links (resolved by following redirects). Bare hosts
without a scheme work too.

### Success response

```json
{
  "success": true,
  "platform": "instagram",
  "shortcode": "Dbup0HNT0lJ",
  "media_id": "3958285023564482889",
  "permalink": "https://www.instagram.com/reel/Dbup0HNT0lJ/",
  "media_type": "video",
  "video_url": "https://scontent-….cdninstagram.com/o1/v/t2/….mp4?…",
  "thumbnail": "https://scontent-….cdninstagram.com/v/….jpg?…",
  "media_list": [{ "type": "video", "url": "…", "thumbnail": "…" }],
  "formats": [
    { "quality": "1080p", "width": 1076, "height": 1914, "bandwidth": 828641,
      "codecs": "vp09.00.40.08.00.01.01.01.00", "url": "…" }
  ],
  "caption": "When the Rajakars Bowed Before the Freedom Fighters…",
  "accessibility_caption": "…",
  "username": "outlineofbangladesh",
  "author_full_name": "Outline of Bangladesh",
  "author_profile_pic": "https://…",
  "author_is_verified": false,
  "duration": 10.8,
  "play_count": null,
  "like_count": 147,
  "comment_count": 3,
  "reshare_count": null,
  "audio_url": "",
  "audio_title": "",
  "audio_artist": "",
  "is_paid_partnership": false,
  "taken_at": 1786084469,
  "slide_count": 1,
  "source": "ig:graphql",
  "is_cached": false,
  "refreshed": false,
  "resolved_in_ms": 543,
  "error": null
}
```

`media_type` is `"video"`, `"image"` or `"carousel"`. For a carousel,
`media_list` has one entry per slide and `video_url` points at the first video
slide. `formats` is the per-quality ladder parsed out of the DASH manifest —
`video_url` is the default progressive rendition, `formats[0]` is the highest
quality available.

### Error response

Errors never leak upstream HTML or tokens; they always carry a stable code.

```json
{ "success": false,
  "error": { "code": "MEDIA_NOT_FOUND", "message": "That post is unavailable…" },
  "is_cached": false, "refreshed": false }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Missing/malformed `url` or body |
| `UNSUPPORTED_URL` | 422 | Not an Instagram/Facebook media URL |
| `UNAUTHORIZED` | 401 | `API_KEY` is set and the key was wrong |
| `MEDIA_UNAVAILABLE` | 403 | Login/age gated, or non-public |
| `MEDIA_NOT_FOUND` | 404 | Deleted, private or region-blocked |
| `RATE_LIMITED` | 429 | Your own per-IP limit |
| `UPSTREAM_BLOCKED` | 502 | Meta rate-limited this Worker's egress IP |
| `UPSTREAM_SCHEMA_CHANGED` | 502 | Instagram rotated the `doc_id` — see below |
| `UPSTREAM_TIMEOUT` | 504 | Upstream too slow |

## Configuration

All optional. The Worker deploys and works with none of it set.

| Binding | Effect |
| --- | --- |
| `API_KEY` (secret) | Requires `X-API-Key` / `Authorization: Bearer`. Unset = open |
| `IG_COOKIE` (secret) | Full cookie string from a logged-in session. Unlocks `play_count`, `reshare_count`, audio metadata and paid-partnership flags |
| `IG_SESSIONID` (secret) | Shorthand for the above when you only have `sessionid` |
| `PROXY_SECRET` (secret) | Enables `/media?u=<url>&s=<hmac-sha256>` CDN passthrough |
| `RATELIMIT` (KV) | Enables per-IP rate limiting |
| `CACHE_TTL`, `RATE_LIMIT` (vars) | Tuning |

## How it works

Ordered fallbacks per platform. `source` in the response tells you which one won.

**Instagram**
1. `ig:authenticated` — `GET /api/v1/media/<pk>/info/`, only when `IG_COOKIE` is
   set. Richest data. A dead cookie falls through silently instead of failing.
2. `ig:graphql` — `POST /api/graphql`, `doc_id=27130156389949648`
   (`PolarisLoggedOutDesktopWWWPostRootContentQuery`). The workhorse.

Three findings from probing the live endpoints that this rests on:

- **`Sec-Fetch-Site: same-origin` is the single load-bearing header.** Without
  it Instagram answers `200` with a 600 KB HTML shell instead of JSON no matter
  what else you send. Browsers forbid page JS from setting `Sec-Fetch-*`; the
  Workers runtime does not, which is precisely why this has to run in a Worker
  and can't run in a browser.
- **A fresh `lsd` token *and* the guest cookie jar are both required.** A dummy
  `lsd` fails; dropping cookies fails. Hence the one-time homepage bootstrap,
  memoised for 10 minutes and shared across requests.
- **Shortcode → numeric pk is a pure base64 decode** (alphabet
  `A-Za-z0-9-_`), so it costs no round-trip. `variables` needs `media_id`, not
  the shortcode.

Endpoints that are **dead** in 2026 and deliberately not attempted:
`?__a=1&__d=dis` (404), `/api/v1/media/<id>/info/` without a session (302 to
login), the old `doc_id=8845758582119845` + shortcode query (`execution error`),
scraping the post page HTML (media JSON no longer embedded), and
`/embed/captioned/` (no longer exposes `video_url`).

**Facebook** — both strategies run in parallel and are merged.
1. `fb:plugin` — `/plugins/video.php?href=…` yields `hd_src`/`sd_src` with no
   cookies. Necessary because `/reel/<id>` and `/videos/<id>` return HTTP 400 to
   datacenter IPs.
2. `fb:watch` — `/watch/?v=<id>` yields `og:*` metadata; its `og:title` carries
   `"<N> views · <M> reactions"`, which is parsed into counts.

## Known limits — read these

- **Logged-out Instagram will not give you `play_count`, `reshare_count` or
  music metadata.** They are withheld from guests, so they come back `null`/`""`.
  Set `IG_COOKIE` if you need them.
- **Meta rate-limits anonymous access per source IP.** Worker egress IPs are
  shared datacenter IPs, so under sustained load you will see
  `UPSTREAM_BLOCKED`. Caching is load-bearing, not an optimisation. For serious
  volume you need either `IG_COOKIE` or an upstream fetcher with a browser TLS
  fingerprint — Workers cannot spoof a TLS fingerprint, and that is not
  something any code in this file can fix.
- **`doc_id` values rotate with Instagram's frontend deploys.** When that
  happens every Instagram lookup returns `UPSTREAM_SCHEMA_CHANGED`. The fix is
  to grab the current `doc_id` from a real browser's Network tab on an
  instagram.com post request and prepend it to `CONFIG.IG_DOC_IDS`. A Cron
  trigger that scrapes it automatically is the obvious hardening step.
- **Returned CDN URLs are signed and expire in hours.** Store the shortcode and
  re-resolve; don't persist the URLs.
- **Facebook comment counts and profile pictures are not available anonymously.**
- This reads only public content. It does not bypass privacy settings, and
  whether you may redistribute what it returns is between you and Meta's terms.

## Tests

```bash
node test/local.mjs          # unit + live checks against Meta (43 assertions)
node test/local.mjs --unit   # offline only
```

The harness runs the Worker module under Node with no `caches` global, which
also exercises the cache-absent code paths.
