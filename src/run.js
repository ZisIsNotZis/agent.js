// The scripted step driver, shared by the page and the probe.
//
// A step is: intent -> effect -> result. The log's result is the only thing
// that makes the effect real, so a kill between intent and result is resolved
// by *checking* whether the effect already landed. For a git commit that is the
// third phrase replay() has: `git.log` says the commit for this seq exists, so
// nothing is re-committed and the commit count does not grow.
//
// The M3 tools (add_node/set_status) stay as pure in-file patches; M4 adds the
// real tools from src/tools.js underneath the same step/1 shape.

import { append, nextSeq, readAll, replay as replayLog } from './log.js';
import { TOOLS as FS_TOOLS, getFs, getGit } from './tools.js';

// The M3 in-file patches stay; M4's real tools sit in the same table.
export const TOOLS = {
  add_node: {
    run: (args) => ({ op: 'add_node', id: args.id, parent: args.parent ?? null }),
    check: (state, args) => Boolean(state.nodes[args.id]),
  },
  set_status: {
    run: (args) => ({ op: 'set_status', node: args.node, status: args.status }),
    check: (state, args) => state.nodes[args.node]?.status === args.status,
  },
  ...FS_TOOLS,
};

export { getFs, getGit };

export function initial() {
  return {
    nodes: { root: { id: 'root', parent: null, status: 'idle' } },
    seqs: [],
    files: {},
    commits: [],
    runs: [],
    head: null,
  };
}

export function applyOut(state, out) {
  if (out.op === 'add_node') {
    state.nodes[out.id] = {
      id: out.id,
      parent: out.parent,
      status: state.nodes[out.id]?.status ?? 'new',
    };
  } else if (out.op === 'set_status') {
    const prev = state.nodes[out.node];
    state.nodes[out.node] = { id: out.node, parent: prev?.parent ?? null, status: out.status };
  } else if (out.op === 'write') {
    state.files[out.path] = out.bytes;
  } else if (out.op === 'git_commit') {
    state.commits.push({ seq: out.seq, oid: out.oid, path: out.path, message: out.message });
    state.head = out.oid;
  } else if (out.op === 'exec') {
    state.runs.push({
      op: 'exec',
      seq: out.seq,
      file: out.file,
      lang: out.lang,
      exit: out.exit,
      stdout: out.stdout,
      stderr: out.stderr,
      refusal: out.refusal,
      wallMs: out.wallMs,
      note: out.note,
    });
  } else if (out.op === 'read' || out.op === 'ls') {
    // Observations: recorded, nothing to fold.
  } else {
    throw new Error(`unknown patch op ${out.op}`);
  }
}

const fold = {
  initial,
  run(tool, args, ctx) {
    const t = TOOLS[tool];
    if (!t) throw new Error(`unknown tool ${tool}`);
    return t.run(args, ctx);
  },
  check(tool, state, args, ctx) {
    return Boolean(TOOLS[tool]?.check?.(state, args, ctx));
  },
  out(tool, args, ctx) {
    const t = TOOLS[tool];
    return t.out ? t.out(args, ctx) : t.run(args, ctx);
  },
  // The model call is the one intent the boot fold must not resolve: the key is
  // memory-only, so re-issuing belongs to the loop, with the person's key in
  // hand. See src/log.js's `defer` note.
  defer(tool) {
    return tool === 'model_call';
  },
  apply(state, result) {
    applyOut(state, result.out);
  },
};

// One lock per session. There is one tree per origin, so the session is the
// origin; the browser releases the lock when this page dies, which is the
// property a heartbeat would be imitating.
const LOCK = 'agentjs-session';

function locked(fn) {
  if (!globalThis.navigator?.locks?.request) return fn();
  return navigator.locks.request(LOCK, fn);
}

const never = () => new Promise(() => {});
const now = () => (globalThis.performance?.now?.() ?? Date.now());

// Test hook, not used by the product path. 'after-intent' hangs between the
// intent and the effect; 'after-effect' hangs between the effect and its
// result, which is the kill that only check() can resolve.
let hold = null;

export function holdAt(phase) {
  hold = phase;
}

export async function step({ node, tool, args }) {
  return locked(async () => {
    const seq = await nextSeq();
    await append({ kind: 'intent', seq, node, tool, args });
    const ctx = { seq, node };
    if (hold === 'after-intent') await never(); // the page is killed here
    const started = now();
    const out = await fold.run(tool, args, ctx);
    const effectMs = now() - started;
    if (hold === 'after-effect') await never(); // killed after the effect, before its result
    await append({ kind: 'result', seq, ok: true, out, at: new Date().toISOString() });
    // The screen reads the run from here; the log remains the truth it reads.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('agent:result', { detail: { seq, out } }));
    }
    return { seq, out, effectMs };
  });
}

let last = null;

// Boot (and resume): the log is folded, any unsettled intent is resolved and its
// result appended exactly once, and the settled state is kept for the screen.
// A model_call intent is left `pending` instead — the loop re-issues it.
export async function replaySettled() {
  const result = await locked(() => replayLog(fold));
  last = result;
  return result;
}

export function snapshot() {
  return last ? last.state : null;
}

export function records() {
  return readAll();
}

// The probe's read-back: commits as isomorphic-git sees them in the page, not
// as the log remembers them.
export async function gitLog() {
  const fs = await getFs();
  const git = await getGit();
  return git.log({ fs, dir: '/', depth: Infinity });
}

if (typeof window !== 'undefined') {
  window.agent = {
    step,
    replay: replaySettled,
    records,
    snapshot,
    holdAt,
    gitLog,
    getFs,
    getGit,
  };
}
