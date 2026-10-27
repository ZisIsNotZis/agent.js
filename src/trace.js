// One run, one trace. The trace is the thing a red run is debugged from
// without re-running it, so every event carries what was actually sent and what
// actually came back:
//
//   run.start      runId, workspace commit, URL, seed, env, model, base URL
//   model.request  the full body sent, and its request hash
//   model.response the full JSON received, including `usage` verbatim
//   tool.call      seq, tool, args, provider tool_call id
//   tool.result    seq, tool, out, duration
//   log.record     every record exactly as appended (intents and results)
//   screen         the visible text at that moment
//   timing         model latency, tool duration, run duration
//   error          a caught failure and its message
//
// It is written to OPFS (`agentjs-trace/<runId>/trace.ndjson`) as it happens,
// so a kill leaves the events up to the kill on disk. The same bytes are what
// the page's export control hands over and what tools/probe-w7.mjs copies into
// `evidence/<runId>/`. The key never enters this module: it is not in the body,
// not in the response and not in any event this file writes.
//
// `summary.md` is derived from the same events, so it cannot disagree with the
// trace; it names the commits and the token/cache numbers the provider returned.

const DIR = 'agentjs-trace';

export const EVENTS = [
  'run.start', 'model.request', 'model.response', 'tool.call', 'tool.result',
  'log.record', 'screen', 'timing', 'error',
];

let run = null;
let chain = Promise.resolve();

function newId() {
  const rnd = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${rnd.slice(0, 8)}`;
}

async function traceDir(runId) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(DIR, { create: true });
  return dir.getDirectoryHandle(runId, { create: true });
}

async function writeText(runId, name, text) {
  const dir = await traceDir(runId);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

function scheduleFlush() {
  const id = run.runId;
  const text = run.lines;
  chain = chain.then(() => writeText(id, 'trace.ndjson', text).catch(() => {}), () => {});
  return chain;
}

export function startRun(meta = {}) {
  const runId = newId();
  run = {
    runId,
    startedAt: Date.now(),
    meta,
    events: [],
    lines: '',
    committed: [],
    errors: [],
  };
  event('run.start', {
    runId,
    commit: meta.commit ?? null,
    url: String(location?.href ?? ''),
    seed: meta.seed ?? null,
    env: meta.env ?? null,
    model: meta.model ?? null,
    baseUrl: meta.baseUrl ?? null,
    // W11: a resume names the nodes the log said were running, so a red run is
    // debugged from what was restarted rather than from what was remembered.
    resumed: meta.resumed ?? null,
    restarted: meta.restarted ?? null,
  });
  return runId;
}

export function active() {
  return run;
}

export async function event(type, data = {}) {
  if (!run) return null;
  if (!EVENTS.includes(type)) throw new Error(`unknown trace event ${type}`);
  const rec = { t: new Date().toISOString(), type, ...data };
  run.events.push(rec);
  run.lines += `${JSON.stringify(rec)}\n`;
  if (type === 'error') run.errors.push(rec);
  await scheduleFlush();
  return rec;
}

export const screen = (label = '') => event('screen', {
  label,
  text: typeof document === 'undefined' ? '' : document.body.innerText,
});

export const logRecord = (record) => event('log.record', { record });

export async function finish(reason = 'complete') {
  if (!run) return null;
  await event('timing', { label: 'run', reason, ms: Date.now() - run.startedAt });
  await screen('run end');
  await writeText(run.runId, 'summary.md', summaryText()).catch(() => {});
  return run;
}

export function text() {
  return run ? run.lines : '';
}

export function runId() {
  return run ? run.runId : null;
}

// What the summary is allowed to say: the events. Nothing is remembered
// separately, so a summary that names a commit is naming one the trace saw.
export function summaryText() {
  if (!run) return '';
  const ev = run.events;
  const requests = ev.filter((e) => e.type === 'model.request');
  const responses = ev.filter((e) => e.type === 'model.response');
  const calls = ev.filter((e) => e.type === 'tool.call');
  const results = ev.filter((e) => e.type === 'tool.result');
  const errors = ev.filter((e) => e.type === 'error');

  const commits = [];
  for (const e of ev) {
    const out = e.type === 'tool.result' ? e.out : e.type === 'log.record' && e.record?.kind === 'result' ? e.record.out : null;
    if (out?.op === 'git_commit' && !commits.some((c) => c.oid === out.oid)) {
      commits.push({ oid: out.oid, path: out.path, message: out.message, seq: out.seq });
    }
  }

  const usage = {};
  for (const r of responses) {
    const u = r.usage;
    if (!u || typeof u !== 'object') continue;
    for (const [k, v] of Object.entries(u)) {
      if (typeof v === 'number') usage[k] = (usage[k] ?? 0) + v;
    }
  }
  const usageLine = Object.keys(usage).length
    ? Object.entries(usage).map(([k, v]) => `${k}=${v}`).join(', ')
    : 'none returned';

  const last = run.events.at(-1);
  const duration = ev.find((e) => e.type === 'timing' && e.label === 'run')?.ms ?? 0;
  const lines = [
    `# run ${run.runId}`,
    '',
    `- model: ${run.meta.model ?? '(none)'} at ${run.meta.baseUrl ?? '(none)'}`,
    `- seed: ${run.meta.seed ?? '(none)'}`,
    `- workspace commit at start: ${run.meta.commit ?? '(none)'}`,
    `- requests (turns): ${requests.length}`,
    `- tool calls: ${calls.length} (${results.length} returned)`,
    `- commits: ${commits.length}`,
    `- duration: ${duration} ms`,
    `- tokens / cache, summed from response usage verbatim: ${usageLine}`,
    `- last event: ${last ? last.type : '(none)'}`,
    '',
    '## commits',
    '',
    ...(commits.length
      ? commits.map((c) => `- ${c.oid} (seq ${c.seq}) ${c.path} — ${c.message}`)
      : ['- none']),
    '',
    '## what went wrong',
    '',
    errors.length ? `- ${errors[0].message ?? errors[0].error?.message ?? JSON.stringify(errors[0])}` : '- nothing',
    '',
  ];
  return lines.join('\n');
}

// The page's "export trajectory" control: the same trace.ndjson bytes a probe
// copies, handed to the person as a file.
export function downloadTrace(filename = `trace-${run?.runId ?? 'run'}.ndjson`) {
  const blob = new Blob([text()], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}
