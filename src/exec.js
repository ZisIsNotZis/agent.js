// The page side of execution: spawn the Worker, collect its stdout/stderr,
// enforce the wall-clock cap by terminating it, and resolve one result.
//
// The Worker is created from src/worker.js as a URL (a module worker), and a
// single worker is kept for the page's lifetime so the TypeScript compiler is
// imported once. A timeout terminates it — a runaway must not freeze the tab —
// and the next run spawns a fresh one, which is the only time the compiler can
// be fetched twice.
//
// What is passed: `{source, lang, file, args}`. Nothing else; in particular the
// page's memory (and any token it holds later) never crosses. That is the whole
// claim — not that the worker is a sandbox, but that the token is not in it.
//
// The run marker is an OPFS file beside the workspace, not in it, and not in
// the log. It is written `done` with the output after a run finishes. That is
// what makes `run_js`'s check() honest: a `done` marker means replay takes the
// recorded output without executing anything, and no marker means the page died
// somewhere after the intent was recorded, so the run is recorded `interrupted`
// and never executed a second time.

export const DEFAULT_TIMEOUT_MS = 10_000;

const MARKER_DIR = 'agentjs-exec';
const WORKER_URL = new URL('./worker.js', import.meta.url);

let worker = null;
let runId = 0;
let queue = Promise.resolve();

async function markerDir() {
  if (!navigator.storage?.getDirectory) {
    throw new Error('this browser has no navigator.storage.getDirectory (OPFS) for run markers');
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(MARKER_DIR, { create: true });
}

export async function writeRunMarker(seq, data) {
  const dir = await markerDir();
  const fh = await dir.getFileHandle(`${seq}.json`, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ seq, ...data, at: new Date().toISOString() }));
  await w.close();
}

export async function readRunMarker(seq) {
  const dir = await markerDir();
  let fh;
  try {
    fh = await dir.getFileHandle(`${seq}.json`);
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
  try {
    return JSON.parse(await (await fh.getFile()).text());
  } catch {
    return { seq, status: 'started', unreadable: true };
  }
}

// The import path replaces the ledger and the tree; markers keyed by seq would
// otherwise be read against a new run that happens to reuse that seq.
export async function clearRunMarkers() {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(MARKER_DIR, { recursive: true });
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }
}

function spawn() {
  const w = new Worker(WORKER_URL, { type: 'module' });
  w.__pending = new Map();
  w.onmessage = (e) => {
    const msg = e.data;
    const job = w.__pending.get(msg?.run);
    if (!job) return; // a line from a run the page already settled (timeout)
    if (msg.type === 'line') {
      (msg.stream === 'stderr' ? job.stderr : job.stdout).push(String(msg.text));
    } else if (msg.type === 'done') {
      job.finish(msg);
    }
  };
  w.onerror = (e) => {
    // A worker that cannot even be constructed/imported fires this. Fail every
    // job it owns rather than hanging the step.
    for (const job of w.__pending.values()) job.fail(new Error(e.message || 'worker error'));
    w.__pending.clear();
    if (worker === w) worker = null;
  };
  return w;
}

function execute({ source, lang, file, args, timeoutMs }) {
  const w = worker ?? (worker = spawn());
  const id = ++runId;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const stdout = [];
    const stderr = [];

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      w.__pending.delete(id);
    };
    const finish = (msg) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: stdout.length ? `${stdout.join('\n')}\n` : '',
        stderr: stderr.length ? `${stderr.join('\n')}\n` : '',
        exit: msg.exit,
        error: msg.error ?? null,
        refusal: msg.refusal ?? null,
        tsBytes: msg.tsBytes ?? 0,
        tsImports: msg.tsImports ?? 0,
        wallMs: performance.now() - started,
      });
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    w.__pending.set(id, { stdout, stderr, finish, fail });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      // The cap is the page's, not the worker's: a loop that never yields must
      // be stopped from outside it.
      if (worker === w) worker = null;
      w.terminate();
      resolve({
        stdout: stdout.length ? `${stdout.join('\n')}\n` : '',
        stderr: stderr.length ? `${stderr.join('\n')}\n` : '',
        exit: 'timeout',
        error: null,
        refusal: null,
        tsBytes: 0,
        tsImports: 0,
        wallMs: performance.now() - started,
      });
    }, timeoutMs);

    w.postMessage({ type: 'run', run: id, source, lang, file, args });
  });
}

// One run at a time per page: a second run while the first is executing would
// share the worker's console and globals.
export function runScript(options) {
  const p = queue.then(() => execute({
    source: options.source,
    lang: options.lang ?? 'js',
    file: options.file ?? '<source>',
    args: options.args ?? null,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }));
  queue = p.then(() => {}, () => {});
  return p;
}
