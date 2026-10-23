kind:    direction
from:    root
spend:   person_attention, about 25 minutes; taste on the two gating questions at the end; machine_time, idle class; money: none spent, nothing metered
id:      none — first contact; no dispatch exists yet

# agent.js — the design tree, the expectation, and what has to be true

Recorded 2026-10-22, from one conversation. It is the sibling of `agent.sh` and shares its metric, not its mechanism. Everything below marked *reported* came from someone else's documentation and has not been measured on this machine; everything marked *measured* was run here.

## Decided — root, 2026-10-23

root answered the two gating questions in `mail/2026-10-23-answer-two-promises.md`, carrying the person's direction: "做能解决 7 天问题的最小那一步", "最小范围是 js 和 git，TS 或 python 有余力再说，免费就行".
Nothing else below is still the person's except the two items named at the end of this section.

**Durability is promised for the site added to the Home Screen, and for nothing else.**
What ships is a manifest with `display: standalone` plus the `apple-mobile-web-app-capable` meta; the user taps Share → Add to Home Screen.
iOS 16.4–25 then treats the icon as a home-screen web app whose site data is exempt from ITP's 7-day wipe, and iOS 26+ opens any home-screen site as a web app with no installability requirement at all, so the manifest is what older iOS and Chrome need and not a gate on 26+.
A plain tab is not promised, and a Safari *bookmark* is not promised either: without the manifest it opens as an ordinary page and keeps the 7-day clock, and `navigator.storage.persist()` does not override ITP on WebKit.
The cost is stated rather than discovered: the home-screen container and the Safari-tab container are separate, so a user who signs in on a tab and then taps the icon meets an empty workspace, and the first screen must either recover itself (import/export) or say "use the icon".
Chrome prompts for nothing and evicts under disk pressure rather than on a timer, so **the promise follows `navigator.storage.persisted()`**, read at load: `true` says "will not be evicted", `false` says "may be evicted, export".
Acceptance line, observable: add to Home Screen, cut the network, kill the app, reopen, and the tree is still there with the `persisted()` reading agreeing with what the screen claims.
Measured 2026-10-23 on a desktop Chromium profile (`tools/probe-m1.mjs`, 13/13): first load writes, reload finds it, a browser restart finds it, an offline reopen finds it, and the claim equals the return value in both directions.
Not yet measured: the same on an iPhone Home Screen, which is the next observation and the one that actually carries the promise.

**Execution is JS natively plus erasable-syntax TS, with git in the tab; Python is a lazy opt-in outside the promise.**
JS runs natively in a Worker — no compiler, no licence, no server.
TS enters the promise only as *erasable* TS: types are stripped with `ts.transpileModule` (sucrase if it earns its ~200KB), and `enum`, `namespace`, decorators and parameter properties are named as not running, so `erasableSyntaxOnly` is a boundary that can be both enforced and shown.
git is real git in the tab: `isomorphic-git` over the OPFS `fs` adapter, pushing with the user's own token.
Python is Pyodide, 10–25MB cold, fetched only when a person taps it, with the download price written at that tap.
Rejected by this decision, with their reasons: WebContainers (commercial licence plus COOP/COEP), any paid runtime, and any server of ours that is not a CDN — which also puts a real `npm install` outside the promise.

**Still not the manager's:** where the site is served from (a CDN account is the one credential this needs and it is not the manager's to hold), and whether the home-screen container needs import/export before the milestone is called done — the manager reads that as the next milestone, not this one.

## The expectation, in his words

> how "lightweight" it can be? Lightweight in terms of two things: It should be able to run (not necessarily) client side (in browser), not server side … be super powerful, WITHOUT need server side infrastructure (CORS is a different story, we can provide helper for that), so does the whole agent framework, the auth token, never sent to our side. We don't care which token provider user is using. It tries to provide tools that lets agent feel familiar (like ls, rg, read, write, git). So all our side pay is CDN.

> it has to get-ready for getting killed at any time randomly … even if that happens, it should have persistent storage instead of in-mem-crash-disappear thing that as long as you re-wake that page, it starts again automatically unattended (not even a "continue"), and it's not only the root agent, the whole fleet tree resumes itself.

> I kind of prefer it to implement most of the common things like ls/rg/read/write/git in js (or use existing implementation), where the backend/platform is abstract. It can be working on real fs files, or in browser.

> pony-tail (don't reinvent wheel … ls/read/write is probably fine-ish, rg(or grep)/git stuff definitely use mature work, also need to support /compact and perfect prefix stability thing

What that adds up to as a thing a person can judge:

1. Open a URL. Paste a token. Point at a repo — clone it from the host with `isomorphic-git`, or open a real folder through the user's own permission. Ask for a change.
2. Watch the tree work: a diagram of nodes and edges with statuses, not a chat transcript. Files change in the workspace; every step is a commit, so the diff can be accepted, reverted, or blamed.
3. Kill the tab mid-run. Reopen the URL. The whole tree resumes by itself — root, children, timers — with no button, and the log shows what was in flight and what was re-run.
4. The context compacts when it fills, and the cache-hit numbers stay high across turns, measured in the response's own `usage` field.
5. All of it with no server of ours: no relay, no credential, no telemetry, no third-party script the user did not ask for.

## The settled leaf

1. **Two deployment postures, one core.** Browser is the default (mode C: zero marginal cost, interactive). Node/Bun is the same core with a different `fs` and `storage` adapter (mode B: self-host, unattended). Browser is not a port of the Bun version; both are adapters over the same interfaces.
2. **A small `fs` interface, platform-abstract**: `read · write · ls · stat · mv · rm` plus an optional `openSync`. Adapters: `opfs`, `node`, `mem`, `fsaccess`. Everything above it — tools, git, the log — is written once and is async.
3. **Storage layering**: OPFS is the workspace and the git repo; IndexedDB is the event log, the tree index and metadata; Cache Storage holds the runtimes (esbuild-wasm, Pyodide); File System Access API is the optional "open my real folder"; `localStorage` holds one key and nothing else.
4. **The log is the truth and JS state is a cache.** Append `intent {seq, node, tool, args}` before the effect and `result {seq, ok, out}` after it. On load, replay the tail: an intent with no result is resolved by re-running (idempotent effects) or by checking (non-idempotent ones, e.g. "does the ref already point at this commit"). The model call is treated as idempotent-but-costly: record the request hash, re-issue on resume, accept that one turn may be paid twice.
5. **The tree resumes because nothing lives in memory.** Root and every child are nodes with their own log and status; the parent owns the children's liveness. On load, every node marked `running` restarts. There is no continue button because there is nothing to continue *from*.
6. **One lock per session.** `navigator.locks` keyed by the session id, because the browser releases a dead page's lock for free. Two tabs on one tree is the only guaranteed corruption.
7. **The Home Screen entry as the durability mechanism, not a nicety** (root, 2026-10-23). A manifest with `display: standalone` plus Share → Add to Home Screen is the whole mechanism; `navigator.storage.persisted()` is read at load and the screen says what it returned, and `estimate()` is shown beside it, because a tab may otherwise be evicted — by ITP on a timer in Safari, by disk pressure anywhere.
8. **Execution is tiered, and the tiers are named in the product** (root, 2026-10-23): (1) JS natively in a **Worker**, plus TS with types stripped — no licence, no shell, faster than spawning a process; (2) Python via Pyodide, lazily fetched and priced at the tap, outside the promise; (3) shell-ish via `wasm-coreutils`; (4) remote compute as an explicit budgeted tool. Tiers 3 and 4 are opt-in; tier 1 is the promise; WebContainers are rejected rather than optional.
9. **Tools are native and named.** `ls · read · write · edit · grep · git_* · run_js · todo · remote`. There is no shell. The tool list exists in the prompt (unlike `agent.sh`, where bash *is* the tool list), and that is a different harness kind, not a port.
10. **Git is the workspace's version control from the first commit.** `isomorphic-git` over the same `fs` adapter; auto-commit per agent step, so undo, review, diff and blame exist without inventing anything.
11. **CORS ladder with no relay of ours**: provider's own browser-origin opt-in first; otherwise a helper on the user's own `127.0.0.1` (which needs `Access-Control-Allow-Private-Network` as well as CORS, per Chrome's Private Network Access rules — *reported*, verify); otherwise an extension the user installs. Never a relay that sees the token.
12. **The token never reaches us and is never at rest by default**: memory only, never a URL, never `localStorage`, never analytics or error reports, an explicit forget button. Optional trivial encryption at rest, documented *as* theatre.
13. **Context**: append-only log, `/compact` as an appended message, compaction recorded as an entry carrying `{summary, firstKeptEntryId}`, the request rebuilt as `system + summary + tail`. Never rewrite the prefix between turns; volatile content (clock, `pwd`, cost meter, last job status) goes in the newest message, never the front.
14. **Minimal dependency set, and every line of it owned**: `isomorphic-git`, `esbuild-wasm`, a grep engine, a diff, a gitignore matcher, a storage adapter per platform. Nothing else without a say-so.

## The tree

### D1. Where the agent runs

| branch | what it is | verdict |
|---|---|---|
| `D1a` browser tab | the loop, the tools, the workspace and the tree all in the page | **chosen default.** Zero marginal cost per user, cost predictable, privacy architectural, install is a URL, works from an iPad. Costs: a tab is not a service; storage is quota-managed; no server-side compute. |
| `D1b` Node/Bun server | same core, `node` adapters | **keep, second.** Its real value is *durability, not CPU*: an agent waiting 95% of the time is cheap to multiplex, but only a server can run while nobody is looking. |
| `D1c` WebContainers (StackBlitz) | real Node in the tab | **rejected as the default.** Commercial licence required for for-profit production (free only for OSS/prototype), and it needs COOP/COEP cross-origin isolation, HTTPS, and SharedArrayBuffer. It is the only way to get "real npm, real Node", so it survives as an opt-in tier. |
| `D1d` remote compute | ship the workspace to a bigger host, as a tool | **kept, not a mode.** It is how the browser stays the default while heavy work still happens, and it is where a price must be shown at the call site. |
| `D1e` a shell in the tab (v86 / portabox / wasi-sh) | a real Linux userland in WASM | **rejected as the default, kept as a curiosity.** Real ELF binaries, BusyBox, no licence (portabox is Apache-2.0), but 10–100× slower than native, often single-threaded, no public network, and it reintroduces the thing we are trying to remove — process-shaped tools. |

The prior art says this is a crowded room: `bolt.new`/`bolt.diy` are the product proof that people want an in-tab coding agent; `Kaset` is the closest *toolkit* (OPFS as the app's filesystem, `isomorphic-git` versioning, approval-gated edits); `SLICC` is a browser-native agent with a shell and VFS and is a young prototype; `nanocodex` ships an agent as a single HTML file from a CDN. Each was checked; none is "one file, BYO token, no server, native tools". That is the gap, and it is a packaging gap, not a research gap. Say so in the product rather than pretending to invent something.

### D2. What the product is

| branch | pro | con |
|---|---|---|
| `D2a` a coding agent | the story in the person's words; competes with bolt on licence and weight | the hardest part is execution, not tools; a crowded field |
| `D2b` an embeddable agent SDK ("your app as a filesystem") | no execution needed, much easier, Kaset shows the demand | smaller ambition than what he described |
| `D2c` single-file CDN page | the strongest "lightweight" claim, no install, no bundler | packaging is a constraint on the architecture (no build step allowed) |

**Not decided.** The record keeps all three alive because they share the same core; the choice changes the first milestone's acceptance, so it is a question for the person, not for the manager to take alone.

### D3. Storage

| candidate | verdict |
|---|---|
| `localStorage` | ~5–10 MB, strings only, synchronous on the main thread, no hierarchy. Rejected for the workspace or the log; kept for one session key. |
| `sessionStorage` | dies with the tab. Rejected — it contradicts the whole design. |
| `IndexedDB` | objects and blobs, async, transactional, large. **Chosen for the event log and the tree index**, because a transaction is exactly the atomic append the log needs. |
| **OPFS** | a real hierarchical POSIX-ish file system private to the origin, with streams and large quota. **Chosen for the workspace and the `.git` directory.** Node-shaped `fs` adapters over it are proven (`shadow-claw`'s `makeOpfsFs`, `private-pages`), including for `isomorphic-git`. |
| `Cache API` | HTTP-response-shaped. Chosen for runtimes: esbuild-wasm is ~12 MB *reported*, and a reload must not re-download it. |
| `File System Access API` | user-visible real folders, permission prompt, handle persisted in IndexedDB. Kept as the "open my actual project" path; Chromium-family mostly. |
| checkpoint snapshots (serialize the whole tree periodically) | **rejected as the resume mechanism**: cost is O(workspace) per checkpoint, and a kill between two checkpoints still loses work. The append-only log is strictly better and cheaper. |
| in-memory only | rejected; it is the failure this project exists to avoid. |

The number that governs the product: all of these share one quota pool per origin. Chrome gives ~60% of disk per origin; Firefox ~10–20%; **Safari ~1 GB and wipes script-writable storage after 7 days without interaction for sites that are not on the Home Screen**, while sites added to the Home Screen are exempt, and Chrome auto-grants `persist()` to installed PWAs. That single rule is why the Home Screen entry is part of the design and not marketing (root, 2026-10-23).

### D4. Surviving a kill

| branch | verdict |
|---|---|
| rely on `beforeunload`/`unload` to flush | **rejected.** Chrome's own guidance is that termination events cannot be detected reliably, especially on mobile, and merely registering `unload` can stop bfcache. |
| rely on the discard notification | **rejected.** The browser will not wake a discarded page to run a handler, so *no cleanup path exists*; `document.wasDiscarded` is only readable after the fact, on the next load. |
| flush at `visibilitychange → hidden`, `freeze` where present | **adopted as a bonus, never as the guarantee.** Last reliable moment; use it to make the log's tail durable, then assume it did not happen. |
| append-only log with intent/result and idempotent re-run | **chosen.** The only mechanism that survives a kill with no event at all. |
| manual lease records with heartbeats for locking | **rejected in favour of Web Locks**, which are released by the browser when the page dies — the semantics a heartbeat is trying to imitate, for free. |
| mirror the log to the user's own git remote | **kept as the durability ladder's top rung**: OPFS → `persist()` → installed PWA → the user's own repo, which is the only copy that survives a wiped origin. |

Two honest limits, both to be stated in the product rather than discovered by the user: if the tab is never reopened, nothing runs; and a browser that wipes storage (Safari's 7-day rule) takes the tree with it unless the mirror exists.

### D5. Tools

| branch | verdict |
|---|---|
| a real shell in the tab | see `D1e`; rejected as default |
| **native JS tools over the abstract fs** | **chosen.** No process, no cold start, milliseconds per call, works on `opfs`, `node`, `mem` unchanged. |
| hand-roll `ls/read/write/edit` | **accepted**, in his words "probably fine-ish": they are thin functions over `fs`. |
| hand-roll `git` | **rejected.** Use `isomorphic-git` — it already abstracts over exactly this `fs` shape, and its OPFS adapters are proven in three projects found. Do not reimplement object storage, packfiles or refs. |
| hand-roll `rg` | **rejected, but the plumbing is the real decision.** There *is* mature work: `ripgrep` itself compiled to `wasm32-wasip1` (SIMD), exported as an ESM-embedded blob; `grep-wasm`, which exposes `search(pattern, files, opts)` over an in-memory file list; `@netgrep/search`, ripgrep's regex engine in WASM (~1.17 MB) that greps over HTTP with streaming. None of them accept an arbitrary `fs` adapter: the first wants a WASI fd preopen, the last wants URLs. So the choice is *(a)* build a WASI shim over the `fs` interface and use real ripgrep, *(b)* pass file contents to `grep-wasm` and lose the streaming walk, or *(c)* a walker over the `fs` interface + the `ignore` package for gitignore semantics + `RegExp`. Whichever is chosen, the *deciding* measurement is how much of a walk of 10k files the adapter costs, and that has not been measured here. |
| TypeScript compiler | never hand-roll. `esbuild-wasm` (the official wasm build) in a Worker; `@swc/wasm-web` is the alternative. |
| diff / gitignore / glob | never hand-roll: `diff` (jsdiff), `ignore`, `picomatch`. |

### D6. Running code, i.e. what "powerful" is allowed to mean

Tier 1 is the promise: a JS/TS project runs in a **Worker**, compiled by `esbuild-wasm`, no shell needed, and that is genuinely sufficient for the web-app class of work. Tier 2 is Pyodide. Tier 3 is `wasm-coreutils` for shell-shaped needs. Tier 4 is a budgeted `remote` tool that ships a tarball and streams results back — the honest way to say "this machine cannot compile your Rust". Tier 5 is WebContainers for people who want `npm i` to just work and will accept the licence. Rejected: pretending tier 1 covers tier 4, and silently falling back to a server.

### D7. Model access

Provider-direct with the user's own token, via chat completions. Rejected outright: our own relay (costs money, sees the token, and invites the exact question "why would you want that"). For providers that forbid browser origins: a helper on the user's `127.0.0.1`, or an extension the user installs. Both are the user's own infrastructure, which is the point.

Measured on this machine for the sibling project, and directly reusable: `POST https://api.deepseek.com/chat/completions` with `reasoning_effort: "low"` returns `usage.prompt_cache_hit_tokens`; a 1242-token prefix repeated with one appended message returned 1024 hit / 227 miss. That number is the whole "perfect prefix" acceptance test and it works from a browser too.

### D8. Context, `/compact`, prefix stability

The mechanism is the same one `agent.sh`'s record derives from pi's `docs/compaction.md`, and it fits the browser better than it fits a shell: the log is already append-only and already in IndexedDB, so a compaction is one more record. What differs here is only *where* the pieces live. Short form, because the reasoning is not duplicated:

- never rewrite; append a compaction record `{summary, firstKeptEntryId}` and rebuild the request as `system + summary + messages from firstKeptEntryId`;
- repeated compactions summarize from the previous boundary and pass the old summary in as iterative context;
- `/compact` itself is an appended user message, so the summarization request is a prefix *extension* of the conversation and reuses the cache;
- volatile content never sits in the front, which is what makes the hit-token arithmetic hold;
- the acceptance is not a code review: on turn *n*+1, `prompt_cache_hit_tokens` should be roughly `prompt_tokens` minus the appended tail, and the margin is the provider's cache chunk size (1024 of 1242 observed).

### D9. Token handling

Memory only. Never a URL, never `localStorage`, never telemetry, never an error report. An explicit forget button. Optional encryption at rest is documented as theatre that stops a casual read, not as security. The trust boundary is stated plainly: a token the user hands to a page is exposed to that page's dependencies and the user's own extensions, and we reduce that surface to "we load what we said, hashed" — pinned versions, SRI, self-hosted WASM — rather than claiming it away.

### D10. The interface

The web's real advantage is not prettiness, it is that the tree can be rendered *as itself*: nodes, edges, statuses, costs, live, with a diff view per node and a timeline that survives a reload because it is derived from the log. A chat transcript hides state; a diagram shows it and doubles as the answer to "why must this tab stay open" — the tab is the control room. Rejected: a chat-first UI with a sidebar (it is what everyone ships and it hides the one thing that is interesting here).

## Prior art, and what to take from each

*Reported, from each project's own docs; not measured here.*

| project | what to take |
|---|---|
| `bolt.new` / `bolt.diy` | the product proof; that an in-tab agent is wanted; and the licence lesson (WebContainers are not free for commercial production) |
| `Kaset` (`pufflyai/kaset`) | OPFS-as-your-app's-filesystem, `isomorphic-git` versioning, approval-gated edits, auto-commit per task, `grep`/`patch` utilities over OPFS |
| `SLICC` (`ai-ecoverse/slicc`) | a browser-native agent with VFS + shell; a young reference for what hurts |
| `nanocodex` | agent loop compiled to WASM, shipped as one HTML file from a CDN — the packaging to beat |
| `private-pages` | `isomorphic-git` + OPFS + Service Worker, Web Locks for cross-tab safety, tokens encrypted with SubtleCrypto in IndexedDB |
| `shadow-claw` | a 40-line `makeOpfsFs` adapter for `isomorphic-git`; a full `git_*` tool table worth copying |
| `wasi-sh` | the best written record of browser-FS traps: hydrate/flush, worker-only handles, write-back that silently drops, memory ceilings |
| `portabox` / `v86` / `linuxontab` | licence-free Linux-in-a-tab, if tier 5 ever needs a fallback |
| `esbuild-standalone` / `@vraksha/esbuild-browser` | TS/TSX and npm-from-CDN in a Worker, no server |
| `WebLLM` / `Transformers.js` / Chrome Prompt API | tier-0 inference: free, offline, private, small models |
| `Page Lifecycle API` docs, `MDN storage quotas`, `StorageManager` | the kill model and the quota model |

## What must be measured before the first package

Nothing above about the browser has been measured on this machine. The first package is a set of probes, not a feature:

1. OPFS: does `createSyncAccessHandle` exist in Workers on the target browsers today? Sources disagree — one says it was removed in Chrome 122+, others document it as current. Feature-detect, do not assume.
2. `isomorphic-git` over OPFS: clone a real repo of 1k and 10k files; time it; measure memory.
3. The grep decision: walk 10k files through the `fs` adapter and time it; then time passing contents to `grep-wasm`; then time a WASI preopen shim. Pick on evidence, per `D5`.
4. Kill-and-resume: kill the tab at 100 random points during a run; count how many resume without losing a step and how many re-run a paid model call.
5. `esbuild-wasm` cold and warm load; the Worker's first compile.
6. Quota and eviction behaviour on Safari specifically, including the 7-day rule and whether an installed PWA really is exempt.
7. The cache arithmetic from a browser origin: two requests, `prompt_cache_hit_tokens` on the second.

## Open questions

1. **Durability target — answered by root, 2026-10-23.** The promise is the site added to the Home Screen and nothing else; a plain tab and a Safari bookmark stay outside it, and the screen repeats `persisted()` so nobody is told more than the browser said. What this closed: the "promise a plain tab too" branch, and the belief that `persist()` can override ITP.
2. **Execution promise — answered by root, 2026-10-23.** JS native plus erasable-syntax TS plus `isomorphic-git` in the tab; Python fetched lazily outside the promise; WebContainers and paid runtimes rejected. What this closed: `esbuild-wasm` as a mandatory 12MB download and the tier-5 "real npm" branch.
3. **Degree** — recorded as `decide` *assumed* from the sibling project's instruction, not stated here; one word vetoes it, and the decisions taken under it are marked.
4. **D2 — taken by the manager at `decide`, 2026-10-23: a coding agent (`D2a`).** It is the story in the person's words, and the only branch whose first milestone is also the promise being checked. What the assumption costs: an embeddable SDK (`D2b`) would have been the cheaper thing to get right first, and a single-file CDN page (`D2c`) is what the "lightweight" claim would look best as. The observation that would overturn it: the in-tab Worker turning out to need WebContainers for the web-app class of work, at which point the SDK is the honest product.
5. **Where the site is served from — root's, not the manager's.** A CDN account is the one credential this needs and the only piece that is not the user's own; M1 is accepted without it, on `http://127.0.0.1:8137/`.

## Non-goals

No server of ours. No relay. No telemetry. No third-party script we did not pin. No real shell by default. No "runs anything" claim. No unattended execution when the tab is closed. No reimplementation of git, TypeScript, ripgrep or diff. No chat-first UI.

## effort

Chosen: browser-first with an abstract `fs`, OPFS+IndexedDB+Cache+FS-Access layering, append-only intent/result log with automatic tree resume, Web Locks, installed PWA as the durability mechanism, native JS tools with a Worker as the JS/TS runtime, `isomorphic-git`, tiered execution, provider-direct tokens with a user-side CORS helper, pi-shaped compaction on an append-only log, tree-as-diagram UI.

Closed with a reason, not a preference: one shell hijacking its own stdio (`agent.sh`'s losing branch, already measured there); a real Linux in the tab as the default (10–100× slower); WebContainers as the default (licence + isolation headers); our own CORS relay (cost + the token); cleanup-on-unload (cannot be detected); checkpoint snapshots (cost, and a kill between them still loses work); chat-first UI (hides the state that makes this product different).

Would reopen: a provider that ships browser-origin support and a cheap frontier model with large context (makes tier 0 less attractive and tier 1 more capable); a licensed WebContainer deal (kills the case for tiers 3–5); a wasm ripgrep that accepts a pluggable `fs` (settles `D5` without a shim); Service Worker background execution becoming reliable (would soften "a tab is not a service" — do not plan on it).
