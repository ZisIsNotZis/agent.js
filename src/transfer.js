// Taking the workspace out and putting it back.
//
// One file format holds both halves of the container split: a person whose tab
// storage is about to be evicted exports here; a person who later opens the
// Home Screen icon (a different storage container) imports the same file there.
//
// The bundle is one JSON object:
//   {v, exportedAt, origin, persisted, tree, log, brief}
//
// `log` is the append-only ledger verbatim — every intent and result, in append
// order. That is what makes an import exact. `tree` is the OPFS snapshot, a
// cache; it carries the created stamp and the boot count, so an import keeps
// them, but the settled state is folded from `log` exactly as a boot does.
// Shipping only the tree would lose the log's tail and is a defect, not a
// smaller export.
//
// Import replaces, never merges. It validates the whole bundle before touching
// anything (a rejected import is a no-op), then clears the ledger and the
// .agentjs/ directory in one deliberate path, writes the records back in order,
// restores the tree cache, and re-reads both to prove the writes landed.

import { append, readAll, clear as clearLog } from './log.js';
import { replaySettled } from './run.js';
import { boot, readState, writeState, clearState, NoOpfs } from './state.js';
import { clearRunMarkers } from './exec.js';

const V = 1;

function countRecords(log) {
  let intents = 0;
  let results = 0;
  for (const r of log) (r.kind === 'intent' ? (intents += 1) : (results += 1));
  return { intents, results };
}

// The brief describes what the bundle settles into, and the log is that
// source: the OPFS tree is a cache written at boot, so counting its nodes here
// would report the state before the steps the log already holds.
function countNodes(log) {
  const ids = new Set(['root']);
  for (const r of log) {
    if (r.kind === 'intent') {
      ids.add(r.node ?? 'root');
      continue;
    }
    const out = r.out;
    if (out?.op === 'add_node') ids.add(out.id);
    else if (out?.op === 'set_status') ids.add(out.node);
    else if (out?.op === 'plan') for (const n of out.nodes ?? []) ids.add(n.id);
    else if (out?.op === 'spawn') ids.add(out.id);
  }
  return ids.size;
}

function describe(log) {
  const nodes = countNodes(log);
  const { intents, results } = countRecords(log);
  const lastSeq = log.reduce((m, r) => Math.max(m, r.seq), 0);
  return `${nodes} node${nodes === 1 ? '' : 's'}, ${log.length} log records `
    + `(${intents} intent${intents === 1 ? '' : 's'}, ${results} result${results === 1 ? '' : 's'}), `
    + `settled at seq ${lastSeq}`;
}

export async function exportBundle() {
  const log = await readAll();
  let tree = null;
  try {
    tree = (await readState())?.state ?? null;
  } catch (e) {
    if (!(e instanceof NoOpfs)) throw e;
  }
  let persisted = null;
  try {
    persisted = await navigator.storage.persisted();
  } catch {
    // An unreadable value is null, not a hoped-for true.
  }
  return {
    v: V,
    exportedAt: new Date().toISOString(),
    origin: globalThis.location?.origin ?? null,
    persisted,
    tree,
    log,
    brief: describe(log),
  };
}

// Readable JSON is the point: two-space indent, no compression, no envelope.
export function bundleText(bundle) {
  return JSON.stringify(bundle, null, 2);
}

export function exportFilename(now = new Date()) {
  const host = (globalThis.location?.hostname || 'workspace').replace(/[^A-Za-z0-9.-]/g, '-');
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}`;
  return `agentjs-${host}-${stamp}.json`;
}

// Share sheet when the browser can share a File (iOS/Android), otherwise an
// <a download> of a Blob. Both carry the same bytes under the same name.
export async function deliverBundle(bundle) {
  const text = bundleText(bundle);
  const filename = exportFilename();
  const type = 'application/json';
  const canShareFile = typeof File === 'function'
    && typeof navigator !== 'undefined'
    && typeof navigator.canShare === 'function'
    && typeof navigator.share === 'function';

  if (canShareFile) {
    const file = new File([text], filename, { type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'agent.js workspace export' });
        return { via: 'share', filename, bytes: new TextEncoder().encode(text).length };
      } catch (e) {
        if (e.name === 'AbortError') {
          return { via: 'cancelled', filename, bytes: new TextEncoder().encode(text).length };
        }
        // A share failure falls through to the download; the file still leaves.
      }
    }
  }

  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { via: 'download', filename, bytes: new TextEncoder().encode(text).length };
}

// Returns null when the bundle is acceptable, or the reason it is refused.
// Everything here runs before the workspace is touched.
function refuseReason(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'the bundle is not a JSON object';
  if (b.v !== V) return `the bundle says v ${JSON.stringify(b.v)}; this build reads v ${V}`;
  if (!Array.isArray(b.log)) return 'the bundle has no log array';
  const intents = new Set();
  const results = new Set();
  for (let i = 0; i < b.log.length; i += 1) {
    const r = b.log[i];
    if (!r || (r.kind !== 'intent' && r.kind !== 'result')) {
      return `log[${i}] is neither an intent nor a result`;
    }
    if (!Number.isInteger(r.seq) || r.seq < 1) {
      return `log[${i}] has no positive integer seq`;
    }
    const seen = r.kind === 'intent' ? intents : results;
    if (seen.has(r.seq)) return `duplicate ${r.kind} seq ${r.seq} at log[${i}]`;
    if (r.kind === 'result' && !intents.has(r.seq)) {
      return `result seq ${r.seq} has no intent before it`;
    }
    seen.add(r.seq);
  }
  return null;
}

function canon(rec) {
  const keys = ['kind', 'seq', 'node', 'by', 'tool', 'args', 'ok', 'out', 'at'];
  const out = {};
  for (const k of keys) if (rec[k] !== undefined) out[k] = rec[k];
  return out;
}

const sameRecords = (a, b) => a.length === b.length
  && a.every((r, i) => JSON.stringify(canon(r)) === JSON.stringify(canon(b[i])));

// Boot-shaped result for the screen, without incrementing the boot count: the
// imported file is the exporting profile's file, so its `created` and `boots`
// are restored as they were. The next real reload is what counts a boot.
function fromDisk(tree) {
  return {
    fresh: false,
    bootsOnDiskBeforeThisLoad: tree?.state?.boots ?? 0,
    state: tree.state,
    verified: tree.state,
    bytesWritten: tree.bytes,
    bytesReadBack: tree.bytes,
  };
}

// Replaces the workspace with the bundle. Returns
//   { ok:true, replayed, result, bundle }   or
//   { ok:false, reason }                    with the workspace untouched.
export async function importBundle(text) {
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not JSON: ${e.message}` };
  }
  const reason = refuseReason(bundle);
  if (reason) return { ok: false, reason };

  try {
    // The one deliberate path: both stores are cleared before anything is written.
    // Run markers are keyed by seq, so they go with the ledger they belonged to.
    await clearLog();
    await clearState();
    await clearRunMarkers();

    for (const rec of bundle.log) await append(rec);
    if (bundle.tree) await writeState(bundle.tree);

    // The same boot replay the page runs: fold the log, append any missing
    // result exactly once. A settled bundle finds nothing in flight.
    const replayed = await replaySettled();

    // Verify by re-reading, not by the memory of having written.
    const back = await readAll();
    if (!sameRecords(back, bundle.log)) {
      throw new Error('the re-read log does not match the bundle');
    }
    const treeBack = await readState();
    if (bundle.tree) {
      if (JSON.stringify(treeBack?.state) !== JSON.stringify(bundle.tree)) {
        throw new Error('the re-read tree does not match the bundle');
      }
      return { ok: true, replayed, result: fromDisk(treeBack), bundle };
    }
    return { ok: true, replayed, result: await boot(replayed.state), bundle };
  } catch (e) {
    return { ok: false, reason: `the import could not be completed: ${e.message}` };
  }
}
