// Regenerate public/vendor/ from the pinned dependencies. The two bundles are
// build output, so they are not committed: `npm i && node build.mjs` reproduces
// them byte-for-byte at the versions in package.json.
//
// isomorphic-git 1.44.4 ships no dist/ and its browser entry imports 8 bare
// specifiers, so it cannot load in a page unbundled; and its StreamReader throws
// "Missing Buffer dependency" without a global Buffer, hence the second bundle.
import { build } from 'esbuild';

const common = { bundle: true, minify: true, format: 'esm', target: 'chrome120' };

await build({ ...common, entryPoints: ['entry-git.js'], outfile: 'public/vendor/isomorphic-git.min.js' });
await build({ ...common, entryPoints: ['entry-buffer.js'], outfile: 'public/vendor/buffer.min.js' });
console.log('wrote public/vendor/{isomorphic-git,buffer}.min.js');
