// The screen. Two claims, each read from the thing it is about:
//   container  <- display-mode / navigator.standalone
//   persistence<- navigator.storage.persisted()
// plus the tree, which is whatever OPFS gave back on this load.

import { boot, NoOpfs } from './state.js';
import { replaySettled, records as readRecords, getFs, getGit } from './run.js';
import { exportBundle, importBundle, bundleText, deliverBundle, exportFilename } from './transfer.js';

const $ = (id) => document.getElementById(id);

// The loop, the provider client and the trace are loaded on first use, never on
// a normal boot: the shell that made the tree survive a kill is unchanged, and
// a page that only shows the tree pays nothing for the agent loop.
let loopMod = null;
const ensureLoop = () => (loopMod ??= import('./loop.js'));
let replayed = null;

const runLines = [];
function pushRun(line) {
  runLines.push(line);
  const el = $('run-status');
  if (el) el.textContent = runLines.join('\n');
}

function transcript(line) {
  const el = $('run-transcript');
  if (!el) return;
  if (el.dataset.empty !== 'false') {
    el.textContent = '';
    el.dataset.empty = 'false';
  }
  el.textContent += `${line}\n`;
}

function showKeyStatus(status) {
  const el = $('key-status');
  if (!el) return;
  el.dataset.hasKey = String(Boolean(status?.hasKey));
  el.textContent = status?.hasKey
    ? 'key        in memory for this page only — not stored, not in the URL, not in the log; Forget clears it'
    : 'key        not set — a run with no key sends nothing';
}

function renderPending(pending) {
  for (const p of pending ?? []) {
    pushRun(`pending model call seq ${p.seq} request ${p.args?.requestHash ?? p.requestHash}`
      + ' — interrupted by a kill; re-issued once when you continue with a key');
  }
}

// The screen's reading of the loop's own events. `usage` is printed with
// JSON.stringify of the object the provider returned: no normalising, no
// renaming, so a provider's cache fields are visible as its own words.
function wireLoop() {
  const send = $('send');
  if (!send) return;

  $('key-set').addEventListener('click', async () => {
    const m = await ensureLoop();
    const status = m.configure({
      baseUrl: $('base-url').value,
      model: $('model-name').value,
      key: $('key-input').value,
    });
    $('key-input').value = '';
    showKeyStatus(status);
  });

  $('key-forget').addEventListener('click', async () => {
    const m = await ensureLoop();
    showKeyStatus(m.forget());
  });

  send.addEventListener('click', async () => {
    const m = await ensureLoop();
    const typedKey = $('key-input').value;
    const status = m.configure({
      baseUrl: $('base-url').value,
      model: $('model-name').value,
      ...(typedKey ? { key: typedKey } : {}),
    });
    if (typedKey) $('key-input').value = '';
    showKeyStatus(status);
    try {
      await m.run($('prompt').value);
    } catch (e) {
      pushRun(`error       ${e.message}`);
    }
  });

  $('export-trace').addEventListener('click', async () => {
    const t = await import('./trace.js');
    const filename = t.downloadTrace();
    pushRun(`export      ${filename}`);
  });

  window.addEventListener('agent:loop', (e) => {
    const d = e.detail || {};
    if (d.phase === 'start') pushRun(`run         started — ${JSON.stringify(String(d.prompt ?? ''))}`);
    else if (d.phase === 'request') pushRun(`request     seq ${d.seq} · ${d.reissue ? 'RE-ISSUED' : 'sent'} · request hash ${d.requestHash}`);
    else if (d.phase === 'reissue') pushRun(`re-issued   seq ${d.seq} request ${d.requestHash} — the one unfinished call, re-issued once`);
    else if (d.phase === 'response') {
      pushRun(`response    seq ${d.seq} · ${Math.round(d.ms)} ms`);
      const usage = $('usage');
      if (usage) usage.textContent = d.usage ? JSON.stringify(d.usage) : 'none returned';
      refreshView();
    } else if (d.phase === 'tool') {
      pushRun(`tool        ${d.tool} seq ${d.seq} · ${d.out?.op ?? 'done'} · ${Math.round(d.ms)} ms`);
      transcript(`tool ${d.tool} -> ${JSON.stringify(d.out).slice(0, 400)}`);
      refreshView();
    } else if (d.phase === 'error') {
      pushRun(`error       ${d.message}`);
      transcript(`error ${d.message}`);
      refreshView();
    } else if (d.phase === 'done') {
      pushRun(`done        ${d.turns} request(s), ${d.toolCalls} tool call(s), ${d.commits} commit(s), trace ${d.runId}`);
      refreshView();
    }
  });
}

function isStandalone() {
  if (navigator.standalone === true) return true; // iOS < 17 has no display-mode query
  try {
    return matchMedia('(display-mode: standalone)').matches ||
           matchMedia('(display-mode: fullscreen)').matches;
  } catch {
    return false;
  }
}

function renderContainer() {
  const standalone = isStandalone();
  const el = $('container');
  el.dataset.standalone = String(standalone);
  el.textContent = standalone
    ? 'Running from the Home Screen: standalone storage is its own container. '
      + 'A browser tab is a different container and does not see these files — to move '
      + 'a workspace in, export it in the tab and import it here.'
    : 'Running in a browser tab: this tab\u2019s storage is its own container. '
      + 'The same site opened from the Home Screen icon is a different container and does '
      + 'not see these files. In Safari this tab is wiped after 7 days without interaction '
      + '(ITP) — export to keep the workspace, or add to Home Screen and import it there.';
}

// Whether this load is driven by the service worker, and which shell entries are
// not in its cache. The worker answers the second from Cache Storage; the first
// is navigator.serviceWorker.controller, the thing itself.
function controllerSettled(ms = 10000) {
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(navigator.serviceWorker.controller !== null), ms);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
}

function askShell(worker, ms = 15000) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('no active worker'));
      return;
    }
    const ch = new MessageChannel();
    const timer = setTimeout(() => {
      ch.port1.close();
      reject(new Error(`no answer in ${ms} ms`));
    }, ms);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    worker.postMessage({ type: 'shell-status' }, [ch.port2]);
  });
}

async function renderShell() {
  const el = $('shell');
  const drivenWord = (driven) => (driven
    ? 'driven by the service worker'
    : 'not driven by a service worker on this load');
  const show = (driven, missing, note = '') => {
    el.dataset.driven = String(driven);
    if (missing === null) {
      el.dataset.missing = 'unknown';
      el.textContent = `shell      ${drivenWord(driven)} — the manifest could not be read${note}`;
      return;
    }
    el.dataset.missing = missing.join(',');
    const list = missing.length
      ? `missing ${missing.join(', ')} — retried on this load and on the next`
      : 'every shell entry is cached';
    el.textContent = `shell      ${drivenWord(driven)} — ${list}${note}`;
  };
  if (!('serviceWorker' in navigator)) {
    show(false, null, ' (no service worker in this browser)');
    return;
  }
  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch (e) {
    show(false, null, ` (no active registration: ${e.name})`);
    return;
  }
  const driven = await controllerSettled();
  const worker = navigator.serviceWorker.controller || reg.active;
  let state;
  try {
    state = await askShell(worker);
  } catch (e) {
    show(driven, null, `: ${e.message}`);
    return;
  }
  show(driven, state && Array.isArray(state.missing) ? state.missing : null);
}

// ---- the tree, as itself -------------------------------------------------
//
// Everything below is folded from the log on every render. The only view state
// is `selection`, an in-memory pointer at a node and a step; it is never stored,
// so a reload with empty memory picks the same default (the newest commit) and
// paints the same tree, timeline and diff from the records alone. There is no
// second copy of the tree anywhere: the OPFS `tree.json` snapshot is a cache for
// export, and the `#tree` line above is what that cache says, not this view.
//
// The log's record shape is untouched. A record already carries `seq`, `node`,
// `tool` (on the intent) and `out` (on the result), and `add_node`/`set_status`
// results carry the parent edge and the status; that is all the tree needs.
// A result has no `node`/`tool` of its own, so it is paired with its intent by
// `seq` — the log's own key, not a new one.

const CONTEXT = 3;
let selection = null;
let selectionExplicit = false;
let currentView = null;
let paintToken = 0;
let refreshing = Promise.resolve();
const diffCache = new Map();

function emptyNode(id, parent, status) {
  return { id, parent, status, steps: 0, commits: [], depth: 0 };
}

function foldView(records) {
  const intents = new Map();
  const results = new Map();
  for (const r of records) (r.kind === 'intent' ? intents : results).set(r.seq, r);

  const nodes = { root: emptyNode('root', null, 'idle') };

  // Parent/status are the settled results of add_node/set_status; git_commit's
  // result names the commit its step produced.
  const commits = [];
  for (const seq of [...results.keys()].sort((a, b) => a - b)) {
    const out = results.get(seq).out;
    if (!out) continue;
    if (out.op === 'add_node') {
      nodes[out.id] ??= emptyNode(out.id, out.parent ?? null, 'new');
      nodes[out.id].parent = out.parent ?? null;
    } else if (out.op === 'set_status') {
      nodes[out.node] ??= emptyNode(out.node, null, 'idle');
      nodes[out.node].status = out.status;
    } else if (out.op === 'git_commit') {
      const intent = intents.get(seq);
      const node = intent?.node ?? 'root';
      const c = { seq, node, oid: out.oid, path: out.path, message: out.message };
      (nodes[node] ??= emptyNode(node, null, 'unrecorded')).commits.push(c);
      commits.push(c);
    }
  }

  // A step whose node has no add_node result is still a step the log holds; it
  // is shown as an orphan rather than dropped from the count.
  for (const [seq, intent] of intents) {
    const node = intent.node ?? 'root';
    (nodes[node] ??= emptyNode(node, null, 'unrecorded')).steps += 1;
    void seq;
  }

  // Depth by parent chain, roots first, then orphans; a cycle cannot come from
  // the tools but is bounded anyway.
  const children = new Map();
  for (const n of Object.values(nodes)) {
    if (n.parent != null && nodes[n.parent]) {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n);
    }
  }
  const ordered = [];
  const seen = new Set();
  const visit = (n, depth) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    n.depth = depth;
    ordered.push(n);
    for (const c of (children.get(n.id) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1))) visit(c, depth + 1);
  };
  visit(nodes.root, 0);
  for (const n of Object.values(nodes).sort((a, b) => (a.id < b.id ? -1 : 1))) visit(n, 0);

  const timeline = records.map((r) => {
    const intent = intents.get(r.seq);
    const result = results.get(r.seq);
    const out = r.kind === 'result' ? r.out : result?.out;
    return {
      seq: r.seq,
      kind: r.kind,
      at: r.at ?? result?.at ?? null,
      node: r.kind === 'intent' ? r.node : (intent?.node ?? 'root'),
      tool: r.kind === 'intent' ? r.tool : (intent?.tool ?? '?'),
      outcome: r.kind === 'result' ? outcomeText(out) : null,
    };
  });

  return { nodes: ordered, commits, timeline, byId: nodes };
}

function outcomeText(out) {
  if (!out) return 'no output';
  if (out.op === 'git_commit') return `commit ${String(out.oid).slice(0, 10)} ${out.path}`;
  if (out.op === 'write') return `wrote ${out.path} (${out.bytes} bytes)`;
  if (out.op === 'read') return `read ${out.path} (${out.bytes} bytes)`;
  if (out.op === 'ls') return `listed ${out.path} (${out.entries?.length ?? 0} entries)`;
  if (out.op === 'exec') return `ran ${out.file} — exit ${out.exit}`;
  if (out.op === 'add_node') return `added node ${out.id} under ${out.parent ?? 'root'}`;
  if (out.op === 'set_status') return `set ${out.node} to ${out.status}`;
  if (out.requestHash) return `model reply ${String(out.requestHash).slice(0, 10)}`;
  return out.op ?? 'result';
}

const shortId = (id) => (id.length > 18 ? `${id.slice(0, 15)}…` : id);

function renderNodes(view) {
  const ul = $('tree-nodes');
  ul.textContent = '';
  for (const n of view.nodes) {
    const li = document.createElement('li');
    li.dataset.node = n.id;
    li.dataset.parent = n.parent ?? '';
    li.dataset.status = n.status;
    li.dataset.steps = String(n.steps);
    li.title = `${n.id} — parent ${n.parent ?? 'none'}, ${n.status}, ${n.steps} step(s), ${n.commits.length} commit(s)`;
    li.textContent = `${'  '.repeat(n.depth)}${n.depth ? '└ ' : ''}${shortId(n.id)} · ${n.status} · ${n.steps} step${n.steps === 1 ? '' : 's'}`
      + (n.commits.length ? ` · ${n.commits.length} commit${n.commits.length === 1 ? '' : 's'}` : '');
    li.addEventListener('click', () => {
      const latest = view.commits.filter((c) => c.node === n.id).at(-1) ?? null;
      selection = { node: n.id, seq: latest ? latest.seq : null };
      selectionExplicit = true;
      paintSelection(view);
    });
    ul.append(li);
  }
}

function renderTimeline(view) {
  const ol = $('timeline');
  ol.textContent = '';
  for (const row of view.timeline) {
    const li = document.createElement('li');
    li.dataset.seq = String(row.seq);
    li.dataset.kind = row.kind;
    li.dataset.node = row.node;
    li.dataset.tool = row.tool;
    const time = row.at ? String(row.at).replace('T', ' ').slice(0, 19) : '—';
    li.textContent = `${time}  ${row.kind} #${row.seq}  ${shortId(row.node)}  ${row.tool}`
      + (row.outcome ? `  — ${row.outcome}` : '');
    li.addEventListener('click', () => {
      selection = { node: row.node, seq: row.seq };
      selectionExplicit = true;
      paintSelection(view);
    });
    ol.append(li);
  }
}

function defaultSelection(view) {
  const latest = view.commits.at(-1);
  return latest ? { node: latest.node, seq: latest.seq } : { node: 'root', seq: null };
}

async function paintSelection(view) {
  const token = ++paintToken;
  for (const li of document.querySelectorAll('#tree-nodes li')) {
    li.dataset.selected = String(li.dataset.node === selection.node);
  }
  for (const li of document.querySelectorAll('#timeline li')) {
    li.dataset.selected = String(selection.seq != null && Number(li.dataset.seq) === selection.seq);
  }

  const node = view.byId[selection.node];
  let commit = null;
  if (selection.seq != null) {
    commit = view.commits.find((c) => c.seq === selection.seq && c.node === selection.node) ?? null;
  }
  commit ??= view.commits.filter((c) => c.node === selection.node).at(-1) ?? null;

  const label = $('diff-label');
  const diff = $('diff');
  if (!node) {
    label.textContent = 'nothing selected';
    diff.textContent = 'nothing selected';
    return;
  }
  if (!commit) {
    label.textContent = `${node.id} — no commit recorded`;
    diff.textContent = `node ${node.id} has no git_commit step in the log`;
    return;
  }
  label.textContent = `${node.id} · step ${commit.seq} · ${commit.path}`;
  diff.textContent = 'reading the commit from git…';
  let text;
  try {
    text = await diffFor(commit.oid);
  } catch (e) {
    text = `the commit could not be read: ${e.name}: ${e.message}`;
  }
  if (token !== paintToken) return; // a newer selection won
  diff.textContent = text || '(the commit changed nothing)'; // eslint-disable-line no-unused-vars
}

async function renderView(records) {
  const view = foldView(records);
  currentView = view;
  if (!selectionExplicit || !selection || !view.byId[selection.node]) selection = defaultSelection(view);
  renderNodes(view);
  renderTimeline(view);
  await paintSelection(view);
}

// One render at a time, and always from a fresh read of the log.
function refreshView() {
  refreshing = refreshing.then(async () => {
    let records;
    try {
      records = await readRecords();
    } catch {
      return;
    }
    await renderView(records);
  }).catch(() => {});
  return refreshing;
}

// ---- the diff ------------------------------------------------------------
// Read from git in this page: the commit's tree against its parent's, blob by
// blob, printed as a unified diff. Nothing here reads the log's memory of the
// commit; the oid comes from the log and git answers what it means.

function splitLines(text) {
  const lines = text.split('\n');
  const trailingNewline = lines.at(-1) === '';
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', line: a[i] }); i += 1; }
    else { ops.push({ t: '+', line: b[j] }); j += 1; }
  }
  while (i < n) { ops.push({ t: '-', line: a[i] }); i += 1; }
  while (j < m) { ops.push({ t: '+', line: b[j] }); j += 1; }
  return ops;
}

const range = (start, count) => (count === 1 ? String(start) : `${start},${count}`);

function unifiedHunks(oldFile, newFile) {
  const ops = diffOps(oldFile.lines, newFile.lines);
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    op.old = oldNo;
    op.new = newNo;
    if (op.t !== '+') oldNo += 1;
    if (op.t !== '-') newNo += 1;
  }
  const changes = [];
  ops.forEach((op, idx) => { if (op.t !== ' ') changes.push(idx); });
  if (!changes.length) return '';

  const groups = [];
  let start = changes[0];
  let end = changes[0];
  for (const idx of changes.slice(1)) {
    if (idx - end - 1 <= CONTEXT * 2) end = idx;
    else { groups.push([start, end]); start = idx; end = idx; }
  }
  groups.push([start, end]);

  let out = '';
  for (const [first, last] of groups) {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length - 1, last + CONTEXT);
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((o) => o.t !== '+').length;
    const newCount = slice.filter((o) => o.t !== '-').length;
    const oldStart = oldCount === 0 ? 0 : slice.find((o) => o.t !== '+').old;
    const newStart = newCount === 0 ? 0 : slice.find((o) => o.t !== '-').new;
    out += `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@\n`;
    let lastOld = oldCount > 0;
    let lastNew = newCount > 0;
    for (const op of slice) {
      out += `${op.t}${op.line}\n`;
      if (op.t !== '+') lastOld = true;
      if (op.t !== '-') lastNew = true;
    }
    if (!oldFile.trailingNewline && lastOld && slice.some((o) => o.t !== '+')) out += '\\ No newline at end of file\n';
    if (!newFile.trailingNewline && lastNew && slice.some((o) => o.t !== '-')) out += '\\ No newline at end of file\n';
  }
  return out;
}

function fileDiff(path, oldText, newText) {
  const oldFile = oldText == null ? { lines: [], trailingNewline: true } : splitLines(oldText);
  const newFile = newText == null ? { lines: [], trailingNewline: true } : splitLines(newText);
  let out = `diff --git a/${path} b/${path}\n`;
  if (oldText == null) out += 'new file mode 100644\n';
  else if (newText == null) out += 'deleted file mode 100644\n';
  out += `--- ${oldText == null ? '/dev/null' : `a/${path}`}\n+++ ${newText == null ? '/dev/null' : `b/${path}`}\n`;
  out += unifiedHunks(oldFile, newFile);
  return out;
}

async function flattenTree(git, fs, oid, prefix = '', out = {}) {
  if (!oid) return out;
  const { tree } = await git.readTree({ fs, dir: '/', oid });
  for (const entry of tree) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'tree') await flattenTree(git, fs, entry.oid, path, out);
    else if (entry.type === 'blob') out[path] = { oid: entry.oid };
  }
  return out;
}

async function blobText(git, fs, oid) {
  const { blob } = await git.readBlob({ fs, dir: '/', oid });
  return new TextDecoder().decode(blob);
}

async function commitDiff(oid) {
  const [fs, git] = await Promise.all([getFs(), getGit()]);
  const { commit } = await git.readCommit({ fs, dir: '/', oid });
  const parentOid = commit.parent?.[0] ?? null;
  const [before, after] = await Promise.all([
    flattenTree(git, fs, parentOid),
    flattenTree(git, fs, oid),
  ]);
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const parts = [];
  for (const path of paths) {
    const a = before[path]?.oid;
    const b = after[path]?.oid;
    if (a === b) continue;
    parts.push(fileDiff(path, a ? await blobText(git, fs, a) : null, b ? await blobText(git, fs, b) : null));
  }
  return parts.join('');
}

function diffFor(oid) {
  if (!diffCache.has(oid)) diffCache.set(oid, commitDiff(oid));
  return diffCache.get(oid);
}

function setStatus(text, status = 'idle') {
  const el = $('transfer-status');
  el.dataset.status = status;
  el.textContent = text;
}

const bytesOf = (text) => new TextEncoder().encode(text).length;

async function renderTransferInfo() {
  const el = $('export-info');
  try {
    const bundle = await exportBundle();
    el.textContent = `${bundle.brief} — ${bytesOf(bundleText(bundle))} bytes as one readable JSON file`;
    return bundle;
  } catch (e) {
    el.textContent = `could not be read: ${e.name}: ${e.message}`;
    return null;
  }
}

async function renderPersistence() {
  const el = $('claim');
  const value = $('persisted-value');
  let persisted;
  try {
    persisted = await navigator.storage.persisted();
  } catch (e) {
    el.dataset.persisted = 'unknown';
    value.textContent = `could not be read (${e.name}: ${e.message}) — take this screen as making no promise`;
    return;
  }
  el.dataset.persisted = String(persisted);
  value.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = String(persisted);
  value.append(strong, ' — ' + (persisted
    ? 'the browser has marked this origin’s storage persistent: it will not evict it on its own timer.'
    : 'the browser has not marked this origin’s storage persistent: it may evict it — under disk '
      + 'pressure anywhere, and in Safari in a tab after 7 days without interaction. '
      + 'Add to Home Screen, reopen from the icon, and ask again.'));
}

function renderInflight(replayed) {
  const el = $('inflight');
  const f = replayed.inFlight;
  if (!f) {
    el.dataset.inflight = 'none';
    el.textContent = 'in flight   nothing was in flight — the log\u2019s tail is settled';
    return;
  }
  el.dataset.inflight = `seq:${f.seq}`;
  const what = f.action === 'pending'
    ? 'the model call was interrupted by a kill; it is named here and re-issued at most once with a key'
    : f.action === 'already settled'
      ? 'found it already settled; its result was appended exactly once'
      : 're-ran it (pure, idempotent); its result was appended exactly once';
  // A model call's args hold the whole request body; the hash names it without
  // dumping a conversation onto one screen line.
  const call = f.tool === 'model_call'
    ? `model_call(request ${String(f.args?.requestHash ?? '').slice(0, 12)}…)`
    : `${f.tool}(${JSON.stringify(f.args)})`;
  el.textContent = `in flight   seq ${f.seq} · ${call} — ${what}`;
}

// What the last executed file did. stdout/stderr and the exit are the run's own
// words; a refused TS file says which construct and which line, because the
// boundary is a thing the person can see rather than a stack trace.
function renderExec(out) {
  const el = $('exec');
  if (!el || !out || out.op !== 'exec') return;
  el.dataset.exit = out.exit;
  const lines = [`run        ${out.file} (${out.lang}) — exit ${out.exit}, ${out.wallMs} ms`];
  if (out.refusal) {
    lines.push(`refused    ${out.refusal.construct} at ${out.refusal.file}:${out.refusal.line}`
      + ' — refused before type stripping; this file is not erasable TS');
  }
  if (out.note) lines.push(`note       ${out.note}`);
  if (out.tsBytes) lines.push(`typescript ${out.tsBytes} bytes read on the tap that loaded it`);
  if (out.stdout) lines.push('stdout', out.stdout.replace(/\n$/, ''));
  if (out.stderr) lines.push('stderr', out.stderr.replace(/\n$/, ''));
  else if (out.error) lines.push('stderr', `${out.error.name}: ${out.error.message}`);
  el.textContent = lines.join('\n');
}

function renderTree(result, replayed) {
  const el = $('tree');
  if (!result) return;
  const s = result.verified;
  const agree = String(s.boots) === String(result.state.boots) &&
                result.bytesReadBack === result.bytesWritten;
  el.textContent = [
    `file       .agentjs/tree.json  (${result.bytesReadBack} bytes read back)`,
    `created    ${s.created}`,
    `boots      ${s.boots}${result.fresh ? '  (this load created the file)' : ''}`,
    `lastSeen   ${s.lastSeen}`,
    `log        ${replayed.records} records, last seq ${replayed.lastSeq}`,
    `nodes      ${s.nodes.map((n) => `${n.id}(${n.status})`).join(', ')}`,
    `read-back  ${agree ? 'agrees with what was written' : 'DISAGREES — do not trust the numbers above'}`,
  ].join('\n');
}

async function main() {
  wireLoop();
  renderContainer();
  await renderPersistence();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    renderShell().catch((e) => {
      const el = $('shell');
      el.dataset.driven = 'unknown';
      el.textContent = `shell      could not be read: ${e.name}: ${e.message}`;
    });
  } else {
    renderShell();
  }

  $('persist').addEventListener('click', async () => {
    $('persist').disabled = true;
    try {
      await navigator.storage.persist();
    } catch {
      // the button's hope is not the claim; the re-read below is.
    }
    await renderPersistence();
    $('persist').disabled = false;
  });

  $('install-hint').textContent = isStandalone()
    ? 'Already opened from the Home Screen.'
    : 'iOS: Share → Add to Home Screen. Android/Chrome: menu → Install app. '
      + 'iOS 26+ opens any Home Screen site as a web app; the manifest is for older iOS and for Chrome.';

  async function doImport(text) {
    const out = await importBundle(text);
    if (!out.ok) {
      setStatus(`import refused — ${out.reason}`, 'error');
      return out;
    }
    setStatus(`imported — ${out.bundle.brief}`, 'ok');
    renderInflight(out.replayed);
    renderTree(out.result, out.replayed);
    await renderTransferInfo();
    return out;
  }

  $('export').addEventListener('click', async () => {
    $('export').disabled = true;
    try {
      const bundle = await exportBundle();
      const sent = await deliverBundle(bundle);
      if (sent.via === 'cancelled') {
        setStatus(`export cancelled — nothing left the page (${bundle.brief})`, 'error');
      } else {
        setStatus(`exported ${sent.filename} — ${sent.bytes} bytes, via ${sent.via}`, 'ok');
        $('export-info').textContent = `${bundle.brief} — ${sent.bytes} bytes as one readable JSON file`;
      }
    } catch (e) {
      setStatus(`export failed: ${e.name}: ${e.message}`, 'error');
    }
    $('export').disabled = false;
  });

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(`reading ${file.name} (${file.size} bytes)…`);
    try {
      await doImport(await file.text());
    } catch (err) {
      setStatus(`import failed: ${err.name}: ${err.message}`, 'error');
    }
    e.target.value = '';
  });

  $('import-paste').addEventListener('click', async () => {
    const text = $('import-text').value;
    if (!text.trim()) {
      setStatus('nothing to import — choose a file or paste a bundle into the box', 'error');
      return;
    }
    try {
      await doImport(text);
    } catch (err) {
      setStatus(`import failed: ${err.name}: ${err.message}`, 'error');
    }
  });

  window.addEventListener('agent:result', (e) => {
    if (e.detail?.out?.op === 'exec') renderExec(e.detail.out);
    refreshView();
  });

  try {
    const settled = await replaySettled();
    replayed = settled;
    renderInflight(settled);
    renderPending(settled.pending);
    renderTree(await boot(settled.state), settled);
    await refreshView();
    const lastRun = replayed.state.runs?.at(-1);
    if (lastRun) renderExec(lastRun);
    await renderTransferInfo();
  } catch (e) {
    $('tree').textContent = e instanceof NoOpfs
      ? `no OPFS here (${e.message}) — nothing is stored, so nothing survives a kill`
      : `the workspace could not be opened: ${e.name}: ${e.message}`;
  }
}

window.agent = {
  ...(window.agent || {}),
  exportBundle, importBundle, bundleText, deliverBundle, exportFilename,
  // The loop's page API, all lazy: nothing here fetches a module until called.
  configure: (opts) => ensureLoop().then((m) => m.configure(opts)),
  status: () => ensureLoop().then((m) => m.status()),
  forgetKey: () => ensureLoop().then((m) => m.forget()),
  run: (prompt) => ensureLoop().then((m) => m.run(prompt)),
  resume: () => ensureLoop().then((m) => m.resume()),
  pendingCalls: () => ensureLoop().then((m) => m.pendingCalls()),
  pending: () => (replayed?.pending ?? []).map((p) => ({
    seq: p.seq,
    requestHash: p.args?.requestHash ?? null,
  })),
  traceText: () => import('./trace.js').then((t) => t.text()),
  traceSummary: () => import('./trace.js').then((t) => t.summaryText()),
  traceRunId: () => import('./trace.js').then((t) => t.runId()),
};

main();
