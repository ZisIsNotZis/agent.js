// The workspace filesystem, and the one place OPFS is spelled.
//
// Every adapter provides the same small async interface (settled-leaf 2):
//
//   read(path)            -> Uint8Array
//   write(path, data)     -> void            data: string | Uint8Array
//   ls(path)              -> [{name, type}]  type: 'file' | 'dir'
//   stat(path)            -> {type, mode, size, mtimeMs, …}
//   mv(from, to)          -> void
//   rm(path, {recursive}) -> void
//
// plus `.promises`, the node-shaped subset isomorphic-git binds:
// readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, lstat, rename
// (and readlink/symlink, which bindFs() asks for even on a filesystem with no
// symlinks — the bench proved their absence breaks every command).
//
// `stat`/`lstat` return {type:'file'|'dir', mode, size, mtimeMs} and the extra
// fields isomorphic-git's compareStats() reads; that exact shape is what made
// git behave in tools/bench-iogit (0 dirty rows in all six runs), so it is
// copied rather than narrowed.
//
// Everything above this file — tools, git, the log — is written against this
// interface. A node or in-memory adapter slots in here without touching them.

export const FILE_MODE = 0o100644;
export const DIR_MODE = 0o040000;

// The workspace directory inside OPFS. It is the git repository root; the
// log's cache (`.agentjs/`) sits beside it, not inside it.
export const ROOT = 'workspace';

function err(code, path, syscall) {
  const e = new Error(`${code}: ${syscall} '${path}'`);
  e.code = code;
  return e;
}

const parts = (p) => String(p).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');

// OPFS adapter. `rootName` is the directory under navigator.storage.getDirectory()
// that acts as this adapter's '/'.
export async function opfsFs(rootName = ROOT) {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    throw new Error('this browser has no navigator.storage.getDirectory (OPFS)');
  }
  const opfs = await navigator.storage.getDirectory();
  const base = await opfs.getDirectoryHandle(rootName, { create: true });

  async function dirOf(path, { create = false, syscall = 'stat' } = {}) {
    const segs = parts(path);
    let dir = base;
    for (const s of segs) {
      try {
        dir = await dir.getDirectoryHandle(s, { create });
      } catch (e) {
        if (create) throw e;
        throw err(e.name === 'TypeMismatchError' ? 'ENOTDIR' : 'ENOENT', path, syscall);
      }
    }
    return dir;
  }

  async function split(path) {
    const segs = parts(path);
    if (!segs.length) throw err('EINVAL', path, 'resolve');
    const parent = await dirOf(segs.slice(0, -1).join('/'), { syscall: 'stat' });
    return { parent, name: segs[segs.length - 1] };
  }

  async function resolve(path) {
    const { parent, name } = await split(path);
    try {
      return { kind: 'file', handle: await parent.getFileHandle(name) };
    } catch { /* not a file */ }
    try {
      return { kind: 'dir', handle: await parent.getDirectoryHandle(name) };
    } catch { /* not a dir either */ }
    throw err('ENOENT', path, 'stat');
  }

  function fileStats(file) {
    return {
      type: 'file',
      mode: FILE_MODE,
      size: file.size,
      mtimeMs: file.lastModified,
      ctimeMs: file.lastModified,
      mtime: new Date(file.lastModified),
      ctime: new Date(file.lastModified),
      // A browser File exposes no inode; a constant keeps compareStats'(ino)
      // term equal on both sides instead of NaN.
      ino: 1,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    };
  }

  function dirStats() {
    return {
      type: 'dir',
      mode: DIR_MODE,
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      mtime: new Date(0),
      ctime: new Date(0),
      ino: 1,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    };
  }

  const asBytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

  // ---- the small interface -------------------------------------------------

  async function read(path) {
    let r;
    try {
      r = await resolve(path);
    } catch (e) {
      throw e.code ? e : err('ENOENT', path, 'read');
    }
    if (r.kind === 'dir') throw err('EISDIR', path, 'read');
    const file = await r.handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async function write(path, data) {
    const segs = parts(path);
    // The high-level write creates missing parents; a node adapter may differ,
    // so git's own ENOENT-then-mkdir retry stays valid either way.
    const parent = await dirOf(segs.slice(0, -1).join('/'), { create: true, syscall: 'write' });
    const name = segs[segs.length - 1];
    let fh;
    try {
      fh = await parent.getFileHandle(name);
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
      fh = await parent.getFileHandle(name, { create: true });
    }
    const w = await fh.createWritable();
    try {
      await w.write(asBytes(data));
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch { /* already gone */ }
      throw e;
    }
  }

  async function ls(path) {
    const dir = await dirOf(path, { syscall: 'readdir' });
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      out.push({ name, type: handle.kind === 'directory' ? 'dir' : 'file' });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async function stat(path) {
    if (!parts(path).length) return dirStats();
    const r = await resolve(path);
    if (r.kind === 'dir') return dirStats();
    return fileStats(await r.handle.getFile());
  }

  async function mv(from, to) {
    const r = await resolve(from);
    if (r.kind !== 'file') throw err('ENOSYS', from, 'rename');
    const { parent, name } = await split(to);
    const src = await r.handle.getFile();
    const dst = await parent.getFileHandle(name, { create: true });
    const w = await dst.createWritable();
    await w.write(new Uint8Array(await src.arrayBuffer()));
    await w.close();
    await remove(from);
  }

  async function remove(path, options = {}) {
    const { parent, name } = await split(path);
    try {
      await parent.removeEntry(name, { recursive: !!options.recursive });
    } catch (e) {
      if (e.name === 'InvalidModificationError') throw err('ENOTEMPTY', path, 'rmdir');
      throw err(e.name === 'NotFoundError' ? 'ENOENT' : 'EIO', path, 'unlink');
    }
  }

  // ---- the node-shaped subset isomorphic-git binds -------------------------

  const promises = {
    async readFile(path, options) {
      const bytes = await read(path);
      const enc = typeof options === 'string' ? options : options && options.encoding;
      // node's contract: {encoding} (or a string encoding) yields a string.
      // isomorphic-git's GitConfigManager.get() depends on this.
      return enc ? new TextDecoder().decode(bytes) : bytes;
    },

    async writeFile(path, data) {
      await write(path, asBytes(data));
    },

    unlink: remove,

    async readdir(path) {
      return (await ls(path)).map((e) => e.name);
    },

    async mkdir(path) {
      if (!parts(path).length) return;
      await dirOf(path, { create: true, syscall: 'mkdir' });
    },

    async rmdir(path, options = {}) {
      await remove(path, { recursive: !!options?.recursive });
    },

    stat,
    lstat: stat, // no symlinks in OPFS

    // bindFs() binds every command in its list unconditionally, so these must
    // exist even though OPFS has neither.
    async readlink(path) {
      throw err('EINVAL', path, 'readlink');
    },
    async symlink() {
      throw err('ENOSYS', '', 'symlink');
    },

    async rename(from, to) {
      await mv(from, to);
    },
  };

  return { read, write, ls, stat, mv, rm: remove, promises };
}
