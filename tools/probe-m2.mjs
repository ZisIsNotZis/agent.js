// Milestone 2's acceptance, run rather than asserted:
//   export in a profile with a settled tree; import that bundle in a fresh
//   profile that has nothing; a rejected import is a no-op with its reason on
//   screen; the container line tells the truth; and an offline reopen after
//   import still boots the imported tree.
//
// Run: node tools/serve.mjs &   then   node tools/probe-m2.mjs
// The server must already be on PORT (default 8137).
//
// Two profiles, both fresh mkdtemp userDataDirs: A runs the script and exports,
// B starts with no OPFS and no IndexedDB and imports A's file. Both export files
// are kept and their paths printed. The standalone branch is exercised by
// stubbing matchMedia/navigator.standalone — that is a stub, not a phone.
//
// Playwright is found, not hard-coded, exactly as in probe-m1 and probe-m3: bare
// `playwright-core`, or PLAYWRIGHT_CORE pointing at an install; CHROME_PATH
// overrides the executable.
//
// The URL may be a live origin, so a load gets 60s and one retry; a load that
// fails twice is reported as NET and never as a milestone failure.
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
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
const STEPS = Number(process.env.STEPS || 6);

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const script = Array.from({ length: STEPS }, (_, i) => (i % 2 === 0
  ? { node: 'root', tool: 'add_node', args: { id: `n${i / 2}`, parent: 'root' } }
  : { node: `n${(i - 1) / 2}`, tool: 'set_status', args: { node: `n${(i - 1) / 2}`, status: 'done' } }));

function seqProblems(recs) {
  const intents = new Map();
  const results = new Map();
  for (const r of recs) {
    const m = r.kind === 'intent' ? intents : results;
    m.set(r.seq, (m.get(r.seq) || 0) + 1);
  }
  const problems = [];
  for (const [seq, n] of intents) if (n !== 1) problems.push(`intent seq ${seq} x${n}`);
  for (const [seq, n] of results) if (n !== 1) problems.push(`result seq ${seq} x${n}`);
  for (const seq of intents.keys()) if (!results.has(seq)) problems.push(`seq ${seq}: intent without result`);
  for (const seq of results.keys()) if (!intents.has(seq)) problems.push(`seq ${seq}: result without intent`);
  return problems;
}

async function launch(userDataDir) {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: EXE,
    headless: true,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  return { ctx, page };
}

// A load is the one part of this probe that can fail for a reason that is not
// the code: a live origin's CDN can be slow. Loads are patient once and retried
// once; a load that fails twice is NET — never a milestone failure.
const NAV = { timeout: 60_000, waitUntil: 'load' };

let retries = 0;
let networkFails = 0;

const isNetwork = (e) => e?.name === 'TimeoutError'
  || /net::ERR_|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ABORTED/.test(e?.message || '');

async function controlling(page) {
  try {
    return await Promise.race([
      page.evaluate(() => navigator.serviceWorker.controller !== null),
      new Promise((r) => setTimeout(() => r('unknown (no answer in 5s)'), 5000)),
    ]);
  } catch (e) {
    return `unknown (${e.message.split('\n')[0]})`;
  }
}

// The last load that got far enough to answer, so a page stuck mid-navigation
// still reports what the SW was doing in that profile a moment earlier.
let lastLoad = null;

// One retry, then a NetworkError that prints its own diagnosis.
async function withRetry(page, label, doNav) {
  try {
    const res = await doNav();
    lastLoad = { label, url: page.url(), controller: await controlling(page) };
    return res;
  } catch (e) {
    if (!isNetwork(e)) throw e;
    retries += 1;
    console.log(`RETRY  ${label} — goto timed out, retrying`);
    try {
      const res = await doNav();
      lastLoad = { label, url: page.url(), controller: await controlling(page) };
      return res;
    } catch (e2) {
      if (!isNetwork(e2)) throw e2;
      const sw = await controlling(page);
      console.log(`NET-DIAG  ${label} — first: ${e.message}`);
      console.log(`NET-DIAG  ${label} — again: ${e2.message}`);
      console.log(`NET-DIAG  ${label} — navigator.serviceWorker.controller !== null: ${sw}`);
      if (lastLoad) {
        console.log(`NET-DIAG  ${label} — last load that answered: ${lastLoad.label} → ${lastLoad.url}, controller=${lastLoad.controller}`);
      }
      const err = new Error(`${label}: ${URL_} failed twice (first: ${e.message} / again: ${e2.message}, controller=${sw})`);
      err.name = 'NetworkError';
      err.network = true;
      throw err;
    }
  }
}

function goto(page, label) {
  return withRetry(page, label, () => page.goto(URL_, NAV));
}

function reload(page, label) {
  return withRetry(page, label, () => page.reload(NAV));
}

async function waitReady(page) {
  try {
    await page.waitForFunction(
      () => window.agent && typeof window.agent.exportBundle === 'function'
        && window.agent.snapshot && window.agent.snapshot() !== null,
      null,
      { timeout: 20000 },
    );
  } catch (e) {
    // A live origin can carry a build without M2 in it; say which it is.
    const d = await page.evaluate(() => ({
      agent: !!window.agent,
      exportBundle: typeof window.agent?.exportBundle,
    })).catch(() => null);
    const err = new Error(`${e.message.split('\n')[0]} (window.agent=${d?.agent}, typeof exportBundle=${d?.exportBundle})`);
    err.name = e.name;
    throw err;
  }
  await page.waitForFunction(() => {
    const t = document.getElementById('tree');
    return t && !t.textContent.includes('reading');
  }, null, { timeout: 20000 });
}

// One read of everything that decides equality between the two profiles.
function capture(page) {
  return page.evaluate(async () => {
    const records = await window.agent.records();
    const bundle = await window.agent.exportBundle();
    const snap = window.agent.snapshot();
    let treeText = null;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('.agentjs');
      const fh = await dir.getFileHandle('tree.json');
      treeText = await (await fh.getFile()).text();
    } catch {
      treeText = null;
    }
    const c = document.getElementById('container');
    return {
      records,
      bundle,
      snap,
      treeText,
      treeRaw: treeText ? JSON.parse(treeText) : null,
      containerText: c.textContent,
      standalone: c.dataset.standalone,
      screenTree: document.getElementById('tree').textContent,
      status: {
        mark: document.getElementById('transfer-status').dataset.status,
        text: document.getElementById('transfer-status').textContent,
      },
      exportInfo: document.getElementById('export-info').textContent,
      filename: window.agent.exportFilename ? window.agent.exportFilename() : null,
    };
  });
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nodesOf = (cap) => cap.snap?.nodes ?? null;

async function importViaTextarea(page, text) {
  await page.fill('#import-text', text);
  await page.click('#import-paste');
}

const exportsDir = await mkdtemp(join(tmpdir(), 'agentjs-m2-exports-'));
const exportDirA = join(exportsDir, 'profile-a');
const exportDirB = join(exportsDir, 'profile-b');
await mkdir(exportDirA, { recursive: true });
await mkdir(exportDirB, { recursive: true });
const profileA = await mkdtemp(join(tmpdir(), 'agentjs-m2-a-'));
const profileB = await mkdtemp(join(tmpdir(), 'agentjs-m2-b-'));

let exportPath = null;
let importExportPath = null;
let exported = null;
let exportedBundle = null;

// A block that cannot load its page cannot run its checks either; it reports
// once, as a check, so the exit code stays honest and the reason is on screen.
let blocking = null;
function failedBlock(where, e) {
  if (e.network) networkFails += 1;
  blocking = e;
  check(`${where}: ran to completion`, false, e.network ? `NET — ${e.message}` : `${e.name}: ${e.message}`);
}

// ---- profile A: a settled tree, then an export through the page's function ----
{
  const { ctx, page } = await launch(profileA);
  try {
    await goto(page, 'profile A');
    await waitReady(page);
    for (const s of script) await page.evaluate((st) => window.agent.step(st), s);
    await page.evaluate(() => window.agent.replay());

    // Drive the real Export control. With no share sheet in headless Chromium it
    // takes the <a download> branch; Playwright hands us the file.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('#export'),
    ]);
    exportPath = join(exportDirA, download.suggestedFilename());
    await download.saveAs(exportPath);
    await page.waitForFunction(
      () => document.getElementById('transfer-status').dataset.status === 'ok',
      null,
      { timeout: 15000 },
    );
    exported = await capture(page);
    exportedBundle = exported.bundle;

    check('export: the bundle is v 1', exportedBundle.v === 1, `v=${exportedBundle.v}`);
    check('export: the bundle log is the page log verbatim',
      sameJson(exportedBundle.log, exported.records),
      `${exportedBundle.log.length} records in both`);
    check('export: the bundle tree is the OPFS snapshot',
      sameJson(exportedBundle.tree, exported.treeRaw),
      exportedBundle.tree ? `created ${exportedBundle.tree.created}, boots ${exportedBundle.tree.boots}` : 'no tree');
    check('export: the bundle carries origin and persisted()',
      typeof exportedBundle.origin === 'string' && 'persisted' in exportedBundle,
      `origin=${exportedBundle.origin} persisted=${exportedBundle.persisted}`);
    check('export: one line says what it contains and its size',
      /nodes?, \d+ log records/.test(exported.exportInfo) && /\u2014 \d+ bytes/.test(exported.exportInfo),
      `"${exported.exportInfo}"`);
    check('export: the filename is agentjs-<host>-<YYYYMMDD-HHMM>.json',
      /^agentjs-.+-\d{8}-\d{4}\.json$/.test(exported.filename),
      exported.filename);

    const text = await readFile(exportPath, 'utf8');
    const parsed = JSON.parse(text);
    check('export: the downloaded file parses and carries the same log and tree',
      parsed.v === 1 && sameJson(parsed.log, exported.records)
        && sameJson(parsed.tree, exported.treeRaw),
      `${text.length} characters from ${download.suggestedFilename()}`);
  } catch (e) {
    failedBlock('profile A (export)', e);
  } finally {
    await ctx.close();
    await rm(profileA, { recursive: true, force: true });
  }
}

// ---- profile B: empty, then import through the real textarea + button ----
if (!blocking) {
  const { ctx, page } = await launch(profileB);
  try {
    await goto(page, 'profile B');
    await waitReady(page);
    const empty = await capture(page);
    check('import target profile really has nothing',
      empty.records.length === 0 && empty.treeRaw !== null
        && empty.treeRaw.nodes.length === 1 && empty.treeRaw.nodes[0].status === 'idle',
      `${empty.records.length} records, ${empty.treeRaw?.nodes?.length} nodes before import`);

    await importViaTextarea(page, await readFile(exportPath, 'utf8'));
    await page.waitForFunction(
      () => document.getElementById('transfer-status').dataset.status === 'ok'
        || document.getElementById('transfer-status').dataset.status === 'error',
      null,
      { timeout: 30000 },
    );
    const after = await capture(page);

    check('import: the screen reports it succeeded', after.status.mark === 'ok',
      `"${after.status.text}"`);
    check('import: created equals the exporting profile',
      after.treeRaw?.created === exportedBundle.tree.created,
      `${after.treeRaw?.created} vs ${exportedBundle.tree.created}`);
    check('import: boots equals the exporting profile',
      String(after.treeRaw?.boots) === String(exportedBundle.tree.boots),
      `${after.treeRaw?.boots} vs ${exportedBundle.tree.boots}`);
    check('import: node set and final statuses equal the exporting profile',
      sameJson(nodesOf(after), nodesOf(exported)),
      JSON.stringify(nodesOf(after)));
    check('import: the log is the exporting log verbatim',
      sameJson(after.bundle.log, exportedBundle.log),
      `${after.bundle.log.length} records`);
    check('import: the screen shows the imported tree',
      after.screenTree.includes('read-back  agrees'), after.screenTree.split('\n')[0]);

    // probe-m3's invariant, after an import: replay finds nothing in flight.
    const reinv = await page.evaluate(async () => {
      const before = (await window.agent.records()).length;
      const r = await window.agent.replay();
      const recs = await window.agent.records();
      return { inFlight: r.inFlight, records: r.records, before, after: recs.length, recs };
    });
    check('import: replay afterwards finds nothing in flight (M3 invariant)',
      reinv.inFlight === null && reinv.before === reinv.after
        && seqProblems(reinv.recs).length === 0,
      `inFlight=${JSON.stringify(reinv.inFlight)} records ${reinv.before}->${reinv.after}`);

    // Export from the importing profile too, and keep the file.
    const text = await page.evaluate(async () => {
      const b = await window.agent.exportBundle();
      return { filename: window.agent.exportFilename(), text: window.agent.bundleText(b) };
    });
    importExportPath = join(exportDirB, text.filename);
    await writeFile(importExportPath, text.text, 'utf8');
    check('import: the importing profile exports its own copy of the same workspace',
      sameJson(JSON.parse(text.text).log, exportedBundle.log),
      importExportPath);

    // ---- rejected imports are no-ops, with the reason on screen ----
    const beforeBad = await capture(page);
    const bad = [
      ['a bundle whose v is not 1', { ...exportedBundle, v: 2 }, /v 2/],
      ['a result with no intent', {
        ...exportedBundle,
        log: [{ kind: 'result', seq: 1, ok: true, out: { op: 'add_node', id: 'x' }, at: new Date().toISOString() }],
      }, /no intent/],
      ['a duplicated seq', {
        ...exportedBundle,
        log: [...exportedBundle.log, exportedBundle.log.find((r) => r.kind === 'intent')],
      }, /duplicate/],
    ];
    for (const [label, bundle, reasonRe] of bad) {
      await importViaTextarea(page, JSON.stringify(bundle));
      await page.waitForFunction(
        () => document.getElementById('transfer-status').dataset.status === 'error',
        null,
        { timeout: 15000 },
      );
      const refused = await capture(page);
      const unchanged = sameJson(refused.records, beforeBad.records)
        && refused.treeText === beforeBad.treeText;
      check(`rejected import (${label}): refused with the reason on screen`,
        refused.status.mark === 'error' && reasonRe.test(refused.status.text),
        `"${refused.status.text}"`);
      check(`rejected import (${label}): the bytes on disk are unchanged`,
        unchanged,
        `${refused.records.length} records, tree ${refused.treeText === beforeBad.treeText ? 'same' : 'CHANGED'}`);
    }

    // ---- the container line, in a tab, told as a tab ----
    check('container: a plain tab is reported as a tab',
      exported.standalone === 'false' && /browser tab/.test(exported.containerText),
      exported.containerText.slice(0, 90));
    check('container: the tab line names the icon as a different container',
      /Home Screen/.test(exported.containerText) && /different container/.test(exported.containerText),
      exported.containerText.slice(0, 160));

    // ---- offline reopen after import: the shell from the SW, the tree from OPFS ----
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await reload(page, 'profile B reload');
    await waitReady(page);
    const controlled = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      return !!(await navigator.serviceWorker.getRegistration())?.active;
    });
    check('offline: the service worker is active', controlled === true, `active=${controlled}`);
    await page.waitForTimeout(500);
    await ctx.setOffline(true);
    // The offline reload is deliberately neither retried nor called a network
    // failure: the network is off on purpose, so a hang here is the service
    // worker's failure and stays a milestone failure.
    await page.reload({ ...NAV });
    await waitReady(page);
    const offline = await capture(page);
    check('offline reopen after import boots the imported tree',
      sameJson(nodesOf(offline), nodesOf(exported))
        && offline.treeRaw?.created === exportedBundle.tree.created
        && offline.screenTree.includes('read-back  agrees'),
      `${offline.records.length} records, ${offline.treeRaw?.nodes?.length} nodes`);
    await ctx.setOffline(false);

    // ---- standalone branch: stubbed, and reported as stubbed ----
    const spoof = await ctx.newPage();
    await spoof.addInitScript(() => {
      window.matchMedia = (q) => ({
        matches: /standalone/.test(q),
        media: q,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; },
      });
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    });
    await spoof.goto(URL_, { ...NAV });
    await waitReady(spoof);
    const st = await capture(spoof);
    check('container: the standalone branch names itself and the tab as different containers',
      st.standalone === 'true' && /Home Screen/.test(st.containerText)
        && /browser tab/.test(st.containerText) && /different container/.test(st.containerText),
      st.containerText.slice(0, 160));
    await spoof.close();
  } catch (e) {
    failedBlock('profile B (import)', e);
  } finally {
    await ctx.close();
    await rm(profileB, { recursive: true, force: true });
  }
}

console.log('\nexports written:');
console.log(`  profile A (exporting): ${exportPath}`);
console.log(`  profile B (importing): ${importExportPath}`);
console.log('note: the standalone container branch was asserted by stubbing matchMedia/navigator.standalone;');
console.log('      no phone or Home Screen was measured.');
console.log(`network=${networkFails} retries=${retries}`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
