// Regenerate the committed bundles in vendor/. They are build output, but a
// vendored file is still a file: the site is served without a build step, so the
// bundles are committed and this script only has to be re-runnable.
//
// isomorphic-git 1.44.4 ships no dist/ and its browser entry imports 8 bare
// specifiers, so it cannot load in a page unbundled; and its StreamReader throws
// "Missing Buffer dependency" without a global Buffer. The two bundles below are
// what tools/bench-iogit/build.mjs measured: 270 KB / 82 KB gzip for git and
// 28 KB / 8.7 KB gzip for the Buffer shim.
//
// TypeScript is the third bundle, and the one with a price: it is only fetched
// from the page on the first `.ts`/`.tsx` run, so a workspace that never runs TS
// never pays for it. The build prints its raw and gzip bytes because the tap's
// price has to be a number, not a surprise.
//
//   node tools/vendor.mjs
//
// The pinned dependencies are installed into a temporary directory and removed
// again, so the served tree gains only vendor/*.min.js and never node_modules/.
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const VERSIONS = {
  'isomorphic-git': '1.44.4',
  buffer: '6.0.3',
  typescript: '5.9.3',
  esbuild: '0.28.2',
};

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'vendor');

const ENTRIES = {
  'isomorphic-git.min.js': "import * as git from 'isomorphic-git'\nexport { git }\nexport default git\n",
  'buffer.min.js': "export { Buffer } from 'buffer'\n",
  'typescript.min.js': "import ts from 'typescript'\nexport { ts }\nexport default ts\n",
};

async function installDeps(dir) {
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'agentjs-vendor-build',
    private: true,
    type: 'module',
    dependencies: {
      'isomorphic-git': VERSIONS['isomorphic-git'],
      buffer: VERSIONS.buffer,
      typescript: VERSIONS.typescript,
    },
    devDependencies: { esbuild: VERSIONS.esbuild },
  }, null, 2));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`npm install exited ${r.status}`);
}

const dir = await mkdtemp(join(tmpdir(), 'agentjs-vendor-'));
try {
  await installDeps(dir);
  const { build } = await import(pathToFileURL(join(dir, 'node_modules/esbuild/lib/main.js')).href);
  await mkdir(OUT, { recursive: true });

  const common = { bundle: true, minify: true, format: 'esm', target: 'chrome120' };
  for (const [name, contents] of Object.entries(ENTRIES)) {
    const outfile = join(OUT, name);
    await build({
      ...common,
      stdin: { contents, resolveDir: dir, sourcefile: name, loader: 'js' },
      outfile,
    });
    const raw = await readFile(outfile);
    const gzip = gzipSync(raw, { level: 9 });
    console.log(`${name.padEnd(26)} ${raw.length} B  ${gzip.length} B gzip`);
  }
  console.log(`wrote ${OUT}/ from isomorphic-git@${VERSIONS['isomorphic-git']} + buffer@${VERSIONS.buffer} + typescript@${VERSIONS.typescript}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
