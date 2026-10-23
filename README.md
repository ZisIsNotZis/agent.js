# agent.js

A coding agent that runs in the browser tab and needs no server: a URL, the user's own token, a workspace in the browser's file system, and a tree of agents that survives the page being killed.

**Not for** anyone who needs unattended runs (close the tab and nothing runs), anyone who needs a real shell today, or anyone who wants us to hold their credential.
It is the sibling of `agent.sh`, not a port of it: there the model writes bash and gets a shell; here it writes JavaScript and gets a Worker.

## Status

The two gating questions are answered (root, 2026-10-23) and recorded at the top of `inbox/2026-10-22-design-tree.md`: durability is promised for the site **added to the Home Screen**, not for a tab or a bookmark; execution is native JS plus erasable-syntax TS with `isomorphic-git` in the tab, with Python as a lazy opt-in outside the promise.
`ROADMAP.md` is the ledger: M1 (the tree survives a kill) and M5 (it is served) are done, and M2–M4, M6 are open.
The promise is measured on desktop Chromium, locally and on the live origin; the Home Screen itself is not yet — the checklist someone has to run is in `mail/2026-10-23-pages-and-the-phone-checklist.md`.

## Where it is

Live: **https://zisisnotzis.github.io/agent.js/**
Source: **https://github.com/ZisIsNotZis/agent.js** — public, AGPL-3.0, served by GitHub Pages from the default branch with no build step and no server of ours.
A project of this workspace that must be reachable lives at `github.com/ZisIsNotZis/<its directory name>`.

## How to start

Read `ROADMAP.md`, then the design record in `inbox/`.
Run it locally: `node tools/serve.mjs` and open `http://127.0.0.1:8137/`.
Run its acceptance: `node tools/probe-m1.mjs` (needs the server up, or `URL=https://zisisnotzis.github.io/agent.js/` to check the live one; it needs `playwright-core`, bare or at `PLAYWRIGHT_CORE`).

## How to continue

`ROADMAP.md` holds the order, each node's owner and its acceptance.
A message for this project lands in `mail/`; a message from it is written into the receiver's own `inbox/`, never kept here.
