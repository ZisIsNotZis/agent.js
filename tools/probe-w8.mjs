// W8's acceptance, run rather than asserted.
//
//   node tools/serve.mjs &   then   node tools/probe-w8.mjs
//
// The scripted run is a sequence of steps through the existing step() path: two
// add_node steps make a two-level tree, two commits under different nodes, a
// status change, and a read. The probe then checks:
//
//   1. the DOM's node set, parent edges, statuses and step counts equal the
//      log's settled state, rebuilt independently from the records;
//   2. a reload with empty memory paints the identical tree, timeline and
//      default (newest-commit) diff;
//   3. the diff shown for a node equals `git show` of that step's commit, run by
//      the system git in a mirror repository — hunk text compared;
//   4. the timeline's row count equals the log's record count;
//   5. clicking a timeline row selects the same node and diff as clicking the
//      node;
//   6. it prints the node/edge/record counts it actually compared.
//
// The other probes (m1/m2/m3/m4/m6/shell/w7) are run separately.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

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

const URL_ = process.env.URL || 'http://127.0.0.1:8137/';
const EXE = process.env.CHROME_PATH || undefined;

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A1 = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
const A2 = 'alpha\nbeta\nGAMMA\ndelta\nepsilon\n';
const HELLO = "console.log('hello from the tree');\n";

// seqs: 1 add plan, 2 add impl, 3 plan done, 4 commit a, 5 commit a again,
// 6 commit hello, 7 impl done, 8 read a. The probe does not assume the numbers;
// it reads them from the records afterwards.
const STEPS = [
  { node: 'root', tool: 'add_node', args: { id: 'plan', parent: 'root' } },
  { node: 'root', tool: 'add_node', args: { id: 'impl', parent: 'plan' } },
  { node: 'plan', tool: 'set_status', args: { node: 'plan', status: 'done' } },
  { node: 'plan', tool: 'git_commit', args: { path: 'notes/a.txt', content: A1, message: 'write a' } },
  { node: 'impl', tool: 'git_commit', args: { path: 'notes/a.txt', content: A2, message: 'edit a' } },
  { node: 'impl', tool: 'git_commit', args: { path: 'src/hello.js', content: HELLO, message: 'add hello' } },
  { node: 'impl', tool: 'set_status', args: { node: 'impl', status: 'done' } },
  { node: 'root', tool: 'read', args: { path: 'notes/a.txt' } },
];

// The independent oracle: rebuild the tree from records alone. No view code is
// imported and no DOM is read; if this and the DOM agree, they agree as
// structures.
function oracleOf(records) {
  const intents = new Map();
  const results = new Map();
  for (const r of records) (r.kind === 'intent' ? intents : results).set(r.seq, r);
  const nodes = { root: { id: 'root', parent: null, status: 'idle', steps: 0 } };
  for (const seq of [...results.keys()].sort((a, b) => a - b)) {
    const out = results.get(seq).out;
    if (out?.op === 'add_node') {
      nodes[out.id] ??= { id: out.id, parent: out.parent ?? null, status: 'new', steps: 0 };
      nodes[out.id].parent = out.parent ?? null;
    } else if (out?.op === 'set_status') {
      nodes[out.node] ??= { id: out.node, parent: null, status: 'idle', steps: 0 };
      nodes[out.node].status = out.status;
    }
  }
  for (const intent of intents.values()) {
    const id = intent.node ?? 'root';
    nodes[id] ??= { id, parent: null, status: 'unrecorded', steps: 0 };
    nodes[id].steps += 1;
  }
  const list = Object.values(nodes).sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = list.filter((n) => n.parent != null).map((n) => `${n.parent}->${n.id}`).sort();
  return { nodes: list, edges };
}

const sortNodes = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
const sameNodes = (a, b) => JSON.stringify(sortNodes(a)) === JSON.stringify(sortNodes(b));

const hunkOf = (text) => {
  const lines = String(text).split('\n');
  const at = lines.findIndex((l) => l.startsWith('@@'));
  return at < 0 ? '' : lines.slice(at).join('\n').replace(/\n+$/, '');
};

async function readDom(page) {
  return page.evaluate(() => ({
    nodes: [...document.querySelectorAll('#tree-nodes li')].map((li) => ({
      id: li.dataset.node,
      parent: li.dataset.parent === '' ? null : li.dataset.parent,
      status: li.dataset.status,
      steps: Number(li.dataset.steps),
    })),
    edges: [...document.querySelectorAll('#tree-nodes li')]
      .filter((li) => li.dataset.parent !== '')
      .map((li) => `${li.dataset.parent}->${li.dataset.node}`).sort(),
    timeline: [...document.querySelectorAll('#timeline li')].map((li) => ({
      seq: Number(li.dataset.seq),
      kind: li.dataset.kind,
      node: li.dataset.node,
      tool: li.dataset.tool,
    })),
    selectedNodes: [...document.querySelectorAll('#tree-nodes li[data-selected="true"]')].map((li) => li.dataset.node),
    selectedRows: [...document.querySelectorAll('#timeline li[data-selected="true"]')].map((li) => Number(li.dataset.seq)),
    diffLabel: document.getElementById('diff-label').textContent,
    diff: document.getElementById('diff').textContent,
  }));
}

async function waitView(page, recordsCount, latestSeq) {
  await page.waitForFunction(({ want, seq }) => {
    const nodes = document.querySelectorAll('#tree-nodes li[data-node]').length;
    const rows = document.querySelectorAll('#timeline li[data-seq]').length;
    const diff = document.getElementById('diff').textContent;
    const label = document.getElementById('diff-label').textContent;
    return nodes > 0 && rows === want && !/reading the commit/.test(diff)
      && diff !== 'nothing selected' && (!seq || label.includes(`step ${seq} `));
  }, { want: recordsCount, seq: latestSeq }, { timeout: 30_000 });
}

async function launch(dir) {
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: EXE, headless: true });
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
}

// git in a mirror repository: the same writes and commit messages, so its
// `git show` is the diff the page's own git must have produced.
async function mirror(commits) {
  const dir = await mkdtemp(join(tmpdir(), 'agentjs-w8-git-'));
  const git = (...args) => run('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'agent.js');
  await git('config', 'user.email', 'agent@agent.js');
  const byMessage = new Map();
  for (const c of commits) {
    const path = join(dir, c.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, c.content);
    await git('add', c.path);
    await git('commit', '-q', '-m', `agent step ${c.seq}: ${c.message}`);
    const { stdout } = await git('log', '-1', '--format=%H');
    byMessage.set(`agent step ${c.seq}: ${c.message}`, stdout.trim());
  }
  return { dir, byMessage };
}

async function expectedDiff(mirrorDir, message) {
  const { stdout: log } = await run('git', ['log', '--format=%H%x09%s'], { cwd: mirrorDir });
  const line = log.split('\n').find((l) => l.split('\t')[1] === message);
  if (!line) throw new Error(`no mirror commit for ${JSON.stringify(message)}`);
  const sha = line.split('\t')[0];
  const { stdout } = await run('git', ['show', '--format=', '--no-color', sha], { cwd: mirrorDir });
  return hunkOf(stdout);
}

let dir = null;
let mirrorDir = null;

try {
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`the site is not served at ${URL_} (${e.message}); run: node tools/serve.mjs &`);
    process.exit(2);
  }

  dir = await mkdtemp(join(tmpdir(), 'agentjs-w8-'));
  let { ctx, page } = await launch(dir);
  await waitReady(page);

  const stepped = await page.evaluate(async (steps) => {
    const out = [];
    for (const s of steps) out.push(await window.agent.step(s));
    return out;
  }, STEPS);
  const records = await page.evaluate(() => window.agent.records());
  const oracle = oracleOf(records);
  const latestSeq = records
    .filter((r) => r.kind === 'result' && r.out?.op === 'git_commit')
    .map((r) => r.seq).sort((a, b) => a - b).at(-1);
  await waitView(page, records.length, latestSeq);

  const first = await readDom(page);
  const defaultDiff = first.diff;

  check('the scripted steps all settled', stepped.length === STEPS.length && records.length === STEPS.length * 2,
    `${stepped.length} steps, ${records.length} records`);

  check('DOM node set, parent edges and statuses equal the log\'s settled state',
    sameNodes(first.nodes, oracle.nodes) && JSON.stringify(first.edges) === JSON.stringify(oracle.edges),
    `${oracle.nodes.map((n) => `${n.id}[${n.status}]${n.parent ? `<-${n.parent}` : ''} steps=${n.steps}`).join(', ')}`
    + ` | edges ${oracle.edges.join(' ')}`);

  check('the timeline has one row per log record, in log order',
    first.timeline.length === records.length
      && first.timeline.every((r, i) => r.seq === records[i].seq && r.kind === records[i].kind),
    `${first.timeline.length} rows vs ${records.length} records: ${first.timeline.map((r) => `${r.kind}#${r.seq}`).join(' ')}`);

  // ---- the diff, against the system git that mirrors the commits ----------
  const mirrorCommits = [
    { seq: records.find((r) => r.kind === 'intent' && r.tool === 'git_commit' && r.args.path === 'notes/a.txt' && r.args.content === A1)?.seq, path: 'notes/a.txt', content: A1, message: 'write a' },
    { seq: records.find((r) => r.kind === 'intent' && r.tool === 'git_commit' && r.args.content === A2)?.seq, path: 'notes/a.txt', content: A2, message: 'edit a' },
    { seq: records.find((r) => r.kind === 'intent' && r.tool === 'git_commit' && r.args.path === 'src/hello.js')?.seq, path: 'src/hello.js', content: HELLO, message: 'add hello' },
  ];
  const m = await mirror(mirrorCommits);
  mirrorDir = m.dir;

  const commitSeqs = Object.fromEntries(mirrorCommits.map((c) => [c.message, c.seq]));
  const expected = {};
  for (const c of mirrorCommits) expected[c.message] = await expectedDiff(mirrorDir, `agent step ${c.seq}: ${c.message}`);

  // click the plan node: its one commit (write a)
  await page.click('#tree-nodes li[data-node="plan"]');
  await sleep(200);
  let dom = await readDom(page);
  check('the plan node shows git\'s diff of its own commit, hunk for hunk',
    hunkOf(dom.diff) === expected['write a'] && dom.selectedNodes.includes('plan'),
    `label="${dom.diffLabel}" hunks ${hunkOf(dom.diff).split('\n').length} lines`);

  // click the impl node: its newest commit (add hello)
  await page.click('#tree-nodes li[data-node="impl"]');
  await sleep(200);
  dom = await readDom(page);
  check('the impl node shows git\'s diff of its newest commit, hunk for hunk',
    hunkOf(dom.diff) === expected['add hello'] && dom.selectedNodes.includes('impl'),
    `label="${dom.diffLabel}" hunks ${hunkOf(dom.diff).split('\n').length} lines`);

  const implNodeDiff = dom.diff;
  const implNodeLabel = dom.diffLabel;

  // ---- 5. the timeline row selects the same node and diff -----------------
  const latestCommitSeq = commitSeqs['add hello'];
  await page.click(`#timeline li[data-seq="${latestCommitSeq}"][data-kind="result"]`);
  await sleep(200);
  dom = await readDom(page);
  check('a timeline row selects the same node and diff as clicking the node',
    dom.diff === implNodeDiff && dom.diffLabel === implNodeLabel
      && dom.selectedNodes.length === 1 && dom.selectedNodes[0] === 'impl'
      && dom.selectedRows.includes(latestCommitSeq),
    `row #${latestCommitSeq} -> node ${dom.selectedNodes.join(',')} label="${dom.diffLabel}"`);

  // ---- 2. reload with empty memory: identical ---------------------------------
  const before = {
    nodes: first.nodes,
    edges: first.edges,
    timeline: first.timeline,
    diff: defaultDiff,
  };
  await page.reload({ timeout: 60_000, waitUntil: 'load' });
  await page.waitForFunction(() => window.agent && window.agent.snapshot && window.agent.snapshot() !== null, null, { timeout: 30_000 });
  await waitView(page, records.length, latestSeq);
  const after = await readDom(page);

  check('a reload with empty memory paints the identical node set, edges and statuses',
    sameNodes(after.nodes, before.nodes) && JSON.stringify(after.edges) === JSON.stringify(before.edges),
    `${after.nodes.length} nodes, ${after.edges.length} edges`);
  check('a reload with empty memory paints the identical timeline',
    JSON.stringify(after.timeline) === JSON.stringify(before.timeline),
    `${after.timeline.length} rows`);
  check('a reload with empty memory shows the identical default (newest commit) diff',
    after.diff === before.diff,
    `label="${after.diffLabel}" same=${after.diff === before.diff}`);

  // ---- 3b. both commits, after the reload, still match git -----------------
  await page.click('#tree-nodes li[data-node="plan"]');
  await sleep(200);
  dom = await readDom(page);
  const planAfter = hunkOf(dom.diff);
  await page.click('#tree-nodes li[data-node="impl"]');
  await sleep(200);
  dom = await readDom(page);
  const implAfter = hunkOf(dom.diff);
  check('the reloaded view reproduces both commits\' diffs from git',
    planAfter === expected['write a'] && implAfter === expected['add hello'],
    `plan ${planAfter.split('\n').length} hunk lines, impl ${implAfter.split('\n').length} hunk lines`);

  console.log(`\nCOUNTS nodes=${oracle.nodes.length} edges=${oracle.edges.length} `
    + `records=${records.length} timeline=${after.timeline.length} commits=${mirrorCommits.length}`);

  await ctx.close();
  ctx = null;
} catch (e) {
  check('probe ran without an exception', false, `${e.name}: ${e.message}`);
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
  if (mirrorDir) await rm(mirrorDir, { recursive: true, force: true });
}

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
