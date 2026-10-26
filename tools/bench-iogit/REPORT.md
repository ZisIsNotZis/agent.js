# isomorphic-git 1.44.4 over OPFS — measured 2026-10-26

Chromium `chromium_headless_shell-1234`, node v24.18.1, **main thread** (no Worker), async OPFS (`createWritable`). Hand-rolled `promises` adapter, no handle cache (every call walks from the OPFS root ⇒ upper bound). Fixture: 1.4 KB text per file, 10 files per directory, `src/d<n>/f<i>.txt`. Cold = fresh browser profile; warm = same profile, second run. Adapter constraint **verified, not assumed**: `stat`/`lstat` return `{type:'file', mode:0o100644, size, mtimeMs}` and `{type:'dir', mode:0o40000}`, and `git.statusMatrix` returned **0 dirty rows** in all 6 runs (both after commit 1 and commit 2).

| phase (ms) | 1k cold | 1k cold | 1k warm | 10k cold | 10k cold | 10k warm |
|---|---|---|---|---|---|---|
| `git.init` | 17.7 | 14.6 | 11.1 | 11.5 | 14.4 | 25.6 |
| gen: write all files | 2824 | 3068 | 3053 | 51409 | 30681 | 35436 |
| `git.add` (all files, one call) | 3042 | 3212 | 3452 | 40640 | 30415 | 29995 |
| `git.commit` (first) | 588 | 572 | 681 | 6833 | 9588 | 10998 |
| `git.statusMatrix` (clean) | 947 | 1039 | 1084 | 12356 | 14135 | 16051 |
| `git.log` (depth ∞, 1 commit) | 10.5 | 9.3 | 7.4 | 7.9 | 14.8 | 14.6 |
| 2nd commit: write 1 file | 3.6 | 2.8 | 2.3 | 8.4 | 231 | 10.8 |
| 2nd commit: `git.add` 1 file | 22.6 | 19.8 | 18.9 | 69 | 911 | 119 |
| 2nd commit: `git.commit` | 225 | 465 | 388 | 4059 | 2905 | 2896 |
| **2nd commit total (per-step cost)** | **251** | **487** | **409** | **4136** | **4047** | **3026** |
| full status again (control) | 1245 | 1434 | 2137 | 17862 | 15388 | 14669 |
| JS heap used/total, MB (after 2nd) | 26/46 | 24/46 | 26/74 | 77/141 | 30/114 | 88/128 |
| OPFS usage after, MB | 2.06 | 2.06 | 2.06 | 20.29 | 20.29 | 20.29 |

First build (`init`+gen+`add`+`commit`): **6.5–7.2 s at 1k**, **71–99 s at 10k**. Quota reported 10 GB; usage ≈ 1.4× the text bytes.

## Bundle and shims
`isomorphic-git@1.44.4` ships **no `dist/`** — its browser ESM entry is `index.js`, 566,672 B, with 8 bare imports (`sha.js`, `async-lock`, `clean-git-ref`, `crc-32`, `pako`, `pify`, `ignore`, `diff3`), so it cannot load in a page without a bundler or import map. esbuild (chrome120, minified ESM): **270,022 B / 82,312 B gzip**. `Buffer` **is required** (`StreamReader` throws `Missing Buffer dependency` without a global one): `buffer@6.0.3` minified adds **28,402 B / 8,733 B gzip**. `process` is **not** needed (only `typeof process !== 'undefined'`-guarded). Loaded per page: 298,424 B raw, **91,045 B gzip**.

## The sentence M4 can quote
A commit that touches one file costs **0.25–0.49 s at 1k files** and **3.0–4.1 s at 10k files** (median 0.39 s / 3.4 s), and the OPFS write is 2–11 ms of that — the other **~95% is `git.commit` rewriting the index and tree objects**.

## What the slope says
The per-step commit grew 8.7× for 10× the files (~0.3 ms/file); `git.status` grew 11–14× to 14 s and the full-tree `git.commit` 12–16×, so any design that runs a full status or a commit on a 10k tree pays seconds, and the same slope puts a 100k-file step in the tens of seconds. Peak JS heap reached 116–141 MB total at 10k — the number a phone tab must afford.

## not measured:
- not measured: any phone, Safari, or Firefox — desktop Chromium headless-shell only.
- not measured: Worker thread — main thread only; `createSyncAccessHandle` untested.
- not measured: `git.log` over real history — only 1 commit existed, so 7–15 ms is constant cost, not a walk.
- not measured: `clone`/`push`/`checkout`/`git.walk` — not on M4's path.
- not measured: an adapter with a handle cache — the naive one here is the upper bound.
- not measured: `rename` — 1.44.4 never calls it (grep of `index.js`), so that path is unexercised.
- not measured: warm HTTP cache — the bench server sends `no-store`, so the 91 KB gzip + shim was re-downloaded on every load; "warm" means storage-warm only.
- Raw runs: `raw-1000.json`, `raw-10000.json` (plus `raw-20.json` smoke). Driver `drive.mjs`, page `public/index.html` + `public/bench.js` + `public/opfs-fs.js`, server `server.mjs` (port 8140).
