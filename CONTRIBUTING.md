# Contributing to agent.js

agent.js is a coding agent that runs entirely in a browser tab — no server of ours, no build step, the workspace in OPFS and the log in IndexedDB. Contributions are welcome in that shape: the published tree is the project root, and what runs is what is served.

## Scope

In scope: the loop, the tools, the tree interface, durability and resume, execution, export/import, and the probes that prove them. Out of scope as decisions rather than gaps (see `ROADMAP.md`, "Not doing"): a server or relay of ours, telemetry, a token at rest, WebContainers, a real shell, unattended runs with the tab closed, and any reimplementation of git, TypeScript, ripgrep or diff.

## What runs, and how to run it

```sh
node tools/serve.mjs          # http://127.0.0.1:8137/ — the site, no dependencies
node tools/mock-provider.mjs  # a provider that costs nothing, on :8138
node tools/probe-w11.mjs      # a probe, with the server already up
URL=https://zisisnotzis.github.io/agent.js/ node tools/probe-m1.mjs
```

There is no linter, bundler or package manifest at the root, and adding one is a design change, not a chore. The probes are the test suite: they need `playwright-core` (bare, or at `PLAYWRIGHT_CORE`) and `CHROME_PATH` when playwright's Chromium is not installed. `node tools/probe-module-graph.mjs` checks `sw.js`'s `SHELL` against the real module graph; bump `CACHE` in `sw.js` whenever `SHELL` changes. `node tools/vendor.mjs` regenerates `vendor/` from pinned versions — the bundles are committed because the site must serve without a build.

## Before you open a pull request

- **Run the probes you touched, and say which ones in the pull request**, with the counts they printed. A probe that went from green to red is the pull request's problem, not the machine's.
- **A claim is measured or it is marked `reported`.** No benchmark, size, compatibility statement or "works on a phone" that was not produced in this tree. If something could not be measured, write that instead of a number.
- **One home per fact.** A fact lives in the file that owns it (`ROADMAP.md` for state and acceptance, the source comment for the mechanism, `README.md` for the person's view); link, do not restate.
- **No new dependency without a note in the pull request** saying what it replaces and what it costs in bytes — the product's main constraint is what a tab can afford to download.
- **A bug fix does not end at the fix.** Add the smallest check that would have caught it — a probe assertion, a type, a refusal — or explain why none is possible.
- **Never delete another run's evidence.** Probes clean only the evidence they wrote, by name; `evidence/` is what a red run is debugged from.
- **The key is never stored.** Nothing may write it to storage, a log, a URL, a trace or a worker.

## Commits and review

Small commits, one concern each, message in the imperative describing what the change makes true. Say in the body what was run and what it printed. Review is about the claims: a change that makes a stronger statement than its evidence is the thing that gets sent back.

## Issues

State what you did, what you expected, and what the screen or the probe printed — a trace from `Export trajectory` is worth more than a description. Do not paste a key, a provider URL with a key in it, or a full request body containing one. Questions about direction belong in an issue before a pull request.

## License

By contributing you agree your work is licensed under AGPL-3.0, as the project is.
