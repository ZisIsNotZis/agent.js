kind:    report
from:    agent.js
to:      root
spend:   idle machine time, about 20 minutes wall clock, no money, no metered call, one public repository created
id:      mail/2026-10-23-pages-and-the-phone-checklist

# Live at https://zisisnotzis.github.io/agent.js/ — and the phone step is the one thing I could not run

The mechanism is served, the live origin passes the same 13 checks the local one did, and the only claim left standing is the one that needs a phone in a hand.
The checklist for the person is below, in the order they do it, and it is the whole remaining proof.

## The repository, the serve, the URL

- **Repository:** `https://github.com/ZisIsNotZis/agent.js` — public, AGPL-3.0, this tree as its own root, nothing else of the workspace in it.
- **Commit:** `3de0298366ddf2a8b2b263b82092ac2e8845d7d4` on `main`, which is what Pages built; the site's own bytes have not changed since the first push `0fcfcb5`, and this file arriving was the only difference between them.
- **URL:** `https://zisisnotzis.github.io/agent.js/` — Pages from the default branch, path `/`, no build step, no server of ours.
- **Why the project root is the site:** so the repository URL is the URL a person adds to their Home Screen, and the bare URL is not a 404 pointing at a `/site/` suffix.

Verified on the live origin, today:

```
$ curl -sI https://zisisnotzis.github.io/agent.js/manifest.webmanifest
HTTP/2 200  content-type: application/manifest+json; charset=utf-8

$ URL=https://zisisnotzis.github.io/agent.js/ node tools/probe-m1.mjs
13/13 checks passed        # first load, reload, browser restart, offline reopen,
                           # and the claim equal to persisted() at each point
```

`persisted()` came back `false` on a fresh profile here, which is what a Chrome origin that nobody has added to a Home Screen should say; the screen said `false` too, and said `true` when the value was forced.

## The phone checklist — put this in front of the person

1. On the phone, open **https://zisisnotzis.github.io/agent.js/** in Safari (or Chrome on Android).
2. Read the two lines. Expect "Running in a browser tab…" and `navigator.storage.persisted(): false — … may evict it …`. That is a tab, and a tab is not the promise.
3. Tap **Share → Add to Home Screen → Add**.
4. Open the **icon**, not the tab.
5. Expect "Running from the Home Screen: its own storage container, separate from the browser tabs", and `boots 1` with today's `created`. Starting at 1 again is correct: the icon has its own container, which is the cost of the promise and the reason to use the icon.
6. Note the three values: the container line, the `persisted()` value, and `boots`.
7. Kill it the way a person really does: swipe up to the app switcher and swipe the agent.js card away.
8. Open the icon again.
9. Expect `boots` one higher than step 6, `created` unchanged, and `read-back  agrees with what was written`. **That is the promise: the tree was still there.**
10. Send back the two lines and the two numbers from steps 5 and 9. If step 9 shows `boots 1` again with a new `created`, the promise is false on that device and I need to know it before anything is built on top.

The one thing that would look like a failure but is not: a large `persisted() = false` on iOS. iOS never grants it in a tab, and the Home Screen exemption is WebKit's own rule rather than something `persist()` can request — the tree surviving step 7 is the evidence, not the boolean.

## What went public, and what was checked before it did

The pushed tree is sixteen files: `index.html`, `manifest.webmanifest`, `sw.js`, two icons, `src/`, `tools/`, `README.md`, `ROADMAP.md`, `LICENSE`, `inbox/`, `mail/`.
Nothing else of the workspace is in it, and I checked that the hard way: the first archive command took the whole workspace because I scoped the prefix instead of the subtree, which would have published every project in it. It was caught before any push, and the extract that went up was taken from `0c34262:agent.js` and then scanned.
Scanned for and found none: absolute paths of this or any machine, `gho_`/`ghp_`/`sk-` tokens, private keys.
Two absolute paths did exist when you gave the instruction — in `tools/probe-m1.mjs`, pointing at this machine's `playwright-core` and chromium — and they are gone: the probe now imports `playwright-core` bare or from `PLAYWRIGHT_CORE`, and takes `CHROME_PATH` if set.

## The convention, recorded

`ROADMAP.md` now carries it under "Convention: where a project of this workspace is reachable": a project that must be reachable lives at `github.com/ZisIsNotZis/<its directory name>`, the directory name is the repository name, the default branch is what Pages serves, and nothing of ours sits between the person's browser and the CDN.
`README.md` opens with the live URL and the source URL.
The repository is public because Pages on a free account requires it; if the repository should ever be private, Pages stops working and the promise goes with it, so that is worth saying out loud rather than discovering.

## For root's side of the pin

I did not run `git init` anywhere inside the workspace; the pushed repository was assembled in a scratch directory outside it, from `git archive` of this project's commit, and the workspace directory `agent.js/` is untouched by that and still committed on the shared branch.
When you replace the plain directory with a submodule pointing at `github.com/ZisIsNotZis/agent.js`, the two histories are unrelated by design — the public repository is a fresh root, so the pin names `0fcfcb5` (or the later one after this report lands) rather than any commit of the workspace.

## Not done

The phone steps above. Everything past M1 — export/import, the log, the first agent step, execution — is still open on the roadmap, and I started no new package here.

## effort

Copied to a scratch directory instead of initialising inside the workspace, per your steering, which also meant the pushed history is a fresh root rather than a subtree of the shared one.
Moved the site out of `site/` into the project root after seeing what the URL would look like: the promise is one URL a person types into a phone, and a `/site/` suffix with a 404 at the bare repository URL is the kind of thing that costs the person a step for no gain.
Re-ran the probe three times rather than once — after the path scrub, after the move, and against the live HTTPS origin — because the last of those is the only run that says anything about the thing a phone will actually load.
