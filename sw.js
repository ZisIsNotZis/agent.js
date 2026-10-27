// The shell, so that reopening the icon with no network still shows the tree.
//
// Each entry is installed on its own. A single stalled or failed fetch loses
// that entry for this load, never the whole shell — the install still succeeds
// and the person still gets a controlling service worker.
//
// What did not arrive is reported by name: the page asks for a `shell-status`
// message and the worker answers from Cache Storage itself. The shell list has
// one home (this file); a page-run `caches.match` probe would need the list
// copied into the page, and the copy is exactly the duplicate that goes stale.
//
// A missing entry is retried once per load — on activate, and on the first cache
// miss of a load — so a returning person gets the gap filled without waiting for
// a release. The retry is bounded: one pass at a time, at most one pass per load,
// and every entry's fetch is aborted after ENTRY_TIMEOUT_MS so a dead origin
// cannot hold the install or the retry open.
//
// Bump CACHE whenever SHELL changes: the manifest is the cache's contents, and
// an old cache must never be read as a complete new shell.
const CACHE = 'agentjs-shell-v7';
const ENTRY_TIMEOUT_MS = 5000;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/app.js',
  './src/state.js',
  './src/log.js',
  './src/run.js',
  './src/fs.js',
  './src/tools.js',
  './src/exec.js',
  './src/worker.js',
  './src/transfer.js',
  './src/loop.js',
  './src/provider.js',
  './src/trace.js',
  './vendor/isomorphic-git.min.js',
  './vendor/buffer.min.js',
  './icon-192.png',
  './icon-512.png',
];

// One entry, bounded end to end: a connection that never answers and a body
// that never finishes both end at ENTRY_TIMEOUT_MS, not at the origin's leisure.
async function fetchEntry(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ENTRY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    // Read the body under the same abort, then rebuild the response: the body,
    // not just the headers, is what a stalled origin withholds.
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } finally {
    clearTimeout(timer);
  }
}

// Each entry settles on its own; the result is the cache, not this array.
async function fill(entries) {
  const cache = await caches.open(CACHE);
  return Promise.allSettled(entries.map(async (url) => {
    await cache.put(url, await fetchEntry(url));
    return url;
  }));
}

async function missing() {
  const cache = await caches.open(CACHE);
  const hits = await Promise.all(SHELL.map((url) => cache.match(url)));
  return SHELL.filter((_, i) => !hits[i]);
}

// A load is a navigation (or the activation that follows one). `loadId` counts
// loads, `retriedFor` remembers which load has already spent its one retry, so a
// page that keeps missing the same URL cannot keep hitting a dead origin.
let loadId = 0;
let retriedFor = -1;

// One retry pass at a time, however many cache misses ask for it.
let fillPass = Promise.resolve();
let filling = false;

function retryMissingOnce() {
  if (filling) return fillPass;
  filling = true;
  fillPass = (async () => {
    try {
      const miss = await missing();
      if (miss.length) await fill(miss);
    } finally {
      filling = false;
    }
  })();
  return fillPass;
}

function retryForThisLoad() {
  if (retriedFor === loadId) return Promise.resolve();
  retriedFor = loadId;
  return retryMissingOnce();
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await fill(SHELL); // allSettled — a failed entry never fails the install
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Start the retry pass before claiming, so a `shell-status` message that
    // arrives the instant the worker is active waits for the attempt instead
    // of answering mid-attempt — then claim, because `ready` can resolve as
    // soon as this event starts and a load that checks `controller` must not
    // read as COLD while cache maintenance is still in front of claim().
    retriedFor = loadId; // activation's retry is this load's one attempt
    const pass = retryMissingOnce();
    await self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await pass;
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') loadId += 1;
  e.respondWith(respond(req));
});

async function respond(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  // A miss is the moment a hole in the shell can be repaired, once this load.
  await retryForThisLoad();
  const repaired = await caches.match(req);
  if (repaired) return repaired;
  const res = await fetch(req);
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  return res;
}

// The page's question: which shell entries are not in the cache right now.
// Answering waits for any retry already in flight, and it is the per-load
// signal that lets an entry the page never requests (an icon, say) take its
// once-per-load retry — the report after it is the state a person would read.
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'shell-status') return;
  const port = e.ports && e.ports[0];
  const reply = (async () => {
    await fillPass;
    if (retriedFor !== loadId) {
      retriedFor = loadId;
      await retryMissingOnce();
    }
    const miss = await missing();
    return { type: 'shell-status', total: SHELL.length, missing: miss };
  })();
  if (port) reply.then((d) => port.postMessage(d));
  else if (e.source) reply.then((d) => e.source.postMessage(d));
});
