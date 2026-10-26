// The shell's install resilience, run rather than asserted:
//   1. one shell entry is refused on the first load (a 503 from the network for
//      every service-worker fetch of that entry); the install must still finish,
//      the service worker must be active and controlling, everything that did
//      arrive must be in the cache, and the screen must name the entry that did
//      not — by name, not as a boolean.
//   2. stop refusing it and reload once: the next load's first cache miss retries
//      the missing entry, so the cache is complete and the screen says so. No
//      release, no cache-version bump.
//   3. kill the network and reload: the shell comes from the cache and the tree
//      from OPFS — the promise this fix exists for.
//   4. with the shell complete, a normal load reaches the network zero times:
//      the repair costs nothing on the happy path. The count is printed.
//
// Run: node tools/serve.mjs &   then   node tools/probe-m5.mjs
// The server must already be on PORT (default 8137).
//
// Playwright is found, not hard-coded, exactly as in probe-m1/m3/m4: bare
// `playwright-core`, or PLAYWRIGHT_CORE pointing at an install; CHROME_PATH
// overrides the executable.
//
// Why the block is on `request.serviceWorker()` only: the page's own first load
// is uncontrolled and imports src/transfer.js from the network; refusing that
// too would break the page rather than the install. Refusing it exactly where
// the service worker asks is the defect reproduction: that is the request whose
// one stalled or 503'd answer used to fail addAll() and lose the whole shell.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function playwrightSpecifier() {
  const p = process.env.PLAYWRIGHT_CORE;
  if (!p) return 'playwright-core';
  if (p.startsWith('/') || p.startsWith('.')) {
    return pathToFileURL(p.endsWith('.js') ? p : join(p, 'index.js')).href;
  }
  return p;
}

let chromium;
try {
  const mod = await import(playwrightSpecifier());
  chromium = (mod.default ?? mod).chromium;
} catch (e) {
  console.error(`playwright-core was not found (${e.code || e.name}); set PLAYWRIGHT_CORE to an install`);
  process.exit(2);
}

const EXE = process.env.CHROME_PATH || undefined;
const URL_ = process.env.URL || 'http://127.0.0.1:8137/';

// The shell list as a reader sees it in sw.js. The probe keeps its own copy on
// purpose: an acceptance oracle that asks the code under test what to expect
// cannot catch the code under test losing an entry.
const CACHE = 'agentjs-shell-v5';
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
  './src/transfer.js',
  './vendor/isomorphic-git.min.js',
  './vendor/buffer.min.js',
  './icon-192.png',
  './icon-512.png',
];
const BLOCKED = './src/transfer.js';
const pathOf = (rel) => new URL(rel, URL_).pathname;

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'agentjs-m5-'));
let ctx = null;
let blocking = true;
let netHits = 0;
let blockHits = 0;

async function launch() {
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: EXE,
    headless: true,
  });
  // Every request that reaches the network passes here; requests the service
  // worker answers from Cache Storage do not. That makes `netHits` the number
  // check 4 reports, and it makes the block below land on the worker's fetches.
  await context.route('**/*', async (route) => {
    const req = route.request();
    netHits += 1;
    if (blocking && req.serviceWorker() && new URL(req.url()).pathname === pathOf(BLOCKED)) {
      blockHits += 1;
      return route.fulfill({ status: 503, headers: { 'content-type': 'text/javascript' }, body: '// refuse one shell entry\n' });
    }
    return route.continue();
  });
  const page = context.pages()[0] || (await context.newPage());
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  return { context, page };
}

async function waitReady(page) {
  await page.waitForFunction(
    () => window.agent && window.agent.snapshot && window.agent.snapshot() !== null,
    null,
    { timeout: 30000 },
  );
  await page.waitForFunction(() => {
    const t = document.getElementById('tree');
    return t && !t.textContent.includes('reading');
  }, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const s = document.getElementById('shell');
    return s && s.dataset.driven !== 'unknown';
  }, null, { timeout: 30000 });
}

async function shell(page) {
  return page.evaluate(() => {
    const s = document.getElementById('shell');
    return { text: s.textContent, driven: s.dataset.driven, missing: s.dataset.missing };
  });
}

async function cachedPaths(page) {
  return page.evaluate(async (name) => {
    const c = await caches.open(name);
    const keys = await c.keys();
    return keys.map((r) => new URL(r.url).pathname).sort();
  }, CACHE);
}

async function swState(page) {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return {
      controller: navigator.serviceWorker.controller !== null,
      activeState: reg?.active?.state ?? null,
      scriptURL: reg?.active?.scriptURL ?? null,
    };
  });
}

const expectedPaths = SHELL.map(pathOf).sort();
const namesMissing = (line, rel) => line.text.includes(rel.replace(/^\.\//, ''));

try {
  let page;
  ({ context: ctx, page } = await launch());

  // ---- 1. the defect reproduction: one shell entry refused ----------------
  netHits = 0;
  await page.goto(URL_, { timeout: 60000, waitUntil: 'load' });
  await waitReady(page);

  const sw1 = await swState(page);
  check('one failed install fetch does not lose the service worker: it is active',
    sw1.activeState === 'activated', `active=${sw1.activeState} script=${sw1.scriptURL}`);
  check('the service worker is controlling this load despite the missing entry',
    sw1.controller === true, `navigator.serviceWorker.controller !== null: ${sw1.controller}`);

  const line1 = await shell(page);
  check('the screen names the shell entry that did not arrive',
    line1.missing === BLOCKED && namesMissing(line1, BLOCKED),
    `data-missing="${line1.missing}" text="${line1.text}"`);

  const cached1 = await cachedPaths(page);
  const arrived = expectedPaths.filter((p) => p !== pathOf(BLOCKED));
  const lost = arrived.filter((p) => !cached1.includes(p));
  check('every shell entry that did arrive is in the cache',
    lost.length === 0, lost.length ? `not cached: ${lost.join(', ')}` : `${arrived.length} of ${SHELL.length} entries cached, ${BLOCKED} absent`);
  check('the failed entry is the only one absent',
    !cached1.includes(pathOf(BLOCKED)) && cached1.length === arrived.length,
    `cache holds ${cached1.length}, expected ${arrived.length}`);

  // ---- 2. the repair: stop refusing, reload once -------------------------
  blocking = false;
  const netBeforeRepair = netHits;
  await page.reload({ timeout: 60000, waitUntil: 'load' });
  await waitReady(page);

  const line2 = await shell(page);
  const cached2 = await cachedPaths(page);
  check('one reload repairs the missing entry — no release, no version bump',
    cached2.length === expectedPaths.length && expectedPaths.every((p) => cached2.includes(p)),
    `cache holds ${cached2.length}/${expectedPaths.length}, ${BLOCKED} present: ${cached2.includes(pathOf(BLOCKED))}`);
  check('the screen says the shell is complete',
    line2.missing === '' && line2.driven === 'true' && /every shell entry is cached/.test(line2.text),
    `data-missing="${line2.missing}" driven=${line2.driven} text="${line2.text}"`);
  check('the repair happened on the same cache version',
    (await page.evaluate(async () => (await caches.keys()).sort())).join() === CACHE,
    `${CACHE} still the only cache`);
  const repairRequests = netHits - netBeforeRepair;
  console.log(`NET  repair load reached the network ${repairRequests} time(s) (${blockHits} refusals so far) — it must fetch the one missing entry, and only that`);

  // ---- 3. offline reopen still boots -------------------------------------
  await ctx.setOffline(true);
  await page.reload({ timeout: 60000, waitUntil: 'load' });
  await waitReady(page);
  const offline = await page.evaluate(() => ({
    tree: document.getElementById('tree').textContent,
    shell: document.getElementById('shell').textContent,
    driven: document.getElementById('shell').dataset.driven,
  }));
  const boots = Number((offline.tree.match(/boots\s+(\d+)/) || [])[1]);
  check('an offline reopen boots from the service worker and OPFS',
    offline.driven === 'true' && Number.isFinite(boots) && boots > 0
      && offline.tree.includes('agrees with what was written'),
    `boots=${boots} driven=${offline.driven} read-back=${offline.tree.includes('agrees with what was written')}`);
  await ctx.setOffline(false);

  // ---- 4. the happy path adds no requests --------------------------------
  netHits = 0;
  await page.reload({ timeout: 60000, waitUntil: 'load' });
  await waitReady(page);
  await sleep(250); // let any late runtime put/update check land inside the count
  const happyNet = netHits;
  const line3 = await shell(page);
  check('a complete shell costs zero network requests on the next load',
    happyNet === 0,
    `${happyNet} request(s) reached the network (the old all-or-nothing worker's complete-shell load was also 0)`);
  check('that load is controlled and still reports a complete shell',
    line3.driven === 'true' && line3.missing === '',
    `driven=${line3.driven} missing="${line3.missing}"`);
  console.log(`REQS  happy-path load: ${happyNet} network request(s)`);
} catch (e) {
  check('probe ran without an exception', false, `${e.name}: ${e.message}`);
} finally {
  if (ctx) await ctx.close();
  await rm(dir, { recursive: true, force: true });
}

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
