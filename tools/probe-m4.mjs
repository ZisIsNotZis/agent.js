// Milestone 4's acceptance, run rather than asserted:
//   two scripted steps over the real tools (write + git_commit each) produce two
//   commits; git.log read back *in the page through isomorphic-git* shows both;
//   the file each step wrote is readable through the `read` tool; and a kill
//   between a commit's intent and its result reopens as "already settled" with
//   the commit count still 2, not 3.
//
// Run: node tools/serve.mjs &   then   node tools/probe-m4.mjs
// The server must already be on PORT (default 8137).
//
// Timing is printed, not asserted vaguely: each step's effect (the OPFS write
// and the one-path commit) is timed in the page and printed next to the bench's
// 0.25–0.49 s at 1k and 3.0–4.1 s at 10k, with the probe tree's file count.
//
// "The step path never calls a full statusMatrix" is checked by grep of the
// served modules src/tools.js, src/run.js and src/fs.js — the modules a step can
// reach — and the probe prints that this is the method. (The bench measured a
// full status at 12–18 s at 10k; a step that ran one is out of budget by 20×.)
//
// Playwright is found exactly as in probe-m1/m3: bare `playwright-core`, or
// PLAYWRIGHT_CORE pointing at an install; CHROME_PATH overrides the executable.
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

// The two-step script: each step is one tool call and one commit.
const A = { path: 'notes/a.txt', content: 'first step\n' };
const B = { path: 'notes/b.txt', content: 'second step\n' };
const script = [
  { node: 'root', tool: 'git_commit', args: { ...A, message: 'write a' } },
  { node: 'root', tool: 'git_commit', args: { ...B, message: 'write b' } },
];

const BENCH = 'bench (tools/bench-iogit/REPORT.md): 0.25–0.49 s per one-file commit at 1k files, 3.0–4.1 s at 10k';

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

async function runStep(page, s) {
  return page.evaluate((st) => window.agent.step(st), s);
}

const records = (page) => page.evaluate(() => window.agent.records());
const commits = (page) => page.evaluate(() => window.agent.gitLog());
const inflight = (page) => page.evaluate(() => ({
  text: document.getElementById('inflight').textContent,
  mark: document.getElementById('inflight').dataset.inflight,
}));

// Count files in the workspace (not .git) through the same fs adapter the tools use.
async function fileCount(page) {
  return page.evaluate(async () => {
    const fs = await window.agent.getFs();
    async function walk(path) {
      let n = 0;
      for (const e of await fs.ls(path)) {
        if (path === '.' && e.name === '.git') continue;
        const child = path === '.' ? e.name : `${path}/${e.name}`;
        n += e.type === 'dir' ? await walk(child) : 1;
      }
      return n;
    }
    return walk('.');
  });
}

const problems = (recs) => {
  const out = [];
  const intents = new Map();
  const results = new Map();
  for (const r of recs) {
    const m = r.kind === 'intent' ? intents : results;
    m.set(r.seq, (m.get(r.seq) || 0) + 1);
  }
  for (const [seq, n] of intents) if (n !== 1) out.push(`intent seq ${seq} x${n}`);
  for (const [seq, n] of results) if (n !== 1) out.push(`result seq ${seq} x${n}`);
  for (const seq of intents.keys()) if (!results.has(seq)) out.push(`seq ${seq}: intent without result`);
  for (const seq of results.keys()) if (!intents.has(seq)) out.push(`seq ${seq}: result without intent`);
  return out;
};

let baselineDir = null;
let killDir = null;
let effectMs = [];

try {
  // ---- the two-step run, no kill -----------------------------------------
  baselineDir = await mkdtemp(join(tmpdir(), 'agentjs-m4-base-'));
  let { ctx, page } = await launch(baselineDir);

  await waitReady(page);
  const booted = await page.evaluate(async () => {
    const fs = await window.agent.getFs();
    const git = await window.agent.getGit();
    return {
      fs: typeof fs.read === 'function' && typeof fs.promises?.readFile === 'function',
      git: typeof git.init === 'function' && typeof git.commit === 'function',
      status: document.getElementById('inflight').dataset.inflight,
    };
  });
  check('page booted with the fs adapter and isomorphic-git', booted.fs && booted.git,
    `fs=${booted.fs} git=${booted.git} inflight=${booted.status}`);

  const s1 = await runStep(page, script[0]);
  const s2 = await runStep(page, script[1]);
  effectMs = [s1.effectMs, s2.effectMs];
  check('step 1 committed through git_commit', s1.out?.op === 'git_commit' && !!s1.out.oid,
    `seq ${s1.seq}, ${Math.round(s1.effectMs)} ms, oid ${String(s1.out?.oid).slice(0, 7)}`);
  check('step 2 committed through git_commit', s2.out?.op === 'git_commit' && !!s2.out.oid,
    `seq ${s2.seq}, ${Math.round(s2.effectMs)} ms, oid ${String(s2.out?.oid).slice(0, 7)}`);
  const filesAtCommit = await fileCount(page);

  const log1 = await commits(page);
  const msgs = log1.map((c) => c.commit.message);
  check('git.log read back in the page through isomorphic-git shows both commits',
    log1.length === 2 && msgs.some((m) => m.startsWith('agent step 1:')) && msgs.some((m) => m.startsWith('agent step 2:')),
    `${log1.length} commits: ${msgs.map((m) => JSON.stringify(m.split('\n')[0])).join(', ')}`);
  check('the two commits are distinct', log1.length === 2 && log1[0].oid !== log1[1].oid,
    log1.map((c) => c.oid.slice(0, 7)).join(' vs '));

  const r1 = await runStep(page, { node: 'root', tool: 'read', args: { path: A.path } });
  const r2 = await runStep(page, { node: 'root', tool: 'read', args: { path: B.path } });
  check('the first file is readable through the read tool and matches',
    r1.out?.content === A.content, `${A.path}: ${JSON.stringify(r1.out?.content)}`);
  check('the second file is readable through the read tool and matches',
    r2.out?.content === B.content, `${B.path}: ${JSON.stringify(r2.out?.content)}`);

  const w = await runStep(page, { node: 'root', tool: 'write', args: { path: 'scratch.txt', content: 'scratch\n' } });
  const l = await runStep(page, { node: 'root', tool: 'ls', args: { path: 'notes' } });
  check('write and ls work over the same fs adapter',
    w.out?.op === 'write' && l.out?.entries?.some((e) => e.name === 'a.txt') && l.out.entries.some((e) => e.name === 'b.txt'),
    `ls notes: ${(l.out?.entries || []).map((e) => `${e.name}(${e.type})`).join(', ')}`);

  const log2 = await commits(page);
  check('observation steps add no commit', log2.length === 2, `${log2.length} commits after read/write/ls`);

  console.log(`TIME  step 1 effect ${Math.round(s1.effectMs)} ms · step 2 effect ${Math.round(s2.effectMs)} ms · probe tree at commit time: ${filesAtCommit} files (the bench's 1k/10k fixture is not built here)`);
  console.log(`TIME  ${BENCH}`);
  check('per-step commit timing recorded', effectMs.every((n) => Number.isFinite(n) && n >= 0),
    `${effectMs.map((n) => `${Math.round(n)} ms`).join(' / ')} at ${filesAtCommit} files`);

  // ---- the step path never runs a full status ----------------------------
  const modules = ['src/tools.js', 'src/run.js', 'src/fs.js'];
  const grep = await page.evaluate(async (paths) => {
    const hits = [];
    for (const p of paths) {
      const text = await (await fetch(`./${p}`)).text();
      if (text.includes('statusMatrix')) hits.push(p);
    }
    return hits;
  }, modules);
  check('the step path never calls statusMatrix (grep of the served modules)',
    grep.length === 0, grep.length ? `found in ${grep.join(', ')}` : `method=grep: ${modules.join(', ')} — 0 hits`);

  const recs1 = await records(page);
  check('baseline ledger has one intent and one result per seq',
    problems(recs1).length === 0, problems(recs1).join('; ') || `${recs1.length} records`);

  await ctx.close();
  ctx = null;

  // ---- the same two steps, killed between step 2's effect and its result --
  killDir = await mkdtemp(join(tmpdir(), 'agentjs-m4-kill-'));
  ({ ctx, page } = await launch(killDir));
  await waitReady(page);
  await runStep(page, script[0]);

  // Step 2's effect (the commit) lands, then the page hangs before the result.
  await page.evaluate((st) => {
    window.agent.holdAt('after-effect');
    window.__stepError = null;
    window.agent.step(st).catch((e) => { window.__stepError = String(e?.stack || e); });
  }, script[1]);
  let committed = false;
  let stepError = null;
  for (let i = 0; i < 120 && !committed && !stepError; i += 1) {
    const st = await page.evaluate(async () => ({
      err: window.__stepError,
      n: await window.agent.gitLog().then((cs) => cs.length).catch(() => 0),
    }));
    stepError = st.err;
    committed = st.n >= 2;
    if (!committed) await sleep(250);
  }
  check('step 2\'s commit landed before the kill', committed, stepError || 'commit visible in git.log');
  const beforeKill = await commits(page);

  await ctx.close();
  ctx = null;
  await sleep(60);

  // Reopen the same profile: this is the resume.
  ({ ctx, page } = await launch(killDir));
  await waitReady(page);

  const screen = await inflight(page);
  const after = await commits(page);
  check('the reopen names the interrupted git_commit as already settled',
    screen.mark === 'seq:2' && /already settled/.test(screen.text),
    JSON.stringify(screen.text));
  check('the commit count after the kill is still 2, not 3',
    beforeKill.length === 2 && after.length === 2,
    `before kill ${beforeKill.length}, after reopen ${after.length}`);
  check('git.log after the reopen still shows both commits',
    after.length === 2 && after.some((c) => c.commit.message.startsWith('agent step 1:')) && after.some((c) => c.commit.message.startsWith('agent step 2:')),
    after.map((c) => c.commit.message.split('\n')[0]).join(' | '));

  const recs2 = await records(page);
  check('the reopen appended one result for seq 2 and no duplicate',
    problems(recs2).length === 0 && recs2.filter((r) => r.kind === 'result' && r.seq === 2).length === 1,
    problems(recs2).join('; ') || `${recs2.length} records, seq 2 has one result`);

  const r2b = await runStep(page, { node: 'root', tool: 'read', args: { path: B.path } });
  check('the file the interrupted step wrote is readable after the reopen',
    r2b.out?.content === B.content, `${B.path}: ${JSON.stringify(r2b.out?.content)}`);

  const finalLog = await commits(page);
  check('reading after the reopen still leaves two commits', finalLog.length === 2,
    `${finalLog.length} commits`);

  await ctx.close();
  ctx = null;
} catch (e) {
  check('probe ran without an exception', false, `${e.name}: ${e.message}`);
} finally {
  if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
  if (killDir) await rm(killDir, { recursive: true, force: true });
}

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
