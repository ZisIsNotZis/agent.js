// W10's acceptance, run rather than asserted, against a local mock provider.
//
//   node tools/serve.mjs &   then   node tools/probe-w10.mjs
//
// W10 is "the run builds the tree": the model declares its work with `plan`
// and every other tool call lands on the item the plan says is running. This
// probe drives one scripted run — two `plan` calls, then two writes and a
// commit — and checks that the result is a tree and not a decoration:
//
//   1. >= 3 nodes, >= 2 edges and >= 2 distinct statuses, counted from the DOM
//      and equal to the log's settled state, rebuilt independently;
//   2. the commits are attributed to the planned item, not to root — read from
//      the log's intents and from git, and shown on the node the screen paints;
//   3. the two `plan` steps land on root (the run's own bookkeeping) while the
//      writes and the commit land on the item that was running;
//   4. a reload with empty memory paints the identical tree, folded from the
//      log with nothing but the records;
//   5. the trajectory recorded the run and contains the `plan` calls.
//
// It prints the node/edge/status counts and which node each commit landed on,
// and writes the run's trace and summary to evidence/w10/.
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
const RECORDS = join(ROOT, '.tmp', `w10-mock-${process.pid}`);
const EVIDENCE = join(ROOT, 'evidence', 'w10');
const KEY = 'sk-w10-SECRET-8b1d3e5f';

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
const mockScript = (script) => mockFetch('/__script', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ script, resetCount: true }),
});

const config = () => ({ baseUrl: `${MOCK_URL}/v1`, model: 'mock-model', key: KEY });
const PROMPT = 'make the change and tell me when it is done';

const A_CONTENT = 'the notes file\n';
const HELLO_CONTENT = "console.log('hello from a planned item');\n";
const PLAN_A = { id: 'plan', title: 'decide what to change', status: 'running' };
const PLAN_B = { id: 'plan', title: 'decide what to change', status: 'done' };
const IMPL = { id: 'impl', title: 'write the files and commit hello', status: 'running' };
const IMPL_DONE = { id: 'impl', title: 'write the files and commit hello', status: 'done' };
const FINAL_TEXT = 'done: notes/a.txt and src/hello.js are written, hello.js is committed';

// Two plan calls, then two writes and a commit on the planned item, then a
// final message with no tool calls. The plan is what the tree is made of.
const SCRIPT = [
  { tool_calls: [{ name: 'plan', arguments: { items: [PLAN_A] } }] },
  { tool_calls: [{ name: 'plan', arguments: { items: [PLAN_B, IMPL] } }] },
  {
    tool_calls: [
      { name: 'write', arguments: { path: 'notes/a.txt', content: A_CONTENT } },
      { name: 'write', arguments: { path: 'src/hello.js', content: HELLO_CONTENT } },
      { name: 'git_commit', arguments: { path: 'src/hello.js', content: HELLO_CONTENT, message: 'add hello' } },
    ],
  },
  { tool_calls: [{ name: 'plan', arguments: { items: [IMPL_DONE] } }] },
  { content: FINAL_TEXT },
];

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

// The tree as the screen paints it, read from the DOM's own attributes.
async function readDom(page) {
  return page.evaluate(() => ({
    nodes: [...document.querySelectorAll('#tree-nodes li[data-node]')].map((li) => ({
      id: li.dataset.node,
      parent: li.dataset.parent === '' ? null : li.dataset.parent,
      status: li.dataset.status,
      steps: Number(li.dataset.steps),
      commits: Number(li.dataset.commits),
      title: li.dataset.title,
      text: li.textContent,
    })),
    rows: document.querySelectorAll('#timeline li[data-seq]').length,
    treePanel: document.getElementById('panels').dataset.tree,
  }));
}

const sortNodes = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
const edgesOf = (nodes) => sortNodes(nodes.filter((n) => n.parent != null))
  .map((n) => `${n.parent}->${n.id}`).sort();
const statusesOf = (nodes) => [...new Set(nodes.map((n) => n.status))].sort();

// The independent oracle: the tree rebuilt from the records alone, by the same
// rule the product documents — a `plan` result upserts its nodes, and a step
// counts on the node its intent names.
function oracleOf(records) {
  const nodes = { root: { id: 'root', parent: null, status: 'idle', steps: 0 } };
  const upsert = (id, parent, status) => {
    nodes[id] ??= { id, parent: parent ?? null, status: status ?? 'idle', steps: 0 };
    if (parent !== undefined) nodes[id].parent = parent;
    if (status !== undefined) nodes[id].status = status;
  };
  for (const r of [...records].sort((a, b) => a.seq - b.seq)) {
    if (r.kind === 'intent') {
      const id = r.node ?? 'root';
      upsert(id);
      nodes[id].steps += 1;
    } else if (r.out?.op === 'plan') {
      for (const n of r.out.nodes ?? []) upsert(n.id, n.parent ?? 'root', n.status);
    }
  }
  const list = sortNodes(Object.values(nodes));
  return { nodes: list, edges: edgesOf(list) };
}

// Only this probe's own two files are replaced; evidence/w10's screenshots
// belong to tools/shot.mjs and are never this probe's to delete.
async function prepareEvidence() {
  await mkdir(EVIDENCE, { recursive: true });
}

let mock = null;
let dir = null;

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

  await prepareEvidence();

  // ---- the scripted run ---------------------------------------------------
  dir = await mkdtemp(join(tmpdir(), 'agentjs-w10-'));
  const { ctx, page } = await launch(dir);
  await waitReady(page);
  await mockReset();
  await mockScript(SCRIPT);

  const ran = await page.evaluate(async ({ cfg, prompt }) => {
    window.AGENT_SEED = 'w10-acceptance-seed';
    await window.agent.configure(cfg);
    return window.agent.run(prompt);
  }, { cfg: config(), prompt: PROMPT });
  check('the run reached its final message with the plan and the work in it',
    ran?.turns === 5 && ran?.toolCalls === 6 && ran?.commits === 1,
    `${ran?.turns} requests, ${ran?.toolCalls} tool calls, ${ran?.commits} commit(s), trace ${ran?.runId}`);

  const records = await page.evaluate(() => window.agent.records());
  const oracle = oracleOf(records);
  await page.waitForFunction((want) => {
    const nodes = document.querySelectorAll('#tree-nodes li[data-node]').length;
    const rows = document.querySelectorAll('#timeline li[data-seq]').length;
    return nodes > 0 && rows === want && !/reading the commit/.test(document.getElementById('diff').textContent);
  }, records.length, { timeout: 30_000 });
  const before = await readDom(page);

  const nodeCount = before.nodes.length;
  const edgeCount = edgesOf(before.nodes).length;
  const statuses = statusesOf(before.nodes);

  check('the run produced a tree: >= 3 nodes, >= 2 edges, >= 2 distinct statuses',
    nodeCount >= 3 && edgeCount >= 2 && statuses.length >= 2,
    `nodes=${nodeCount} ${before.nodes.map((n) => `${n.id}[${n.status}]`).join(' ')} `
    + `| edges=${edgeCount} ${edgesOf(before.nodes).join(' ')} | statuses=${statuses.join(',')}`);

  check('the DOM tree equals the tree folded from the log alone',
    JSON.stringify(sortNodes(before.nodes.map(({ id, parent, status, steps }) => ({ id, parent, status, steps }))))
      === JSON.stringify(oracle.nodes.map(({ id, parent, status, steps }) => ({ id, parent, status, steps })))
    && JSON.stringify(edgesOf(before.nodes)) === JSON.stringify(oracle.edges),
    `${oracle.nodes.map((n) => `${n.id}[${n.status}] steps=${n.steps} <- ${n.parent}`).join(', ')}`);

  // ---- the commit belongs to the planned item, not to root ---------------
  const commitIntents = records.filter((r) => r.kind === 'intent' && r.tool === 'git_commit');
  const commitNodes = records
    .filter((r) => r.kind === 'result' && r.out?.op === 'git_commit')
    .map((r) => ({ seq: r.seq, path: r.out.path, node: commitIntents.find((i) => i.seq === r.seq)?.node ?? null }));
  check('every commit was attributed to the planned item, not to root',
    commitNodes.length === 1 && commitNodes.every((c) => c.node === IMPL.id),
    commitNodes.map((c) => `seq ${c.seq} ${c.path} -> node ${c.node}`).join(', ') || 'no commits');

  const git = await page.evaluate(() => window.agent.gitLog());
  const implNode = before.nodes.find((n) => n.id === IMPL.id);
  const rootNode = before.nodes.find((n) => n.id === 'root');
  check('the screen shows the commit on that node and none on root',
    git.length === 1 && implNode?.commits === 1 && rootNode?.commits === 0,
    `git has ${git.length} commit(s); impl node "${implNode?.text}" / root node "${rootNode?.text}"`);

  const planIntents = records.filter((r) => r.kind === 'intent' && r.tool === 'plan');
  const workIntents = records.filter((r) => r.kind === 'intent' && ['write', 'run_js', 'git_commit'].includes(r.tool));
  check('a plan step lands on root and the work lands on the running item',
    planIntents.length === 3 && planIntents.every((i) => i.node === 'root')
      && workIntents.length === 3 && workIntents.every((i) => i.node === IMPL.id),
    `plan steps on ${[...new Set(planIntents.map((i) => i.node))].join(',')}; `
    + `work steps on ${[...new Set(workIntents.map((i) => i.node))].join(',')}`);

  check('the item\'s own step count is real', implNode?.steps === 3 && implNode?.status === 'done',
    `impl: ${implNode?.steps} steps, status ${implNode?.status}, title "${implNode?.title}"`);

  // ---- the trajectory recorded the run, plan calls and all ----------------
  const traceText = await page.evaluate(() => window.agent.traceText());
  const summaryText = await page.evaluate(() => window.agent.traceSummary());
  const events = traceText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const planCalls = events.filter((e) => e.type === 'tool.call' && e.tool === 'plan');
  const planResults = events.filter((e) => e.type === 'tool.result' && e.tool === 'plan');
  check('the trace contains the plan calls, with their items and the node set they changed',
    planCalls.length === 3 && planResults.length === 3
      && planCalls.every((e) => Array.isArray(e.args?.items) && e.args.items.length > 0)
      && planResults.every((e) => e.out?.op === 'plan' && Array.isArray(e.out.nodes)),
    `${planCalls.length} plan calls, ${planResults.length} plan results, ${events.length} events`);

  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(join(EVIDENCE, 'trace.ndjson'), traceText);
  await writeFile(join(EVIDENCE, 'summary.md'), summaryText);
  const writtenTrace = await readFile(join(EVIDENCE, 'trace.ndjson'), 'utf8');
  check('the run\'s trace and summary are in evidence/w10',
    writtenTrace === traceText && !writtenTrace.includes(KEY) && summaryText.includes(git[0].oid),
    `${join(EVIDENCE, 'trace.ndjson')} — ${events.length} events, ${writtenTrace.length} bytes, 0 key hits; `
    + `summary names commit ${git[0].oid.slice(0, 12)}`);

  // ---- a reload with empty memory: the same tree, from the log -----------
  await page.reload({ timeout: 60_000, waitUntil: 'load' });
  await page.waitForFunction(
    () => window.agent && window.agent.snapshot && window.agent.snapshot() !== null,
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction((want) => {
    const nodes = document.querySelectorAll('#tree-nodes li[data-node]').length;
    const rows = document.querySelectorAll('#timeline li[data-seq]').length;
    return nodes > 0 && rows === want && !/reading the commit/.test(document.getElementById('diff').textContent);
  }, records.length, { timeout: 30_000 });
  const after = await readDom(page);
  const shape = (dom) => JSON.stringify(sortNodes(dom.nodes.map(({ id, parent, status, steps, commits }) => ({
    id, parent, status, steps, commits,
  }))));
  check('a reload with empty memory paints the identical tree, folded from the log',
    shape(after) === shape(before) && JSON.stringify(edgesOf(after.nodes)) === JSON.stringify(edgesOf(before.nodes)),
    `${after.nodes.length} nodes, ${edgesOf(after.nodes).length} edges, `
    + `${[...new Set(after.nodes.map((n) => n.status))].sort().join(',')} — same=${shape(after) === shape(before)}`);

  console.log(`\nCOUNTS nodes=${nodeCount} edges=${edgeCount} statuses=${statuses.length} `
    + `(${statuses.join(',')}) steps=${before.nodes.map((n) => `${n.id}:${n.steps}`).join(' ')}`);
  console.log(`COMMITS ${commitNodes.map((c) => `${c.path} -> ${c.node} (seq ${c.seq})`).join(', ')}`);
  console.log(`TREE ${before.nodes.map((n) => n.text).join(' | ')}`);

  await ctx.close();
} catch (e) {
  check('probe ran without an exception', false, `${e.name}: ${e.message}`);
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
  if (mock) mock.kill('SIGTERM');
}

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
