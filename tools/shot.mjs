// Photograph the page on demand, at a chosen viewport, full page.
//
//   SHOT=/tmp/agentjs.png WIDTH=1280 HEIGHT=1000 node tools/shot.mjs
//   SHOT=evidence/w8c/narrow-run.png WIDTH=390 HEIGHT=844 SHOT_RUN=1 node tools/shot.mjs
//
// SHOT_DEMO=1 first runs four real steps through window.agent.step (two nodes,
// two commits), so the tree, diff and timeline are populated; without it the
// page is photographed as a person first meets it.
//
// SHOT_RUN=1 starts tools/mock-provider.mjs itself (per-node scripts), drives the
// real controls (endpoint, model, key, Use key, prompt, Send) through a run where
// the root spawns two children and each runs its own loop, and writes the trace
// beside the picture — so the photographed
// screen carries a multi-node tree, not a one-node decoration. The shot is
// taken once that message is in #run-transcript, and the mock is stopped
// afterwards. Nothing here is part of the product or its probes.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

function playwrightSpecifier() {
  const p = process.env.PLAYWRIGHT_CORE;
  if (!p) return 'playwright-core';
  if (p.startsWith('/') || p.startsWith('.')) {
    return pathToFileURL(p.endsWith('.js') ? p : join(p, 'index.js')).href;
  }
  return p;
}

const SHOT = process.env.SHOT;
if (!SHOT) {
  console.error('set SHOT=/path/to.png (optional WIDTH, HEIGHT, URL, SHOT_DEMO=1, CHROME_PATH)');
  process.exit(2);
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
const WIDTH = Number(process.env.WIDTH || 1280);
const HEIGHT = Number(process.env.HEIGHT || 1000);
const EXE = process.env.CHROME_PATH || undefined;
const RUN = process.env.SHOT_RUN === '1';
const MOCK_PORT = Number(process.env.MOCK_PORT || 8138);
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const RUN_PROMPT = 'split the work: two children, each writes one file and commits it';
const HELLO = "console.log('hello from child hello');\n";
const NOTES = 'the child wrote the notes\n';
const ROOT_FILE = 'the root wrote this\n';
const RUN_FINAL = 'done: both children committed their files and I committed notes/root.txt';
const CHILD_HELLO_FINAL = 'child hello done: src/hello.js is committed';
const CHILD_NOTES_FINAL = 'child notes done: notes/plan.txt is committed';
// W11: the root spawns two children, each of which runs its own model loop and
// writes + commits one file; the root also commits its own. Per-node scripts,
// routed by the mock on x-agent-node, are what let the three conversations be
// different while the page only ever speaks one wire shape.
const RUN_NODES = {
  root: [
    {
      tool_calls: [
        { name: 'spawn', arguments: { id: 'child-hello', task: 'write src/hello.js and commit it' } },
        { name: 'spawn', arguments: { id: 'child-notes', task: 'write notes/plan.txt and commit it' } },
        { name: 'git_commit', arguments: { path: 'notes/root.txt', content: ROOT_FILE, message: 'root notes' } },
      ],
    },
    { content: RUN_FINAL },
  ],
  'child-hello': [
    {
      tool_calls: [
        { name: 'write', arguments: { path: 'src/hello.js', content: HELLO } },
        { name: 'git_commit', arguments: { path: 'src/hello.js', content: HELLO, message: 'add hello' } },
      ],
    },
    { content: CHILD_HELLO_FINAL },
  ],
  'child-notes': [
    {
      tool_calls: [
        { name: 'write', arguments: { path: 'notes/plan.txt', content: NOTES } },
        { name: 'git_commit', arguments: { path: 'notes/plan.txt', content: NOTES, message: 'add notes' } },
      ],
    },
    { content: CHILD_NOTES_FINAL },
  ],
};

const DEMO = [
  { node: 'root', tool: 'add_node', args: { id: 'plan', parent: 'root' } },
  { node: 'root', tool: 'add_node', args: { id: 'impl', parent: 'plan' } },
  { node: 'plan', tool: 'git_commit', args: { path: 'notes/plan.txt', content: 'the plan\n', message: 'write the plan' } },
  { node: 'impl', tool: 'git_commit', args: { path: 'src/hello.js', content: "console.log('hello');\n", message: 'add hello' } },
];

const dir = await mkdtemp(join(tmpdir(), 'agentjs-shot-'));
const mockRecords = RUN ? await mkdtemp(join(tmpdir(), 'agentjs-shot-mock-')) : null;
let ctx = null;
let mock = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockCall(path, init) {
  const res = await fetch(`${MOCK_URL}${path}`, init);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function startMock() {
  // A stale mock on the port would make this script drive someone else's
  // script; name it instead of silently reusing it.
  try {
    const h = await fetch(`${MOCK_URL}/__health`, { signal: AbortSignal.timeout(1000) });
    if (h.ok) throw new Error(`something is already listening on ${MOCK_URL}; stop it first`);
  } catch (e) {
    if (/already listening/.test(e.message)) throw e;
  }
  mock = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'mock-provider.mjs')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_RECORD_DIR: mockRecords },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`));
  for (let i = 0; i < 100; i += 1) {
    try {
      const h = await mockCall('/__health');
      if (h?.ok) return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`the mock provider did not answer on ${MOCK_URL}`);
}

try {
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`the site is not served at ${URL_} (${e.message}); run: node tools/serve.mjs &`);
    process.exit(2);
  }

  if (RUN) {
    await startMock();
    await mockCall('/__reset', { method: 'POST', body: '{}' });
    await mockCall('/__script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodes: RUN_NODES, resetCount: true }),
    });
  }

  ctx = await chromium.launchPersistentContext(dir, {
    executablePath: EXE,
    headless: true,
    viewport: { width: WIDTH, height: HEIGHT },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
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

  if (process.env.SHOT_DEMO === '1') {
    await page.evaluate(async (steps) => {
      for (const s of steps) await window.agent.step(s);
    }, DEMO);
    await page.waitForFunction((want) => {
      const rows = document.querySelectorAll('#timeline li[data-seq]').length;
      const info = document.getElementById('export-info').textContent;
      return rows === want && info.includes(`${want} log records`);
    }, DEMO.length * 2, { timeout: 30_000 });
  }

  if (RUN) {
    await page.fill('#base-url', `${MOCK_URL}/v1`);
    await page.fill('#model-name', 'mock-model');
    await page.fill('#key-input', 'sk-shot-run-local-mock');
    await page.click('#key-set');
    await page.fill('#prompt', RUN_PROMPT);
    await page.click('#send');
    await page.waitForFunction((finals) => {
      const el = document.getElementById('run-transcript');
      const status = document.getElementById('run-status').textContent;
      const nodes = [...document.querySelectorAll('#tree-nodes li[data-node]')];
      const settled = nodes.length >= 3 && nodes.every((li) => li.dataset.status !== 'running');
      return Boolean(el) && finals.every((t) => el.textContent.includes(t))
        && settled && /\bdone\b/.test(status);
    }, [RUN_FINAL, CHILD_HELLO_FINAL, CHILD_NOTES_FINAL], { timeout: 120_000 });
  }

  await mkdir(dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT, fullPage: true });
  if (RUN) {
    // The run's trajectory, beside the picture: a red run is debugged from it,
    // and the same run is the evidence for the tree the picture shows.
    const stem = join(dirname(SHOT), basename(SHOT).replace(/\.png$/, ''));
    const trace = await page.evaluate(() => window.agent.traceText());
    const summary = await page.evaluate(() => window.agent.traceSummary());
    await writeFile(`${stem}.trace.ndjson`, trace);
    await writeFile(`${stem}.summary.md`, summary);
    console.log(`${stem}.trace.ndjson — ${trace.split('\n').filter(Boolean).length} events`);
  }
  console.log(`${SHOT} — ${WIDTH}x${HEIGHT} viewport, full page${RUN ? ', after a completed multi-node run' : ''}${process.env.SHOT_DEMO === '1' ? ', after 4 demo steps' : ''}`);
} finally {
  if (ctx) await ctx.close();
  if (mock) mock.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
  if (mockRecords) await rm(mockRecords, { recursive: true, force: true });
}
