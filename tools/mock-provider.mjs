// A local OpenAI-shaped provider for the W7 probe. It is deliberately dumb:
// it speaks `POST .../chat/completions`, records every request body verbatim to
// disk, and returns the scripted reply the probe asked for. No request ever
// leaves this machine, and no script in this repo may point the page at a real
// provider — that is what the probe asserts.
//
// Run: node tools/mock-provider.mjs
//   MOCK_PORT        default 8138
//   MOCK_RECORD_DIR  default .tmp/mock-w7-<pid>
//
// Control endpoints (they are the probe's, not the product's):
//   GET  /__health           {ok, port, recordsDir}
//   GET  /__state            {count, scriptIndex, usages, bodies, headers}
//   POST /__script           {script, resetCount?}  set the reply sequence
//   POST /__reset            {}                     count/script/bodies back to 0
//
// A script entry is one of:
//   {tool_calls:[{name, arguments}]}   emit tool calls (arguments object or string)
//   {content:"..."}                    emit a final assistant message
//   {delayMs:n}                        wait n ms before answering
//   {hang:true}                        never answer (the probe kills the page)
//   {status:400, error:"..."}          answer with an HTTP error
//
// CORS is for the page origin (http://127.0.0.1:8137 by default), including the
// Authorization preflight, because the page sends a real key header.
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 8138);
const RECORD_DIR = process.env.MOCK_RECORD_DIR
  || join(process.cwd(), '.tmp', `mock-w7-${process.pid}`);

await mkdir(RECORD_DIR, { recursive: true });

let count = 0;
let script = [];
let scriptIndex = 0;
let bodies = [];
let usages = [];
let headersSeen = [];

function cors(req, res) {
  res.setHeader('access-control-allow-origin', req.headers.origin || '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'origin');
}

function usageFor(n) {
  const prompt = 1000 + n * 100;
  const completion = 25;
  const hit = n === 1 ? 0 : 900;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: prompt - hit,
  };
}

function buildResponse(body, entry) {
  const n = count;
  const message = { role: 'assistant', content: null };
  let finish = 'stop';
  if (Array.isArray(entry.tool_calls) && entry.tool_calls.length) {
    finish = 'tool_calls';
    message.tool_calls = entry.tool_calls.map((c, i) => ({
      id: `call_${n}_${i}`,
      type: 'function',
      function: {
        name: c.name,
        arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
      },
    }));
  } else {
    message.content = String(entry.content ?? '');
  }
  const usage = usageFor(n);
  usages.push(usage);
  return {
    id: `chatcmpl-mock-${n}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? 'mock-model',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/__health') {
    json(res, 200, { ok: true, port: PORT, recordsDir: RECORD_DIR });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__state') {
    json(res, 200, {
      count, scriptIndex, recordsDir: RECORD_DIR,
      usages, bodies, headers: headersSeen,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__script') {
    const raw = await readBody(req);
    const data = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    script = Array.isArray(data.script) ? data.script : [];
    scriptIndex = 0;
    if (data.resetCount) {
      count = 0;
      bodies = [];
      usages = [];
      headersSeen = [];
    }
    json(res, 200, { ok: true, script: script.length, count });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__reset') {
    await readBody(req);
    count = 0;
    script = [];
    scriptIndex = 0;
    bodies = [];
    usages = [];
    headersSeen = [];
    json(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
    return;
  }

  const raw = await readBody(req);
  const rawText = raw.toString('utf8');
  let body = null;
  try {
    body = JSON.parse(rawText);
  } catch {
    json(res, 400, { error: { message: 'request body was not JSON' } });
    return;
  }
  count += 1;
  bodies.push(body);
  headersSeen.push({ authorization: req.headers.authorization ? 'present' : 'absent' });
  // Every chat request, verbatim, the moment its bytes are complete.
  await writeFile(join(RECORD_DIR, `request-${String(count).padStart(4, '0')}.json`), rawText);

  const entry = script[scriptIndex++] ?? { content: 'script exhausted' };
  if (entry.hang) return; // no answer; the probe kills the page
  if (entry.delayMs) await new Promise((r) => setTimeout(r, entry.delayMs));
  if (entry.status && entry.status >= 400) {
    json(res, entry.status, { error: { message: entry.error ?? 'scripted error' } });
    return;
  }
  if (res.writableEnded) return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(buildResponse(body, entry)));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock provider on http://127.0.0.1:${PORT}/v1 (records in ${RECORD_DIR})`);
});
