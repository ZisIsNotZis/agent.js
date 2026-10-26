// Milestone 6's acceptance, run rather than asserted: native JS executes in a
// Worker, a runaway is stopped at the wall-clock cap, erasable TS runs, and a
// file that is not erasable TS is refused by the compiler's AST with the
// construct and its line on screen.
//
// Run: node tools/serve.mjs &   then   node tools/probe-m6.mjs
// The server must already be on PORT (default 8137).
//
// The checks, in the order the promise is read:
//   1. a JS file returns its stdout, and the exit value is `ok`;
//   2. a file that throws returns `threw` with its message, and the page still
//      works afterwards;
//   3. an infinite loop is killed at the default 10 s cap — the elapsed time is
//      near the cap, not unbounded — and the page is responsive after it;
//   4. a `.ts` file with an `enum` is refused naming the construct and line, the
//      refusal is on screen, and the same file with a plain union runs;
//   5. the TypeScript bytes show up at the tap and a second `.ts` run imports
//      nothing more (the worker's own resource reading, plus the nav counter);
//   6. a kill between a run's effect and its result reopens `already settled`
//      with its stdout recovered, and a kill mid-run reopens `interrupted`
//      without executing the file a second time.
//
// The gzip price of the compiler is measured here from the served bytes with
// node's zlib, so the number printed is the number the tap pays.
//
// Playwright is found exactly as in probe-m1/m3/m4: bare `playwright-core`, or
// PLAYWRIGHT_CORE pointing at an install; CHROME_PATH overrides the executable.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

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
const CAP_MS = 10_000;
const TS_URL = new URL('vendor/typescript.min.js', URL_).href;

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(userDataDir) {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: EXE,
    headless: true,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  const net = { ts: 0, typescriptUrls: [] };
  page.on('request', (r) => {
    if (r.url().includes('typescript.min.js')) {
      net.ts += 1;
      net.typescriptUrls.push(r.url());
    }
  });
  return { ctx, page, net };
}

async function waitReady(page, label = 'load') {
  await page.goto(URL_, { timeout: 60_000, waitUntil: 'load' });
  try {
    await page.waitForFunction(
      () => window.agent && window.agent.snapshot && window.agent.snapshot() !== null,
      null,
      { timeout: 30_000 },
    );
  } catch (e) {
    const state = await page.evaluate(() => ({
      hasAgent: !!window.agent,
      snapshot: window.agent?.snapshot?.() ?? null,
      inflight: document.getElementById('inflight')?.textContent,
      tree: document.getElementById('tree')?.textContent,
      bootError: document.getElementById('tree')?.textContent,
    }));
    console.log(`WAIT-FAIL ${label}: snapshot never settled;`, JSON.stringify(state));
    throw e;
  }
  try {
    await page.waitForFunction(() => {
      const t = document.getElementById('tree');
      return t && !t.textContent.includes('reading');
    }, null, { timeout: 30_000 });
  } catch (e) {
    const tree = await page.evaluate(() => document.getElementById('tree')?.textContent);
    console.log(`WAIT-FAIL ${label}: tree still reading;`, JSON.stringify(tree));
    throw e;
  }
}

const runStep = (page, s) => page.evaluate((st) => window.agent.step(st), s);
const records = (page) => page.evaluate(() => window.agent.records());
const screenshot = (page) => page.evaluate(() => ({
  text: document.getElementById('exec').textContent,
  exit: document.getElementById('exec').dataset.exit,
}));
const inflight = (page) => page.evaluate(() => ({
  text: document.getElementById('inflight').textContent,
  mark: document.getElementById('inflight').dataset.inflight,
}));

const JS_HELLO = "console.log('hello from the worker');";
const JS_THROW = "throw new Error('boom from the worker');";
const TS_ENUM = [
  'enum Color { Red = 1, Blue = 2 }',
  'console.log(Color.Red);',
  '',
].join('\n');
const TS_UNION = [
  "type Color = 'red' | 'blue';",
  "const c: Color = 'red';",
  'console.log(`color ${c}`);',
  '',
].join('\n');

const write = (page, path, content) => runStep(page, { node: 'root', tool: 'write', args: { path, content } });
const run = (page, args) => runStep(page, { node: 'root', tool: 'run_js', args });

let baseDir = null;
let killDir = null;

try {
  // ---- 1. native JS executes, stdout is its own line ----------------------
  baseDir = await mkdtemp(join(tmpdir(), 'agentjs-m6-'));
  let { ctx, page, net } = await launch(baseDir);
  await waitReady(page, 'base');

  const booted = await page.evaluate(() => ({
    exec: typeof Worker === 'function' && typeof document.getElementById('exec') === 'object',
    runs: Array.isArray(window.agent.snapshot()?.runs),
  }));
  check('page booted with an execution output area and a runs fold',
    booted.exec && booted.runs, `exec=${booted.exec} runs=${booted.runs}`);

  await write(page, 'hello.js', JS_HELLO);
  const hello = await run(page, { path: 'hello.js' });
  check('a JS file prints, and its stdout is exactly the line',
    hello.out?.exit === 'ok' && hello.out?.stdout === 'hello from the worker\n',
    `exit=${hello.out?.exit} stdout=${JSON.stringify(hello.out?.stdout)} wall=${hello.out?.wallMs} ms`);
  const helloScreen = await screenshot(page);
  check('the run\'s stdout and exit are on screen',
    helloScreen.text.includes('hello from the worker') && helloScreen.exit === 'ok',
    JSON.stringify(helloScreen.text.split('\n').slice(0, 2)));

  const errOnly = await run(page, { source: "console.error('to stderr'); console.log('to stdout');" });
  check('console.error is stderr and console.log is stdout',
    errOnly.out?.stderr === 'to stderr\n' && errOnly.out?.stdout === 'to stdout\n',
    `stdout=${JSON.stringify(errOnly.out?.stdout)} stderr=${JSON.stringify(errOnly.out?.stderr)}`);

  // ---- 2. a throw is reported, and the page survives ----------------------
  await write(page, 'bad.js', JS_THROW);
  const threw = await run(page, { path: 'bad.js' });
  check('a throwing file exits `threw` with its message',
    threw.out?.exit === 'threw' && /boom from the worker/.test(threw.out?.error?.message || ''),
    `exit=${threw.out?.exit} error=${JSON.stringify(threw.out?.error?.message)}`);
  const threwScreen = await screenshot(page);
  check('the throw is on screen as stderr',
    threwScreen.exit === 'threw' && /boom from the worker/.test(threwScreen.text),
    JSON.stringify(threwScreen.text.split('\n').slice(-2)));
  const alive = await page.evaluate(() => 6 * 7);
  const afterThrow = await run(page, { source: "console.log('still here');" });
  check('the page still works after a throw',
    alive === 42 && afterThrow.out?.exit === 'ok' && afterThrow.out?.stdout === 'still here\n',
    `${alive}, then exit=${afterThrow.out?.exit}`);

  // ---- 3. the wall-clock cap, and a responsive tab afterwards ------------
  const t0 = Date.now();
  const loop = await run(page, { source: 'while (true) {}', timeoutMs: CAP_MS });
  const elapsed = Date.now() - t0;
  check('an infinite loop is killed at the cap, not left unbounded',
    loop.out?.exit === 'timeout' && loop.out?.wallMs >= CAP_MS - 500 && elapsed < CAP_MS + 4000,
    `exit=${loop.out?.exit} wall=${loop.out?.wallMs} ms elapsed=${elapsed} ms cap=${CAP_MS} ms`);
  const loopScreen = await screenshot(page);
  check('the timeout is on screen as its own exit',
    loopScreen.exit === 'timeout', `screen exit=${loopScreen.exit}`);
  const responsive = await page.evaluate(() => {
    const t = performance.now();
    let s = 0;
    for (let i = 0; i < 1e6; i += 1) s += i;
    return { s, ms: performance.now() - t, title: document.title };
  });
  const afterLoop = await run(page, { source: "console.log('after the loop');" });
  check('the tab is responsive after the kill and can run again',
    responsive.s > 0 && afterLoop.out?.exit === 'ok' && afterLoop.out?.stdout === 'after the loop\n',
    `main thread ${responsive.ms.toFixed(1)} ms for 1e6 adds, then exit=${afterLoop.out?.exit}`);

  // ---- 4. erasable TS: enum refused by the AST, union runs ---------------
  await write(page, 'shape.ts', TS_ENUM);
  const nBefore = net.ts;
  const refused = await run(page, { path: 'shape.ts' });
  const nAfterFirst = net.ts;
  check('a .ts file with an enum is refused, naming the construct and line',
    refused.out?.exit === 'refused'
      && refused.out?.refusal?.construct === 'enum'
      && refused.out?.refusal?.file === 'shape.ts'
      && refused.out?.refusal?.line === 1,
    `exit=${refused.out?.exit} refusal=${JSON.stringify(refused.out?.refusal)}`);
  const refusedScreen = await screenshot(page);
  check('the refusal names the construct and line on screen',
    refusedScreen.exit === 'refused'
      && /enum/.test(refusedScreen.text)
      && /shape\.ts:1/.test(refusedScreen.text),
    JSON.stringify(refusedScreen.text.split('\n').slice(0, 2)));

  await write(page, 'shape.ts', TS_UNION);
  const union = await run(page, { path: 'shape.ts' });
  check('the same file with a plain union runs and prints',
    union.out?.exit === 'ok' && union.out?.stdout === 'color red\n',
    `exit=${union.out?.exit} stdout=${JSON.stringify(union.out?.stdout)}`);

  const thrownTs = await run(page, {
    path: 'throws.ts',
    source: "type N = number;\nconst n: N = 1;\nthrow new Error('typed boom');",
  });
  check('a throwing .ts file also exits `threw` after stripping',
    thrownTs.out?.exit === 'threw' && /typed boom/.test(thrownTs.out?.error?.message || ''),
    `exit=${thrownTs.out?.exit} error=${JSON.stringify(thrownTs.out?.error?.message)}`);

  // ---- 5. the tap's price, and no second fetch ---------------------------
  const second = await run(page, { path: 'shape.ts' });
  const nAfterSecond = net.ts;
  check('the first .ts run loaded TypeScript exactly once',
    refused.out?.tsImports === 1 || union.out?.tsImports === 1,
    `first tsImports=${refused.out?.tsImports}, worker says it read ${refused.out?.tsBytes} bytes`);
  check('a second .ts run imports nothing more',
    second.out?.exit === 'ok' && second.out?.tsImports === 1 && nAfterSecond === nAfterFirst,
    `tsImports=${second.out?.tsImports} (was 1), nav requests ${nBefore}→${nAfterFirst}→${nAfterSecond}`);

  const served = await fetch(TS_URL);
  const bytes = new Uint8Array(await served.arrayBuffer());
  const gz = gzipSync(bytes, { level: 9 }).length;
  console.log(`TIME  TypeScript tap: ${bytes.length} bytes served, ${gz} bytes gzip`
    + ` (${(gz / 1024).toFixed(0)} KB gzip), fetched lazily on the first .ts run only`);
  check('the TypeScript bytes at the tap are printed and nonzero',
    gz > 0 && refused.out?.tsBytes > 0,
    `worker read ${refused.out?.tsBytes} bytes; served ${bytes.length} B / ${gz} B gzip`);
  console.log(`NET   typescript.min.js requests seen by the page: ${net.ts} (urls: ${net.typescriptUrls.join(', ') || 'not surfaced by the page target'})`);

  const recs = await records(page);
  const execIntents = recs.filter((r) => r.kind === 'intent' && r.tool === 'run_js').length;
  const execResults = recs.filter((r) => r.kind === 'result' && r.out?.op === 'exec').length;
  check('every run is recorded as one intent and one result through the ledger',
    execIntents === execResults && execIntents > 0,
    `${execIntents} run_js intents, ${execResults} exec results`);

  await ctx.close();
  ctx = null;

  // ---- 6a. kill between the effect and its result: output recovered ------
  killDir = await mkdtemp(join(tmpdir(), 'agentjs-m6-kill-'));
  ({ ctx, page, net } = await launch(killDir));
  await waitReady(page);

  // The script's own durable evidence that it executed: a counter in OPFS
  // outside the workspace. A second execution would make it 2.
  await write(page, 'once.js', [
    'const root = await navigator.storage.getDirectory();',
    "const fh = await root.getFileHandle('m6-count', { create: true });",
    'let n = 0;',
    'try { n = Number(await (await fh.getFile()).text()) || 0; } catch {}',
    'const w = await fh.createWritable();',
    'await w.write(String(n + 1));',
    'await w.close();',
    "console.log('ran once');",
    '',
  ].join('\n'));
  await page.evaluate(() => {
    window.agent.holdAt('after-effect');
    window.__stepError = null;
    window.agent.step({
      node: 'root',
      tool: 'run_js',
      args: { path: 'once.js' },
    }).catch((e) => { window.__stepError = String(e?.stack || e); });
  });
  // Wait for the *effect*, not just the intent: the run has finished when its
  // done marker and its OPFS counter both exist. (A kill before the effect is
  // the mid-run case, tested below.)
  let markerDone = false;
  for (let i = 0; i < 120 && !markerDone; i += 1) {
    const st = await page.evaluate(async () => {
      const recs = await window.agent.records();
      const intents = recs.filter((r) => r.kind === 'intent');
      const results = recs.filter((r) => r.kind === 'result');
      const root = await navigator.storage.getDirectory();
      let marker = null;
      let count = null;
      try {
        const d = await root.getDirectoryHandle('agentjs-exec');
        const f = await d.getFileHandle('2.json');
        marker = JSON.parse(await (await f.getFile()).text()).status;
      } catch { /* not yet */ }
      try {
        const f = await root.getFileHandle('m6-count');
        count = await (await f.getFile()).text();
      } catch { /* not yet */ }
      return { intents: intents.length, results: results.length, marker, count, err: window.__stepError };
    });
    markerDone = st.intents === 2 && st.results === 1 && st.marker === 'done' && st.count === '1';
    if (!markerDone) await sleep(100);
  }
  check('the run finished before the kill (done marker and its own counter are on disk)', markerDone,
    `marker=${markerDone ? 'done' : 'missing'}`);
  await ctx.close();
  ctx = null;
  await sleep(500);

  ({ ctx, page, net } = await launch(killDir));
  await waitReady(page, '6a-first');
  const resumed = await inflight(page);
  const resumedRun = await screenshot(page);
  const count = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('m6-count');
    return (await fh.getFile()).text();
  });
  const recs2 = await records(page);
  check('a kill between a run\'s effect and result reopens as already settled',
    resumed.mark === 'seq:2' && /already settled/.test(resumed.text),
    JSON.stringify(resumed.text));
  check('the settled run was not executed a second time, and its output was recovered',
    count === '1' && resumedRun.exit === 'ok' && /ran once/.test(resumedRun.text)
      && recs2.filter((r) => r.kind === 'result' && r.seq === 2).length === 1,
    `OPFS counter=${count}, screen exit=${resumedRun.exit} (stdout from the done marker)`);

  await ctx.close();
  ctx = null;
  await sleep(500);

  // ---- 6b. kill mid-run: interrupted, never executed twice ---------------
  ({ ctx, page, net } = await launch(killDir));
  await waitReady(page, '6b-first');
  // The script's first act is a counter write; then it never returns. The kill
  // is taken only after that write exists, so the run is genuinely mid-flight.
  const SLOW = [
    'const root = await navigator.storage.getDirectory();',
    "const fh = await root.getFileHandle('m6-slow-count', { create: true });",
    'let n = 0;',
    'try { n = Number(await (await fh.getFile()).text()) || 0; } catch {}',
    'const w = await fh.createWritable();',
    'await w.write(String(n + 1));',
    'await w.close();',
    'while (true) {}',
  ].join('\n');
  await page.evaluate((src) => {
    window.__stepError = null;
    window.agent.step({
      node: 'root',
      tool: 'run_js',
      args: { path: 'slow.js', source: src, timeoutMs: 60_000 },
    }).catch((e) => { window.__stepError = String(e?.stack || e); });
  }, SLOW);
  let started = false;
  for (let i = 0; i < 150 && !started; i += 1) {
    const st = await page.evaluate(async () => {
      const recs = await window.agent.records();
      const intents = recs.filter((r) => r.kind === 'intent');
      const results = recs.filter((r) => r.kind === 'result');
      const root = await navigator.storage.getDirectory();
      let slow = null;
      try {
        const f = await root.getFileHandle('m6-slow-count');
        slow = await (await f.getFile()).text();
      } catch { /* not yet */ }
      return { last: intents.at(-1)?.seq, intents: intents.length, results: results.length, slow };
    });
    started = st.intents === 3 && st.results === 2 && st.slow === '1';
    if (!started) await sleep(100);
  }
  check('the mid-run kill was taken while the run was executing', started,
    started ? 'its counter is 1 and it has not returned' : 'the run did not start in time');
  await ctx.close();
  ctx = null;
  await sleep(500);

  const tReopen = Date.now();
  ({ ctx, page, net } = await launch(killDir));
  await waitReady(page, '6b-reopen');
  const reopenMs = Date.now() - tReopen;
  const interrupted = await screenshot(page);
  const resumedAgain = await inflight(page);
  const recs3 = await records(page);
  const slowResult = recs3.find((r) => r.kind === 'result' && r.seq === 3);
  const slowCount = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const f = await root.getFileHandle('m6-slow-count');
    return (await f.getFile()).text();
  });
  check('a kill mid-run reopens `interrupted`, without executing it again',
    interrupted.exit === 'interrupted'
      && slowResult?.out?.exit === 'interrupted'
      && /not run again/.test(slowResult?.out?.note || '')
      && slowCount === '1',
    `screen exit=${interrupted.exit}, its counter is still ${slowCount}, reopen=${reopenMs} ms (no cap waited out)`);
  check('the interrupted resume is named on the in-flight line and appended once',
    resumedAgain.mark === 'seq:3' && /already settled/.test(resumedAgain.text)
      && recs3.filter((r) => r.kind === 'result' && r.seq === 3).length === 1,
    JSON.stringify(resumedAgain.text));

  const stillWorks = await run(page, { source: "console.log('after resume');" });
  check('the page runs code again after an interrupted resume',
    stillWorks.out?.exit === 'ok' && stillWorks.out?.stdout === 'after resume\n',
    `exit=${stillWorks.out?.exit}`);

  await ctx.close();
  ctx = null;
} catch (e) {
  check('probe ran without an exception', false, `${e.name}: ${e.message}`);
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
  if (killDir) await rm(killDir, { recursive: true, force: true });
}

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
