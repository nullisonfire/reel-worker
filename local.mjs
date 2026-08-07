/**
 * Local harness: runs the Worker module under Node against the real upstreams.
 * `caches` is intentionally absent so the worker's cache guards are exercised.
 *
 *   node test/local.mjs            # unit checks + live lookups
 *   node test/local.mjs --unit     # unit checks only (no network)
 */
import worker, { __internals as U } from '../src/worker.js';

const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); } };
const env = {};

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`);
  ok ? passed++ : failed++;
}

function assert(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail}`}`);
  condition ? passed++ : failed++;
}

/* ------------------------------- unit ---------------------------------- */

console.log('\n=== pure functions ===');
check('shortcode -> pk', U.shortcodeToPk('Dbup0HNT0lJ'), '3958285023564482889');
check('pk -> shortcode', U.pkToShortcode('3958285023564482889'), 'Dbup0HNT0lJ');
check('round-trip long code', U.pkToShortcode(U.shortcodeToPk('DWO51c8kfFH')), 'DWO51c8kfFH');

check('ig /reel/', U.parseInstagramShortcode(new URL('https://www.instagram.com/reel/Dbup0HNT0lJ/')), 'Dbup0HNT0lJ');
check('ig /p/', U.parseInstagramShortcode(new URL('https://instagram.com/p/DWO51c8kfFH/?igsh=x')), 'DWO51c8kfFH');
check('ig /tv/', U.parseInstagramShortcode(new URL('https://www.instagram.com/tv/ABCDEfghij/')), 'ABCDEfghij');
check('ig user reel', U.parseInstagramShortcode(new URL('https://www.instagram.com/someuser/reel/Dbup0HNT0lJ/')), 'Dbup0HNT0lJ');
check('ig /reels/', U.parseInstagramShortcode(new URL('https://www.instagram.com/reels/Dbup0HNT0lJ/')), 'Dbup0HNT0lJ');

check('fb /reel/', U.parseFacebookVideoId(new URL('https://www.facebook.com/reel/719954752560559/')), '719954752560559');
check('fb /watch?v=', U.parseFacebookVideoId(new URL('https://www.facebook.com/watch/?v=719954752560559')), '719954752560559');
check('fb /videos/', U.parseFacebookVideoId(new URL('https://www.facebook.com/page/videos/719954752560559/')), '719954752560559');
check('fb share link', U.parseFacebookVideoId(new URL('https://www.facebook.com/share/v/abc123/')), null);

check('platform ig', U.normaliseInputUrl('instagram.com/reel/X/').platform, 'instagram');
check('platform fb', U.normaliseInputUrl('https://fb.watch/abc/').platform, 'facebook');
assert('rejects foreign host', (() => {
  try { U.normaliseInputUrl('https://evil.example.com/reel/x/'); return false; } catch { return true; }
})());
assert('rejects internal host (SSRF)', (() => {
  try { U.normaliseInputUrl('http://169.254.169.254/latest/meta-data/'); return false; } catch { return true; }
})());

check('escaped json string', U.extractJsonString('x{"hd_src":"https:\\/\\/a.b\\/c?d=1&e=\\u00e9"}', 'hd_src'), 'https://a.b/c?d=1&e=é');
check('json string with escaped quote', U.extractJsonString('{"t":"a\\"b"}', 't'), 'a"b');
check('missing key', U.extractJsonString('{"a":"b"}', 'zz'), null);
check('iso duration', U.parseIsoDuration('PT10.8S'), 10.8);
check('iso duration h/m/s', U.parseIsoDuration('PT1H2M3S'), 3723);
check('compact count K', U.parseCompactCount('32K views'), 32000);
check('compact count plain', U.parseCompactCount('1,234'), 1234);
check('meta tag', U.extractMetaTag('<meta property="og:title" content="a &amp; b" />', 'og:title'), 'a & b');

const dash = `<MPD mediaPresentationDuration="PT10.8S">
<Representation mimeType="video/mp4" width="1080" height="1920" bandwidth="2000" codecs="avc1" FBQualityLabel="1080p"><BaseURL>https://cdn/1080.mp4</BaseURL></Representation>
<Representation mimeType="video/mp4" width="480" height="854" bandwidth="500" FBQualityLabel="480p"><BaseURL>https://cdn/480.mp4</BaseURL></Representation>
<Representation mimeType="audio/mp4" bandwidth="128"><BaseURL>https://cdn/a.mp4</BaseURL></Representation></MPD>`;
const parsedDash = U.parseDashManifest(dash);
check('dash duration', parsedDash.duration, 10.8);
check('dash drops audio + sorts desc', parsedDash.formats.map((f) => f.quality), ['1080p', '480p']);

/* ------------------------------ live ----------------------------------- */

const call = (body, method = 'POST') => worker.fetch(
  new Request('https://w.dev/', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }),
  env, ctx,
);

async function liveCase(label, url, expect = {}) {
  const res = await call({ url });
  const data = await res.json();
  if (!data.success) {
    console.log(`FAIL  ${label}  -> ${res.status} ${data.error?.code}: ${data.error?.message}`);
    failed++;
    return null;
  }
  const problems = [];
  for (const [k, v] of Object.entries(expect)) {
    if (typeof v === 'function' ? !v(data[k]) : data[k] !== v) {
      problems.push(`${k}=${JSON.stringify(data[k])}`);
    }
  }
  assert(`${label}  [${data.source}]`, problems.length === 0, problems.join(' '));
  console.log(
    `        type=${data.media_type} slides=${data.slide_count} dur=${data.duration}` +
    ` likes=${data.like_count} comments=${data.comment_count} formats=${data.formats.length}` +
    ` user=@${data.username} in ${data.resolved_in_ms}ms`,
  );
  console.log(`        video_url=${(data.video_url || '(none)').slice(0, 96)}…`);
  return data;
}

async function errorCase(label, body, expectedCode, method = 'POST') {
  const res = await call(body, method);
  const data = await res.json();
  assert(`${label} -> ${expectedCode}`,
    data.success === false && data.error.code === expectedCode,
    JSON.stringify(data.error || data).slice(0, 140));
}

if (!process.argv.includes('--unit')) {
  console.log('\n=== error handling ===');
  await errorCase('empty body', undefined, 'BAD_REQUEST');
  await errorCase('missing url', {}, 'BAD_REQUEST');
  await errorCase('non-string url', { url: 42 }, 'BAD_REQUEST');
  await errorCase('unsupported host', { url: 'https://tiktok.com/x' }, 'UNSUPPORTED_URL');
  await errorCase('ig url with no code', { url: 'https://www.instagram.com/explore/' }, 'UNSUPPORTED_URL');
  await errorCase('deleted post', { url: 'https://www.instagram.com/p/Bt4ChNyCzGH/' }, 'MEDIA_NOT_FOUND');

  const health = await (await worker.fetch(new Request('https://w.dev/health'), env, ctx)).json();
  assert('health endpoint', health.status === 'ok', JSON.stringify(health));
  const notFound = await worker.fetch(new Request('https://w.dev/nope'), env, ctx);
  assert('unknown route 404', notFound.status === 404);
  const options = await worker.fetch(new Request('https://w.dev/', { method: 'OPTIONS' }), env, ctx);
  assert('CORS preflight 204', options.status === 204
    && options.headers.get('Access-Control-Allow-Origin') === '*');

  console.log('\n=== live: instagram ===');
  await liveCase('reel (video)', 'https://www.instagram.com/reel/Dbup0HNT0lJ/', {
    media_type: 'video',
    shortcode: 'Dbup0HNT0lJ',
    username: 'outlineofbangladesh',
    video_url: (v) => typeof v === 'string' && v.startsWith('https://'),
    duration: (d) => typeof d === 'number' && d > 0,
    thumbnail: (t) => typeof t === 'string' && t.startsWith('https://'),
    caption: (c) => typeof c === 'string' && c.length > 20,
    author_full_name: (n) => !!n,
    formats: (f) => Array.isArray(f) && f.length >= 2,
  });
  await liveCase('carousel (3 slides)', 'https://www.instagram.com/p/DWO51c8kfFH/', {
    media_type: 'carousel',
    slide_count: 3,
    media_list: (l) => l.length === 3 && l.every((i) => i.url?.startsWith('https://')),
  });
  await liveCase('carousel (14 slides)', 'https://www.instagram.com/p/DMyBXyOvBN6/', {
    media_type: 'carousel',
    slide_count: 14,
  });
  await liveCase('reel via bare host + query', 'instagram.com/reel/DNi2wnaMcm6/?igsh=abc', {
    media_type: 'video',
    shortcode: 'DNi2wnaMcm6',
  });
  await liveCase('GET query-string form',
    'https://www.instagram.com/reel/Dbup0HNT0lJ/', { media_type: 'video' });

  console.log('\n=== live: facebook ===');
  await liveCase('fb reel', 'https://www.facebook.com/reel/719954752560559/', {
    media_type: 'video',
    platform: 'facebook',
    video_url: (v) => typeof v === 'string' && v.includes('fbcdn.net'),
  });
  await liveCase('fb watch url', 'https://www.facebook.com/watch/?v=1483279718781217', {
    platform: 'facebook',
    video_url: (v) => typeof v === 'string' && v.includes('fbcdn.net'),
  });

  console.log('\n=== GET form ===');
  const getRes = await worker.fetch(
    new Request('https://w.dev/?url=' + encodeURIComponent('https://www.instagram.com/reel/Dbup0HNT0lJ/')),
    env, ctx,
  );
  const getData = await getRes.json();
  assert('GET ?url= works', getData.success === true && getData.media_type === 'video',
    JSON.stringify(getData.error || '').slice(0, 120));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
