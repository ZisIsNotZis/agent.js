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
    await page.goto(URL_, { waitUntil: 'load' });
    await waitReady(page);
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

const baseline = await killFreeRun();
check('kill-free run has one intent and one result per seq',
  seqProblems(baseline.recs).length === 0,
  seqProblems(baseline.recs).join('; ') || `${baseline.recs.length} records, seqs 1..${STEPS}`);

const trials = [];
let consistent = 0;
let rerunNamed = 0;
let midTrials = 0;

for (let i = 0; i < KILLS; i += 1) {
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
    await page.goto(URL_, { waitUntil: 'load' });
    await waitReady(page);

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
    await page.goto(URL_, { waitUntil: 'load' });
    await waitReady(page);

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
    problems.push(`${e.name}: ${e.message}`);
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

check('every reopen was consistent with the kill-free run', consistent === KILLS, `${consistent}/${KILLS}`);
check('every mid-step kill named exactly one re-run', rerunNamed === midTrials,
  `${rerunNamed}/${midTrials} mid-step kills`);

console.log(`\nN=${KILLS} kills=${KILLS} consistent=${consistent} rerun-named=${rerunNamed}`);
console.log(`seed=${SEED} steps=${STEPS} mid-step kills=${midTrials} between-step kills=${KILLS - midTrials}`);

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
