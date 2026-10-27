// The shell must cover the modules the app actually loads.
//
// The defect this exists for: `sw.js`'s SHELL was missing `./src/loop.js`,
// `./src/provider.js` and `./src/trace.js` for a whole workset. Offline the
// page booted (they are dynamic imports) but pressing Send could not load the
// loop. `probe-shell` could not catch it: its oracle is an independent copy of
// the list, so it could only prove the copy matched `sw.js`, never that the
// list matched the code. A check that asks `sw.js` what to expect has the same
// hole. This one walks the real module graph instead.
//
// The rule: start at `index.html`, follow every static `import … from './x.js'`,
// every `import('./x.js')`, `export … from './x.js'`, every
// `new URL('./x.js', import.meta.url)` (the worker body) and every literal
// `new Worker('./x.js')` / `importScripts('./x.js')`, transitively through
// `src/` and `vendor/`; normalize each path against the file that named it; and
// require every reached module to be an entry in `sw.js`'s SHELL. It is a text
// scan on purpose: no browser, no network, no build step.
//
// `LAZY` is a written rule, not a remembered one. `vendor/typescript.min.js` is
// 998 KB gzip and M6 decided it is fetched on the first `.ts` run and *never*
// in the shell; putting it in the shell would make every install pay for a
// file most runs never touch. It is named here with that reason, printed as
// lazy on every run, and nothing else is exempt — a new dynamically imported
// module fails this check until it is either in SHELL or added here with a
// reason, and adding it here is a visible decision rather than a silent pass.
//
// Run: node tools/probe-module-graph.mjs   (or via probe-shell, which calls it)
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LAZY = new Set(['vendor/typescript.min.js']);

const toPosix = (p) => p.split(sep).join('/');
const relOf = (root, abs) => toPosix(relative(root, abs));

// `root`-relative, no leading `./`, matching how SHELL entries are stored here.
const normEntry = (p) => p.replace(/^\.\//, '');

// Everything a file can name and that the graph must follow.
const PATTERNS = [
  // import x from './x.js'   |   import './x.js'   (multiline-safe)
  { re: /(?:^|[^\w$.])import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm, kind: 'static import' },
  // export … from './x.js'
  { re: /(?:^|[^\w$.])export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/gm, kind: 're-export' },
  // import('./x.js')
  { re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'dynamic import' },
  // new URL('./x.js', import.meta.url) — the worker body, and any module URL
  { re: /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g, kind: 'module URL' },
  // new Worker('./x.js') / importScripts('./x.js')
  { re: /\bnew\s+Worker\s*\(\s*['"]([^'"]+)['"]/g, kind: 'worker URL' },
  { re: /\bimportScripts\s*\(\s*['"]([^'"]+)['"]/g, kind: 'importScripts' },
];

const HTML_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g;

function isModulePath(spec) {
  return spec.endsWith('.js') || spec.endsWith('.mjs');
}

// Resolve a specifier the way the browser would, for the only case that is in
// this tree: a relative path. Bare and absolute-URL specifiers are not part of
// the graph this asserts (there is no bare import here, and a CDN import would
// be a decision to record, not to silently skip) — they are reported instead.
function resolveSpec(spec, fromAbs, root) {
  if (/^[a-z]+:/i.test(spec) || spec.startsWith('//')) return { external: true, spec };
  if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/')) {
    return { bare: true, spec };
  }
  const base = spec.startsWith('/') ? root : dirname(fromAbs);
  const abs = resolve(base, spec);
  const rel = relOf(root, abs);
  if (rel.startsWith('..')) return { outside: true, spec };
  return { abs, rel: normEntry(rel) };
}

export async function checkModuleGraph({ root = ROOT } = {}) {
  const entryAbs = join(root, 'index.html');
  const found = new Map(); // rel -> kind that first named it (ordered)
  const seen = new Set(); // rel already queued
  const queue = [entryAbs];
  found.set('index.html', 'entry');
  seen.add('index.html');
  const problems = [];
  const externals = [];
  const bare = [];
  const outside = [];

  // SHELL is read from the same tree the graph is walked in: the assertion is
  // about this tree, not about a deployed copy.
  let swSrc;
  try {
    swSrc = await readFile(join(root, 'sw.js'), 'utf8');
  } catch (e) {
    return { ok: false, modules: [], missing: [], problems: [`sw.js is unreadable: ${e.message}`], lazy: [], externals, bare, outside };
  }
  const block = (swSrc.match(/const SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
  const shell = new Set([...block.matchAll(/'([^']+)'/g)].map((m) => normEntry(m[1])));
  if (!block) problems.push('sw.js has no `const SHELL = [...]` list');

  while (queue.length) {
    const abs = queue.shift();
    const rel = normEntry(relOf(root, abs));
    let src;
    try {
      src = await readFile(abs, 'utf8');
    } catch (e) {
      problems.push(`${rel} is named by the graph but cannot be read (${e.code || e.message})`);
      continue;
    }
    // A vendored bundle is build output shipped as one file; its internal
    // `import` text is bundle machinery, not a module of this tree.
    if (rel.endsWith('.min.js')) continue;
    const isHtml = abs.endsWith('.html');
    const scan = isHtml ? [{ re: HTML_SCRIPT, kind: 'script src' }] : PATTERNS;
    for (const { re, kind } of scan) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        const spec = m[1];
        const r = resolveSpec(spec, abs, root);
        if (r.external) { externals.push(`${rel} -> ${spec} (${kind})`); continue; }
        if (r.bare) { bare.push(`${rel} -> ${spec} (${kind})`); continue; }
        if (r.outside) { outside.push(`${rel} -> ${spec} (${kind})`); continue; }
        if (isHtml && !isModulePath(r.rel)) continue; // icons, manifest: not modules
        if (!isModulePath(r.rel)) { problems.push(`${rel} names a non-module ${spec} (${kind})`); continue; }
        if (seen.has(r.rel)) continue;
        seen.add(r.rel);
        found.set(r.rel, kind);
        queue.push(r.abs);
      }
    }
  }

  const modules = [...found.keys()].sort();

  const missing = modules.filter((p) => !shell.has(p) && !LAZY.has(p));
  const lazy = modules.filter((p) => LAZY.has(p) && !shell.has(p));
  const actuallyLazyInShell = modules.filter((p) => LAZY.has(p) && shell.has(p));
  if (actuallyLazyInShell.length) {
    problems.push(`LAZY claims these are not in the shell, but they are: ${actuallyLazyInShell.join(', ')} — remove them from LAZY`);
  }
  for (const m of missing) problems.push(`missing from sw.js SHELL: ./${m}`);

  return {
    ok: problems.length === 0,
    modules,
    shell: [...shell],
    missing,
    lazy,
    externals,
    bare,
    outside,
    problems,
  };
}

// Runnable on its own: prints every module the graph found, then the verdict.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await checkModuleGraph({ root: process.env.ROOT || ROOT });
  console.log(`module graph from index.html: ${r.modules.length} modules`);
  const shellSet = new Set(r.shell);
  for (const m of r.modules) {
    const what = r.lazy.includes(m)
      ? 'lazy (deliberately not in SHELL: M6, 998 KB gzip, first .ts run only)'
      : shellSet.has(m) ? 'shell' : 'MISSING';
    console.log(`  ${what.padEnd(8)} ./${m}`);
  }
  for (const line of r.bare) console.log(`  note  bare specifier ${line}`);
  for (const line of r.externals) console.log(`  note  external specifier ${line}`);
  for (const line of r.outside) console.log(`  note  outside the tree: ${line}`);
  if (!r.ok) {
    console.log('\nFAIL — the shell does not cover the module graph:');
    for (const p of r.problems) console.log(`  ${p}`);
  } else {
    console.log(`\nPASS — every one of ${r.modules.length} modules is in sw.js SHELL (${r.lazy.length} declared lazy)`);
  }
  process.exit(r.ok ? 0 : 1);
}
