// Photograph the page on demand, at a chosen viewport, full page.
//
//   SHOT=/tmp/agentjs.png WIDTH=1280 HEIGHT=1000 node tools/shot.mjs
//   SHOT=evidence/w8b/narrow.png WIDTH=390 HEIGHT=844 node tools/shot.mjs
//
// SHOT_DEMO=1 first runs four real steps through window.agent.step (two nodes,
// two commits), so the tree, diff and timeline are populated; without it the
// page is photographed as a person first meets it. Nothing here is part of the
// product or its probes.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

const DEMO = [
  { node: 'root', tool: 'add_node', args: { id: 'plan', parent: 'root' } },
  { node: 'root', tool: 'add_node', args: { id: 'impl', parent: 'plan' } },
  { node: 'plan', tool: 'git_commit', args: { path: 'notes/plan.txt', content: 'the plan\n', message: 'write the plan' } },
  { node: 'impl', tool: 'git_commit', args: { path: 'src/hello.js', content: "console.log('hello');\n", message: 'add hello' } },
];

const dir = await mkdtemp(join(tmpdir(), 'agentjs-shot-'));
let ctx = null;
try {
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`the site is not served at ${URL_} (${e.message}); run: node tools/serve.mjs &`);
    process.exit(2);
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

  await mkdir(dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT, fullPage: true });
  console.log(`${SHOT} — ${WIDTH}x${HEIGHT} viewport, full page${process.env.SHOT_DEMO === '1' ? ', after 4 demo steps' : ''}`);
} finally {
  if (ctx) await ctx.close();
  await rm(dir, { recursive: true, force: true });
}
