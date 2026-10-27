// The loop: one turn is one model call, the tool calls in its reply are `step()`
// each — the existing log, the existing per-step commit, M6's Worker for
// `run_js`. There is no second execution path and no provider SDK.
//
// Since W11 the loop is *per node*. Root and every child are nodes with their
// own `messages`, their own system prompt and their own tool loop; the root's
// `spawn` tool creates a child whose first user message is the task, and whose
// steps are logged with `node: <child id>` like any other step. The parent owns
// the children's liveness: the spawn result writes the child `running`, the
// child's own loop writes `done`/`failed`, and on boot every node whose status is
// `running` is restarted from its own messages folded from the log. That is why
// a kill in a four-node run reopens with four loops, not one.
//
// Prefix stability is the shape of this file: a node's `messages` is built by
// appending and never rebuilt, so turn n+1's body is turn n's array plus what
// happened after it, byte for byte. Volatile text (the seed, timing) never
// enters a message; it lives in the trace. A child's system prompt is its own
// constant, so its prefix is stable too.
//
// A model call is an intent with a request hash and its response is the result:
//
//   intent {seq, node, by, tool:'model_call', args:{requestHash, body}}
//   result {seq, ok, out:{requestHash, response}, at}
//
// `body` is the exact JSON body that was sent, kept so a re-issue after a kill
// is the same bytes (not a reconstruction, which would be a second source of
// truth). `requestHash` is SHA-256 of that body. The response is kept whole so
// `usage` and the assistant message are recoverable without paying twice.
// `by` is the node whose loop issued a step; a step that lands on a plan item is
// issued by the loop driving the item's tree, and that is what lets a reload
// rebuild the conversation of a node while children interleave their steps.
//
// The boot fold refuses to resolve a model_call (src/log.js `defer`): the key is
// memory-only, so re-issuing belongs here, once per node, with the person's key
// in hand.
//
// The tree is the run, not a decoration: a node declares work with the `plan`
// tool and every other tool call is `step()`ed on the item the plan says is
// running, so a node's step count, its commits and its status are the log's own
// facts. The loop holds no plan of its own — `planItems()` below folds it from
// the records, scoped to the node whose loop declared it.

import { append, nextSeq, onAppend, readAll } from './log.js';
import { step, replaySettled, getFs, getGit } from './run.js';
import * as trace from './trace.js';
import { chatCompletion } from './provider.js';

const MAX_TURNS = 16;

// How many child loops may be in flight at once. A child's cost is mostly
// network latency, so a small fanout buys real overlap; four is under the
// browser's per-host connection limit (six), stays inside a typical provider's
// rate limit, and keeps the tree's interleaving readable. The git lock in
// src/run.js serialises the *effects* whatever this number is, so the bound is
// about requests and memory, not correctness. A fifth child waits and is already
// `running` in the log — "queued" is not a status a resume has to invent.
const SPAWN_LIMIT = 4;

// The provider's tools, in OpenAI's shape. Names must be the tool names in
// src/run.js, so the request and the executor have one vocabulary.
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'plan',
      description: 'Declare or advance the work items you are doing. Upserts the items you name; '
        + 'the item whose status is "running" is the one the next tool call lands on. Call it '
        + 'before the first change and again as each item starts and finishes.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'unique within this run, never "root"' },
                parent: { type: 'string', description: 'parent item id; defaults to the calling node' },
                title: { type: 'string' },
                status: { type: 'string', description: 'pending, running or done' },
              },
              required: ['id', 'title', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn',
      description: 'Start a child agent that runs its own model loop on a task, in the same workspace. '
        + 'Returns at once; the child works in parallel and its steps land on node <id>. Use one '
        + 'child per independent piece of work, and do not wait for it by polling.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the child node id, unique in this tree, never "root"' },
          task: { type: 'string', description: 'what the child must do; it becomes its first message' },
          parent: { type: 'string', description: 'parent node id; defaults to the calling node' },
        },
        required: ['id', 'task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write a text file in the workspace (no commit).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_js',
      description: 'Run a JS/TS file in the workspace in a Worker and return its output.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          source: { type: 'string' },
          args: { type: 'array', items: {} },
          timeoutMs: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Write one file and commit that one path. Every step that changes the tree is one commit.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a text file in the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: 'List a directory in the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
];

const ALLOWED = new Set(TOOL_DEFS.map((t) => t.function.name));

// The system message is a constant and nothing volatile is ever interpolated
// into it: that is what keeps the prefix byte-stable across turns, which is what
// makes a provider's cache hit real. The plan's state is not injected here or
// anywhere at the front of the conversation — a tool result carries it, so the
// model reads the plan where it belongs, at the end.
const SYSTEM = [
  'You are agent.js, a coding agent working in a browser workspace.',
  'Tools are native; there is no shell.',
  '',
  '  plan        declare and advance the work items you are doing.',
  '              plan({items:[{id, parent?, title, status}]}) upserts them;',
  '              status is "pending", "running" or "done". Call it before the',
  '              first change, and again as each item starts and finishes.',
  '              The one item whose status is "running" is where your tool',
  '              calls land, so mark it running and mark it done when it is.',
  '  spawn       start a child agent with its own model loop on a task.',
  '              spawn({id, task, parent?}) returns immediately; the child works',
  '              in parallel and its steps are logged on node <id>.',
  '  read, ls    look at the workspace.',
  '  write       write a text file in the workspace (no commit).',
  '  run_js      run a JS/TS file in the workspace in a Worker; read its output.',
  '  git_commit  write one file and commit that one path.',
  '',
  'Every change to a file is committed with git_commit, one file per step.',
  'Keep answers short.',
].join('\n');

// A child's first model request has its own system prompt: the same rules plus
// the one fact a child needs that root does not — the task is its first message
// and its work belongs to its own node. Constant per node, so the prefix is
// stable. Root keeps the plain one, byte for byte as W7 recorded it.
function systemFor(node) {
  if (node === 'root') return SYSTEM;
  return `${SYSTEM}\n\nYou are child node "${node}" of this run. Your task is the first user `
    + 'message. Work on it and finish with a short final message; your tool calls are logged '
    + 'on your own node.';
}

// The key lives here and only here, in page memory. No storage, no URL, no log.
let config = { baseUrl: '', model: '', key: '' };

export function configure({ baseUrl, model, key } = {}) {
  if (baseUrl !== undefined) config.baseUrl = String(baseUrl);
  if (model !== undefined) config.model = String(model);
  if (key !== undefined) config.key = String(key);
  return status();
}

export function forget() {
  config.key = '';
  return status();
}

export function hasKey() {
  return config.key.length > 0;
}

// Never returns the key.
export function status() {
  return { baseUrl: config.baseUrl, model: config.model, hasKey: hasKey() };
}

onAppend((rec) => trace.logRecord(rec));

const now = () => (globalThis.performance?.now?.() ?? Date.now());

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function headSha() {
  try {
    const fs = await getFs();
    const git = await getGit();
    const log = await git.log({ fs, dir: '/', depth: 1 });
    return log[0]?.oid ?? null;
  } catch {
    return null;
  }
}

function envInfo() {
  return {
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    lang: typeof navigator !== 'undefined' ? navigator.language : '',
    platform: typeof navigator !== 'undefined' ? navigator.platform : '',
    dpr: typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : null,
    viewport: typeof innerWidth !== 'undefined' ? `${innerWidth}x${innerHeight}` : null,
  };
}

function seedValue() {
  return globalThis.AGENT_SEED ?? (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
}

function emit(phase, detail = {}) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('agent:loop', { detail: { phase, ...detail } }));
  }
}

function makeBody(messages) {
  return {
    model: config.model,
    messages,
    tools: TOOL_DEFS,
    tool_choice: 'auto',
    stream: false,
  };
}

// A test hook, not used by the product path: hold node's n-th model request
// after its intent is on disk and before it is sent, so a kill there leaves a
// named, re-issuable model call and no cost at the provider. It is how the W11
// probe kills a multi-node run deterministically — the same spirit as run.js's
// holdAt, but per node.
const holds = new Map();
const never = () => new Promise(() => {});

export function holdTurn(node, n = 1) {
  holds.set(node, n);
}

export function clearHolds() {
  holds.clear();
}

// One model request: intent -> request bytes -> response -> result. The intent
// is on disk before the request leaves, which is what makes a kill mid-call a
// named, re-issuable intent rather than a lost turn.
async function requestTurn(messages, counters, node, { seq, hash, body, reissue = false } = {}) {
  const useSeq = seq ?? await nextSeq();
  const useBody = body ?? makeBody(messages);
  const useHash = hash ?? await sha256Hex(JSON.stringify(useBody));
  counters.requests += 1;

  if (!reissue) {
    await append({
      kind: 'intent',
      seq: useSeq,
      node,
      by: node,
      tool: 'model_call',
      args: { requestHash: useHash, body: useBody },
    });
  } else {
    // The intent is already in the log; verify the bytes are the ones it names.
    const again = await sha256Hex(JSON.stringify(useBody));
    if (again !== useHash) throw new Error(`request hash mismatch on re-issue: ${again} != ${useHash}`);
  }

  if (holds.get(node) === counters.requests) await never(); // the page is killed here

  await trace.event('model.request', { seq: useSeq, node, requestHash: useHash, body: useBody, reissue });
  emit('request', { seq: useSeq, node, requestHash: useHash, reissue });

  const started = now();
  let response;
  try {
    response = await chatCompletion({ baseUrl: config.baseUrl, key: config.key, body: useBody, node });
  } catch (e) {
    await trace.event('error', {
      seq: useSeq, node, name: e.name, message: e.message, status: e.status ?? null,
    });
    await append({
      kind: 'result',
      seq: useSeq,
      ok: false,
      out: {
        requestHash: useHash,
        error: { name: e.name, message: e.message, status: e.status ?? null },
      },
      at: new Date().toISOString(),
    });
    emit('error', { seq: useSeq, node, message: e.message });
    throw e;
  }
  const ms = now() - started;
  await trace.event('model.response', {
    seq: useSeq, node, requestHash: useHash, response, usage: response.usage ?? null, ms,
  });
  await trace.event('timing', { label: 'model', seq: useSeq, node, ms });
  await append({
    kind: 'result',
    seq: useSeq,
    ok: true,
    out: { requestHash: useHash, response },
    at: new Date().toISOString(),
  });
  counters.turns += 1;
  emit('response', { seq: useSeq, node, usage: response.usage ?? null, ms });
  return response;
}

function assistantOf(response) {
  const message = response?.choices?.[0]?.message;
  if (!message) throw new Error('provider response had no choices[0].message');
  if (!message.role) message.role = 'assistant';
  return message;
}

// ---- the tree, folded from the log -------------------------------------
//
// One rule for a node's shape, whatever wrote it: add_node, set_status, plan and
// spawn all fold through `upsertNode` (the same rule as src/run.js), so a field
// a record does not carry keeps the value the record before it set.
function foldNodes(records) {
  const nodes = { root: { id: 'root', parent: null, title: 'root', status: 'idle' } };
  const upsert = (id, patch) => {
    const prev = nodes[id];
    nodes[id] = {
      id,
      parent: patch.parent === undefined ? (prev?.parent ?? null) : patch.parent,
      title: patch.title ?? prev?.title ?? id,
      status: patch.status ?? prev?.status ?? 'new',
    };
  };
  for (const r of records) {
    if (r.kind !== 'result' || !r.out) continue;
    const out = r.out;
    if (out.op === 'add_node') upsert(out.id, { parent: out.parent });
    else if (out.op === 'set_status') upsert(out.node, { status: out.status });
    else if (out.op === 'plan') for (const n of out.nodes ?? []) upsert(n.id, n);
    else if (out.op === 'spawn') upsert(out.id, { parent: out.parent, title: out.task, status: out.status });
  }
  return nodes;
}

const nodeStatus = (records, node) => foldNodes(records)[node]?.status ?? null;

// A plan item is a node, and the log is where it lives. The item list is a fold
// over the `plan` results of one node's loop, in seq order, and nothing else
// stores it. All a loop needs of it is one fact — which of *its* items is
// `running` — so that is all it folds. Scoping by the intent's own node is what
// keeps a child's plan from steering the root's next step (and the other way
// round); before W11 every plan intent was root's, so root's fold is unchanged.
function planItems(records, node) {
  const intents = new Map();
  for (const r of records) if (r.kind === 'intent') intents.set(r.seq, r);
  const items = new Map(); // id -> status, in the order the plan declared them
  for (const r of records) {
    if (r.kind !== 'result' || r.out?.op !== 'plan') continue;
    if ((intents.get(r.seq)?.node ?? 'root') !== node) continue;
    for (const n of r.out.nodes ?? []) items.set(n.id, n.status ?? 'pending');
  }
  return [...items].map(([id, status]) => ({ id, status }));
}

const currentOf = (records, node) => planItems(records, node).find((i) => i.status === 'running')?.id ?? node;

// A malformed plan is refused here, before it becomes a step: an effect that
// threw would leave an intent replay could never resolve. The model is told
// what was wrong in the tool result instead.
function planProblem(args) {
  const items = args?.items;
  if (!Array.isArray(items) || items.length === 0) return 'plan needs items: [{id, title, status}]';
  const seen = new Set();
  for (const [i, it] of items.entries()) {
    const id = typeof it?.id === 'string' ? it.id.trim() : '';
    if (!id) return `items[${i}] has no id`;
    if (id === 'root') return 'root is the run itself, not a plan item';
    if (seen.has(id)) return `item ${id} appears twice in one plan call`;
    seen.add(id);
    if (typeof it?.title !== 'string' || !it.title.trim()) return `item ${id} has no title`;
    if (typeof it?.status !== 'string' || !it.status.trim()) return `item ${id} has no status`;
  }
  return null;
}

// A spawn is refused for the same reason a plan is: the step exists to record a
// node, and a node that already exists would get two loops writing to it.
async function spawnProblem(args, callerNode) {
  const id = typeof args?.id === 'string' ? args.id.trim() : '';
  if (!id) return 'spawn needs an id';
  if (id === 'root') return 'root is the run itself, not a child';
  if (id === callerNode) return `node ${id} cannot spawn itself`;
  if (typeof args?.task !== 'string' || !args.task.trim()) return `child ${id} has no task`;
  const records = await readAll();
  const nodes = foldNodes(records);
  if (nodes[id]) return `node ${id} already exists`;
  const parent = typeof args?.parent === 'string' && args.parent.trim() ? args.parent.trim() : callerNode;
  if (parent !== 'root' && !nodes[parent]) return `parent ${parent} does not exist`;
  return null;
}

// ---- the scheduler ------------------------------------------------------
//
// The parent owns the children's liveness: a child is `running` from its spawn
// result until its own loop says otherwise, and this map is only the page's
// memory of which loops are alive *now*. It is not the truth — the log is — so a
// reload rebuilds it from the statuses and nothing here is needed to resume.
const loops = new Map(); // node id -> promise of its loop
const slots = { active: 0, queue: [] };

function acquire() {
  if (slots.active < SPAWN_LIMIT) {
    slots.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => slots.queue.push(resolve));
}

function release() {
  const next = slots.queue.shift();
  if (next) next(); // hand the slot over; active count unchanged
  else slots.active -= 1;
}

function track(node, promise) {
  loops.set(node, promise);
  const done = () => { if (loops.get(node) === promise) loops.delete(node); };
  promise.then(done, done);
  return promise;
}

// Start one node's loop: its own conversation, its own tools, its own log
// records. Root is started this way only on resume; a fresh run drives root
// inline so the person's prompt is the one in its first request.
function startNode(node) {
  if (loops.has(node)) return loops.get(node);
  const promise = (async () => {
    await acquire();
    try {
      await runNode(node);
      await markNode(node, terminal(node));
    } catch (e) {
      await trace.event('error', { node, name: e.name, message: e.message });
      await markNode(node, 'failed').catch(() => {});
      throw e;
    } finally {
      release();
    }
  })();
  promise.catch(() => {}); // a child's failure is its status, not an unhandled rejection
  return track(node, promise);
}

async function settleTree() {
  while (loops.size) await Promise.allSettled([...loops.values()]);
}

// ---- one node's loop ----------------------------------------------------

// The tool calls in one assistant message, executed one `step()` each. Returns
// whether the turn asked for anything, i.e. whether another request follows.
//
// `plan.node` is the item the next step lands on, recomputed from the log after
// every plan call — the plan is the log's, and the loop keeps no copy of it. A
// plan or spawn call itself lands on the node whose loop issued it: declaring
// work and starting a child are the caller's bookkeeping, not work on an item.
//
// `skip` is resume's: the first `skip` calls already have their tool results in
// the log (their effects happened), so only the rest are executed, and the
// assistant message is already in `messages`.
async function runToolCalls(messages, assistant, counters, plan, callerNode, skip = 0) {
  if (skip === 0) messages.push(assistant);
  const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
  for (let i = skip; i < calls.length; i += 1) {
    const call = calls[i];
    const name = call?.function?.name;
    const callId = call?.id ?? `call_${counters.toolCalls}`;
    let args;
    try {
      const raw = call?.function?.arguments;
      args = raw ? JSON.parse(raw) : {};
    } catch (e) {
      await trace.event('error', { node: callerNode, tool: name, callId, message: `tool arguments were not JSON: ${e.message}` });
      messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error: 'arguments were not JSON' }) });
      continue;
    }
    if (!ALLOWED.has(name)) {
      await trace.event('error', { node: callerNode, tool: name, callId, message: `unknown tool ${name}` });
      messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error: `unknown tool ${name}` }) });
      continue;
    }
    if (name === 'plan') {
      const problem = planProblem(args);
      if (problem) {
        await trace.event('error', { node: callerNode, tool: name, callId, message: problem });
        messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error: problem }) });
        continue;
      }
    }
    if (name === 'spawn') {
      const problem = await spawnProblem(args, callerNode);
      if (problem) {
        await trace.event('error', { node: callerNode, tool: name, callId, message: problem });
        messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error: problem }) });
        continue;
      }
    }

    await trace.event('tool.call', { node: callerNode, tool: name, args, callId });
    const started = now();
    const node = name === 'plan' || name === 'spawn' ? callerNode : plan.node;
    const result = await step({ node, tool: name, args, by: callerNode });
    const ms = now() - started;
    counters.toolCalls += 1;
    if (result.out?.op === 'git_commit') counters.commits += 1;
    // The plan just changed: the next step's node is whatever the log now says
    // is running. Re-read rather than patch a copy, so the loop cannot drift
    // from the log a reload would fold.
    if (name === 'plan') plan.node = currentOf(await readAll(), callerNode);
    // The child exists in the log before its loop starts: the spawn result is
    // what a resume folds, so a kill between the two costs the child's first
    // request at most, never the child itself.
    if (name === 'spawn' && result.out?.op === 'spawn') startNode(result.out.id);
    await trace.event('tool.result', { seq: result.seq, node, by: callerNode, tool: name, out: result.out, ms });
    await trace.event('timing', { label: 'tool', tool: name, seq: result.seq, node, ms });
    messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(result.out) });
    emit('tool', { seq: result.seq, node, by: callerNode, tool: name, out: result.out, ms });
    await trace.screen(`after tool ${name} on ${node}`);
  }
  return calls.length > skip;
}

async function drive(messages, counters, plan, node) {
  while (counters.turns < MAX_TURNS) {
    const response = await requestTurn(messages, counters, node);
    const assistant = assistantOf(response);
    const hadTools = await runToolCalls(messages, assistant, counters, plan, node);
    if (!hadTools) break;
    await trace.screen(`after turn ${counters.turns} of ${node}`);
  }
  if (counters.turns >= MAX_TURNS) {
    await trace.event('error', { node, message: `stopped after ${MAX_TURNS} turns without a final message` });
  }
}

// Rebuild one node's conversation from the log. The newest model_call intent for
// that node carries the exact conversation at that point; its result (if any)
// appended one assistant message, and the tool steps *that node issued* after it
// (matched by `by`) appended tool messages. Children interleave their steps, so
// matching by node is what makes this exact rather than "the next N records".
//
// A child with no model call yet has never had a request recorded; its task is
// in its spawn result, and that is its first user message. That is the case a
// kill between `spawn` and the child's first request leaves behind, and it is
// why the child restarts with its task intact.
function conversation(records, node) {
  const base = () => {
    if (node === 'root') return [{ role: 'system', content: systemFor('root') }];
    const spawn = records.find((r) => r.kind === 'result' && r.out?.op === 'spawn' && r.out.id === node);
    const messages = [{ role: 'system', content: systemFor(node) }];
    if (spawn?.out?.task) messages.push({ role: 'user', content: spawn.out.task });
    return messages;
  };
  const models = records
    .filter((r) => r.kind === 'intent' && r.tool === 'model_call' && (r.node ?? 'root') === node)
    .sort((a, b) => a.seq - b.seq);
  if (!models.length) return { messages: base(), pending: null, unanswered: null };
  const last = models[models.length - 1];
  const messages = (last.args?.body?.messages ?? base()).map((m) => ({ ...m }));
  const result = records.find((r) => r.kind === 'result' && r.seq === last.seq);
  if (!result) return { messages, pending: { seq: last.seq, args: last.args }, unanswered: null };
  const assistant = result.out?.response?.choices?.[0]?.message;
  if (!assistant) return { messages, pending: null, unanswered: null };
  messages.push(assistant);
  const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
  const after = records
    .filter((r) => r.kind === 'intent' && r.tool !== 'model_call' && r.seq > last.seq
      && (r.by ?? 'root') === node)
    .sort((a, b) => a.seq - b.seq);
  let skip = 0;
  for (let i = 0; i < calls.length; i += 1) {
    const intent = after[i];
    if (!intent) break;
    const res = records.find((r) => r.kind === 'result' && r.seq === intent.seq);
    if (!res) break;
    messages.push({ role: 'tool', tool_call_id: calls[i].id ?? `call_${i}`, content: JSON.stringify(res.out) });
    skip += 1;
  }
  return { messages, pending: null, unanswered: skip < calls.length ? { assistant, skip } : null };
}

const isFinal = (messages) => {
  const last = messages.at(-1);
  return Boolean(last && last.role === 'assistant' && !(last.tool_calls?.length));
};

// Root's terminal status is `idle` — no loop is alive — not `done`: there is
// nothing left to finish, and the screen's one-node view has always read that
// way. A child's terminal status is `done`, because the parent is what started
// it and "finished" is the fact a parent's reader wants.
const terminal = (node) => (node === 'root' ? 'idle' : 'done');

async function markNode(node, status) {
  const records = await readAll();
  if (nodeStatus(records, node) === status) return null;
  return step({ node, tool: 'set_status', args: { node, status }, by: node });
}

// Run one node to the end of its turns: finish any interrupted call or
// half-executed turn, then drive to the final assistant message. It does not
// mark status — the caller does, because root on a fresh run marks `done` only
// after its children have settled.
async function runNode(node) {
  const records = await readAll();
  const conv = conversation(records, node);
  const counters = zeroCounters();
  const plan = { node: currentOf(records, node) };
  const messages = conv.messages;

  if (conv.pending) {
    if (!hasKey()) {
      const e = new Error('no key — the unfinished call was not re-issued');
      e.code = 'NO_KEY';
      throw e;
    }
    emit('reissue', { seq: conv.pending.seq, node, requestHash: conv.pending.args.requestHash });
    const response = await requestTurn(messages, counters, node, {
      seq: conv.pending.seq,
      hash: conv.pending.args.requestHash,
      body: conv.pending.args.body,
      reissue: true,
    });
    const assistant = assistantOf(response);
    await runToolCalls(messages, assistant, counters, plan, node);
  } else if (conv.unanswered) {
    await runToolCalls(messages, conv.unanswered.assistant, counters, plan, node, conv.unanswered.skip);
  }

  // A conversation whose last message is an assistant with no tool calls has
  // already finished its turns; resuming it must not buy the same turn twice.
  if (!isFinal(messages)) await drive(messages, counters, plan, node);
  mergeTotals(counters);
  return counters;
}

// ---- counters and the trace --------------------------------------------

const zeroCounters = () => ({ turns: 0, requests: 0, toolCalls: 0, commits: 0 });
let runTotals = zeroCounters();

function mergeTotals(c) {
  runTotals.turns += c.turns;
  runTotals.toolCalls += c.toolCalls;
  runTotals.commits += c.commits;
}

async function beginTrace(extra = {}) {
  const commit = extra.commit !== undefined ? extra.commit : await headSha();
  const runId = trace.startRun({
    commit,
    seed: seedValue(),
    env: envInfo(),
    model: config.model,
    baseUrl: config.baseUrl,
    ...extra,
  });
  return runId;
}

function ensureReady() {
  if (!hasKey()) {
    const e = new Error('no key — nothing was sent');
    e.code = 'NO_KEY';
    return e;
  }
  if (!config.baseUrl) {
    const e = new Error('no endpoint — nothing was sent');
    e.code = 'NO_ENDPOINT';
    return e;
  }
  return null;
}

async function finishRun(extra = {}) {
  await trace.finish('complete');
  const summary = {
    ...runTotals,
    runId: trace.runId(),
    trace: trace.text(),
    traceSummary: trace.summaryText(),
    ...extra,
  };
  emit('done', summary);
  return summary;
}

// Start a run with a person's message. If a model call was left unfinished by a
// kill, that is resumed first and the new message waits for the next send — the
// call was probably paid for, so it is not silently dropped.
export async function run(prompt) {
  await replaySettled();
  const records = await readAll();
  const restored = conversation(records, 'root');
  if (restored.pending || restored.unanswered) return resume();

  const blocked = ensureReady();
  await beginTrace(blocked ? { commit: null } : {});
  await trace.screen('run start');
  if (blocked) {
    await trace.event('error', { name: blocked.name, message: blocked.message });
    await trace.screen('refused: no key');
    await trace.finish('refused');
    emit('error', { message: blocked.message });
    throw blocked;
  }

  emit('start', { prompt: String(prompt ?? '') });
  runTotals = zeroCounters();
  const messages = restored.messages.slice();
  messages.push({ role: 'user', content: String(prompt ?? '') });
  const counters = zeroCounters();
  const plan = { node: currentOf(records, 'root') };
  try {
    await markNode('root', 'running');
    await drive(messages, counters, plan, 'root');
    mergeTotals(counters);
    // The parent owns the children's liveness: the run is not done while a node
    // it started is still running. This is a join, not a sequential walk — the
    // children have been running since their spawn steps.
    await settleTree();
    await markNode('root', 'idle');
  } catch (e) {
    await markNode('root', 'failed').catch(() => {});
    await trace.event('error', { name: e.name, message: e.message });
    await trace.screen('run failed');
    await trace.finish('failed');
    emit('error', { message: e.message });
    throw e;
  }
  return finishRun({ restarted: [] });
}

// Re-issue the one unfinished root model call, at most once, then continue the
// turn. Root-scoped and kept for W7's shape; the tree-wide restart is
// `resumeAll()`.
export async function resume() {
  if (!hasKey()) {
    const e = new Error('no key — the unfinished call was not re-issued');
    e.code = 'NO_KEY';
    throw e;
  }
  await replaySettled();
  const records = await readAll();
  const conv = conversation(records, 'root');
  const pendingSeq = conv.pending?.seq ?? null;
  const work = Boolean(conv.pending || conv.unanswered || !isFinal(conv.messages));
  await beginTrace({ resumed: work });
  await trace.screen('resume start');
  runTotals = zeroCounters();
  if (!work) {
    await trace.finish('nothing to resume');
    return finishRun({ resumed: false, reissuedSeq: null, restarted: [] });
  }
  try {
    await runNode('root');
    await settleTree();
    await markNode('root', 'idle');
  } catch (e) {
    await markNode('root', 'failed').catch(() => {});
    await trace.event('error', { name: e.name, message: e.message });
    await trace.screen('resume failed');
    await trace.finish('failed');
    emit('error', { message: e.message });
    throw e;
  }
  return finishRun({ resumed: true, reissuedSeq: pendingSeq, restarted: [] });
}

// The design record's leaf 5: on load, every node marked `running` restarts.
// Which nodes those are is folded from the log — nothing here remembers the
// page that died. Each node rebuilds its own messages from its own model_call
// intents (a child that never got as far as its first request rebuilds from its
// spawn task), re-issues its own interrupted call at most once, and writes its
// own `done`/`failed`. A node is started once; a second call to resumeAll while
// one is in flight is the same promise.
let resuming = null;

export async function resumeAll() {
  if (!hasKey()) {
    const e = new Error('no key — the unfinished nodes were not restarted');
    e.code = 'NO_KEY';
    throw e;
  }
  if (resuming) return resuming;
  resuming = (async () => {
    await replaySettled();
    const records = await readAll();
    const nodes = Object.values(foldNodes(records));
    const running = nodes.filter((n) => n.status === 'running').map((n) => n.id);
    await beginTrace({ resumed: running.length > 0, restarted: running });
    await trace.screen('resume all start');
    runTotals = zeroCounters();
    if (!running.length) {
      await trace.finish('nothing to resume');
      return finishRun({ resumed: false, restarted: [] });
    }
    for (const id of running) startNode(id);
    await settleTree();
    // A root that was restarted alongside children is `done` here; the call is
    // idempotent and guarded by the log's own status.
    if (running.includes('root') && nodeStatus(await readAll(), 'root') === 'running') {
      await markNode('root', 'idle');
    }
    return finishRun({ resumed: true, restarted: running });
  })().finally(() => { resuming = null; });
  return resuming;
}

// The newest unfinished model calls, as the screen names them. Read from the
// log, which is the truth, not from the last replay's memory.
export async function pendingCalls() {
  const records = await readAll();
  const resultSeqs = new Set(records.filter((r) => r.kind === 'result').map((r) => r.seq));
  return records
    .filter((r) => r.kind === 'intent' && r.tool === 'model_call' && !resultSeqs.has(r.seq))
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({ seq: r.seq, node: r.node ?? 'root', requestHash: r.args?.requestHash ?? null }));
}

// Which nodes the log says are `running`, i.e. what a boot would restart. The
// screen uses this to name them; it is a fold, not a guess.
export async function runningNodes() {
  const nodes = foldNodes(await readAll());
  return Object.values(nodes).filter((n) => n.status === 'running').map((n) => n.id);
}

export function traceText() {
  return trace.text();
}

export function traceSummary() {
  return trace.summaryText();
}
