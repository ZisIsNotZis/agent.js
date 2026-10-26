# bench-iogit — isomorphic-git over OPFS, timed

This is a measurement, not a product path, and nothing in it is served to a person:
`tools/serve.mjs` serves the project root, so the files exist in the published tree
but nothing links to them.

The question it answers, and `ROADMAP.md`'s M4 quotes the answer:
**what does a per-step git commit cost over OPFS at 1k and at 10k files?**

## Run

```
cd tools/bench-iogit
npm i                    # isomorphic-git 1.44.4, playwright-core, esbuild, buffer
node build.mjs           # writes public/vendor/*.min.js (not committed, reproducible)
node server.mjs &        # http://127.0.0.1:8140/
CHROME_PATH=/path/to/chrome node drive.mjs 1000 10000
```

`drive.mjs <sizes…>` runs each size in a fresh profile (cold) and again in the same
profile (warm) and writes `raw-<size>.json`.

## Result, measured 2026-10-26

`REPORT.md` holds the full table, the bundle cost and the `not measured:` lines.
The two numbers that matter:

- **per-step commit, 1 file touched:** 0.25–0.49 s at 1k files, 3.0–4.1 s at 10k;
- **first build** (init + write + add + commit of everything): 6.5–7.2 s at 1k, 71–99 s at 10k.

Desktop Chromium headless shell, main thread, naive adapter with no handle cache —
so these are upper bounds. No phone, no Safari, no Firefox, no Worker.
