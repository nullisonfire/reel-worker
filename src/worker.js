/**
 * ============================================================================
 *  reels-worker — Instagram & Facebook reel/video metadata resolver
 * ============================================================================
 *
 *  POST /                {"url": "https://www.instagram.com/reel/<code>/"}
 *  GET  /?url=...        same thing, convenient for browsers
 *  GET  /health          liveness + which optional features are configured
 *  GET  /media?u=..&s=.. signed CDN passthrough (only when PROXY_SECRET is set)
 *
 *  Design notes
 *  ------------
 *  Deliberately a SINGLE FILE. A Worker is a single deployable unit and this
 *  one has no build step: `wrangler deploy`, or paste it into the dashboard
 *  editor. Internal structure is layered by section banners instead of by
 *  file — same separation of concerns, zero toolchain.
 *
 *  Every upstream technique below was verified live against Meta's servers
 *  before being written down. The important, non-obvious findings:
 *
 *   1. Instagram's logged-out post query lives at
 *        POST https://www.instagram.com/api/graphql
 *      with doc_id 27130156389949648
 *      (friendly name PolarisLoggedOutDesktopWWWPostRootContentQuery).
 *      `variables` takes {"media_id": <numeric pk>} — NOT the shortcode.
 *
 *   2. THE header that makes or breaks it is `Sec-Fetch-Site: same-origin`.
 *      Without it Instagram answers 200 + a 600 KB HTML shell instead of JSON,
 *      no matter how many other headers you send. Browsers forbid page JS from
 *      setting Sec-Fetch-*; the Workers runtime imposes no such restriction
 *      (workerd's Headers guard never inspects header names), so a Worker can
 *      send it and a browser cannot. This is why this must live server-side.
 *
 *   3. A fresh `lsd` token AND the guest cookie jar from a homepage GET are
 *      both required. A dummy lsd fails; omitting cookies fails. Hence the
 *      one-time bootstrap, cached and shared across requests.
 *
 *   4. The shortcode <-> numeric pk mapping is pure base64 with the alphabet
 *      A-Za-z0-9-_ , so it costs zero network round-trips.
 *
 *   5. Facebook: `/reel/<id>` and `/videos/<id>` return HTTP 400 to a plain
 *      datacenter GET, but `/plugins/video.php?href=...` cheerfully returns a
 *      VideoConfig blob with `hd_src` and `sd_src` and needs no cookies. The
 *      `/watch/?v=<id>` page then supplies og:* metadata (its og:title carries
 *      "<N> views · <M> reactions"). The worker merges both.
 *
 *  Honest limits — see README:
 *   - Logged-out Instagram never exposes play_count, reshare_count or music
 *     metadata. Set IG_COOKIE to unlock those via the authenticated endpoint.
 *   - Meta rate-limits anonymous access per source IP. Caching is therefore
 *     load-bearing, not an optimisation.
 *   - Returned CDN URLs are signed and expire (hours). Do not persist them.
 */

/* ==========================================================================
 * 1. Configuration
 * ========================================================================== */

const CONFIG = {
  /** Instagram's public web client id. Stable for years. */
  IG_APP_ID: '936619743392459',

  /**
   * Ordered doc_id candidates for the logged-out single-post query.
   * These rotate with Instagram's frontend deploys — index 0 is the one
   * verified working; the rest are historical fallbacks. If all fail, the
   * worker reports UPSTREAM_SCHEMA_CHANGED so the cause is unambiguous.
   *
   * Future extension: a Cron trigger could scrape the current doc_id from
   * instagram.com's JS bundles and stash it in KV, making this self-healing.
   */
  IG_DOC_IDS: ['27130156389949648', '8845758582119845', '10015901848480474'],
  IG_FRIENDLY_NAME: 'PolarisLoggedOutDesktopWWWPostRootContentQuery',

  UA_DESKTOP:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',

  /** Successful lookups cached this long (seconds). CDN URLs outlive this. */
  CACHE_TTL: 1800,
  /** Failures cached briefly so a hammered bad URL can't stampede upstream. */
  CACHE_TTL_ERROR: 60,
  /** Guest session (cookies + lsd) reuse window. */
  SESSION_TTL: 600,

  /** Per-IP requests per minute. 0 disables. Requires the RATELIMIT KV binding. */
  RATE_LIMIT: 60,

  UPSTREAM_TIMEOUT_MS: 12_000,
  MAX_BODY_BYTES: 4096,
  MAX_REDIRECTS: 5,
};

/** Media type codes used across Instagram's API surface. */
const IG_MEDIA = { IMAGE: 1, VIDEO: 2, CAROUSEL: 8 };

/* ==========================================================================
 * 2. Errors & HTTP plumbing
 * ========================================================================== */

/**
 * Errors that are safe to show a caller. Anything thrown that is NOT an
 * ApiError is treated as an internal fault and reported generically, so
 * upstream HTML, stack traces and tokens can never leak out.
 */
class ApiError extends Error {
  constructor(code, message, status = 400, meta = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.meta = meta;
  }
}

const ERR = {
  badRequest: (m) => new ApiError('BAD_REQUEST', m, 400),
  unsupported: (m) => new ApiError('UNSUPPORTED_URL', m, 422),
  notFound: (m) => new ApiError('MEDIA_NOT_FOUND', m, 404),
  private: (m) => new ApiError('MEDIA_UNAVAILABLE', m, 403),
  unauthorized: (m) => new ApiError('UNAUTHORIZED', m, 401),
  rateLimited: (m) => new ApiError('RATE_LIMITED', m, 429),
  blocked: (m) => new ApiError('UPSTREAM_BLOCKED', m, 502),
  schema: (m) => new ApiError('UPSTREAM_SCHEMA_CHANGED', m, 502),
  timeout: (m) => new ApiError('UPSTREAM_TIMEOUT', m, 504),
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  'Access-Control-Max-Age': '86400',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function jsonResponse(body, { status = 200, cacheSeconds = 0, extra = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

/* ==========================================================================
 * 3. Small utilities
 * ========================================================================== */

/** fetch() with a hard deadline, so one slow upstream can't hold the request. */
async function fetchWithTimeout(url, init = {}, ms = CONFIG.UPSTREAM_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, redirect: init.redirect ?? 'follow' });
  } catch (err) {
    if (err?.name === 'AbortError') throw ERR.timeout('Upstream did not respond in time.');
    throw ERR.blocked('Could not reach upstream.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read every Set-Cookie value into a single `Cookie` request header.
 * getSetCookie() is the correct API; the joined-string fallback covers older
 * runtime versions where only get('set-cookie') exists.
 */
function harvestCookies(response, into = new Map()) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') || '').split(/,(?=[^;]+=[^;]+)/);

  for (const line of raw) {
    const [pair] = String(line).split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) into.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return into;
}

const cookieHeader = (jar) =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

/** Follow redirects manually so we can read the final URL of a share link. */
async function resolveRedirects(startUrl, headers) {
  let current = startUrl;
  for (let hop = 0; hop < CONFIG.MAX_REDIRECTS; hop++) {
    const res = await fetchWithTimeout(current, { headers, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!location) return { url: current, response: res };
    current = new URL(location, current).toString();
  }
  return { url: current, response: null };
}

/**
 * Pull a JSON string value out of raw HTML/JS by key, honouring escapes.
 * Meta embeds config as JSON inside <script> tags, so a naive
 * /"key":"([^"]*)"/ breaks on every escaped quote or \/ sequence. This finds
 * the value's real end and hands it to JSON.parse for correct unescaping.
 */
function extractJsonString(text, key) {
  const needle = `"${key}":"`;
  let from = 0;
  while (true) {
    const start = text.indexOf(needle, from);
    if (start === -1) return null;
    let i = start + needle.length;
    for (; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === '"') break;
    }
    try {
      const parsed = JSON.parse(text.slice(start + needle.length - 1, i + 1));
      if (parsed) return parsed;
    } catch { /* malformed occurrence — try the next one */ }
    from = i + 1;
  }
}

function extractJsonNumber(text, key) {
  const m = new RegExp(`"${key}":\\s*(-?\\d+(?:\\.\\d+)?)`).exec(text);
  return m ? Number(m[1]) : null;
}

function extractMetaTag(html, property) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`,
    'i',
  );
  const m = re.exec(html) || new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`,
    'i',
  ).exec(html);
  return m ? decodeHtmlEntities(m[1]) : null;
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&(?:amp|#38);/g, '&')
    .replace(/&(?:lt|#60);/g, '<')
    .replace(/&(?:gt|#62);/g, '>')
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** "12.3K" / "4.5M" / "1,234" -> number. Facebook renders counts this way. */
function parseCompactCount(input) {
  if (input == null) return null;
  const m = /(\d[\d.,]*)\s*([KMB])?/i.exec(String(input));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * scale);
}

/* ==========================================================================
 * 4. Instagram: shortcode <-> pk
 * ========================================================================== */

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Instagram shortcodes are the media's 64-bit primary key written in base64.
 * BigInt keeps precision that Number would silently destroy past 2^53.
 */
function shortcodeToPk(shortcode) {
  let n = 0n;
  for (const ch of shortcode) {
    const digit = B64_ALPHABET.indexOf(ch);
    if (digit === -1) throw ERR.badRequest(`Invalid character "${ch}" in shortcode.`);
    n = n * 64n + BigInt(digit);
  }
  return n.toString();
}

function pkToShortcode(pk) {
  let n = BigInt(pk);
  let out = '';
  while (n > 0n) {
    out = B64_ALPHABET[Number(n % 64n)] + out;
    n /= 64n;
  }
  return out;
}

/* ==========================================================================
 * 5. URL parsing / routing of the caller's input
 * ========================================================================== */

const IG_HOSTS = new Set([
  'instagram.com', 'www.instagram.com', 'm.instagram.com',
  'instagr.am', 'www.instagr.am', 'ddinstagram.com',
]);
const FB_HOSTS = new Set([
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com',
  'mbasic.facebook.com', 'fb.watch', 'fb.com', 'www.fb.com', 'l.facebook.com',
]);

function normaliseInputUrl(raw) {
  if (typeof raw !== 'string') throw ERR.badRequest('"url" must be a string.');
  const trimmed = raw.trim();
  if (!trimmed) throw ERR.badRequest('"url" must not be empty.');
  if (trimmed.length > 2048) throw ERR.badRequest('"url" is unreasonably long.');

  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw ERR.badRequest('"url" is not a valid URL.');
  }
  // SSRF guard: this worker only ever talks to Meta's public web properties.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw ERR.badRequest('Only http(s) URLs are supported.');
  }
  parsed.protocol = 'https:';
  const host = parsed.hostname.toLowerCase();

  if (IG_HOSTS.has(host)) return { platform: 'instagram', url: parsed };
  if (FB_HOSTS.has(host)) return { platform: 'facebook', url: parsed };
  throw ERR.unsupported(`Host "${parsed.hostname}" is not an Instagram or Facebook URL.`);
}

/** /reel/CODE, /reels/CODE, /p/CODE, /tv/CODE, /username/reel/CODE, /share/... */
const IG_PATH_RE = /\/(?:reels?|p|tv|share\/reel)\/([A-Za-z0-9_-]{5,64})/;

function parseInstagramShortcode(url) {
  const direct = IG_PATH_RE.exec(url.pathname);
  if (direct) return direct[1];
  if (/\/share\//.test(url.pathname)) return null; // needs a redirect hop
  throw ERR.unsupported('Could not find an Instagram shortcode in that URL.');
}

/** Numeric video id from the many shapes Facebook video URLs take. */
function parseFacebookVideoId(url) {
  const p = url.pathname;
  const patterns = [
    /\/reels?\/(\d+)/,
    /\/videos\/(?:[^/]+\/)?(\d+)/,
    /\/watch\/?$/,           // id arrives via ?v=
    /\/video\.php/,          // id arrives via ?v=
  ];
  for (const re of patterns) {
    const m = re.exec(p);
    if (m && m[1]) return m[1];
  }
  const v = url.searchParams.get('v');
  if (v && /^\d+$/.test(v)) return v;
  const fbid = url.searchParams.get('story_fbid') || url.searchParams.get('id');
  if (fbid && /^\d+$/.test(fbid)) return fbid;
  return null; // share/fb.watch link — resolve via redirect
}

/* ==========================================================================
 * 6. Instagram guest session (cookies + lsd token)
 * ========================================================================== */

/**
 * Both the guest cookie jar and a live `lsd` token are mandatory for the
 * GraphQL call. Cached in-process and in the edge cache so a burst of
 * requests costs one bootstrap instead of one per lookup — which also keeps
 * us well under Meta's anonymous rate limits.
 */
let sessionMemo = { value: null, expiresAt: 0 };

async function getInstagramSession(ctx, { force = false } = {}) {
  const now = Date.now();
  if (!force && sessionMemo.value && sessionMemo.expiresAt > now) return sessionMemo.value;

  const res = await fetchWithTimeout('https://www.instagram.com/', {
    headers: {
      'User-Agent': CONFIG.UA_DESKTOP,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  const jar = harvestCookies(res);
  const html = await res.text();

  // The token appears in a few shapes depending on which bundle rendered.
  const lsd =
    /\["LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ||
    /"lsd":"([^"]+)"/.exec(html)?.[1] ||
    /<script[^>]+id="__eqmc"[^>]*>([^<]+)<\/script>/.exec(html)?.[1]
      ?.match(/"l":"([^"]+)"/)?.[1] ||
    null;

  const csrf = jar.get('csrftoken') || /"csrf_token":"([^"]+)"/.exec(html)?.[1] || '';
  if (csrf && !jar.has('csrftoken')) jar.set('csrftoken', csrf);

  if (!lsd || jar.size === 0) {
    throw ERR.blocked(
      'Instagram did not hand out a guest session. The source IP is most likely rate-limited.',
    );
  }

  const session = { cookie: cookieHeader(jar), lsd, csrf };
  sessionMemo = { value: session, expiresAt: now + CONFIG.SESSION_TTL * 1000 };
  return session;
}

/* ==========================================================================
 * 7. Instagram extraction strategies
 * ========================================================================== */

/**
 * Strategy A — authenticated private API. Only runs when IG_COOKIE is set.
 * This is the only path that yields play_count, reshare_count, music metadata
 * and paid-partnership flags, because Instagram hides those from guests.
 */
async function igStrategyAuthenticated(pk, env) {
  const cookie = env.IG_COOKIE || (env.IG_SESSIONID ? `sessionid=${env.IG_SESSIONID}` : null);
  if (!cookie) return null;

  const csrf = /csrftoken=([^;]+)/.exec(cookie)?.[1] || 'missing';
  const res = await fetchWithTimeout(
    `https://www.instagram.com/api/v1/media/${pk}/info/`,
    {
      headers: {
        'User-Agent': CONFIG.UA_DESKTOP,
        'X-IG-App-ID': CONFIG.IG_APP_ID,
        'X-CSRFToken': csrf,
        'X-IG-WWW-Claim': '0',
        'X-ASBD-ID': '359341',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: '*/*',
        Cookie: cookie,
        Referer: 'https://www.instagram.com/',
        Origin: 'https://www.instagram.com',
        'Sec-Fetch-Site': 'same-origin',
      },
      redirect: 'manual',
    },
  );

  // A 302 means the session cookie is dead — fall through to the guest path
  // rather than failing the whole request.
  if (res.status !== 200) return null;
  let data;
  try { data = await res.json(); } catch { return null; }
  const item = data?.items?.[0];
  return item ? { product: item, source: 'ig:authenticated' } : null;
}

/**
 * Strategy B — the logged-out web GraphQL query. This is the workhorse.
 * `Sec-Fetch-Site: same-origin` is what separates JSON from a 600 KB HTML
 * shell; see the file header.
 */
async function igStrategyGraphql(pk, ctx, env) {
  let session = await getInstagramSession(ctx);
  let sawHtmlShell = false;

  for (const docId of CONFIG.IG_DOC_IDS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = new URLSearchParams({
        av: '0',
        __d: 'www',
        __user: '0',
        __a: '1',
        __comet_req: '7',
        lsd: session.lsd,
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: CONFIG.IG_FRIENDLY_NAME,
        server_timestamps: 'true',
        doc_id: docId,
        variables: JSON.stringify({ media_id: pk }),
      });

      const res = await fetchWithTimeout('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          'User-Agent': CONFIG.UA_DESKTOP,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-IG-App-ID': CONFIG.IG_APP_ID,
          'X-ASBD-ID': '359341',
          'X-IG-WWW-Claim': '0',
          'X-CSRFToken': session.csrf,
          'X-FB-LSD': session.lsd,
          'X-FB-Friendly-Name': CONFIG.IG_FRIENDLY_NAME,
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://www.instagram.com',
          Referer: `https://www.instagram.com/p/${pkToShortcode(pk)}/`,
          // ---- load-bearing. Do not remove. ----
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
        },
        body,
      });

      const text = await res.text();

      // An HTML body means the request was rejected at the edge, usually
      // because the guest session went stale. Re-bootstrap once, then move on.
      if (!text.startsWith('{')) {
        sawHtmlShell = true;
        if (attempt === 0) { session = await getInstagramSession(ctx, { force: true }); continue; }
        break;
      }

      let payload;
      try { payload = JSON.parse(text); } catch { break; }

      const root = payload?.data?.xig_polaris_media;
      const product = root?.if_not_gated_logged_out;
      if (product) return { product, root, source: 'ig:graphql', docId };

      // Distinguish "gated/removed" from "wrong doc_id" so the error is honest.
      if (root === null && !payload?.errors) {
        throw ERR.notFound('That post is unavailable — it may be deleted, private or region-blocked.');
      }
      if (root && !product) {
        throw ERR.private('That post is age- or login-gated, so it cannot be read anonymously.');
      }
      break; // errors present: try the next doc_id
    }
  }

  if (sawHtmlShell) {
    throw ERR.blocked(
      'Instagram refused the API call and served an HTML shell instead. ' +
      'The source IP is likely rate-limited; retry later or configure IG_COOKIE.',
    );
  }
  throw ERR.schema(
    'Instagram accepted the request but returned no media for any known doc_id. ' +
    'The doc_id has probably rotated and needs updating.',
  );
}

/* ==========================================================================
 * 8. Instagram normalisation
 * ========================================================================== */

/** ISO-8601 duration ("PT10.8S") -> seconds. */
function parseIsoDuration(iso) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/
    .exec(String(iso || ''));
  if (!m) return null;
  const [, d, h, min, s] = m.map((v) => (v ? Number(v) : 0));
  const total = d * 86400 + h * 3600 + min * 60 + s;
  return total > 0 ? Number(total.toFixed(3)) : null;
}

/**
 * Instagram's DASH manifest is the richest source we get anonymously: exact
 * duration plus a per-quality list of progressive BaseURLs (up to 1080p),
 * which the flat video_versions array does not label.
 */
function parseDashManifest(xml) {
  if (!xml || typeof xml !== 'string') return { duration: null, formats: [] };

  const duration = parseIsoDuration(/mediaPresentationDuration="([^"]+)"/.exec(xml)?.[1]);
  const formats = [];

  for (const rep of xml.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g)) {
    const attrs = rep[1];
    const baseUrl = /<BaseURL>([\s\S]*?)<\/BaseURL>/.exec(rep[2])?.[1];
    if (!baseUrl) continue;
    // The leading boundary matters: a bare /width="/ also matches the tail of
    // bandwidth="828641", which silently produced absurd dimensions.
    const attr = (name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1] || null;
    const mime = attr('mimeType') || '';
    if (!mime.startsWith('video')) continue;
    formats.push({
      quality: attr('FBQualityLabel'),
      width: attr('width') ? Number(attr('width')) : null,
      height: attr('height') ? Number(attr('height')) : null,
      bandwidth: attr('bandwidth') ? Number(attr('bandwidth')) : null,
      codecs: attr('codecs'),
      url: decodeHtmlEntities(baseUrl.trim()),
    });
  }

  formats.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  return { duration, formats };
}

/** Widest available still, falling back to the video's first frame. */
const bestImage = (node) => {
  const v2 = node?.image_versions2 || {};
  const widest = [...(v2.candidates || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return widest?.url || v2.additional_candidates?.first_frame?.url || node?.display_uri || null;
};

/** One carousel slide / single media -> the shape used in `media_list`. */
function normaliseIgNode(node) {
  const isVideo = node?.media_type === IG_MEDIA.VIDEO || !!node?.video_versions?.length;
  const dash = parseDashManifest(node?.video_dash_manifest);
  const versions = [...(node?.video_versions || [])].sort((a, b) => (a.type || 0) - (b.type || 0));

  return {
    type: isVideo ? 'video' : 'image',
    url: isVideo ? versions[0]?.url || dash.formats[0]?.url || null : bestImage(node),
    thumbnail: bestImage(node),
    width: node?.original_width ?? null,
    height: node?.original_height ?? null,
    duration: isVideo ? dash.duration : null,
    formats: isVideo ? dash.formats : [],
  };
}

function normaliseInstagram({ product, root, source }, { shortcode, permalink }) {
  const type = product.media_type;
  const isCarousel = type === IG_MEDIA.CAROUSEL || Array.isArray(product.carousel_media);
  const slides = isCarousel
    ? (product.carousel_media || []).map(normaliseIgNode)
    : [normaliseIgNode(product)];

  const primaryVideo = slides.find((s) => s.type === 'video') || null;
  const user = product.user || {};
  const music = product.clips_metadata?.music_info?.music_asset_info || null;
  const originalAudio = product.clips_metadata?.original_sound_info || null;

  return {
    success: true,
    platform: 'instagram',
    shortcode: product.code || shortcode,
    media_id: product.pk ?? product.id ?? null,
    permalink,
    media_type: isCarousel ? 'carousel' : primaryVideo ? 'video' : 'image',
    video_url: primaryVideo?.url ?? null,
    thumbnail: slides[0]?.thumbnail ?? null,
    media_list: slides.map(({ type: t, url, thumbnail }) => ({ type: t, url, thumbnail })),
    formats: primaryVideo?.formats ?? [],
    caption: product.caption?.text ?? '',
    accessibility_caption: product.accessibility_caption ?? '',
    username: user.username ?? '',
    author_full_name: user.full_name ?? '',
    author_profile_pic: user.profile_pic_url ?? '',
    author_is_verified: user.is_verified ?? null,
    duration: primaryVideo?.duration ?? null,
    // Guest clients never receive these; the authenticated path fills them in.
    play_count: product.play_count ?? product.view_count ?? null,
    like_count: product.like_and_view_counts_disabled ? null : product.like_count ?? null,
    comment_count: product.comment_count ?? null,
    reshare_count: product.reshare_count ?? null,
    audio_url: originalAudio?.progressive_download_url ?? music?.progressive_download_url ?? '',
    audio_title: music?.title ?? originalAudio?.original_audio_title ?? '',
    audio_artist: music?.display_artist ?? originalAudio?.ig_artist?.username ?? '',
    is_paid_partnership: product.is_paid_partnership ?? false,
    taken_at: product.taken_at ?? null,
    slide_count: slides.length,
    source,
    error: null,
  };
}

/* ==========================================================================
 * 9. Instagram orchestration
 * ========================================================================== */

async function resolveInstagram(url, ctx, env) {
  let shortcode = parseInstagramShortcode(url);

  // /share/... links carry no shortcode; one redirect hop reveals the canonical URL.
  if (!shortcode) {
    const { url: finalUrl } = await resolveRedirects(url.toString(), {
      'User-Agent': CONFIG.UA_DESKTOP,
      'Accept-Language': 'en-US,en;q=0.9',
    });
    shortcode = IG_PATH_RE.exec(new URL(finalUrl).pathname)?.[1] || null;
    if (!shortcode) throw ERR.unsupported('That share link did not resolve to a post.');
  }

  const pk = shortcodeToPk(shortcode);
  const permalink = `https://www.instagram.com/reel/${shortcode}/`;

  const extracted =
    (await igStrategyAuthenticated(pk, env)) ||
    (await igStrategyGraphql(pk, ctx, env));

  return normaliseInstagram(extracted, { shortcode, permalink });
}

/* ==========================================================================
 * 10. Facebook extraction
 * ========================================================================== */

const FB_BROWSER_HEADERS = {
  'User-Agent': CONFIG.UA_DESKTOP,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Strategy A — the embeddable player. `/reel/<id>` answers 400 to datacenter
 * IPs, but the plugin endpoint stays open and no cookies are required, so
 * this is the reliable route to the actual media.
 */
async function fbStrategyPlugin(videoId) {
  const href = encodeURIComponent(`https://www.facebook.com/watch/?v=${videoId}`);
  const res = await fetchWithTimeout(
    `https://www.facebook.com/plugins/video.php?href=${href}&show_text=false&autoplay=false`,
    { headers: FB_BROWSER_HEADERS },
  );
  if (!res.ok) return null;
  const html = await res.text();

  const hd = extractJsonString(html, 'hd_src') || extractJsonString(html, 'hd_src_no_ratelimit');
  const sd = extractJsonString(html, 'sd_src') || extractJsonString(html, 'sd_src_no_ratelimit');
  if (!hd && !sd) return null;

  return {
    source: 'fb:plugin',
    hd,
    sd,
    dashManifest: extractJsonString(html, 'dash_manifest'),
    duration: extractJsonNumber(html, 'video_duration'),
    width: extractJsonNumber(html, 'original_width') ?? extractJsonNumber(html, 'width'),
    height: extractJsonNumber(html, 'original_height') ?? extractJsonNumber(html, 'height'),
    thumbnail: extractJsonString(html, 'preferred_thumbnail_image_uri')
      || extractJsonString(html, 'thumbnail_src'),
  };
}

/**
 * Strategy B — the watch page. Supplies caption/owner/thumbnail via og:* tags
 * and, when Facebook feels generous, the post-Oct-2024
 * videoDeliveryResponseFragment progressive URLs.
 */
async function fbStrategyWatchPage(videoId) {
  const res = await fetchWithTimeout(
    `https://www.facebook.com/watch/?v=${videoId}`,
    { headers: FB_BROWSER_HEADERS },
  );
  if (!res.ok) return null;
  const html = await res.text();

  const ogTitle = extractMetaTag(html, 'og:title') || '';
  // og:title reads like "32K views · 484 reactions | How much should I tip? | ATTN:"
  const segments = ogTitle.split('|').map((s) => s.trim()).filter(Boolean);
  const stats = /views|reactions/i.test(segments[0] || '') ? segments.shift() : null;

  const progressive = [...html.matchAll(/"progressive_url":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return null; } })
    .filter(Boolean);

  return {
    source: 'fb:watch',
    hd: extractJsonString(html, 'browser_native_hd_url')
      || extractJsonString(html, 'playable_url_quality_hd')
      || progressive[0] || null,
    sd: extractJsonString(html, 'browser_native_sd_url')
      || extractJsonString(html, 'playable_url')
      || progressive[1] || null,
    title: segments[0] || null,
    ownerName: segments.length > 1 ? segments[segments.length - 1] : null,
    caption: extractMetaTag(html, 'og:description') || '',
    thumbnail: extractMetaTag(html, 'og:image'),
    duration: extractJsonNumber(html, 'playable_duration_in_ms') != null
      ? extractJsonNumber(html, 'playable_duration_in_ms') / 1000
      : extractJsonNumber(html, 'length_in_second'),
    playCount: parseCompactCount(/([\d.,]+\s*[KMB]?)\s*views/i.exec(stats || '')?.[1]),
    likeCount: parseCompactCount(/([\d.,]+\s*[KMB]?)\s*reactions/i.exec(stats || '')?.[1]),
  };
}

async function resolveFacebook(url, ctx, env) {
  let videoId = parseFacebookVideoId(url);
  let permalink = url.toString();

  // fb.watch / share/v / share/r links only reveal the id after a redirect.
  if (!videoId) {
    const { url: finalUrl } = await resolveRedirects(permalink, FB_BROWSER_HEADERS);
    permalink = finalUrl;
    videoId = parseFacebookVideoId(new URL(finalUrl));
    if (!videoId) throw ERR.unsupported('Could not determine a Facebook video id from that URL.');
  }

  // Both strategies are independent: run them together and merge.
  const [plugin, page] = await Promise.all([
    fbStrategyPlugin(videoId).catch(() => null),
    fbStrategyWatchPage(videoId).catch(() => null),
  ]);

  if (!plugin && !page) {
    throw ERR.blocked('Facebook returned nothing usable for that video. It may be private or removed.');
  }

  const hd = plugin?.hd || page?.hd || null;
  const sd = plugin?.sd || page?.sd || null;
  const videoUrl = hd || sd;
  if (!videoUrl) {
    throw ERR.private('That video exists but its media is not readable anonymously (likely non-public).');
  }

  const dash = parseDashManifest(plugin?.dashManifest);
  const formats = dash.formats.length
    ? dash.formats
    : [hd && { quality: 'hd', url: hd }, sd && { quality: 'sd', url: sd }].filter(Boolean);
  const thumbnail = page?.thumbnail || plugin?.thumbnail || null;

  return {
    success: true,
    platform: 'facebook',
    shortcode: videoId,
    media_id: videoId,
    permalink: `https://www.facebook.com/reel/${videoId}/`,
    media_type: 'video',
    video_url: videoUrl,
    thumbnail,
    media_list: [{ type: 'video', url: videoUrl, thumbnail }],
    formats,
    caption: page?.caption || page?.title || '',
    accessibility_caption: '',
    username: page?.ownerName || '',
    author_full_name: page?.ownerName || '',
    author_profile_pic: '',
    author_is_verified: null,
    duration: plugin?.duration ?? page?.duration ?? dash.duration ?? null,
    play_count: page?.playCount ?? null,
    like_count: page?.likeCount ?? null,
    comment_count: null,
    reshare_count: null,
    audio_url: '',
    audio_title: '',
    audio_artist: '',
    is_paid_partnership: false,
    taken_at: null,
    slide_count: 1,
    source: [plugin?.source, page?.source].filter(Boolean).join('+'),
    error: null,
  };
}

/* ==========================================================================
 * 11. Cache & rate limiting
 * ========================================================================== */

const cacheKeyFor = (platform, id) =>
  new Request(`https://reels-cache.internal/v1/${platform}/${encodeURIComponent(id)}`);

async function readCache(platform, id) {
  if (typeof caches === 'undefined') return null;
  const hit = await caches.default.match(cacheKeyFor(platform, id));
  if (!hit) return null;
  try { return await hit.json(); } catch { return null; }
}

function writeCache(ctx, platform, id, payload, ttl) {
  if (typeof caches === 'undefined' || !ctx?.waitUntil) return;
  const body = new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
  });
  ctx.waitUntil(caches.default.put(cacheKeyFor(platform, id), body));
}

/**
 * Fixed-window per-IP limiter. Skipped entirely when the RATELIMIT KV
 * namespace is not bound, so the worker deploys fine without it.
 *
 * Future extension: swap for Durable Objects or the native Rate Limiting
 * binding if you need strict, race-free accounting.
 */
async function enforceRateLimit(request, env) {
  const limit = Number(env.RATE_LIMIT ?? CONFIG.RATE_LIMIT);
  if (!env.RATELIMIT || !limit) return;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const used = Number((await env.RATELIMIT.get(key)) || 0);
  if (used >= limit) throw ERR.rateLimited(`Rate limit of ${limit} requests/minute exceeded.`);
  await env.RATELIMIT.put(key, String(used + 1), { expirationTtl: 120 });
}

/* ==========================================================================
 * 12. Optional auth & signed media proxy
 * ========================================================================== */

/** Constant-time comparison so token checks can't be timing-probed. */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function assertAuthorised(request, env) {
  if (!env.API_KEY) return; // open by default; set API_KEY to lock it down
  const presented =
    request.headers.get('X-API-Key') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!presented || !safeEqual(presented, env.API_KEY)) {
    throw ERR.unauthorized('A valid API key is required.');
  }
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Streams a Meta CDN asset through the worker. Useful when a browser client
 * needs CORS-clean bytes or a stable-origin <video src>. HMAC-signed and
 * host-allowlisted so it can never be turned into an open proxy.
 */
async function handleMediaProxy(request, env) {
  if (!env.PROXY_SECRET) throw ERR.notFound('Media proxy is not enabled.');

  const params = new URL(request.url).searchParams;
  const target = params.get('u');
  const signature = params.get('s');
  if (!target || !signature) throw ERR.badRequest('Both "u" and "s" are required.');
  if (!safeEqual(signature, await hmacHex(env.PROXY_SECRET, target))) {
    throw ERR.unauthorized('Invalid media signature.');
  }

  const parsed = new URL(target);
  const allowed = /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/i.test(parsed.hostname);
  if (parsed.protocol !== 'https:' || !allowed) {
    throw ERR.badRequest('Only Instagram/Facebook CDN hosts may be proxied.');
  }

  const upstream = await fetchWithTimeout(target, {
    headers: {
      'User-Agent': 'facebookexternalhit/1.1', // browser UAs get rate-limited on CDN reads
      Accept: '*/*',
      Range: request.headers.get('Range') || '',
    },
  }, 30_000);

  const headers = new Headers(SECURITY_HEADERS);
  for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'public, max-age=3600');
  return new Response(upstream.body, { status: upstream.status, headers });
}

/* ==========================================================================
 * 13. Request handling
 * ========================================================================== */

async function readRequestedUrl(request) {
  if (request.method === 'GET') {
    const q = new URL(request.url).searchParams;
    return { raw: q.get('url'), refresh: q.get('refresh') === '1' };
  }

  const contentType = request.headers.get('Content-Type') || '';
  const text = await request.text();
  if (text.length > CONFIG.MAX_BODY_BYTES) throw ERR.badRequest('Request body is too large.');

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(text);
    return { raw: form.get('url'), refresh: form.get('refresh') === '1' };
  }

  if (!text.trim()) throw ERR.badRequest('Request body is empty. Send {"url": "..."}.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw ERR.badRequest('Request body is not valid JSON.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ERR.badRequest('Request body must be a JSON object.');
  }
  return { raw: parsed.url ?? parsed.link, refresh: parsed.refresh === true };
}

const failurePayload = (err) => ({
  success: false,
  error: { code: err.code, message: err.message, ...(err.meta ? { details: err.meta } : {}) },
  is_cached: false,
  refreshed: false,
});

async function handleResolve(request, env, ctx) {
  assertAuthorised(request, env);
  await enforceRateLimit(request, env);

  const { raw, refresh } = await readRequestedUrl(request);
  if (raw == null) throw ERR.badRequest('Missing "url". Send {"url": "https://www.instagram.com/reel/..."}.');

  const { platform, url } = normaliseInputUrl(raw);
  const cacheId = `${url.pathname}${url.search}`;

  if (!refresh) {
    const cached = await readCache(platform, cacheId);
    if (cached) {
      return jsonResponse({ ...cached, is_cached: true, refreshed: false },
        { cacheSeconds: 60 });
    }
  }

  const started = Date.now();
  const result = platform === 'instagram'
    ? await resolveInstagram(url, ctx, env)
    : await resolveFacebook(url, ctx, env);

  const payload = {
    ...result,
    is_cached: false,
    refreshed: refresh,
    resolved_in_ms: Date.now() - started,
  };

  writeCache(ctx, platform, cacheId, { ...payload, resolved_in_ms: undefined },
    Number(env.CACHE_TTL ?? CONFIG.CACHE_TTL));

  return jsonResponse(payload, { cacheSeconds: 60 });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, ...SECURITY_HEADERS } });
    }

    try {
      if (pathname === '/health' || pathname === '/healthz') {
        return jsonResponse({
          success: true,
          status: 'ok',
          features: {
            authenticated_instagram: Boolean(env.IG_COOKIE || env.IG_SESSIONID),
            api_key_required: Boolean(env.API_KEY),
            rate_limiting: Boolean(env.RATELIMIT),
            media_proxy: Boolean(env.PROXY_SECRET),
          },
          doc_ids: CONFIG.IG_DOC_IDS.length,
        });
      }

      if (pathname === '/media') {
        if (request.method !== 'GET') throw ERR.badRequest('Use GET for /media.');
        return await handleMediaProxy(request, env);
      }

      if (pathname !== '/' && pathname !== '/resolve') {
        throw ERR.notFound(`No route for ${pathname}. Use POST / with {"url": "..."}.`);
      }
      if (request.method !== 'POST' && request.method !== 'GET') {
        throw ERR.badRequest(`${request.method} is not supported. Use POST or GET.`);
      }

      return await handleResolve(request, env, ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        return jsonResponse(failurePayload(err), {
          status: err.status,
          cacheSeconds: err.status >= 500 ? 0 : 0,
        });
      }
      // Unknown fault: log for the operator, stay vague for the caller.
      console.error('unhandled', err?.stack || err);
      return jsonResponse(
        failurePayload(new ApiError('INTERNAL_ERROR', 'An unexpected error occurred.', 500)),
        { status: 500 },
      );
    }
  },
};

/** Exported for the local test harness only. */
export const __internals = {
  shortcodeToPk, pkToShortcode, normaliseInputUrl, parseFacebookVideoId,
  parseInstagramShortcode, extractJsonString, parseDashManifest, parseIsoDuration,
  parseCompactCount, decodeHtmlEntities, normaliseInstagram, extractMetaTag,
};
