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

import { opfsFs } from './fs.js';

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
