# agent.js — roadmap

**The Goal, in one line:** a coding agent that runs in a tab, needs no server of ours, and keeps its whole tree when the tab is killed.

Source: **CONFIRMED** — the design record's two promises, `inbox/2026-10-22-design-tree.md`, and the person's direction of 2026-10-23: the smallest step that solves the seven-day problem, JS and git first, free.
Milestone closure: **EXPLICIT** — the person's instruction of 2026-10-27: this project is the harness itself, no real-provider run is needed, verify that every function works and call it an end.
Budget: no paid model call. Every acceptance below runs against a local mock provider and costs nothing.

Two promises bound the product (root, 2026-10-23): durability for the site added to the Home Screen, and execution as native JS plus erasable-syntax TS with git in the tab.
Degree: `decide`; every decision taken under it is recorded in the design record.

## The milestone — reached, 2026-10-27

A person opens the URL, pastes their own token, points at a workspace, says what to change, and watches a tree of work happen: files change, every step is a commit, the diff is visible, and killing the tab at any moment costs at most the step that was in flight. No server of ours at any point.

The acceptance a person gives is the judgement of a working thing; its evidence is a recorded trajectory, not the manager's opinion.
The person closed the harness boundary on 2026-10-27: the loop is proven against the mock, and the one paid first run stays theirs, at their own key and provider. That is a deliberate boundary, not a missing feature.
The device observation — iPhone Home Screen, Safari, Firefox — was deferred on 2026-10-26 and stays deferred; nothing in the milestone depends on it.

### Worksets

| workset | made true | commit | evidence |
|---|---|---|---|
| W1 durability + the served copy | the tree survives a kill; a URL serves it with no build step | `0fcfcb5` | `probe-m1`, `probe-m2`, `probe-m3` |
| W2 the log | the log is the truth; a kill mid-step costs that step | `d2ecbfa` | `probe-m3` |
| W3 export / import | the workspace leaves as one JSON file and comes back exact | `3f9fe5f` | `probe-m2` |
| W4 files, git, one commit per step | a step writes a file and commits it; an interrupted commit is checked, not repeated | `8c57c7c` | `probe-m4` |
| W5 execution | JS runs in a Worker, erasable TS runs, the rest is refused by name | `ed44c40` | `probe-m6` |
| W6 the shell that installs entry by entry | one bad fetch costs one entry, and it refills on the next load | `73be015` | `probe-shell` |
| W7 the loop, with a mock | typing a request produces tool calls that are executed and committed | `bc72393` | `probe-w7` |
| W8 the tree, as itself | the interface a person judges: nodes, statuses, diffs, timeline, transcript | `b7f3993`, `7e9ec1d`, `b7aec6b` | `probe-w8`, `evidence/w8b/`, `evidence/w8c/` |
| W9 the trajectory | every run leaves a recorded trace, so a red run is debugged from evidence instead of by re-running | `bc72393` | traces under `evidence/` |
| W10 the run builds the tree | a model run declares subtasks and advances their statuses, so the tree is the run rather than a decoration | `7c3233b` | `probe-w10`, `evidence/w10/` |
| W11 children run their own loops | a node can spawn a child that runs its own model loop and resumes with the rest | `e51f12f` | `probe-w11`, `evidence/w11/` |
| W12 the shell checked against the module graph | a module that ships but is not in `SHELL` fails a check instead of failing offline | `21dfba8` | `probe-module-graph` |

Old stage labels survive as aliases for the commits and mail that use them: M1→W1, M2→W3, M3→W2, M4→W4, M5→W1, M6→W5, M7→W7, M8→the compaction work not built, M9→W8.

W8b and W8c are the two corrections that made W8 judgeable: the screen is ordered around the run panel and every number it declares is re-folded from the log on append; the transcript is the conversation the log already holds, with the final assistant message last.
A three-node run where root spawns two children that each write and commit is `evidence/w11/desktop-run.png` and `narrow-run.png`; the kill test's traces are `evidence/w11/probe-baseline.*` and `probe-resume.*`.

## Verified at close, 2026-10-27

Every probe was run against `node tools/serve.mjs` on `127.0.0.1:8137`, in Chromium headless shell, with the mock provider spawned by the probe. The tree is the one committed here.

| probe | result | proves |
|---|---|---|
| `probe-m1` | 13/13 | a first load writes, reload finds it, a browser restart finds it, offline reopen finds it, and the claim equals `navigator.storage.persisted()` |
| `probe-m2` | 27/27 | an export from one profile imports into another exactly; invalid bundles are refused with the disk untouched |
| `probe-m3` | 29/29, `N=24 kills=24 consistent=24 rerun-named=13 network=0 cold=0` | a kill mid-step reopens with the same settled state and names the one re-run |
| `probe-m4` | 19/19 | two scripted steps produce two real commits, and a kill before the result is `already settled`, not a third commit |
| `probe-m6` | 25/25 | JS runs, erasable TS runs, non-erasable TS is refused by construct and line, a runaway is stopped, and a killed execution is not re-run |
| `probe-shell` | 13/13 | a 503 on one shell entry costs that entry only, it repairs on the next load, and a complete shell costs 0 network requests |
| `probe-module-graph` | 16 modules, 1 declared lazy | every module reachable from `index.html` is in `sw.js` `SHELL` except the named lazy TypeScript bundle |
| `probe-w7` | 28/28 | a typed request becomes tool calls and commits; prefix stability; one interrupted model call re-issued at most once; the key is in no store, URL or history; no key refuses before sending |
| `probe-w8` | 11/11 | nodes, edges, statuses, timeline and diffs survive a reload with empty memory and equal the commits |
| `probe-w10` | 11/11 | `plan` builds the tree, steps land on the planned node, and a reload paints the identical tree |
| `probe-w11` | 20/20 | three loops run, a kill mid-call reopens all three, each re-issues its own call once, and the resumed tree equals the kill-free tree |

**Total: 196 checks passed, plus the module-graph check.** No probe was skipped, retried into green, or run against a live origin in this pass.

## The worksets as built

### W1 — durability and the served copy

Outcome: a person adds the site to the Home Screen, kills it, reopens it, and the same tree is on screen — with a persistence line that says what `navigator.storage.persisted()` returned, not what we hoped.
Deliverable: the project root is the site — `index.html`, `manifest.webmanifest`, `sw.js`, icons, one OPFS-backed tree file in `src/`; `tools/serve.mjs`, `tools/probe-m1.mjs`.
Acceptance: `node tools/serve.mjs &` then `node tools/probe-m1.mjs` → 13/13: first load writes, reload finds it, a browser restart finds it, an offline reopen finds it, and the claim equals the return value with `persisted()` false *and* with it forced true.
Measured on desktop Chromium only. The Home Screen itself — iOS, where the 7-day rule and the container split actually live — is **not** measured; the person deferred it, so the promise stands unconfirmed rather than weakened.

### W2 — the log, and resume with nothing in memory

Outcome: a kill mid-step costs at most the step. The tree on reopen is reconstructed from the append-only log, not from a snapshot.
Deliverable: `src/log.js` (IndexedDB, intent/result pairs, uniqueness enforced by a `kind:seq` index), `src/run.js` (`step()`, boot replay), the `in flight` line, `tools/probe-m3.mjs`. The OPFS snapshot is a cache, not the truth.
Acceptance: kill the page at N random points in a scripted run; every reopen reports the same settled state and names the one step that was re-run.
Measured: `N=24 kills=24 consistent=24 rerun-named=13` (13 mid-step, 11 between-step). The `check()` branch ("already settled") is exercised by W4's git commit; at this size it was not reachable for the pure file tools.

### W3 — export, import, and the container split

Outcome: a person who signs in on a tab and taps the icon is not met by an empty workspace, and a person whose data is about to be evicted can take it out.
Deliverable: `src/transfer.js` — one `{v:1, exportedAt, origin, persisted, tree, log, brief}` JSON where `log` is the ledger verbatim and `tree` the OPFS cache; `navigator.share` with a `File` where available and `<a download>` otherwise; import validates before touching anything, replaces both stores, replays, and re-reads to verify.
Acceptance: `node tools/probe-m2.mjs` → 27/27, including three refusals (wrong `v`, result with no intent, duplicated seq) with the bytes on disk unchanged, and an offline reopen after import.
The standalone container branch is asserted by stubbing `matchMedia`/`navigator.standalone`; no phone was measured.

### W4 — one tool, one commit

Outcome: a step that writes a file to OPFS and commits it with `isomorphic-git`, so the diff exists before any model does.
Deliverable: `src/fs.js` (the adapter plus the `promises` subset `isomorphic-git` binds), `src/tools.js` (`ls`/`read`/`write`/`git_commit`, each with `check()`), `src/run.js` (replay resolves an interrupted commit by `git.log`), the committed bundles, `tools/probe-m4.mjs`.
Acceptance: a scripted two-step run produces two commits; `git log` after a kill and reopen still shows both; a kill between the effect and its result reopens as `already settled` with the count still 2.
Budget: **0.25–0.49 s at 1k files, 3.0–4.1 s at 10k**, bundle **91 KB gzip** including the `Buffer` shim (`tools/bench-iogit/REPORT.md`). A full `status` instead of committing one path is out of budget by 20× at 10k and is a defect, not slow.

### W5 — execution

Outcome: the first half of the execution promise. A file in the workspace is executed in a Worker with no shell and no licence.
Deliverable: `run_js` (page side in `src/exec.js`, worker body in `src/worker.js`: stdout/stderr/exit/wallMs, a 10 s cap that terminates), `.ts`/`.tsx` stripped by a lazily tapped vendored TypeScript, with `enum` / `namespace` / decorators / constructor parameter properties refused by an AST walk naming file, line and construct.
Acceptance: `probe-m6` → 25/25. A JS file returns its stdout; a `.ts` file with an `enum` is refused with the reason; one without runs; a runaway is stopped; a mid-run kill reopens `interrupted` without executing it again.
Cost, measured: **TypeScript is 998 KB gzip** (3.56 MB raw), fetched only on the first `.ts` run, never in the shell; a second `.ts` run fetches nothing. Sucrase (~200 KB) was rejected because it compiles an `enum` instead of refusing it.
The worker can call `fetch` (same origin); it cannot read the token, because the token is never in the worker — a stated limit, not a sandbox claim.

### W6 — the shell that installs entry by entry

Outcome: one bad fetch costs one shell entry, and the missing entry is retried on the next load with no release.
The defect measured before the fix: `caches.addAll(SHELL)` is all-or-nothing, so one stalling fetch left the page with no offline shell at all (`cold=5` of 24 live loads).
Acceptance: with one entry forced to fail, a fresh profile ends with an active controlling worker, every entry that did arrive is cached, the missing one is named and retried, and an offline reopen boots. `probe-shell` → 13/13; a complete shell costs **0 network requests**.
Residual, named: on the live origin one of 24 loads still had no registration at all (`active=null installing=null waiting=null`) — a failed install that the next load heals. The screen says "not driven by the service worker" rather than hiding it.

### W7 — the loop, against a mock

Outcome: a person enters an endpoint, a model and a key in the page, types what they want, and the agent answers with tool calls that are executed, committed per step, and resumed by the log after a kill — with the key never written anywhere.
Deliverable: `src/provider.js` (chat completions, streaming off, `usage` verbatim, base URL + model + key from the page), `src/loop.js` (one turn = one model call; tool calls are steps), the token field and transcript, `tools/mock-provider.mjs` (records every request, emits scripted tool calls).
Acceptance: `probe-w7` → 28/28: a two-turn scripted conversation writes and commits; the second request's messages are a strict prefix of the first plus one appended message, byte-compared; a kill mid-turn re-issues the unfinished call at most once with the request hash shown; the key appears in no store, URL or history; `usage` is displayed; no key refuses before sending.
No paid call was made. The paid first run belongs to the person.

### W8 — the tree, as itself

Outcome: nodes, edges and statuses rendered as a tree, a diff per step, a timeline, and a transcript that reads as the conversation — all folded from the log, so a reload reconstructs the view instead of the view lying about it.
Deliverable: `src/app.js` run panel, tree, transcript, diff and timeline; `src/trace.js` writes the evidence.
Acceptance: every node and status on screen comes from the log; a reload with empty memory paints the identical tree, timeline and default diff; a step's diff equals the git diff of the commit it produced. `probe-w8` → 11/11.
The "does it read well" part is a person's judgement, and the screenshots in `evidence/w8b/` and `evidence/w8c/` are what they judge.

### W9 — the trajectory

Outcome: every run leaves `trace.ndjson` in OPFS plus a derived `summary.md`, written as the run happens and exportable from the page.
Acceptance: the trace records each model request/response, each tool intent/result, screen state and timing; the summary names commits and the provider's token/cache numbers verbatim; a red run is debugged from the trace instead of by re-running. Every probe asserts `0 key hits` in its trace.
Not doing: telemetry, a server-side log, or replaying a trace as if it were a model.

### W10 — the run builds the tree

Outcome: the model calls a `plan` tool; the loop attributes each subsequent step to the item being worked on; the tree, its step counts and its commits are folded from plan results.
Acceptance: `probe-w10` → 11/11: ≥3 nodes, ≥2 edges, ≥2 statuses with the commit on the planned node; a reload with empty memory paints the identical tree (`evidence/w10/`).

### W11 — children run their own loops

Outcome: `spawn` gives a child its own conversation, system prompt and tool loop; the parent owns its liveness; on boot every node the log still calls `running` restarts from its own messages.
Acceptance: `probe-w11` → 20/20: a three-node run where root spawns two children, each writing and committing; every commit attributed to the node whose loop issued it; a kill with every node held at its second model call reopens all three, each re-issues its own interrupted call exactly once, and the resumed final tree equals the kill-free tree. The `in flight` line names every restarted node by id before a key is entered.
The one thing a resume cannot restore is the key: it is memory-only by design, so a reopen names the restarted nodes and continues when the person pastes it again.

### W12 — the shell checked against the module graph

Outcome: `probe-module-graph` reads `src/` and `sw.js` and fails when a module ships but is not cached — the defect that once left the shell without the loop, the provider and the trace. It also fails loudly when its own independent copy of `CACHE`/`SHELL` disagrees with `sw.js`.
Acceptance: 16 modules checked, one declared lazy exception (`vendor/typescript.min.js`); a module that ships but is absent from `SHELL` makes the check fail and is named in the output.

## Measured facts that bound the product

- **A step commits one path and never runs a full `status`:** 0.25–0.49 s at 1k files, 3.0–4.1 s at 10k; ~0.3 ms per file per commit. Bundle 91 KB gzip.
- **TypeScript costs 998 KB gzip**, lazily; this is the largest one-time cost.
- **A public page cannot reach a loopback provider on Chromium.** `https://…` fetching `http://127.0.0.1:…` is denied by Private Network Access before any preflight; `Access-Control-Allow-Private-Network` changes nothing. The CORS ladder is therefore two rungs on Chromium today: the provider must allow the browser origin, or the user installs an extension. A local helper works only when the page itself is served locally, or in a browser that does not enforce PNA.
- **The live origin is slow and occasionally stalls** (TTFB 0.73–11.4 s, one 0-byte response after 65 s at a 10 s cadence). That is a fact about the path and the CDN, not about this code; the probes wait and count `NET`/`COLD` rather than retrying into green.
- **`reported`, not measured:** anything on a phone, Safari or Firefox; `createSyncAccessHandle`; the `promises` path at 100k files.
- **The grep route is unmeasured.** Whether a 10k-file walk through the `fs` adapter is affordable decides whether grep ships at all; it has not been measured, so grep is not shipped.

## Beyond the milestone — explicitly not built

These are the design record's larger ambitions. None is part of the milestone's acceptance; none is claimed by the README.

- **Compaction and cache arithmetic** (`/compact`, `{summary, firstKeptEntryId}`, hit/miss on screen). Prefix stability is proven; compaction is not built.
- **Clone a repo / open a real folder.** The workspace is OPFS; a git remote clone and the File System Access path are not implemented.
- **`grep`/`rg`, `edit`, `todo`, a remote-compute tool.** The tool set is `ls`, `read`, `write`, `git_commit`, `run_js`, `plan`, `spawn`.
- **Python via Pyodide.** Not built.
- **A Node/Bun adapter.** The core is browser-only today; the adapter interface exists, the second adapter does not.
- **The Home Screen observation, Safari, Firefox.** Deferred by the person; the device that carries the durability promise has not opened it.

## Not doing, as decisions rather than gaps

No server of ours beyond a CDN; no relay; no telemetry; no token at rest; no WebContainers; no paid runtime; no real shell; no "runs anything"; no unattended runs when the page is closed; no reimplementation of git, TypeScript, ripgrep or diff; no chat-first UI; no install prompt or installer — the product says "add it to the Home Screen".

## Probe rules, each learned by breaking one

1. **Wait for the product's own signal, never for a side condition.** `probe-m3` once returned while boot replay was still in flight and reported a correct product as red. The signal is `window.agent.snapshot()` becoming non-null, with its own timeout.
2. **In a persistent context the last page is the browser.** Closing the only page tears the context down; open the replacement before closing the old one.
3. **A navigation that timed out is still running.** A retry needs a fresh page, and a fresh page needs rule 2.
4. **A probe's independent oracle must be asserted against the thing it mirrors.** `probe-shell` keeps its own copy of `CACHE` and `SHELL`; a check now fails loudly when it disagrees with `sw.js`.
5. **A slow origin is not a failure, and a retry is not a pass.** `NET`, `COLD` and `consistent` are counted apart; `exit 0` requires all three clean.
6. **A probe deletes only its own evidence, by name.** `probe-w7` once cleared `evidence/` except its own directory and deleted screenshots another run had committed. Evidence is nobody's cleaner to run.
7. **Kill-test artifacts are named as artifacts.** Every iteration tears the browser context down, so the worker restarts on every load; `cold` is defined as *still* uncontrolled after a 20 s claim wait, not as the first uncontrolled frame.

## Convention: where a project of this workspace is reachable

A project of this workspace that must be reachable lives at `github.com/ZisIsNotZis/<its directory name>`, and this project's is `github.com/ZisIsNotZis/agent.js`.
The directory name is the repository name, the default branch is what Pages serves, and nothing of ours sits between the person's browser and the CDN.
Public, because Pages on a free account requires a public repository; the tree that goes up is this directory and nothing else.
The workspace pins this directory as a submodule pointing at that repository, which is why nothing here runs `git init` inside the workspace tree.

**Push path, when the HTTPS one flaps.** `github.com` can resolve to a regional IPv4 whose TCP connect stalls for minutes while `140.82.112.x` answers, so `git push` dies in `GnuTLS recv error (-110)` or a bare connect timeout. The remote that works in that state is SSH on port 443 — `ssh://git@ssh.github.com:443/ZisIsNotZis/agent.js.git`, key-authenticated, same refs. Retrying HTTPS is the wrong response.
