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
Acceptance: kill the page at N random points in a scripted run; every reopen reports the same settled state and names the one step that was re-run. `node tools/probe-m3.mjs` prints N and the count — `N=24 kills=24 consistent=24 rerun-named=13` with 13 mid-step and 11 between-step kills, printed on 2026-10-26 at 29/29 (seed `20261026` and an unseeded run) with `probe-m1` still 13/13 in the same tree; and against the live origin twice: `N=24 kills=24 consistent=24 rerun-named=13 network=0 cold=5` before the shell fix, and `consistent=23 rerun-named=13 network=1 cold=1` after it (`SEED=20261026 CADENCE_MS=2500`, 13m44s wall). In both, every inconsistency in the settled state is the load that never reached the page — the resume property holds on the bytes that are actually served, and what stayed red is the service worker, not the log.
Known and accepted at this size: `replay()`'s `check()` branch ("already settled") is reachable only for effects that can be duplicated, and at M3 every interrupted intent is genuinely re-run, so the probe proves two of the three phrases. M4's git commit is the first effect that needs the third.
Not doing: checkpoints, a continue button, model calls.

**M4 — the first real agent step: one tool, one commit — `done`, 2026-10-26, commit `8c57c7c`.** Depends on M3.
Outcome: a step that writes a file to OPFS and commits it with `isomorphic-git`, so the diff exists before any model does.
Deliverable: `src/fs.js` (the adapter interface plus the OPFS implementation and the `promises` subset `isomorphic-git` binds), `src/tools.js` (`ls`/`read`/`write`/`git_commit`, each with a `check()`), `src/run.js` (the tools in the fold, `step()` timing, `replay()` resolving an interrupted commit by `git.log`), `tools/probe-m4.mjs`, and the committed bundles `vendor/isomorphic-git.min.js` + `vendor/buffer.min.js`. The bundles are build output but still files: **regenerate them with `node tools/vendor.mjs`** (pinned `isomorphic-git@1.44.4` + `buffer@6.0.3`, installed into a temp dir and removed; prints the sizes). The file header carries the same instruction.
Acceptance: a scripted two-step run produces two commits; `git log` read back through `isomorphic-git` in the page shows both after a kill and reopen. The per-step budget is already measured, so it is part of the acceptance rather than a later discovery: **0.25–0.49 s at 1k files, 3.0–4.1 s at 10k**, bundle **91 KB gzip** including the `Buffer` shim (`tools/bench-iogit/REPORT.md`); a step that runs a full `status` instead of committing one path is out of budget by 20× at 10k and is a defect, not slow.
Measured 2026-10-26: `node tools/probe-m4.mjs` → **19/19**, the two `git_commit` steps at **76–87 ms and 45–52 ms** on the probe's 2-file tree, a kill between the second commit's effect and its result reopening as **`already settled`** with the count still **2, not 3**, and the step path grep-clean of a full `status` (`src/tools.js`, `src/run.js`, `src/fs.js`: 0 hits). `probe-m1` 13/13, `probe-m2` 27/27 and `probe-m3` 29/29 in the same tree. The probe's tree is 2 files, not the bench's 1k/10k, so its timing is a commit's fixed cost, not the slope; the budget stands as measured in `tools/bench-iogit/REPORT.md`.
Not doing: grep, patch, push, TS, Python.

**WP-shell-install-resilient — `done`, 2026-10-26, commit `73be015`.** Found by measurement on 2026-10-26, ordered after M4 because M4 bumps the same cache.
A live-origin probe run produced `COLD` loads — pages with `navigator.serviceWorker.controller === null` — which is only possible if the shell was never installed or the install was lost, and the cause is visible in `sw.js`: `caches.open(CACHE).then(c => c.addAll(SHELL))` is all-or-nothing, so **one** fetch of `./src/transfer.js` that stalls (the path measured at up to 65 s with zero bytes) fails the whole install, and there is no offline shell at all. Bumping the cache version on each release makes every returning person pay that roll of the dice again.
Measured size of the defect: a live-origin M3 run of 24 loads had **5 loads with no controlling service worker** (`cold=5`, one of them still uncontrolled after a second load), every other check green. That is the rate at which a person's first load after a release has no offline shell.
Acceptance: with the network throttled and one shell entry forced to hang, a fresh profile ends with an **active controlling** service worker, every entry that did arrive is in the cache, the missing one is retried on the next load, and an offline reopen boots. The probe must show the failing entry by name rather than only a boolean.
Done as: `tools/probe-shell.mjs` — named after the workpackage, not after a milestone, because it proves this and nothing else; `11/11`, with a 503 on one entry costing that entry and only that entry, the repair arriving on the next reload with no release, and **0 network requests** on a load whose shell is complete (the fix did not buy robustness with latency). A per-entry fetch with a 5 s abort that covers the body, `clients.claim()` before the cache work so a load cannot read `COLD` behind it, and at most one retry pass per load. Measured before the fix: `cold=5` of 24 live loads; after it, on a single live run, `cold=1` — so the verdict is **reduced, not eliminated**, and 24 loads is an observation rather than a rate.
That one surviving load is diagnosed: `active=null installing=null waiting=null` — no registration at all, i.e. an install that failed and was discarded, not a cache entry that went missing and not a claim that came late. The screen already says "not driven by the service worker" for that load and the page re-registers on the next one, so the failure is visible and self-healing rather than silent — but a person's first load after such a failure has no offline shell, and that is the price that is still being paid. Real-time accounting of every load on the live origin, `late-claims=24 max-claim-wait=14492ms`: every load in this test pattern starts uncontrolled because each kill tears the browser context down and the worker restarts, and 23 of 24 were claimed inside 14.5 s. That is the artifact described in the probe rules, and it is why `cold` is defined as *still* uncontrolled after 20 s.
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

## What the manager does not ask

Written after asking the person "which provider, which model, what budget?" on 2026-10-26 and being rightly sent back to the goal.

1. **Nothing the design record already answers.** The provider is a runtime input (D7: provider-direct, the person's own token, no relay of ours); asking which one is asking the product to be built for one vendor.
2. **Nothing that is a runtime variable rather than a build decision.** Endpoint, model, key, budget: the person enters them, in the page, at the moment they use it.
3. **Nothing already deferred.** The Home Screen observation was deferred on 2026-10-26; offering it again is noise, not diligence.
4. **Spend is stated, not negotiated, where it is unavoidable** — but a measurement that needs a real paid call is not required to build or verify the harness: a local mock provider is the verification path, and the paid call belongs to the person who owns the key.

The test for a question before it reaches the person: *could the answer be a default, or a mock, or a runtime field?* If yes to any, it is mine.

## Probe rules, each learned by breaking one

These are not style: every one of them was a probe reporting red that was measuring itself, and each cost a run to discover.

1. **Wait for the product's own signal, never for a side condition.** `probe-m3` returned from a load once the service worker was controlling, which happens to be *after* boot on a fast origin; on one measured at TTFB 0.7–11.4 s it returned while boot replay was still in flight and reported `consistent=7/24` against a product that was correct. The signal is `window.agent.snapshot()` becoming non-null, with its own timeout.
2. **In a persistent context the last page is the browser.** Closing the only page tears the context down, so a retry that closes before opening gets `net::ERR_ABORTED` and blames the origin. Open the replacement first, then close.
3. **A navigation that timed out is still running.** Playwright does not cancel it, so a retry on the same page interrupts it; the retry needs a fresh page, and a fresh page needs rule 2.
4. **A probe's independent oracle must be asserted against the thing it mirrors, or it silently rots.** `probe-shell` kept its own copy of `CACHE` and `SHELL` — which is what makes it independent — and when M6 bumped the cache to v6 it reported 7/11 that read exactly like a product defect. The copy stays; a check now fails loudly when it disagrees with `sw.js`.
5. **A slow origin is not a failure, and a retry is not a pass.** `NET` (load failed twice), `COLD` (no controller after the claim wait) and `consistent` are counted apart; `exit 0` requires all three clean. Nothing may be retried into green.
6. **Kill-test artifacts are named as artifacts.** Every iteration tears the browser context down, so the service worker restarts on every load; a navigation that begins while it is starting is uncontrolled and is claimed seconds later (`late-claims=23 max-claim-wait=13387ms` on live). That is the test pattern, not a person's second load — and it is exactly why `cold` is defined as *still* uncontrolled after a 20 s claim wait.

## Convention: where a project of this workspace is reachable

A project of this workspace that must be reachable lives at `github.com/ZisIsNotZis/<its directory name>`, and this project's is `github.com/ZisIsNotZis/agent.js`.
That is the person's convention as given on 2026-10-23, not an invention here: the directory name is the repository name, the default branch is what Pages serves, and nothing of ours sits between the person's browser and the CDN.
Public, because Pages on a free account requires a public repository; the tree that goes up is this directory and nothing else, so no other project's work is exposed by it.
The workspace pins this directory as a submodule pointing at that repository, which is why nothing here runs `git init` inside the workspace tree.

**Push path, when the HTTPS one flaps (seen 2026-10-26).** `github.com` resolves to a single regional IPv4 here (`20.205.243.166`) whose TCP connect stalls for minutes while `140.82.112.x` answers immediately, so `git push` dies in `GnuTLS recv error (-110)` or a bare connect timeout and says nothing about why. The remote that works in that state is SSH on port 443 — `ssh://git@ssh.github.com:443/ZisIsNotZis/agent.js.git`, reachable at `140.82.112.36`, key-authenticated, same refs. It is registered in this clone as `sshpush`; push with `git push sshpush main` and move the tracking ref by hand (`git update-ref refs/remotes/origin/main <sha>`), because a push through a second remote does not update `origin/main`. Retrying HTTPS is the wrong response: it spends minutes per attempt on a path that is down.

**The live origin's path from this machine, measured 2026-10-26.** A bare `curl` at a **10 s** cadence — no browser, no service worker, no concurrency — made **18** requests and got TTFB between **0.73 s and 11.4 s** (median ~2.5 s, connect alone up to 5.4 s), with **one** request that returned **0 bytes after 65 s** against a 65 s `--max-time`. That is the whole explanation of the live probe failures: the route to the CDN stalls for minutes at a time, occasionally to the point of never answering, and it does so at a cadence too low to be rate limiting. It is therefore a fact about the network path and the edge, not about this code, and the response is the one the probes now carry: every load waits 60 s, a load that fails twice is counted as `NET`, a load with no service-worker controller is `COLD` and retried once, and `node tools/probe-m3.mjs` exits 0 only when `network=0`. A run against the live origin is taken with an explicit `CADENCE_MS` (default 2500) so the pressure it puts on the origin is a number rather than an accident.

**M6 — execution: native JS in a Worker, then erasable TS — `done`, 2026-10-26, commit `ed44c40`.** Depends on M4.
Outcome: the promise's first half. A file in the workspace is executed in a Worker with no shell and no licence.
Deliverable: `run_js` (`src/exec.js` page side, `src/worker.js` the worker body fetched as a URL, Blob-constructed, stdout/stderr/exit/wallMs, 10 s cap that terminates it); `.ts`/`.tsx` stripped by a **lazily tapped** vendored TypeScript, with `enum` / `namespace` / decorators / constructor parameter properties **refused by an AST walk** (not a regex) naming file, line and construct; both recorded as steps through the same log.
Acceptance: a JS file returns its stdout; a `.ts` file with an `enum` is refused with the reason, and one without runs. `node tools/probe-m6.mjs` → **25/25**, and the other five probes unchanged: m1 13/13, m2 27/27, m3 29/29, m4 19/19, shell 12/12.
The costs, measured rather than deferred: **TypeScript is 998 KB gzip** (3.56 MB raw) and is fetched only on the first `.ts` run, never in the shell; a second `.ts` run fetches nothing. That is the largest one-time cost in the product, and the branch that would cut it is sucrase at roughly 200 KB — rejected for now because sucrase *compiles* an `enum` instead of refusing it, which would dissolve the one boundary the promise is built on. The worker can call `fetch` (same origin); it cannot read the token, because the token is never in the worker — stated as the limit rather than called a sandbox.
`run_js` is non-idempotent and is **never auto-replayed**: an intent with no result is resolved from an OPFS `done` marker (recovering the recorded output) or reported `interrupted`. A kill cannot execute a side effect twice, and the price is that a run killed before its code started is not retried — both shown on screen rather than hidden.
Not doing: bundling, npm, `esbuild-wasm`, Python.

## Not doing, as decisions rather than gaps

No server of ours beyond a CDN; no relay; no telemetry; no token at rest; no WebContainers; no paid runtime; no real shell; no "runs anything"; no unattended runs when the page is closed; no reimplementation of git, TypeScript, ripgrep or diff; no chat-first UI; no install prompt or installer — the product says "add it to the Home Screen".

**M7 — the loop, with the person's own key and a mock that spends nothing — `open`.** Depends on M6.
Outcome: the thing the design record's five points describe starts existing. A person enters an endpoint, a model and a key in the page, types what they want, and the agent answers with tool calls that are executed, committed per step, and resumed by the log after a kill — with the key never written anywhere.
Deliverable: `src/provider.js` (chat-completions client: base URL + model + key from the page, streaming off, `usage` captured verbatim, no retry that doubles a paid turn without recording it), `src/loop.js` (one turn: build request → parse tool calls → `step()` each through the existing log → repeat until a message with no tool calls), the token field and the run transcript on screen, and `tools/mock-provider.mjs` (a local OpenAI-shaped endpoint that records every request body and can be told to emit scripted tool calls, so the whole path is verifiable without a cent).
Acceptance (`node tools/probe-m7.mjs`, against the mock): a two-turn scripted conversation produces the intended file writes and commits; **prefix stability** — the second request's messages are a strict prefix of the first plus one appended message, byte-compared; a kill mid-turn reopens, replays the log, and re-issues the one unfinished model call **at most once** with the recorded request hash on screen; the key appears in no `localStorage`/`sessionStorage`/IndexedDB record/URL/history entry (scanned, not asserted by reading the code); `usage` from the response is displayed; and the page refuses to start a run with no key rather than sending an empty one.
Not doing: compaction (M8), any provider-specific SDK, any relay, streaming, or a paid call in the probe.
Cost of acceptance: **zero**. The paid first run belongs to the person, at their own key, and the screen says so before the first send.

**M8 — compaction and the cache arithmetic — `open`.** Depends on M7.
Outcome: a long conversation keeps working and the visible numbers say whether it is cheap. `/compact` is an appended message; a compaction record carries `{summary, firstKeptEntryId}`; the request is rebuilt as `system + summary + tail`; volatile content never sits at the front.
Acceptance: against the mock (which reports synthetic `prompt_tokens`/`prompt_cache_hit_tokens`), after a compaction the next request still extends a prefix, and the numbers on screen show hit/miss; a second compaction summarizes from the previous boundary.

**M9 — the tree, as itself — `open`, `need_user_review`.** Depends on M7.
Outcome: the interface the design record argues for: nodes, edges and statuses rendered as a tree, a diff per node, and a timeline derived from the log, so a reload reconstructs the view rather than the view lying about it.
Acceptance that is not taste: every node and status on screen comes from the log, a reload with an empty memory shows the same tree, and a step's diff equals `git diff` of the commit it produced. Whether it *reads* well is the person's call, marked here so it is not counted as passed by evidence.

## What the ledger does not yet show

Some measurements in the design record's probe list are still `reported`, not `measured`.
`isomorphic-git` over OPFS is no longer one of them: measured 2026-10-26, a per-step commit of one file costs **0.25–0.49 s at 1k files** and **3.0–4.1 s at 10k**, and the bundle is **91 KB gzip** including the `Buffer` shim it requires (`tools/bench-iogit/`). What that fixes in advance: the step path commits one file and never runs a full `status` (12–18 s at 10k), and the workspace's practical size is set by that slope (~0.3 ms per file per commit), not by quota.
The Worker thread is no longer one of them: M6 runs JS and TS in one, with a 10 s cap that stops a runaway and a tab that stays responsive (`probe-m6`).
The one left that decides a later milestone: the **grep route** — whether a walk of 10k files through the `fs` adapter, or a WASI preopen shim, or passing contents to a wasm regex engine is the one that fits `D5`. Unmeasured, and it decides whether grep ships at all.
Still `reported` and not `measured`: anything on a phone, Safari or Firefox; `createSyncAccessHandle`; the `promises` path at 100k files, where the 0.3 ms/file slope would start to matter.
