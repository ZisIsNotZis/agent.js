// W7's acceptance, run rather than asserted, against a local mock provider.
//
//   node tools/serve.mjs &   then   node tools/probe-w7.mjs
//
// The probe starts tools/mock-provider.mjs on its own port (8138 by default),
// points the page at it, and never at a real provider. What it checks:
//
//   1. a two-turn scripted conversation writes the intended files through
//      write/run_js and produces the commits;
//   2. prefix stability: request 2's messages equals request 1's plus the
//      appended turn, byte-compared through JSON;
//   3. a kill between request and result reopens, names the one unfinished
//      model call, and re-issues exactly one extra request, saying so on screen;
//   4. the key appears in no localStorage/sessionStorage/IndexedDB record, URL,
//      history state, log record, export bundle or trace;
//   5. usage is on screen verbatim, next to the mock's own usage object;
//   6. with no key, nothing is sent (mock count 0) and the trace has an error;
//   7. the trace exists, parses as NDJSON, carries the W7 event types in causal
//      order, and summary.md names the commits — its path and line count print.
//
// The other probes (m1/m2/m3/m4/m6/shell) are run separately; this probe does
// not re-run them.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXE = process.env.CHROME_PATH || undefined;
const URL_ = process.env.URL || 'http://127.0.0.1:8137/';
const PAGE_ORIGIN = new URL(URL_).origin;
const MOCK_PORT = Number(process.env.MOCK_PORT || 8138);
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const RECORDS = join(ROOT, '.tmp', `w7-mock-${process.pid}`);
const EVIDENCE = join(ROOT, 'evidence');
const KEY = 'sk-w7-SECRET-4f9a2c7d';

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockFetch(path, init) {
  const res = await fetch(`${MOCK_URL}${path}`, init);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const mockState = () => mockFetch('/__state');
const mockReset = () => mockFetch('/__reset', { method: 'POST', body: '{}' });
const mockScript = (script, resetCount = false) => mockFetch('/__script', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ script, resetCount }),
});

async function launch(userDataDir) {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: EXE,
    headless: true,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  return { ctx, page };
}

async function waitReady(page) {
  await page.goto(URL_, { timeout: 60_000, waitUntil: 'load' });
  await page.waitForFunction(
    () => window.agent && window.agent.snapshot && window.agent.snapshot() !== null,
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => {
    const t = document.getElementById('tree');
    return t && !t.textContent.includes('reading');
  }, null, { timeout: 30_000 });
}

const config = () => ({ baseUrl: `${MOCK_URL}/v1`, model: 'mock-model', key: KEY });

// The two-turn script: turn 1 asks for files and commits, turn 2 is a final
// message with no tool calls, which ends the loop.
const A_CONTENT = 'first step\n';
const HELLO_CONTENT = "console.log('hello from the loop');\n";
const SCRIPT = [
  {
    tool_calls: [
      { name: 'write', arguments: { path: 'notes/a.txt', content: A_CONTENT } },
      { name: 'write', arguments: { path: 'hello.js', content: HELLO_CONTENT } },
      { name: 'run_js', arguments: { path: 'hello.js' } },
      { name: 'git_commit', arguments: { path: 'notes/a.txt', content: A_CONTENT, message: 'write a' } },
      { name: 'git_commit', arguments: { path: 'hello.js', content: HELLO_CONTENT, message: 'write hello' } },
    ],
  },
  { content: 'done: a.txt and hello.js are committed' },
];

const hashOf = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

async function prepareEvidence() {
  await mkdir(EVIDENCE, { recursive: true });
  for (const name of await readdir(EVIDENCE)) {
    if (name === 'w7-acceptance') continue;
    await rm(join(EVIDENCE, name), { recursive: true, force: true });
  }
}

let mock = null;
let baseDir = null;
let killDir = null;
let noKeyDir = null;

try {
  // ---- the mock and the served page -------------------------------------
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`the site is not served at ${URL_} (${e.message}); run: node tools/serve.mjs &`);
    process.exit(2);
  }

  mock = spawn(process.execPath, [join(ROOT, 'tools', 'mock-provider.mjs')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_RECORD_DIR: RECORDS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`));
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try {
      const h = await mockFetch('/__health');
      up = Boolean(h?.ok);
    } catch {
      await sleep(100);
    }
  }
  check('the mock provider is up on its own port, recording to disk', up,
    up ? `${MOCK_URL} -> ${RECORDS}` : 'no /__health answer');
  if (!up) throw new Error('mock provider did not start');

  await prepareEvidence();

  // ---- 1+2+5+7. the two-turn scripted conversation ----------------------
  baseDir = await mkdtemp(join(tmpdir(), 'agentjs-w7-base-'));
  let { ctx, page } = await launch(baseDir);
  await waitReady(page);
  await mockReset();
  await mockScript(SCRIPT);

  const ran = await page.evaluate(async (cfg) => {
    window.AGENT_SEED = 'w7-acceptance-seed';
    await window.agent.configure(cfg);
    return window.agent.run('please do the two-turn thing');
  }, config());
  check('the loop ran to a final message', ran?.turns === 2 && ran?.toolCalls === 5,
    `${ran?.turns} requests, ${ran?.toolCalls} tool calls, ${ran?.commits} commits, trace ${ran?.runId}`);

  const files = await page.evaluate(async () => {
    const fs = await window.agent.getFs();
    const dec = new TextDecoder();
    return {
      a: dec.decode(await fs.read('notes/a.txt')),
      hello: dec.decode(await fs.read('hello.js')),
    };
  });
  check('write wrote the intended files', files.a === A_CONTENT && files.hello === HELLO_CONTENT,
    `notes/a.txt=${JSON.stringify(files.a)} hello.js=${JSON.stringify(files.hello)}`);

  const recs = await page.evaluate(() => window.agent.records());
  const exec = recs.find((r) => r.kind === 'result' && r.out?.op === 'exec');
  check('run_js executed the written file through M6\'s Worker',
    exec?.out?.exit === 'ok' && exec?.out?.stdout === 'hello from the loop\n',
    `exit=${exec?.out?.exit} stdout=${JSON.stringify(exec?.out?.stdout)}`);

  const commits = await page.evaluate(() => window.agent.gitLog());
  const msgs = commits.map((c) => c.commit.message);
  check('the tool calls produced the commits',
    commits.length === 2
      && msgs.some((m) => m.startsWith('agent step') && m.includes('write a'))
      && msgs.some((m) => m.startsWith('agent step') && m.includes('write hello')),
    `${commits.length} commits: ${msgs.map((m) => JSON.stringify(m.split('\n')[0])).join(', ')}`);

  const mock1 = await mockState();
  check('the mock received exactly two requests', mock1.count === 2,
    `count=${mock1.count}, usages=${JSON.stringify(mock1.usages)}`);
  const b1 = mock1.bodies[0];
  const b2 = mock1.bodies[1];
  const prefix = JSON.stringify(b2.messages.slice(0, b1.messages.length)) === JSON.stringify(b1.messages);
  const appended = b2.messages.length - b1.messages.length;
  check('PREFIX: request 2\'s messages equals request 1\'s plus the appended turn, byte-compared',
    prefix && appended === 1 + 5,
    `prefix=${prefix}, appended=${appended} (1 assistant + 5 tool results), messages ${b1.messages.length} -> ${b2.messages.length}`);

  const usageText = await page.evaluate(() => document.getElementById('usage').textContent);
  const expectedUsage = JSON.stringify(mock1.usages[mock1.usages.length - 1]);
  check('usage is on screen verbatim', usageText === expectedUsage,
    `screen=${usageText}`);

  const traceText = await page.evaluate(() => window.agent.traceText());
  const summaryText = await page.evaluate(() => window.agent.traceSummary());
  const lines = traceText.split('\n').filter(Boolean);
  let events = [];
  let parseError = null;
  try {
    events = lines.map((l) => JSON.parse(l));
  } catch (e) {
    parseError = e.message;
  }
  check('the trace parses as NDJSON', !parseError && events.length > 0 && events.length === lines.length,
    parseError || `${lines.length} events`);

  const types = events.map((e) => e.type);
  const required = ['run.start', 'model.request', 'model.response', 'tool.call', 'tool.result', 'log.record', 'screen', 'timing'];
  const missing = required.filter((t) => !types.includes(t));
  const at = (t) => types.indexOf(t);
  // `screen` and `timing` are recorded throughout, so their *last* occurrence
  // is what must follow the work; the request/response/tool chain is causal.
  const last = (t) => types.lastIndexOf(t);
  const causal = at('run.start') === 0
    && at('model.request') < at('model.response')
    && at('model.response') < at('tool.call')
    && at('tool.call') < at('tool.result')
    && last('screen') > last('tool.result')
    && last('timing') > last('model.response');
  check('the trace has the W7 event types in causal order',
    missing.length === 0 && causal,
    missing.length ? `missing ${missing.join(', ')}` : `types: ${[...new Set(types)].join(', ')}`);

  const reqEvent = events.find((e) => e.type === 'model.request');
  const respEvent = events.find((e) => e.type === 'model.response');
  check('the trace carries the full body sent and the full response with usage',
    JSON.stringify(reqEvent?.body?.messages) === JSON.stringify(b1.messages)
      && Boolean(respEvent?.response?.id)
      && Array.isArray(respEvent?.response?.choices)
      && JSON.stringify(respEvent?.usage) === JSON.stringify(mock1.usages[0]),
    `requestHash=${reqEvent?.requestHash?.slice(0, 12)}… response id=${respEvent?.response?.id} usage=${JSON.stringify(respEvent?.usage)}`);

  const commitNames = commits.map((c) => c.oid);
  check('summary.md names the commits',
    commitNames.every((oid) => summaryText.includes(oid)) && /write a/.test(summaryText) && /write hello/.test(summaryText),
    commitNames.map((o) => o.slice(0, 12)).join(', '));

  const runId = events[0]?.runId;
  const evDir = join(EVIDENCE, runId);
  await mkdir(evDir, { recursive: true });
  await writeFile(join(evDir, 'trace.ndjson'), traceText);
  await writeFile(join(evDir, 'summary.md'), summaryText);
  check('the trace and summary are on disk', Boolean(runId) && lines.length > 0,
    `${join(evDir, 'trace.ndjson')} — ${lines.length} lines`);
  const writtenTrace = await readFile(join(evDir, 'trace.ndjson'), 'utf8');
  const writtenSummary = await readFile(join(evDir, 'summary.md'), 'utf8');
  check('the written trace file contains no key', !writtenTrace.includes(KEY) && !writtenSummary.includes(KEY),
    `${writtenTrace.length} bytes of trace + ${writtenSummary.length} bytes of summary scanned for the key — 0 hits`);

  // ---- 4. the key is nowhere it could rest -------------------------------
  const scan = await page.evaluate(async (needle) => {
    const hits = [];
    const scanText = (where, text) => {
      if (String(text ?? '').includes(needle)) hits.push(where);
    };
    scanText('location.href', location.href);
    scanText('history.state', JSON.stringify(history.state));
    scanText('document.referrer', document.referrer);
    scanText('document.cookie', document.cookie);
    for (const key of Object.keys(localStorage)) scanText(`localStorage[${key}]`, `${key}=${localStorage.getItem(key)}`);
    for (const key of Object.keys(sessionStorage)) scanText(`sessionStorage[${key}]`, `${key}=${sessionStorage.getItem(key)}`);
    for (const entry of performance.getEntriesByType('resource')) scanText(`resource:${entry.name}`, entry.name);
    let dbs = [];
    try {
      dbs = await indexedDB.databases();
    } catch { /* older engine */ }
    for (const info of dbs) {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(info.name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const store of db.objectStoreNames) {
        const rows = await new Promise((res, rej) => {
          const tx = db.transaction(store, 'readonly');
          const q = tx.objectStore(store).getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        scanText(`idb:${info.name}/${store}`, JSON.stringify(rows));
      }
      db.close();
    }
    scanText('log records', JSON.stringify(await window.agent.records()));
    const bundle = await window.agent.exportBundle();
    scanText('export bundle', window.agent.bundleText(bundle));
    scanText('trace', await window.agent.traceText());
    return { hits, dbs: dbs.map((d) => d.name), historyLength: history.length };
  }, KEY);
  check('the key appears in no storage, URL, history, log record, bundle or trace',
    scan.hits.length === 0,
    scan.hits.length ? `found in ${scan.hits.join(', ')}` : `scanned ${scan.dbs.length} IndexedDB database(s), localStorage, sessionStorage, URL, history, log, bundle, trace — 0 hits`);
  check('the key never reaches the provider as anything but the Authorization header',
    mock1.headers.every((h) => h.authorization === 'present'),
    `headers seen: ${JSON.stringify(mock1.headers)}`);

  await ctx.close();
  ctx = null;

  // ---- 3. a kill between request and result, then one re-issue -----------
  killDir = await mkdtemp(join(tmpdir(), 'agentjs-w7-kill-'));
  ({ ctx, page } = await launch(killDir));
  await waitReady(page);
  await mockReset();
  await mockScript([{ hang: true }]);

  await page.evaluate((cfg) => window.agent.configure(cfg), config());
  const hanging = page.evaluate(() => window.agent.run('kill this call')).catch(() => {});
  let first = null;
  for (let i = 0; i < 100 && !first; i += 1) {
    const st = await mockState();
    if (st.count >= 1) first = st;
    else await sleep(100);
  }
  check('the first request reached the mock and its body is on disk',
    first?.count === 1 && first.bodies[0]?.messages?.length > 0,
    first ? `count=${first.count}, ${first.bodies[0].messages.length} messages, hash ${hashOf(first.bodies[0]).slice(0, 12)}…` : 'no request');
  const killBody = first.bodies[0];
  const killHash = hashOf(killBody);
  const killRaw = await readFile(join(RECORDS, 'request-0001.json'), 'utf8');
  check('the mock recorded the request body verbatim on disk',
    JSON.parse(killRaw).model === 'mock-model', `${join(RECORDS, 'request-0001.json')} (${killRaw.length} bytes)`);

  await ctx.close();
  ctx = null;
  hanging.catch(() => {});
  await sleep(200);

  // The re-issue answers; count is not reset, so one extra request is visible.
  await mockScript([{ content: 'recovered after the kill' }], false);
  ({ ctx, page } = await launch(killDir));
  await waitReady(page);

  const pending = await page.evaluate(() => window.agent.pending());
  const pendingScreen = await page.evaluate(() => document.getElementById('run-status').textContent);
  check('the reopen names the one unfinished model call, before any key is entered',
    pending.length === 1 && pending[0].requestHash === killHash
      && /pending model call/.test(pendingScreen) && pendingScreen.includes(killHash),
    `pending=${JSON.stringify(pending)}`);
  const stillOne = await mockState();
  check('no key after the reopen means nothing was re-sent', stillOne.count === 1,
    `count=${stillOne.count}`);

  await page.evaluate((cfg) => window.agent.configure(cfg), config());
  const resumed = await page.evaluate(() => window.agent.resume());
  check('the re-issue sent exactly one extra request', (await mockState()).count === 2,
    `count=${(await mockState()).count}, reissuedSeq=${resumed?.reissuedSeq}`);
  const resendRaw = await readFile(join(RECORDS, 'request-0002.json'), 'utf8');
  check('the re-issued request is the same bytes as the interrupted one',
    resendRaw === killRaw, `${resendRaw.length} bytes, identical=${resendRaw === killRaw}`);
  const resumeScreen = await page.evaluate(() => document.getElementById('run-status').textContent);
  check('the screen says the unfinished call was re-issued, naming its request hash',
    /re-issued/.test(resumeScreen) && resumeScreen.includes(killHash),
    JSON.stringify(resumeScreen.split('\n').filter((l) => /re-issued|RE-ISSUED|request/.test(l)).slice(-2)));
  const resumeTrace = await page.evaluate(() => window.agent.traceText());
  const reissueEvent = resumeTrace.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.type === 'model.request' && e.reissue);
  check('the reopen trace records the re-issue with the same request hash',
    Boolean(reissueEvent) && reissueEvent.requestHash === killHash,
    reissueEvent ? `seq ${reissueEvent.seq} hash ${reissueEvent.requestHash.slice(0, 12)}…` : 'no re-issue event');

  await ctx.close();
  ctx = null;

  // ---- 6. no key, nothing sent -------------------------------------------
  noKeyDir = await mkdtemp(join(tmpdir(), 'agentjs-w7-nokey-'));
  ({ ctx, page } = await launch(noKeyDir));
  await waitReady(page);
  await mockReset();
  await mockScript([{ content: 'this must never be reached' }]);
  const refused = await page.evaluate(async (cfg) => {
    try {
      await window.agent.configure({ baseUrl: cfg.baseUrl, model: cfg.model });
      await window.agent.run('no key here');
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }, config());
  const noKeyState = await mockState();
  check('with no key, the run refuses and nothing is sent',
    !refused.ok && /no key/.test(refused.message) && noKeyState.count === 0,
    `refused=${JSON.stringify(refused)} mock count=${noKeyState.count}`);
  const noKeyScreen = await page.evaluate(() => document.getElementById('run-status').textContent);
  check('the refusal is on screen', /no key/.test(noKeyScreen), JSON.stringify(noKeyScreen.split('\n').slice(-1)));
  const noKeyTrace = await page.evaluate(() => window.agent.traceText());
  const noKeyEvents = noKeyTrace.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('the refused run still leaves a trace with an error event',
    noKeyEvents[0]?.type === 'run.start' && noKeyEvents.some((e) => e.type === 'error'),
    `${noKeyEvents.length} events: ${[...new Set(noKeyEvents.map((e) => e.type))].join(', ')}`);

  await ctx.close();
  ctx = null;

  console.log(`\nEVIDENCE ${join(EVIDENCE, runId || '<run>')}/trace.ndjson — ${lines.length} lines`);
} catch (e) {
  check('probe ran without an exception', false, `${e.name}: ${e.message}`);
} finally {
  for (const dir of [baseDir, killDir, noKeyDir]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  if (mock) mock.kill('SIGTERM');
}

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
