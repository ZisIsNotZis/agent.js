// Milestone 3's acceptance, run rather than asserted:
//   a scripted run is killed at seeded random points — between an intent and its
//   result, and between steps — and every reopen is checked against a kill-free
//   run of the same script: same settled state, same seq set, no duplicate seqs,
//   and the screen names exactly the one step that was re-run (or none).
//
// Run: node tools/serve.mjs &   then   node tools/probe-m3.mjs
// The server must already be on PORT (default 8137).
//
// The kill points are random but reproducible: SEED selects the shuffle of the
// 2*STEPS boundaries, and every boundary is killed at least once when
// KILLS >= 2*STEPS. A mid-step kill commits the intent and then hangs on a test
// hook, so the page dies exactly between intent and result — no timing race.
//
// The URL may be a live origin, so a load gets 60s and one retry; a load that
// fails twice is counted as NET and never read as a resume failure. Exit is 0
// only when every check passed, i.e. only when network=0.
//
// Playwright is found, not hard-coded, exactly as in probe-m1: bare
// `playwright-core`, or PLAYWRIGHT_CORE pointing at an install; CHROME_PATH
// overrides the executable.
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
const STEPS = Number(process.env.STEPS || 8);
const KILLS = Number(process.env.KILLS || 24);
// A live origin is a shared CDN, not a local server: 24 fresh-profile loads
// fired back to back is a burst the edge can stall on. The cadence is explicit
// so a run's pressure on the origin is a number, not an accident.
const CADENCE_MS = Number(process.env.CADENCE_MS ?? 2500);
const SEED = Number(process.env.SEED || Math.floor(Math.random() * 1e9));

// A tiny deterministic PRNG, so a failing seed can be run again verbatim.
function mulberry32(a) {
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

const script = Array.from({ length: STEPS }, (_, i) => (i % 2 === 0
  ? { node: 'root', tool: 'add_node', args: { id: `n${i / 2}`, parent: 'root' } }
  : { node: `n${(i - 1) / 2}`, tool: 'set_status', args: { node: `n${(i - 1) / 2}`, status: 'done' } }));

const boundaries = [];
for (let c = 0; c < STEPS; c += 1) {
  boundaries.push({ c, mid: true }); // kill after step c's intent, before its result
  boundaries.push({ c, mid: false }); // kill after step c's result, between steps
}
for (let i = boundaries.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rng() * (i + 1));
  [boundaries[i], boundaries[j]] = [boundaries[j], boundaries[i]];
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A load is the one part of this probe that can fail for a reason that is not
// the code: a live origin's CDN can be slow. Loads are patient once and retried
// once, and a load that fails twice is reported as NET — never folded into
// `consistent`, and never called a resume failure.
const NAV = { timeout: 60_000, waitUntil: 'load' };

let retries = 0;

const isNetwork = (e) => e?.name === 'TimeoutError'
  || /net::ERR_|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ABORTED/.test(e?.message || '');

async function controlling(page) {
  try {
    return await Promise.race([
      page.evaluate(() => navigator.serviceWorker.controller !== null),
      sleep(5000).then(() => { throw new Error('no answer in 5s'); }),
    ]);
  } catch (e) {
    return `unknown (${e.message.split('\n')[0]})`;
  }
}

// The last load that got far enough to answer, so a page stuck mid-navigation
// still reports what the SW was doing in that profile a moment earlier.
let lastLoad = null;

// goto with one retry. `label` names the attempt — a kill index, or the kill-free
// baseline. A repeat failure at the same label prints the navigation's own words
// and whether the SW was driving the page, then throws a NetworkError.
async function goto(page, label) {
  try {
    const res = await page.goto(URL_, NAV);
    lastLoad = { label, url: res?.url?.() ?? page.url(), controller: await controlling(page) };
    return res;
  } catch (e) {
    if (!isNetwork(e)) throw e;
    retries += 1;
    console.log(`RETRY  ${label} — goto timed out, retrying`);
    try {
      const res = await page.goto(URL_, NAV);
      lastLoad = { label, url: res?.url?.() ?? page.url(), controller: await controlling(page) };
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
      const err = new Error(`goto ${URL_} failed twice (first: ${e.message} / again: ${e2.message}, controller=${sw})`);
      err.name = 'NetworkError';
      err.network = true;
      throw err;
    }
  }
}

// Wait until the SW is active and driving this page: `sw.js` skips waiting and
// claims its clients, so a controlled load appears without a reload.
async function driven(page, ms = 15000) {
  try {
    await page.evaluate(async (t) => {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('no active SW')), t)),
      ]);
    }, ms);
  } catch { /* the check below is the answer */ }
  return (await controlling(page)) === true;
}

let cold = 0;

// A load the service worker is not driving fetched the shell from the origin:
// that is not a resume observation, so it is named COLD, the SW is given its
// chance to take control, and the load happens once more — counted apart from
// NET so neither can hide inside the other.
async function loaded(page, label) {
  await goto(page, label);
  await waitReady(page);
  if (await driven(page)) return;
  cold += 1;
  console.log(`COLD  ${label} — loaded with no service-worker controller; loading again once the SW controls the page`);
  await goto(page, `${label} (cold again)`);
  await waitReady(page);
  if (!(await driven(page))) console.log(`COLD  ${label} — still uncontrolled after the second load`);
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

async function waitReady(page) {
  await page.waitForFunction(
    () => window.agent && window.agent.snapshot && window.agent.snapshot() !== null,
    null,
    { timeout: 20000 },
  );
  await page.waitForFunction(() => {
    const t = document.getElementById('tree');
    return t && !t.textContent.includes('reading');
  }, null, { timeout: 20000 });
}

async function runStep(page, s) {
  return page.evaluate((st) => window.agent.step(st), s);
}

async function records(page) {
  return page.evaluate(() => window.agent.records());
}

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
  const a = [...intents.keys()].sort((x, y) => x - y).join(',');
  const b = [...results.keys()].sort((x, y) => x - y).join(',');
  if (a !== b) problems.push(`seq sets differ: intents {${a}} results {${b}}`);
  return problems;
}

// The kill-free run: same script, same fresh-profile shape, all steps settle.
// Prefix states are captured after each step so an interrupted reopen can be
// compared to exactly the part of the run that should have happened.
async function killFreeRun() {
  const dir = await mkdtemp(join(tmpdir(), 'agentjs-m3-base-'));
  const { ctx, page } = await launch(dir);
  try {
    await loaded(page, 'kill-free baseline');
    const prefixes = [];
    for (let i = 0; i < STEPS; i += 1) {
      await runStep(page, script[i]);
      const r = await page.evaluate(() => window.agent.replay());
      prefixes.push(r.state);
    }
    const recs = await records(page);
    return { prefixes, final: prefixes[STEPS - 1], recs };
  } finally {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const trials = [];
let consistent = 0;
let rerunNamed = 0;
let midTrials = 0;
let networkFails = 0;
let midNet = 0;

function finish() {
  console.log(`\nN=${KILLS} kills=${KILLS} consistent=${consistent} rerun-named=${rerunNamed} network=${networkFails} cold=${cold}`);
  console.log(`seed=${SEED} steps=${STEPS} mid-step kills=${midTrials} between-step kills=${KILLS - midTrials} retries=${retries} cadence=${CADENCE_MS}ms`);
  const failed = checks.filter((x) => !x.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

let baseline;
try {
  baseline = await killFreeRun();
} catch (e) {
  if (e.network) networkFails += 1;
  check('kill-free run', false, e.network ? `NET — ${e.message}` : `${e.name}: ${e.message}`);
  finish();
}
check('kill-free run has one intent and one result per seq',
  seqProblems(baseline.recs).length === 0,
  seqProblems(baseline.recs).join('; ') || `${baseline.recs.length} records, seqs 1..${STEPS}`);

for (let i = 0; i < KILLS; i += 1) {
  if (i > 0) await sleep(CADENCE_MS);
  const { c, mid } = boundaries[i % boundaries.length];
  if (mid) midTrials += 1;
  const where = mid ? `after intent of step ${c}` : `after result of step ${c}`;
  const dir = await mkdtemp(join(tmpdir(), 'agentjs-m3-'));
  let ctx = null;
  const problems = [];
  let namesOne = null;
  try {
    let page;
    ({ ctx, page } = await launch(dir));
    await loaded(page, `kill ${i + 1}/${KILLS}`);

    // Everything before the kill point runs normally.
    const doneBefore = mid ? c : c + 1;
    for (let k = 0; k < doneBefore; k += 1) await runStep(page, script[k]);

    if (mid) {
      // Commit step c's intent, then hang forever: this is the kill.
      await page.evaluate((st) => {
        window.agent.holdAt('after-intent');
        window.agent.step(st).catch(() => {});
      }, script[c]);
      await page.waitForFunction((seq) => window.agent.records()
        .then((rs) => rs.some((r) => r.kind === 'intent' && r.seq === seq)), c + 1, { timeout: 15000 });
    }

    await ctx.close();
    ctx = null;
    await sleep(60);

    // Reopen the same profile: this is the resume.
    ({ ctx, page } = await launch(dir));
    await loaded(page, `kill ${i + 1}/${KILLS} reopen`);

    const screen = await page.evaluate(() => ({
      text: document.getElementById('inflight').textContent,
      mark: document.getElementById('inflight').dataset.inflight,
      state: window.agent.snapshot(),
    }));
    const atReopen = await records(page);
    const reopenProblems = seqProblems(atReopen);
    if (reopenProblems.length) problems.push(...reopenProblems);
    if (JSON.stringify(screen.state) !== JSON.stringify(baseline.prefixes[c])) {
      problems.push('settled state after reopen differs from the kill-free prefix');
    }

    const seqMentions = screen.text.match(/seq \d+/g) || [];
    if (mid) {
      namesOne = screen.mark === `seq:${c + 1}` && /re-ran/.test(screen.text) && seqMentions.length === 1;
      if (!namesOne) problems.push(`screen did not name exactly the re-run of seq ${c + 1}: "${screen.text}"`);
    } else {
      namesOne = screen.mark === 'none' && /nothing was in flight/.test(screen.text) && seqMentions.length === 0;
      if (!namesOne) problems.push(`screen named something with nothing in flight: "${screen.text}"`);
    }

    // Continue the script from where it was interrupted, then replay once more.
    for (let k = c + 1; k < STEPS; k += 1) await runStep(page, script[k]);
    const final = await page.evaluate(() => window.agent.replay());
    const finalRecs = await records(page);
    const finalProblems = seqProblems(finalRecs);
    if (finalProblems.length) problems.push(...finalProblems);
    if (JSON.stringify(final.state) !== JSON.stringify(baseline.final)) {
      problems.push('final settled state differs from the kill-free run');
    }
    if (final.records !== baseline.recs.length) {
      problems.push(`record count ${final.records} != ${baseline.recs.length}`);
    }
  } catch (e) {
    if (e.network) {
      networkFails += 1;
      if (mid) midNet += 1;
      problems.push(`NET — ${e.message}`);
    } else {
      problems.push(`${e.name}: ${e.message}`);
    }
  } finally {
    if (ctx) await ctx.close();
    await rm(dir, { recursive: true, force: true });
  }

  const ok = problems.length === 0;
  if (ok) consistent += 1;
  if (ok && mid && namesOne) rerunNamed += 1;
  trials.push({ i, c, mid, ok });
  check(`kill ${i + 1}/${KILLS} at step ${c} ${mid ? 'after-intent' : 'after-result'}`,
    ok, problems.join('; ') || (mid ? 'state matched, one re-run named' : 'state matched, nothing named'));
}

const reached = KILLS - networkFails;
check('every reopen was consistent with the kill-free run', consistent === reached,
  `${consistent}/${reached} reopens that reached the page${networkFails ? `, ${networkFails} never got there (NET)` : ''}`);
check('every mid-step kill named exactly one re-run', rerunNamed === midTrials - midNet,
  `${rerunNamed}/${midTrials - midNet} mid-step kills${midNet ? `, ${midNet} NET` : ''}`);
check('no load failed on the network', networkFails === 0,
  networkFails ? `${networkFails} of ${KILLS} loads failed twice (NET)` : `${KILLS}/${KILLS} loads reached the page`);
check('every load was driven by the service worker', cold === 0,
  cold ? `${cold} loads loaded uncontrolled (COLD)` : 'the SW drove every load it was asked about');

finish();
