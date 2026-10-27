// W11's acceptance, run rather than asserted, against a local mock provider.
//
//   node tools/serve.mjs &   then   node tools/probe-w11.mjs
//
// W11 is "children run their own loops, and the whole tree resumes": `spawn`
// creates a child node with its own conversation and its own tool loop, the
// parent owns its liveness, and a boot restarts every node the log still calls
// `running` — from that node's own messages, not from this page's memory.
//
// What it checks, in two fresh profiles against per-node mock scripts:
//
//   1. a run where the root spawns two children, each doing one write and one
//      git_commit, produces >= 3 nodes with >= 2 children `done`; every commit
//      is attributed to the node whose loop issued it (mapping printed), and the
//      root's own steps are root's;
//   2. kill mid-run (every node held at its second model call, after its first
//      turn's effects), reopen, restart: every node that was `running` reaches a
//      settled state, and the reopened final tree equals the kill-free run's —
//      nodes, parent edges, statuses, per-node step counts and the per-node
//      commit set;
//   3. the `in flight` line names the restarted nodes by id before any key is
//      entered (data-restarted and the text);
//   4. the transcript shows children: one block per node, labelled by node id,
//      with each child's task, its tool calls and its own final message.
//
// The mock routes per node on the `x-agent-node` header the page sends; the
// control shapes are documented in tools/mock-provider.mjs. The probe writes
// only its own evidence (evidence/w11/probe-*.ndjson|md).
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const MOCK_PORT = Number(process.env.MOCK_PORT || 8138);
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const RECORDS = join(ROOT, '.tmp', `w11-mock-${process.pid}`);
const EVIDENCE = join(ROOT, 'evidence', 'w11');
const KEY = 'sk-w11-SECRET-2c7e9a1b';

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
const mockReset = () => mockFetch('/__reset', { method: 'POST', body: '{}' });
const mockScript = (nodes) => mockFetch('/__script', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nodes, resetCount: true }),
});

const config = () => ({ baseUrl: `${MOCK_URL}/v1`, model: 'mock-model', key: KEY });
const PROMPT = 'split the work between two children and finish';

const CHILD_A = 'child-a';
const CHILD_B = 'child-b';
const TASK_A = 'write src/a.js and commit it';
const TASK_B = 'write src/b.js and commit it';
const FINAL_A = 'child-a done: src/a.js is committed';
const FINAL_B = 'child-b done: src/b.js is committed';
const ROOT_FINAL = 'root done: two children finished and notes/root.txt is committed';
const A_CONTENT = "export const a = 'a';\n";
const B_CONTENT = "export const b = 'b';\n";
const ROOT_CONTENT = 'the root wrote this\n';

const ROOT_SCRIPT = [
  {
    tool_calls: [
      { name: 'spawn', arguments: { id: CHILD_A, task: TASK_A } },
      { name: 'spawn', arguments: { id: CHILD_B, task: TASK_B } },
      { name: 'git_commit', arguments: { path: 'notes/root.txt', content: ROOT_CONTENT, message: 'root notes' } },
    ],
  },
  { content: ROOT_FINAL },
];
const childScript = (file, content, message, final) => [
  {
    tool_calls: [
      { name: 'write', arguments: { path: file, content } },
      { name: 'git_commit', arguments: { path: file, content, message } },
    ],
  },
  { content: final },
];
const SCRIPTS = () => ({
  root: ROOT_SCRIPT,
  [CHILD_A]: childScript('src/a.js', A_CONTENT, 'child a file', FINAL_A),
  [CHILD_B]: childScript('src/b.js', B_CONTENT, 'child b file', FINAL_B),
});

async function launch(userDataDir) {
  const ctx = await chromium.launchPersistentContext(userDataDir, { executablePath: EXE, headless: true });
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

const readRecords = (page) => page.evaluate(() => window.agent.records());
const readDom = (page) => page.evaluate(() => ({
  nodes: [...document.querySelectorAll('#tree-nodes li[data-node]')].map((li) => ({
    id: li.dataset.node,
    parent: li.dataset.parent === '' ? null : li.dataset.parent,
    status: li.dataset.status,
    steps: Number(li.dataset.steps),
    commits: Number(li.dataset.commits),
    text: li.textContent,
  })),
}));

// The tree rebuilt from the log alone, by the documented rule: a plan result
// upserts its nodes, a spawn result creates a child, a set_status result moves a
// status, and every intent is a step on the node it names.
function treeOf(records) {
  const nodes = { root: { id: 'root', parent: null, status: 'idle', steps: 0 } };
  const upsert = (id, parent, status) => {
    nodes[id] ??= { id, parent: parent ?? null, status: status ?? 'idle', steps: 0 };
    if (parent !== undefined) nodes[id].parent = parent;
    if (status !== undefined) nodes[id].status = status;
  };
  const commits = [];
  for (const r of [...records].sort((a, b) => a.seq - b.seq)) {
    if (r.kind === 'intent') {
      const id = r.node ?? 'root';
      upsert(id);
      nodes[id].steps += 1;
      continue;
    }
    const out = r.out;
    if (out?.op === 'plan') for (const n of out.nodes ?? []) upsert(n.id, n.parent ?? 'root', n.status);
    else if (out?.op === 'spawn') upsert(out.id, out.parent, out.status);
    else if (out?.op === 'set_status') upsert(out.node, undefined, out.status);
    else if (out?.op === 'git_commit') {
      const intent = records.find((x) => x.kind === 'intent' && x.seq === r.seq);
      commits.push({ path: out.path, node: intent?.node ?? 'root', by: intent?.by ?? intent?.node ?? 'root' });
    }
  }
  const list = Object.values(nodes).sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = list.filter((n) => n.parent != null).map((n) => `${n.parent}->${n.id}`).sort();
  return { nodes: list, edges, commits };
}

// The comparable shape: ids, parents, statuses and step counts per node, plus
// each commit's path and owning node. Commit oids are not compared — a commit's
// hash carries its time and its seq, so two runs cannot have the same bytes.
const shape = (records) => {
  const t = treeOf(records);
  return JSON.stringify({
    nodes: t.nodes.map(({ id, parent, status, steps }) => ({ id, parent, status, steps })),
    edges: t.edges,
    commits: [...t.commits].sort((a, b) => (a.path < b.path ? -1 : 1)),
  });
};

let mock = null;
const dirs = [];

try {
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
      up = Boolean((await mockFetch('/__health'))?.ok);
    } catch {
      await sleep(100);
    }
  }
  check('the mock provider is up on its own port, recording to disk', up,
    up ? `${MOCK_URL} -> ${RECORDS}` : 'no /__health answer');
  if (!up) throw new Error('mock provider did not start');

  await mkdir(EVIDENCE, { recursive: true });

  // ---- 1 + 4. the kill-free run: two children, their own loops -----------
  const baseDir = await mkdtemp(join(tmpdir(), 'agentjs-w11-base-'));
  dirs.push(baseDir);
  let { ctx, page } = await launch(baseDir);
  await waitReady(page);
  await mockReset();
  await mockScript(SCRIPTS());

  const ran = await page.evaluate(async ({ cfg, prompt }) => {
    window.AGENT_SEED = 'w11-acceptance-seed';
    await window.agent.configure(cfg);
    return window.agent.run(prompt);
  }, { cfg: config(), prompt: PROMPT });
  const baseRecords = await readRecords(page);
  const base = treeOf(baseRecords);

  check('the run spawned two children and all three nodes reached a settled state',
    ran?.turns === 6 && ran?.toolCalls === 7 && ran?.commits === 3,
    `${ran?.turns} model request(s) across the tree (2 per node), ${ran?.toolCalls} tool call(s), `
    + `${ran?.commits} commit(s), trace ${ran?.runId}`);

  const children = base.nodes.filter((n) => n.id === CHILD_A || n.id === CHILD_B);
  check('>= 3 nodes with >= 2 children in done',
    base.nodes.length >= 3 && children.length === 2 && children.every((n) => n.status === 'done'),
    `${base.nodes.length} nodes: ${base.nodes.map((n) => `${n.id}[${n.status}]`).join(' ')}`);

  const mapping = base.commits
    .map((c) => `${c.path} -> node ${c.node} (by ${c.by})`)
    .sort();
  const commitOk = base.commits.length === 3
    && base.commits.every((c) => c.node === c.by)
    && base.commits.some((c) => c.node === 'root' && c.path === 'notes/root.txt')
    && base.commits.some((c) => c.node === CHILD_A && c.path === 'src/a.js')
    && base.commits.some((c) => c.node === CHILD_B && c.path === 'src/b.js');
  check('every commit is attributed to the node whose loop issued it', commitOk, mapping.join(', '));

  const rootOwn = baseRecords.filter((r) => r.kind === 'intent' && (r.by ?? r.node) === 'root');
  const spawnByRoot = rootOwn.filter((r) => r.tool === 'spawn');
  const childOwn = baseRecords.filter((r) => r.kind === 'intent'
    && ((r.by ?? r.node) === CHILD_A || (r.by ?? r.node) === CHILD_B));
  check('the root\'s own steps are root\'s and the children\'s steps are theirs',
    spawnByRoot.length === 2 && spawnByRoot.every((r) => r.node === 'root')
    && rootOwn.some((r) => r.tool === 'git_commit')
    && childOwn.length === 10 && childOwn.every((r) => r.node === r.by),
    `root issued ${rootOwn.length} step(s) (${[...new Set(rootOwn.map((r) => r.tool))].join(',')}); `
    + `children issued ${childOwn.length} step(s) on ${[...new Set(childOwn.map((r) => r.node))].join(',')}`);

  // ---- 4. the transcript, one block per node, labelled -------------------
  await page.waitForFunction(({ finals }) => {
    const el = document.getElementById('run-transcript');
    const done = [...document.querySelectorAll('#tree-nodes li[data-node]')]
      .every((li) => li.dataset.status === 'done' || li.dataset.node === 'root');
    return Boolean(el) && finals.every((t) => el.textContent.includes(t)) && done;
  }, { finals: [ROOT_FINAL, FINAL_A, FINAL_B] }, { timeout: 30_000 }).catch(() => {});
  const transcript = await page.evaluate(() => {
    const el = document.getElementById('run-transcript');
    return {
      blocks: [...el.querySelectorAll('[data-node]')].filter((n) => n.classList.contains('node-block'))
        .map((n) => ({ node: n.dataset.node, text: n.textContent })),
      all: el.textContent,
    };
  });
  const blockOf = (id) => transcript.blocks.find((b) => b.node === id);
  check('the transcript has one block per node, labelled by node id',
    transcript.blocks.length === 3 && [CHILD_A, CHILD_B, 'root'].every((id) => Boolean(blockOf(id))),
    transcript.blocks.map((b) => b.node).join(', '));
  check('each child\'s block shows its task, its own tool calls and its final message',
    [CHILD_A, CHILD_B].every((id) => {
      const b = blockOf(id);
      const task = id === CHILD_A ? TASK_A : TASK_B;
      const final = id === CHILD_A ? FINAL_A : FINAL_B;
      const file = id === CHILD_A ? 'src/a.js' : 'src/b.js';
      return b && b.text.includes(task) && b.text.includes(file)
        && /write →/.test(b.text) && /git_commit → commit/.test(b.text) && b.text.includes(final);
    }),
    [CHILD_A, CHILD_B].map((id) => `${id}: ${blockOf(id)?.text.length ?? 0} chars`).join(', '));
  check('the root\'s block carries the run\'s prompt and its final message',
    blockOf('root')?.text.includes(PROMPT) && blockOf('root')?.text.includes(ROOT_FINAL),
    `root block ${blockOf('root')?.text.length ?? 0} chars`);

  const baseTrace = await page.evaluate(() => window.agent.traceText());
  const baseSummary = await page.evaluate(() => window.agent.traceSummary());
  await writeFile(join(EVIDENCE, 'probe-baseline.ndjson'), baseTrace);
  await writeFile(join(EVIDENCE, 'probe-baseline.md'), baseSummary);
  check('the kill-free run\'s trace and summary are in evidence/w11',
    baseTrace.split('\n').filter(Boolean).length > 0 && !baseTrace.includes(KEY),
    `${join(EVIDENCE, 'probe-baseline.ndjson')} — ${baseTrace.split('\n').filter(Boolean).length} events, 0 key hits`);

  await ctx.close();
  ctx = null;

  console.log(`\nNODES ${base.nodes.map((n) => `${n.id}[${n.status}] steps=${n.steps}`).join(' ')}`);
  console.log(`COMMITS ${mapping.join(' | ')}`);

  // ---- 2 + 3. kill mid-run: hold every node at its second model call -----
  const killDir = await mkdtemp(join(tmpdir(), 'agentjs-w11-kill-'));
  dirs.push(killDir);
  ({ ctx, page } = await launch(killDir));
  await waitReady(page);
  await mockReset();
  await mockScript(SCRIPTS());

  const started = await page.evaluate(async ({ cfg, prompt }) => {
    window.AGENT_SEED = 'w11-acceptance-seed';
    await window.agent.configure(cfg);
    // Each node is held at request #2, after its first turn's effects landed, so
    // the kill leaves three named model calls in flight and every node running.
    window.agent.holdTurn('root', 2);
    window.agent.holdTurn('child-a', 2);
    window.agent.holdTurn('child-b', 2);
    window.agent.run(prompt).catch(() => {});
    return true;
  }, { cfg: config(), prompt: PROMPT });
  check('the run started with every node held at its second model call', started);

  let atKill = null;
  for (let i = 0; i < 200 && !atKill; i += 1) {
    const recs = await readRecords(page);
    const results = new Set(recs.filter((r) => r.kind === 'result').map((r) => r.seq));
    const open = recs.filter((r) => r.kind === 'intent' && r.tool === 'model_call' && !results.has(r.seq));
    const resultOf = (op) => recs.filter((r) => r.kind === 'result' && r.out?.op === op).length;
    if (open.length === 3
      && new Set(open.map((r) => r.node)).size === 3
      && resultOf('spawn') === 2 && resultOf('git_commit') === 3) {
      atKill = { records: recs, open: open.map((r) => r.node).sort() };
    } else {
      await sleep(100);
    }
  }
  check('the kill leaves one unfinished model call per node, after the spawns and commits',
    Boolean(atKill), atKill ? `open: ${atKill.open.join(', ')}` : 'never reached three open calls');

  const atKillTree = atKill ? treeOf(atKill.records) : null;
  const runningAtKill = atKillTree
    ? atKillTree.nodes.filter((n) => n.status === 'running').map((n) => n.id).sort()
    : [];
  check('every node is running at the kill',
    JSON.stringify(runningAtKill) === JSON.stringify(['child-a', 'child-b', 'root']),
    runningAtKill.join(', '));

  const countBeforeReopen = (await mockFetch('/__state')).count;
  await ctx.close();
  ctx = null;
  await sleep(100);

  // ---- reopen: the log names what to restart -----------------------------
  ({ ctx, page } = await launch(killDir));
  await waitReady(page);
  const inflight = await page.evaluate(() => {
    const el = document.getElementById('inflight');
    return { text: el.textContent, mark: el.dataset.inflight, restarted: (el.dataset.restarted ?? '').split(',').filter(Boolean) };
  });
  check('the in-flight line names every restarted node by id, before a key is entered',
    JSON.stringify([...inflight.restarted].sort()) === JSON.stringify(['child-a', 'child-b', 'root'])
    && ['root', CHILD_A, CHILD_B].every((id) => inflight.text.includes(id)),
    `data-restarted=[${inflight.restarted.join(',')}] "${inflight.text}"`);
  const countAtReopen = (await mockFetch('/__state')).count;
  check('no key after the reopen means nothing was re-sent',
    countAtReopen === countBeforeReopen,
    `mock count before the kill=${countBeforeReopen}, after the reopen=${countAtReopen}`);

  const resumed = await page.evaluate(async (cfg) => {
    await window.agent.configure(cfg);
    return window.agent.resumeAll();
  }, config());
  check('resumeAll restarted the nodes the log named',
    JSON.stringify([...resumed.restarted].sort()) === JSON.stringify(['child-a', 'child-b', 'root']),
    `restarted: ${(resumed.restarted ?? []).join(', ')}`);
  check('each restarted node re-issued its own interrupted call exactly once',
    (await mockFetch('/__state')).count === countAtReopen + 3,
    `mock count ${countAtReopen} -> ${(await mockFetch('/__state')).count} for 3 restarted nodes`);

  await page.waitForFunction(() => {
    const el = document.getElementById('run-transcript');
    return Boolean(el) && [...document.querySelectorAll('#tree-nodes li[data-node]')]
      .every((li) => li.dataset.status !== 'running');
  }, null, { timeout: 30_000 }).catch(() => {});

  const killRecords = await readRecords(page);
  const after = treeOf(killRecords);
  const afterDom = await readDom(page);
  check('every node that was running reached a settled state',
    after.nodes.every((n) => n.status !== 'running'),
    after.nodes.map((n) => `${n.id}[${n.status}]`).join(' '));
  check('the reopened final tree equals the kill-free run\'s tree',
    shape(killRecords) === shape(baseRecords),
    shape(killRecords) === shape(baseRecords)
      ? `same ${after.nodes.length} nodes, ${after.edges.length} edges, per-node steps `
        + `${after.nodes.map((n) => `${n.id}:${n.steps}`).join(' ')}`
      : `baseline ${shape(baseRecords)} vs reopened ${shape(killRecords)}`);
  check('the screen paints the same tree the log folds',
    JSON.stringify(afterDom.nodes.map(({ id, parent, status, steps }) => ({ id, parent, status, steps }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)))
      === JSON.stringify(after.nodes.map(({ id, parent, status, steps }) => ({ id, parent, status, steps }))),
    afterDom.nodes.map((n) => `${n.id}[${n.status}] ${n.steps} step(s)`).join(', '));

  const killTrace = await page.evaluate(() => window.agent.traceText());
  const killSummary = await page.evaluate(() => window.agent.traceSummary());
  await writeFile(join(EVIDENCE, 'probe-resume.ndjson'), killTrace);
  await writeFile(join(EVIDENCE, 'probe-resume.md'), killSummary);
  const resumeLines = killTrace.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const restartEvent = resumeLines.find((e) => e.type === 'run.start');
  check('the resume trace records which nodes were restarted',
    JSON.stringify([...(restartEvent?.restarted ?? [])].sort())
      === JSON.stringify(['child-a', 'child-b', 'root']) && !killTrace.includes(KEY),
    `${join(EVIDENCE, 'probe-resume.ndjson')} — restarted: ${(restartEvent?.restarted ?? []).join(', ')}, 0 key hits`);

  console.log(`\nRESUMED ${after.nodes.map((n) => `${n.id}[${n.status}] steps=${n.steps}`).join(' ')}`);
  console.log(`RESUME-COMMITS ${[...after.commits].sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((c) => `${c.path}->${c.node}`).join(', ')}`);
  console.log(`INFLIGHT "${inflight.text}"`);

  await ctx.close();
  ctx = null;
} catch (e) {
  check('probe ran without an exception', false, `${e.name}: ${e.message}`);
} finally {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  if (mock) mock.kill('SIGTERM');
}

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
