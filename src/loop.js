// The loop: one turn is one model call, the tool calls in its reply are `step()`
// each — the existing log, the existing per-step commit, M6's Worker for
// `run_js`. There is no second execution path and no provider SDK.
//
// Prefix stability is the shape of this file: `messages` is built by appending
// and never rebuilt, so turn n+1's body is turn n's array plus what happened
// after it, byte for byte. Volatile text (the seed, timing) never enters a
// message; it lives in the trace.
//
// A model call is an intent with a request hash and its response is the result:
//
//   intent {seq, node:'root', tool:'model_call', args:{requestHash, body}}
//   result {seq, ok, out:{requestHash, response}, at}
//
// `body` is the exact JSON body that was sent, kept so a re-issue after a kill
// is the same bytes (not a reconstruction, which would be a second source of
// truth). `requestHash` is SHA-256 of that body. The response is kept whole so
// `usage` and the assistant message are recoverable without paying twice.
// Nothing else about the log's record shape changes.
//
// The boot fold refuses to resolve a model_call (src/log.js `defer`): the key is
// memory-only, so re-issuing belongs here, once, with the person's key in hand.

import { append, nextSeq, onAppend, readAll } from './log.js';
import { step, replaySettled, getFs, getGit } from './run.js';
import * as trace from './trace.js';
import { chatCompletion } from './provider.js';

const MAX_TURNS = 16;

// The provider's tools, in OpenAI's shape. Names must be the tool names in
// src/run.js, so the request and the executor have one vocabulary.
const TOOL_DEFS = [
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
const SYSTEM = [
  'You are agent.js, a coding agent working in a browser workspace.',
  'Tools are native: write, run_js, git_commit, read, ls. There is no shell.',
  'Every change to a file is committed with git_commit, one file per step.',
  'Keep answers short.',
].join('\n');

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

// One model request: intent -> request bytes -> response -> result. The intent
// is on disk before the request leaves, which is what makes a kill mid-call a
// named, re-issuable intent rather than a lost turn.
async function requestTurn(messages, counters, { seq, hash, body, reissue = false } = {}) {
  const useSeq = seq ?? await nextSeq();
  const useBody = body ?? makeBody(messages);
  const useHash = hash ?? await sha256Hex(JSON.stringify(useBody));

  if (!reissue) {
    await append({
      kind: 'intent',
      seq: useSeq,
      node: 'root',
      tool: 'model_call',
      args: { requestHash: useHash, body: useBody },
    });
  } else {
    // The intent is already in the log; verify the bytes are the ones it names.
    const again = await sha256Hex(JSON.stringify(useBody));
    if (again !== useHash) throw new Error(`request hash mismatch on re-issue: ${again} != ${useHash}`);
  }

  await trace.event('model.request', { seq: useSeq, requestHash: useHash, body: useBody, reissue });
  emit('request', { seq: useSeq, requestHash: useHash, reissue });

  const started = now();
  let response;
  try {
    response = await chatCompletion({ baseUrl: config.baseUrl, key: config.key, body: useBody });
  } catch (e) {
    await trace.event('error', {
      seq: useSeq, name: e.name, message: e.message, status: e.status ?? null,
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
    emit('error', { seq: useSeq, message: e.message });
    throw e;
  }
  const ms = now() - started;
  await trace.event('model.response', { seq: useSeq, requestHash: useHash, response, usage: response.usage ?? null, ms });
  await trace.event('timing', { label: 'model', seq: useSeq, ms });
  await append({
    kind: 'result',
    seq: useSeq,
    ok: true,
    out: { requestHash: useHash, response },
    at: new Date().toISOString(),
  });
  counters.turns += 1;
  emit('response', { seq: useSeq, usage: response.usage ?? null, ms });
  return response;
}

function assistantOf(response) {
  const message = response?.choices?.[0]?.message;
  if (!message) throw new Error('provider response had no choices[0].message');
  if (!message.role) message.role = 'assistant';
  return message;
}

// The tool calls in one assistant message, executed one `step()` each. Returns
// whether the turn asked for anything, i.e. whether another request follows.
async function runToolCalls(messages, assistant, counters) {
  messages.push(assistant);
  const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
  for (const call of calls) {
    const name = call?.function?.name;
    const callId = call?.id ?? `call_${counters.toolCalls}`;
    let args;
    try {
      const raw = call?.function?.arguments;
      args = raw ? JSON.parse(raw) : {};
    } catch (e) {
      await trace.event('error', { tool: name, callId, message: `tool arguments were not JSON: ${e.message}` });
      messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error: 'arguments were not JSON' }) });
      continue;
    }
    if (!ALLOWED.has(name)) {
      await trace.event('error', { tool: name, callId, message: `unknown tool ${name}` });
      messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error: `unknown tool ${name}` }) });
      continue;
    }

    await trace.event('tool.call', { tool: name, args, callId });
    const started = now();
    const result = await step({ node: 'root', tool: name, args });
    const ms = now() - started;
    counters.toolCalls += 1;
    if (result.out?.op === 'git_commit') counters.commits += 1;
    await trace.event('tool.result', { seq: result.seq, tool: name, out: result.out, ms });
    await trace.event('timing', { label: 'tool', tool: name, seq: result.seq, ms });
    messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(result.out) });
    emit('tool', { seq: result.seq, tool: name, out: result.out, ms });
    await trace.screen(`after tool ${name}`);
  }
  return calls.length > 0;
}

async function drive(messages, counters) {
  while (counters.turns < MAX_TURNS) {
    const response = await requestTurn(messages, counters);
    const assistant = assistantOf(response);
    const hadTools = await runToolCalls(messages, assistant, counters);
    if (!hadTools) break;
    await trace.screen(`after turn ${counters.turns}`);
  }
  if (counters.turns >= MAX_TURNS) {
    await trace.event('error', { message: `stopped after ${MAX_TURNS} turns without a final message` });
  }
}

// Rebuild the conversation from the log. The newest model_call intent's body is
// the exact conversation at that point; its result (if any) appended one
// assistant message, and any tool steps after it appended tool messages.
function conversation(records) {
  const models = records
    .filter((r) => r.kind === 'intent' && r.tool === 'model_call')
    .sort((a, b) => a.seq - b.seq);
  if (!models.length) return { messages: [{ role: 'system', content: SYSTEM }], pending: null };
  const last = models[models.length - 1];
  const messages = (last.args?.body?.messages ?? []).map((m) => ({ ...m }));
  const result = records.find((r) => r.kind === 'result' && r.seq === last.seq);
  if (!result) return { messages, pending: { seq: last.seq, args: last.args } };
  const assistant = result.out?.response?.choices?.[0]?.message;
  if (!assistant) return { messages, pending: null };
  messages.push(assistant);
  const calls = assistant.tool_calls ?? [];
  const after = records
    .filter((r) => r.kind === 'intent' && r.tool !== 'model_call' && r.seq > last.seq)
    .sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < after.length && i < calls.length; i += 1) {
    const res = records.find((r) => r.kind === 'result' && r.seq === after[i].seq);
    if (!res) break;
    messages.push({
      role: 'tool',
      tool_call_id: calls[i].id ?? `call_${i}`,
      content: JSON.stringify(res.out),
    });
  }
  return { messages, pending: null };
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

function counters() {
  return { turns: 0, toolCalls: 0, commits: 0 };
}

async function finishRun(counters, extra = {}) {
  await trace.finish('complete');
  const summary = { ...counters, runId: trace.runId(), trace: trace.text(), traceSummary: trace.summaryText(), ...extra };
  emit('done', summary);
  return summary;
}

// Start a run with a person's message. If a model call was left unfinished by a
// kill, that is resumed first and the new message waits for the next send — the
// call was probably paid for, so it is not silently dropped.
export async function run(prompt) {
  await replaySettled();
  const records = await readAll();
  const { messages: restored, pending } = conversation(records);
  if (pending) return resume();

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
  const messages = restored.slice();
  messages.push({ role: 'user', content: String(prompt ?? '') });
  const c = counters();
  try {
    await drive(messages, c);
  } catch (e) {
    await trace.event('error', { name: e.name, message: e.message });
    await trace.screen('run failed');
    await trace.finish('failed');
    emit('error', { message: e.message });
    throw e;
  }
  return finishRun(c);
}

// Re-issue the one unfinished model call, at most once, then continue the turn.
export async function resume() {
  if (!hasKey()) {
    const e = new Error('no key — the unfinished call was not re-issued');
    e.code = 'NO_KEY';
    throw e;
  }
  const records = await readAll();
  const models = records
    .filter((r) => r.kind === 'intent' && r.tool === 'model_call')
    .sort((a, b) => a.seq - b.seq);
  const resultSeqs = new Set(records.filter((r) => r.kind === 'result').map((r) => r.seq));
  const pending = models.filter((m) => !resultSeqs.has(m.seq));
  await beginTrace({ resumed: pending.length > 0 });
  await trace.screen('resume start');
  if (!pending.length) {
    await trace.finish('nothing to resume');
    return finishRun(counters(), { resumed: false });
  }
  if (pending.length > 1) {
    await trace.event('error', { message: `${pending.length} unfinished model calls; re-issuing the newest only` });
  }
  const one = pending[pending.length - 1];
  const messages = (one.args?.body?.messages ?? []).map((m) => ({ ...m }));
  const c = counters();
  try {
    emit('reissue', { seq: one.seq, requestHash: one.args.requestHash });
    const response = await requestTurn(messages, c, {
      seq: one.seq,
      hash: one.args.requestHash,
      body: one.args.body,
      reissue: true,
    });
    const assistant = assistantOf(response);
    const hadTools = await runToolCalls(messages, assistant, c);
    if (hadTools) await drive(messages, c);
  } catch (e) {
    await trace.event('error', { name: e.name, message: e.message });
    await trace.screen('resume failed');
    await trace.finish('failed');
    emit('error', { message: e.message });
    throw e;
  }
  return finishRun(c, { resumed: true, reissuedSeq: one.seq, requestHash: one.args.requestHash });
}

// The newest unfinished model calls, as the screen names them. Read from the
// log, which is the truth, not from the last replay's memory.
export async function pendingCalls() {
  const records = await readAll();
  const resultSeqs = new Set(records.filter((r) => r.kind === 'result').map((r) => r.seq));
  return records
    .filter((r) => r.kind === 'intent' && r.tool === 'model_call' && !resultSeqs.has(r.seq))
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({ seq: r.seq, requestHash: r.args?.requestHash ?? null }));
}

export function traceText() {
  return trace.text();
}

export function traceSummary() {
  return trace.summaryText();
}
