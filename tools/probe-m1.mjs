// Milestone 1's acceptance, run rather than asserted:
//   a load writes the tree, a reload finds it, a *browser restart* finds it,
//   an offline reopen finds it, and the screen's persistence claim equals
//   navigator.storage.persisted() at every one of those points.
//
// Run: node tools/probe-m1.mjs   (server must already be running on PORT)
//
// The browser is found, not hard-coded: `npm i -D playwright-core` and it is used
// bare, or point PLAYWRIGHT_CORE at an install elsewhere (a file path or a package
// directory), and CHROME_PATH at a chromium binary if the bundle's own is not the
// one you want.
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
const userDataDir = await mkdtemp(join(tmpdir(), 'agentjs-m1-'));

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function launch() {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: EXE,
    headless: true,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });
  return { ctx, page };
}

async function read(page) {
  await page.waitForFunction(() => {
    const t = document.getElementById('tree');
    return t && !t.textContent.includes('reading');
  }, null, { timeout: 15000 });
  return page.evaluate(async () => {
    const claim = document.getElementById('claim');
    let persisted = null;
    try { persisted = await navigator.storage.persisted(); } catch {}
    const txt = document.getElementById('tree').textContent;
    const boots = Number((txt.match(/boots\s+(\d+)/) || [])[1]);
    return {
      persisted,
      claimAttr: claim.dataset.persisted,
      claimText: document.getElementById('persisted-value').textContent,
      standaloneAttr: document.getElementById('container').dataset.standalone,
      boots,
      treeText: txt,
      readBackAgrees: txt.includes('agrees with what was written'),
    };
  });
}

const agree = (r, where) => {
  const said = r.claimAttr === 'true' ? true : r.claimAttr === 'false' ? false : null;
  const literalShown = r.claimText.trim().startsWith(String(r.persisted));
  check(`claim equals persisted() — ${where}`, said === r.persisted && literalShown,
    `persisted()=${r.persisted} screen=${r.claimAttr} text="${r.claimText.slice(0, 60)}…"`);
};

// 1. first load creates the file
let { ctx, page } = await launch();
await page.goto(URL_, { waitUntil: 'load' });
const first = await read(page);
check('first load wrote the tree to OPFS', first.boots === 1 && first.readBackAgrees,
  `boots=${first.boots} read-back=${first.readBackAgrees}`);
check('a plain tab is reported as a tab', first.standaloneAttr === 'false', `standalone=${first.standaloneAttr}`);
agree(first, 'first load');

// 2. reload in the same tab finds it
await page.reload({ waitUntil: 'load' });
const second = await read(page);
check('reload finds the tree', second.boots === first.boots + 1, `boots ${first.boots} -> ${second.boots}`);
agree(second, 'after reload');

// 3. the ask does not overrule the reading
await page.click('#persist');
await page.waitForTimeout(500);
const afterAsk = await read(page);
agree(afterAsk, 'after navigator.storage.persist()');
check('the ask does not change the tree', afterAsk.boots === second.boots, `boots=${afterAsk.boots}`);

// 4. browser killed and restarted, same profile
await ctx.close();
({ ctx, page } = await launch());
await page.goto(URL_, { waitUntil: 'load' });
const afterRestart = await read(page);
check('a browser restart finds the tree', afterRestart.boots === second.boots + 1,
  `boots ${second.boots} -> ${afterRestart.boots}`);
agree(afterRestart, 'after browser restart');

// 5. offline reopen: the shell comes from the service worker, the tree from OPFS
const controlled = await page.evaluate(async () => {
  await navigator.serviceWorker.ready;
  return !!(await navigator.serviceWorker.getRegistration())?.active;
});
check('the service worker took control', controlled === true, `active=${controlled}`);
await page.waitForTimeout(500);
await ctx.setOffline(true);
await page.reload({ waitUntil: 'load' });
const offline = await read(page);
check('an offline reopen finds the tree', offline.boots === afterRestart.boots + 1,
  `boots ${afterRestart.boots} -> ${offline.boots}`);
agree(offline, 'offline reopen');
await ctx.setOffline(false);

console.log('\n--- what the screen says on the last load ---');
console.log(offline.treeText);

// 6. the same rule pointing the other way: with persisted() forced true, the
// screen must say so. A claim that only ever reads "false" is not a claim that
// follows the value.
const spoof = await ctx.newPage();
await spoof.addInitScript(() => {
  Object.defineProperty(navigator.storage, 'persisted', { value: async () => true, configurable: true });
});
await spoof.goto(URL_, { waitUntil: 'load' });
const forced = await read(spoof);
check('the claim follows persisted()=true as well',
  forced.claimAttr === 'true' && forced.claimText.startsWith('true') && /will not evict/.test(forced.claimText),
  `screen=${forced.claimAttr} text="${forced.claimText.slice(0, 40)}…"`);
await spoof.close();

await ctx.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
