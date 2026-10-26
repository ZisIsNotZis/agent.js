// The scripted step driver, shared by the page and the probe.
//
// A step is: intent -> effect -> result. The effect is a pure patch over the
// settled state, so re-running the step after a kill is always safe, and the
// log's result is the only thing that makes the effect real.
//
// The tool set is deliberately tiny and in-file for this milestone: no model,
// no fs write beyond the log, no git. M4 swaps in the real tools underneath the
// same step/1 shape.

import { append, nextSeq, readAll, replay as replayLog } from './log.js';

export const TOOLS = {
  add_node: {
    run: (args) => ({ op: 'add_node', id: args.id, parent: args.parent ?? null }),
    check: (state, args) => Boolean(state.nodes[args.id]),
  },
  set_status: {
    run: (args) => ({ op: 'set_status', node: args.node, status: args.status }),
    check: (state, args) => state.nodes[args.node]?.status === args.status,
  },
};

export function initial() {
  return {
    nodes: { root: { id: 'root', parent: null, status: 'idle' } },
    seqs: [],
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
  } else {
    throw new Error(`unknown patch op ${out.op}`);
  }
}

const fold = {
  initial,
  run(tool, args) {
    const t = TOOLS[tool];
    if (!t) throw new Error(`unknown tool ${tool}`);
    return t.run(args);
  },
  check(tool, state, args) {
    return Boolean(TOOLS[tool]?.check?.(state, args));
  },
  out(tool, args) {
    return TOOLS[tool].run(args);
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

let hold = null;

// Test hook: 'after-intent' makes the next step commit its intent and then stop,
// so a probe can kill the page exactly between intent and result. It is not used
// by the product path.
export function holdAt(phase) {
  hold = phase;
}

export async function step({ node, tool, args }) {
  return locked(async () => {
    const seq = await nextSeq();
    await append({ kind: 'intent', seq, node, tool, args });
    if (hold === 'after-intent') await new Promise(() => {}); // the page is killed here
    const out = fold.run(tool, args);
    await append({ kind: 'result', seq, ok: true, out, at: new Date().toISOString() });
    return { seq, out };
  });
}

let last = null;

// Boot (and resume): the log is folded, any unsettled intent is resolved and its
// result appended exactly once, and the settled state is kept for the screen.
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

if (typeof window !== 'undefined') {
  window.agent = { step, replay: replaySettled, records, snapshot, holdAt };
}
