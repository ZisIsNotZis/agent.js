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
The Home Screen itself — iOS, where the 7-day rule and the container split actually live — is **not** measured, so M1 is done as a mechanism and unproven as a promise on the device that carries it.

## Next, in order (edges are precedence; siblings without an edge run in parallel)

**M2 — export, import, and the container split — `open`.** Depends on M1.
Outcome: a person who signs in on a tab and taps the icon is not met by an empty workspace, and a person whose data is about to be evicted can take it out.
Deliverable: one JSON export of `.agentjs/` plus a share-sheet download, and one import that replaces the tree.
Acceptance: `node tools/probe-m2.mjs` — export in a tab, import in a profile that has nothing, boots/created/nodes match; and the Home Screen/ tab distinction is on screen in both containers.
Not doing: partial merges, account sync, encryption theatre.

**M3 — the log, and resume with nothing in memory — `open`.** Depends on M1.
Outcome: a kill mid-step costs at most the step. The tree on reopen is reconstructed from the append-only log, not from a snapshot.
Deliverable: `src/log.js` (IndexedDB, intent/result pairs), a replay on boot, and a visible "what was in flight" line.
Acceptance: kill the page at N random points in a scripted run; every reopen reports the same settled state and names the one step that was re-run. `node tools/probe-m3.mjs` prints N and the count.
Not doing: checkpoints, a continue button, model calls.

**M4 — the first real agent step: one tool, one commit — `open`.** Depends on M3.
Outcome: a step that writes a file to OPFS and commits it with `isomorphic-git`, so the diff exists before any model does.
Deliverable: `fs` adapter over OPFS, `isomorphic-git` wired, `ls`/`read`/`write`/`git_commit`, a boot that replays them.
Acceptance: a scripted two-step run produces two commits; `git log` read back through `isomorphic-git` in the page shows both after a kill and reopen.
Not doing: grep, patch, push, TS, Python.

**M5 — the served copy — `done`, 2026-10-23.** Depends on M1 only.
Outcome: the URL a person can add to the Home Screen, and the only place the promise can be observed.
Deliverable: this tree served by GitHub Pages from the public repository `github.com/ZisIsNotZis/agent.js`, default branch, no server of ours and no build step.
Acceptance: `curl -sI https://zisisnotzis.github.io/agent.js/manifest.webmanifest` returns 200 and `application/manifest+json` (seen 2026-10-23); the M1 probe run against the live origin prints 13/13 (seen 2026-10-23, commit `0fcfcb5`); and the phone steps are **not yet run**.
Not doing: any origin server, any telemetry, any credential of ours.

## The one step still unrun, and who runs it

Everything M1 claims is measured on desktop Chromium, locally and on the live origin.
The device that carries the promise has never opened it, so the promise is unconfirmed rather than proven.
The list is written for the person, in the order they do it, and root puts it in front of them; the report in `mail/2026-10-23-pages-and-the-phone-checklist.md` is where it lives.

## Convention: where a project of this workspace is reachable

A project of this workspace that must be reachable lives at `github.com/ZisIsNotZis/<its directory name>`, and this project's is `github.com/ZisIsNotZis/agent.js`.
That is the person's convention as given on 2026-10-23, not an invention here: the directory name is the repository name, the default branch is what Pages serves, and nothing of ours sits between the person's browser and the CDN.
Public, because Pages on a free account requires a public repository; the tree that goes up is this directory and nothing else, so no other project's work is exposed by it.
The workspace pins this directory as a submodule pointing at that repository, which is why nothing here runs `git init` inside the workspace tree.

**M6 — execution: native JS in a Worker, then erasable TS — `open`.** Depends on M4.
Outcome: the promise's first half. A file in the workspace is executed in a Worker with no shell and no licence.
Deliverable: `run_js`; then type-stripping for the erasable subset with the unsupported constructs named on screen.
Acceptance: a JS file returns its stdout; a `.ts` file with an `enum` is refused with the reason, and one without runs. `node tools/probe-m6.mjs`.
Not doing: bundling, npm, `esbuild-wasm`, Python.

## Not doing, as decisions rather than gaps

No server of ours beyond a CDN; no relay; no telemetry; no token at rest; no WebContainers; no paid runtime; no real shell; no "runs anything"; no unattended runs when the page is closed; no reimplementation of git, TypeScript, ripgrep or diff; no chat-first UI; no install prompt or installer — the product says "add it to the Home Screen".

## What the ledger does not yet show

Every measurement in the design record's probe list other than the durability mechanism is still `reported`, not `measured`.
The two that decide later milestones: `isomorphic-git` timing over OPFS at 1k and 10k files (M4), and the grep route (M6/never, depending on what the walk costs).
