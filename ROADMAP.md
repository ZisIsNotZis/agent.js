# agent.js — roadmap

Manager document, written 2026-10-23. This is where every node's state is read from.
The goal is the design record's: a coding agent that runs in a tab, needs no server of ours, and keeps its tree when the tab is killed.
Two promises bound it (root, 2026-10-23, `inbox/2026-10-22-design-tree.md`): durability for the site added to the Home Screen, and execution as native JS plus erasable-syntax TS with git in the tab.
Degree: `decide` (assumed); every decision taken under it is marked in the design record.

## Now

**M1 — the tree survives a kill on a device where it was added to the Home Screen. — `done`, 2026-10-23, commit `c40b543`.**

| term | what was promised |
|---|---|
| outcome | a person adds the site to the Home Screen, kills it, reopens it, and the same tree is on screen — with a persistence line that says what `navigator.storage.persisted()` returned, not what we hoped |
| deliverable | the project root is the site — `index.html`, `manifest.webmanifest`, `sw.js`, icons, one OPFS-backed tree file in `src/`; `tools/serve.mjs`, `tools/probe-m1.mjs` |
| acceptance | `node tools/serve.mjs &` then `node tools/probe-m1.mjs` → 13/13: first load writes, reload finds it, a browser restart finds it, an offline reopen finds it, and the claim equals the return value with `persisted()` false *and* with it forced true |
| not doing | no agent loop, no model call, no token field, no git, no editor, no diff view, no tree diagram, no import/export |

Measured on desktop Chromium only.
The Home Screen itself — iOS, where the 7-day rule and the container split actually live — is **not** measured. The person deferred that observation on 2026-10-26 ("no need phone (for now)"); deferred is not withdrawn, so the Home Screen stays the container the promise is written for and M1 is accepted on the browser evidence the probe prints, with the device observation waiting on the person rather than on the work.

## Next, in order (edges are precedence; siblings without an edge run in parallel)

**M2 — export, import, and the container split — `done`, 2026-10-26, commit `3f9fe5f`.** Depends on M1.
Outcome: a person who signs in on a tab and taps the icon is not met by an empty workspace, and a person whose data is about to be evicted can take it out.
Since the person deferred the phone on 2026-10-26, only the eviction half is judged now; the container half is built because it is the same file format and the same button, and it is proven when a phone appears.
Deliverable: `src/transfer.js` — one `{v:1, exportedAt, origin, persisted, tree, log, brief}` JSON where `log` is the ledger verbatim and `tree` the OPFS cache; `navigator.share` with a `File` where available and `<a download>` otherwise; import from a file input or a pasted textarea that validates before touching anything, replaces both stores, replays the log, and re-reads to verify; the Export/Import controls and the container line; `tools/probe-m2.mjs`.
Acceptance: `node tools/probe-m2.mjs` → 27/27: the descending profile exports the page's 12 records and its tree; a fresh `mkdtemp` profile with no OPFS and no IndexedDB imports them, matching `created`, `boots`, nodes/statuses and log, and replay finds nothing in flight; a wrong `v`, a result with no intent and a duplicated seq are each refused on screen with the bytes on disk unchanged; a tab says it is a tab and names the icon as a different container; an offline reopen after import boots the imported tree. The standalone branch was asserted by stubbing `matchMedia`/`navigator.standalone` and that is what the probe prints — no phone was measured.
Not doing: partial merges, account sync, encryption theatre, compression, a model call, any new dependency.

**M3 — the log, and resume with nothing in memory — `done`, 2026-10-26, commit `d2ecbfa`.** Depends on M1.
Outcome: a kill mid-step costs at most the step. The tree on reopen is reconstructed from the append-only log, not from a snapshot.
Deliverable: `src/log.js` (IndexedDB, intent/result pairs, the uniqueness rule enforced by a `kind:seq` index rather than by its callers), `src/run.js` (the step and its pure in-file tool set, plus the boot replay), the `in flight` line on screen, `tools/probe-m3.mjs`. The OPFS snapshot is kept but demoted to a cache, which is what the design record said it was.
Acceptance: kill the page at N random points in a scripted run; every reopen reports the same settled state and names the one step that was re-run. `node tools/probe-m3.mjs` prints N and the count — `N=24 kills=24 consistent=24 rerun-named=13` with 13 mid-step and 11 between-step kills, printed on 2026-10-26 at 29/29 (seed `20261026` and an unseeded run) with `probe-m1` still 13/13 in the same tree; and against the live origin, `N=24 kills=24 consistent=24 rerun-named=13 network=0 cold=5` — the resume property holds on the bytes that are actually served, and the one red check is the service worker, not the log.
Known and accepted at this size: `replay()`'s `check()` branch ("already settled") is reachable only for effects that can be duplicated, and at M3 every interrupted intent is genuinely re-run, so the probe proves two of the three phrases. M4's git commit is the first effect that needs the third.
Not doing: checkpoints, a continue button, model calls.

**M4 — the first real agent step: one tool, one commit — `open`.** Depends on M3.
Outcome: a step that writes a file to OPFS and commits it with `isomorphic-git`, so the diff exists before any model does.
Deliverable: `fs` adapter over OPFS, `isomorphic-git` wired, `ls`/`read`/`write`/`git_commit`, a boot that replays them.
Acceptance: a scripted two-step run produces two commits; `git log` read back through `isomorphic-git` in the page shows both after a kill and reopen. The per-step budget is already measured, so it is part of the acceptance rather than a later discovery: **0.25–0.49 s at 1k files, 3.0–4.1 s at 10k**, bundle **91 KB gzip** including the `Buffer` shim (`tools/bench-iogit/REPORT.md`); a step that runs a full `status` instead of committing one path is out of budget by 20× at 10k and is a defect, not slow.
Not doing: grep, patch, push, TS, Python.

**WP-shell-install-resilient — `open`, found by measurement on 2026-10-26, ordered after M4 because M4 bumps the same cache.**
A live-origin probe run produced `COLD` loads — pages with `navigator.serviceWorker.controller === null` — which is only possible if the shell was never installed or the install was lost, and the cause is visible in `sw.js`: `caches.open(CACHE).then(c => c.addAll(SHELL))` is all-or-nothing, so **one** fetch of `./src/transfer.js` that stalls (the path measured at up to 65 s with zero bytes) fails the whole install, and there is no offline shell at all. Bumping the cache version on each release makes every returning person pay that roll of the dice again.
Measured size of the defect: a live-origin M3 run of 24 loads had **5 loads with no controlling service worker** (`cold=5`, one of them still uncontrolled after a second load), every other check green. That is the rate at which a person's first load after a release has no offline shell.
Acceptance: with the network throttled and one shell entry forced to hang, a fresh profile ends with an **active controlling** service worker, every entry that did arrive is in the cache, the missing one is retried on the next load, and an offline reopen boots. The probe must show the failing entry by name rather than only a boolean.
Not doing: a build step, versioned assets, a runtime from Cache Storage change, or a second service worker.

**M5 — the served copy — `done`, 2026-10-23.** Depends on M1 only.
Outcome: the URL a person can add to the Home Screen, and the only place the promise can be observed.
Deliverable: this tree served by GitHub Pages from the public repository `github.com/ZisIsNotZis/agent.js`, default branch, no server of ours and no build step.
Acceptance: `curl -sI https://zisisnotzis.github.io/agent.js/manifest.webmanifest` returns 200 and `application/manifest+json` (seen 2026-10-23); the M1 probe run against the live origin prints 13/13 (seen 2026-10-23, commit `0fcfcb5`). The phone steps are deferred by the person, 2026-10-26, and are not part of this node's acceptance.
Not doing: any origin server, any telemetry, any credential of ours.

## Deferred: the Home Screen observation, and who runs it

Everything M1 claims is measured on desktop Chromium, locally and on the live origin.
The device that carries the promise has never opened it, so the promise is unconfirmed rather than disproved — and the person said on 2026-10-26 that a phone is not needed for now.
Nothing waits on it: M2 onward are judged on a desktop profile, which is why they were ordered behind M1 rather than behind the device.
When the person has a phone in hand, the ten steps are already written in the order they are done and stay there — `mail/2026-10-23-pages-and-the-phone-checklist.md`.

## Convention: where a project of this workspace is reachable

A project of this workspace that must be reachable lives at `github.com/ZisIsNotZis/<its directory name>`, and this project's is `github.com/ZisIsNotZis/agent.js`.
That is the person's convention as given on 2026-10-23, not an invention here: the directory name is the repository name, the default branch is what Pages serves, and nothing of ours sits between the person's browser and the CDN.
Public, because Pages on a free account requires a public repository; the tree that goes up is this directory and nothing else, so no other project's work is exposed by it.
The workspace pins this directory as a submodule pointing at that repository, which is why nothing here runs `git init` inside the workspace tree.

**Push path, when the HTTPS one flaps (seen 2026-10-26).** `github.com` resolves to a single regional IPv4 here (`20.205.243.166`) whose TCP connect stalls for minutes while `140.82.112.x` answers immediately, so `git push` dies in `GnuTLS recv error (-110)` or a bare connect timeout and says nothing about why. The remote that works in that state is SSH on port 443 — `ssh://git@ssh.github.com:443/ZisIsNotZis/agent.js.git`, reachable at `140.82.112.36`, key-authenticated, same refs. It is registered in this clone as `sshpush`; push with `git push sshpush main` and move the tracking ref by hand (`git update-ref refs/remotes/origin/main <sha>`), because a push through a second remote does not update `origin/main`. Retrying HTTPS is the wrong response: it spends minutes per attempt on a path that is down.

**The live origin's path from this machine, measured 2026-10-26.** A bare `curl` at a **10 s** cadence — no browser, no service worker, no concurrency — made **18** requests and got TTFB between **0.73 s and 11.4 s** (median ~2.5 s, connect alone up to 5.4 s), with **one** request that returned **0 bytes after 65 s** against a 65 s `--max-time`. That is the whole explanation of the live probe failures: the route to the CDN stalls for minutes at a time, occasionally to the point of never answering, and it does so at a cadence too low to be rate limiting. It is therefore a fact about the network path and the edge, not about this code, and the response is the one the probes now carry: every load waits 60 s, a load that fails twice is counted as `NET`, a load with no service-worker controller is `COLD` and retried once, and `node tools/probe-m3.mjs` exits 0 only when `network=0`. A run against the live origin is taken with an explicit `CADENCE_MS` (default 2500) so the pressure it puts on the origin is a number rather than an accident.

**M6 — execution: native JS in a Worker, then erasable TS — `open`.** Depends on M4.
Outcome: the promise's first half. A file in the workspace is executed in a Worker with no shell and no licence.
Deliverable: `run_js`; then type-stripping for the erasable subset with the unsupported constructs named on screen.
Acceptance: a JS file returns its stdout; a `.ts` file with an `enum` is refused with the reason, and one without runs. `node tools/probe-m6.mjs`.
Not doing: bundling, npm, `esbuild-wasm`, Python.

## Not doing, as decisions rather than gaps

No server of ours beyond a CDN; no relay; no telemetry; no token at rest; no WebContainers; no paid runtime; no real shell; no "runs anything"; no unattended runs when the page is closed; no reimplementation of git, TypeScript, ripgrep or diff; no chat-first UI; no install prompt or installer — the product says "add it to the Home Screen".

## What the ledger does not yet show

Every measurement in the design record's probe list other than the durability mechanism is still `reported`, not `measured`.
`isomorphic-git` over OPFS is no longer one of them: measured 2026-10-26, a per-step commit of one file costs **0.25–0.49 s at 1k files** and **3.0–4.1 s at 10k**, and the bundle is **91 KB gzip** including the `Buffer` shim it requires (`tools/bench-iogit/`). What that fixes in advance: the step path commits one file and never runs a full `status` (12–18 s at 10k), and the workspace's practical size is set by that slope (~0.3 ms per file per commit), not by quota.
The one left that decides a later milestone: the grep route (M6/never, depending on what the walk costs). Still `reported` and not `measured`: anything on a phone, Safari or Firefox; the Worker thread; `createSyncAccessHandle`.
