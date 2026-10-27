// The first real agent tools, over src/fs.js.
//
// Each tool is an effect whose `run(args, ctx)` does the work and whose
// `check(state, args, ctx)` answers "did this already happen?" — the question
// replay() asks of an intent that has no result. `out(args, ctx)` is the
// descriptor to record when check() says yes, so recognising a settled effect
// never repeats it.
//
// git_commit is the first non-idempotent one: its commit message carries the
// step's seq, so "did step 7 commit?" is answered by git.log — one ref read and
// a scan of the messages — rather than by re-committing or by a full status
// walk. The step path commits one path and never runs a full status; the probe
// greps these modules for that call.
//
// A step's commit is its effect: write the one file, stage that one path,
// commit. `write` is the same write without the commit, for scaffolding.
//
// run_js is the first effect whose point is that code executes. It is treated
// as non-idempotent even though a pure script invites the opposite assumption:
// a kill mid-run must not silently execute the file a second time. The rule is
// a non-replay rule plus a durable `done` marker in OPFS
// (`agentjs-exec/<seq>.json`, written with the output after a run finishes):
//   - marker `done`      -> replay takes the recorded output without executing
//                           anything, so a kill between the effect and its
//                           result loses nothing;
//   - anything else      -> the page died somewhere after the intent was
//                           recorded; replay records `interrupted` and never
//                           executes the file again.
// The rule is deliberately conservative: the intent is the only durable proof
// that the run may have started, so an interrupted run is never repeated. The
// cost is that a run killed before any code ran is also not retried, and an
// interrupted run's output is lost; both are reported on screen, not hidden.
// The marker lives beside the workspace, not inside git: a run is not a file.

import { opfsFs } from './fs.js';
import { DEFAULT_TIMEOUT_MS, readRunMarker, runScript, writeRunMarker } from './exec.js';

const DIR = '/';
const AUTHOR = { name: 'agent.js', email: 'agent@agent.js' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let fsP = null;
let gitP = null;

export function getFs() {
  fsP ??= opfsFs();
  return fsP;
}

// Loaded lazily and in this order: the Buffer shim must be global before
// isomorphic-git's StreamReader is constructed (its ESM build imports no shim
// of its own), and a page that never commits should not pay the 91 KB.
export function getGit() {
  gitP ??= (async () => {
    const { Buffer } = await import('../vendor/buffer.min.js');
    globalThis.Buffer = globalThis.Buffer ?? Buffer;
    const mod = await import('../vendor/isomorphic-git.min.js');
    return mod.git ?? mod.default ?? mod;
  })();
  return gitP;
}

const text = (value) => (typeof value === 'string' ? value : String(value ?? ''));

export function makeTools(fsOf = getFs, gitOf = getGit) {
  const find = async (seq) => {
    const fs = await fsOf();
    const git = await gitOf();
    try {
      const commits = await git.log({ fs, dir: DIR, depth: Infinity });
      return commits.find((c) => c.commit.message.startsWith(`agent step ${seq}:`)) ?? null;
    } catch {
      return null;
    }
  };

  const writeRun = async (args) => {
    const fs = await fsOf();
    const bytes = encoder.encode(text(args.content));
    await fs.write(args.path, bytes);
    return { op: 'write', path: args.path, bytes: bytes.length };
  };

  const langOf = (file) => (/\.tsx$/i.test(file) ? 'tsx'
    : /\.[cm]?ts$/i.test(file) ? 'ts' : 'js');

  // `plan` is how the model declares and advances its own work: one call
  // upserts the items it names (`id`, optional `parent`, `title`, `status`).
  // The effect *is* the result — the node set it changed — so it is a pure
  // function of its arguments and nothing but the log remembers a plan. A
  // replay re-runs it and lands on the same bytes.
  //
  // It normalises rather than throws: an effect that threw would leave an
  // intent replay could never resolve, so the loop refuses a malformed plan
  // before stepping it and names the problem to the model there.
  const planRun = (args, ctx) => {
    const items = Array.isArray(args?.items) ? args.items : [];
    // An item's parent defaults to the node whose loop declared it: root for the
    // run's own plan, the child's id for a child's plan. `ctx.node` is the node
    // the plan step lands on (src/loop.js), so this needs no separate input.
    const self = text(ctx?.node) || 'root';
    const nodes = items.map((it) => ({
      id: text(it?.id).trim(),
      parent: text(it?.parent).trim() || self,
      title: text(it?.title).trim() || text(it?.id).trim(),
      status: text(it?.status).trim() || 'pending',
    })).filter((n) => n.id && n.id !== 'root'); // root is the run, not an item
    return { op: 'plan', nodes };
  };

  // `spawn` is the one tool whose effect is a *node*, not a file: it records the
  // child and its task (the child's first user message), and the loop starts the
  // child's own model loop after this step is committed. The step lands on the
  // caller, so the child's existence is the parent's log record and a resume
  // folds it without any memory of this page. Validation (unique id, a task, not
  // root) lives in src/loop.js, before the step, for the same reason `plan`'s
  // does: an effect that threw would leave an intent replay could never resolve.
  const spawnRun = (args, ctx) => ({
    op: 'spawn',
    id: text(args?.id).trim(),
    parent: text(args?.parent).trim() || text(ctx?.node) || 'root',
    task: text(args?.task),
    status: 'running',
  });

  const execRun = async (args, ctx) => {
    const fs = await fsOf();
    const file = args.path ?? '<source>';
    const source = args.source != null
      ? text(args.source)
      : decoder.decode(await fs.read(args.path));
    const lang = langOf(file);
    const passed = args.args ?? null;
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const r = await runScript({ source, lang, file, args: passed, timeoutMs });
    const out = {
      op: 'exec',
      seq: ctx.seq,
      file,
      lang,
      stdout: r.stdout,
      stderr: r.stderr,
      exit: r.exit,
      wallMs: Math.round(r.wallMs),
      refusal: r.refusal,
      tsBytes: r.tsBytes,
      tsImports: r.tsImports,
      error: r.error ? { name: r.error.name, message: r.error.message } : null,
    };
    await writeRunMarker(ctx.seq, { status: 'done', out });
    return out;
  };

  const commitRun = async (args, ctx) => {
    const seq = ctx.seq;
    const message = `agent step ${seq}: ${text(args.message) || args.path}`;
    const fs = await fsOf();
    const git = await gitOf();

    // The write is idempotent; the commit is what check() recognises.
    const bytes = encoder.encode(text(args.content));
    await fs.write(args.path, bytes);

    let inited = true;
    try {
      await fs.stat('/.git');
    } catch {
      inited = false;
    }
    if (!inited) await git.init({ fs, dir: DIR, defaultBranch: 'main' });

    await git.add({ fs, dir: DIR, filepath: args.path });
    const oid = await git.commit({
      fs,
      dir: DIR,
      message,
      author: AUTHOR,
      committer: AUTHOR,
    });
    return { op: 'git_commit', seq, path: args.path, oid, message, bytes: bytes.length };
  };

  return {
    plan: {
      run: planRun,
    },

    spawn: {
      // Pure: the result is the node it declares, so a replay re-runs it and
      // lands on the same bytes. The child loop itself is the loop's to start.
      run: spawnRun,
    },

    ls: {
      run: async (args) => {
        const fs = await fsOf();
        const path = args.path ?? '.';
        return { op: 'ls', path, entries: await fs.ls(path) };
      },
    },

    read: {
      run: async (args) => {
        const fs = await fsOf();
        const bytes = await fs.read(args.path);
        return { op: 'read', path: args.path, content: decoder.decode(bytes), bytes: bytes.length };
      },
    },

    write: {
      run: writeRun,
      check: async (state, args) => {
        try {
          const fs = await fsOf();
          const bytes = await fs.read(args.path);
          return decoder.decode(bytes) === text(args.content);
        } catch {
          return false;
        }
      },
      out: (args) => ({ op: 'write', path: args.path, bytes: encoder.encode(text(args.content)).length }),
    },

    run_js: {
      run: execRun,
      // Non-idempotent: an intent with no result is never executed a second
      // time. check() is therefore always true, and out() decides: the `done`
      // marker means the run finished and its output is recovered; anything
      // else (no marker, or a half-written one) means it may have been running
      // when the page died, so it is recorded `interrupted` and not repeated.
      // The cost is named: a run killed just after its intent, before any code
      // ran, is also not retried; the person runs it again deliberately.
      check: () => true,
      out: async (args, ctx) => {
        const marker = await readRunMarker(ctx.seq);
        if (marker?.status === 'done') return marker.out;
        return {
          op: 'exec',
          seq: ctx.seq,
          file: marker?.file ?? args.path ?? '<source>',
          lang: marker?.lang ?? langOf(args.path ?? '<source>'),
          stdout: '',
          stderr: '',
          exit: 'interrupted',
          wallMs: 0,
          refusal: null,
          tsBytes: 0,
          tsImports: 0,
          error: null,
          note: 'the run may have been executing when the page died; it was not run again',
        };
      },
    },

    git_commit: {
      run: commitRun,
      check: async (state, args, ctx) => Boolean(await find(ctx.seq)),
      out: async (args, ctx) => {
        const found = await find(ctx.seq);
        if (!found) throw new Error(`step ${ctx.seq}'s commit is not in git.log after all`);
        return {
          op: 'git_commit',
          seq: ctx.seq,
          path: args.path,
          oid: found.oid,
          message: found.commit.message,
        };
      },
    },
  };
}

export const TOOLS = makeTools();
