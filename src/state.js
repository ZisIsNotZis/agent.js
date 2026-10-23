// The workspace on disk. Everything here is read from OPFS, never from memory alone:
// the screen's claim about "the tree is still there" is a fresh read of the file.

const DIR = '.agentjs';
const FILE = 'tree.json';

export class NoOpfs extends Error {}

async function treeDir() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    throw new NoOpfs('this browser has no navigator.storage.getDirectory (OPFS)');
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export async function readState() {
  const dir = await treeDir();
  let fh;
  try {
    fh = await dir.getFileHandle(FILE);
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
  const text = await (await fh.getFile()).text();
  return { state: JSON.parse(text), bytes: text.length };
}

export async function writeState(state) {
  const dir = await treeDir();
  const fh = await dir.getFileHandle(FILE, { create: true });
  const w = await fh.createWritable();
  const text = JSON.stringify(state, null, 2);
  await w.write(text);
  await w.close();
  return text.length;
}

function fresh() {
  const now = new Date().toISOString();
  return {
    v: 1,
    created: now,
    boots: 0,
    lastSeen: null,
    nodes: [{ id: 'root', parent: null, status: 'idle' }],
    bootsLog: [],
  };
}

// One boot: read what is on disk, count it, write it back, then read it again.
// The value returned as `verified` is what a *second* read of the file says —
// that is the evidence the write landed, not the memory of having asked.
export async function boot() {
  const before = await readState();
  const state = before ? before.state : fresh();
  state.boots = (state.boots || 0) + 1;
  state.lastSeen = new Date().toISOString();
  state.bootsLog = (state.bootsLog || []).concat([{ n: state.boots, at: state.lastSeen }]).slice(-50);
  const bytesWritten = await writeState(state);
  const after = await readState();
  return {
    fresh: before === null,
    bootsOnDiskBeforeThisLoad: before ? before.state.boots : 0,
    state,
    verified: after && after.state,
    bytesWritten,
    bytesReadBack: after ? after.bytes : 0,
  };
}
