// The log is the truth. IndexedDB, one store, append-only records of two kinds:
//
//   intent {seq, node, tool, args}   written before the effect
//   result {seq, ok, out, at}        written after it
//
// A record only ever joins the store; nothing is updated or deleted. The
// transaction is the atomic unit: an intent has landed or it has not, and a
// result is refused unless its intent is already in the store and no result for
// that seq exists. That is the whole consistency rule, enforced by the store
// (a unique index on kind:seq) rather than by whoever happens to call append().
//
// `replay()` folds the records into the settled state. An intent with no result
// is the one thing a kill can leave behind; replay resolves it with the caller's
// fold (re-run a pure effect, or recognise that it was already settled), then
// appends its result exactly once.

const DB = 'agentjs';
const VERSION = 1;
const STORE = 'log';

let dbp = null;

// A record that has landed may need a second reader (the trajectory recorder).
// Listeners are awaited in append order, so a trace line is never written after
// a later one; a listener that throws never fails the append that caused it.
const listeners = new Set();

export function onAppend(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notify(rec) {
  for (const fn of listeners) {
    try {
      await fn(rec);
    } catch {
      // the log is the truth; a reader's failure is not the log's failure
    }
  }
}

export function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('seq', 'seq', { unique: false });
        // intent:7 and result:7 are different keys; a second of either is not.
        store.createIndex('tag', 'tag', { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB open blocked by another connection'));
  });
  return dbp;
}

function row(rec) {
  if (rec.kind !== 'intent' && rec.kind !== 'result') {
    throw new Error(`log record kind must be intent or result, got ${rec.kind}`);
  }
  if (!Number.isInteger(rec.seq)) throw new Error(`log record needs an integer seq, got ${rec.seq}`);
  const out = { ...rec, tag: `${rec.kind}:${rec.seq}` };
  if (rec.kind === 'result' && out.at == null) out.at = new Date().toISOString();
  return out;
}

export async function append(rec) {
  const db = await openDb();
  const r = row(rec);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let failure = null;
    if (r.kind === 'result') {
      const q = store.index('seq').getAll(r.seq);
      q.onsuccess = () => {
        const rows = q.result;
        if (!rows.some((x) => x.kind === 'intent')) {
          failure = new Error(`refusing a result for seq ${r.seq}: no intent recorded`);
          tx.abort();
          return;
        }
        if (rows.some((x) => x.kind === 'result')) {
          failure = new Error(`refusing a second result for seq ${r.seq}`);
          tx.abort();
          return;
        }
        store.add(r);
      };
    } else {
      store.add(r);
    }
    tx.oncomplete = async () => {
      await notify(r);
      resolve(r);
    };
    tx.onerror = () => reject(failure || tx.error);
    tx.onabort = () => reject(failure || tx.error || new Error('log transaction aborted'));
  });
}

export async function readAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    // getAll returns key order, which for an autoIncrement key is append order.
    req.onsuccess = () => resolve(req.result.map(({ id, tag, ...rec }) => rec));
    req.onerror = () => reject(req.error);
  });
}

// Used only by transfer.js's deliberate replace path. Nothing in the running
// product deletes records; the log is append-only everywhere else.
export async function clear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('log clear aborted'));
  });
}

export async function nextSeq() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('seq').openKeyCursor(null, 'prev');
    req.onsuccess = () => resolve((req.result ? req.result.key : 0) + 1);
    req.onerror = () => reject(req.error);
  });
}

// fold = {
//   initial() -> state
//   run(tool, args, ctx) -> out            the effect, re-run on resume
//   check(tool, state, args, ctx) -> bool  optional: is the effect already settled?
//   out(tool, args, ctx) -> out            the out to record when check() says yes
//   defer(tool, args, ctx) -> bool         optional: leave this intent unsettled
//   apply(state, result) -> void           fold one settled result into state
// }
//
// `defer` is the model call's shape: a request that may have been paid for is
// not re-run by the boot fold, because the key is memory-only and absent on a
// reopen. The intent stays in the log with no result; the loop re-issues it at
// most once when the person supplies a key, and that is the only place it runs.
// Every other tool keeps the M3/M4 rule: an unsettled intent is resolved here.
// fold.run/check/out may be async: git_commit's check reads git.log.
export async function replay(fold) {
  const records = await readAll();
  const intents = new Map();
  const results = new Map();
  for (const r of records) (r.kind === 'intent' ? intents : results).set(r.seq, r);

  const state = fold.initial();
  const seqs = [...intents.keys()].sort((a, b) => a - b);
  const rerun = [];
  const pending = [];

  for (const seq of seqs) {
    const intent = intents.get(seq);
    let result = results.get(seq);
    if (!result) {
      const ctx = { seq, node: intent.node };
      if (fold.defer && await fold.defer(intent.tool, intent.args, ctx)) {
        pending.push({ seq, node: intent.node, tool: intent.tool, args: intent.args });
        continue;
      }
      const settled = fold.check ? await fold.check(intent.tool, state, intent.args, ctx) : false;
      const out = settled
        ? await fold.out(intent.tool, intent.args, ctx)
        : await fold.run(intent.tool, intent.args, ctx);
      result = { kind: 'result', seq, ok: true, out, at: new Date().toISOString() };
      await append(result);
      rerun.push({
        seq,
        node: intent.node,
        tool: intent.tool,
        args: intent.args,
        action: settled ? 'already settled' : 're-ran',
      });
    }
    fold.apply(state, result);
    state.seqs.push(seq);
  }

  const inFlight = pending[0]
    ? { ...pending[0], action: 'pending' }
    : rerun[0] || null;

  return {
    state,
    inFlight,
    rerun,
    pending,
    records: records.length,
    lastSeq: seqs.length ? seqs[seqs.length - 1] : 0,
  };
}
