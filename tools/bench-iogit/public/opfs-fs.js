// OPFS -> isomorphic-git fs adapter, hand-rolled (shadow-claw's makeOpfsFs was
// not retrievable: the only public repos of that name are unrelated Electron
// projects, and grep.app's code search sits behind a bot checkpoint).
//
// Deliberate choices, because they change the numbers:
//  * no handle cache: every call walks from the OPFS root. Upper bound.
//  * stat/lstat return {type, mode, mtimeMs, ctimeMs, size, ino, uid, gid,
//    dev} -- isomorphic-git's compareStats() reads mtimeSeconds, ctimeSeconds,
//    uid, gid, ino, size and mode, and silently re-hashes (or misreports)
//    without them.
//  * ENOENT/ENOTDIR errors carry .code so isNotFoundError() sees them.

const FILE_MODE = 0o100644
const DIR_MODE = 0o040000

function err(code, path, syscall) {
  const e = new Error(`${code}: ${syscall} '${path}'`)
  e.code = code
  return e
}

const parts = p => String(p).replace(/\\/g, '/').split('/').filter(s => s && s !== '.')

export async function makeOpfsFs(rootName = 'bench') {
  const root = await navigator.storage.getDirectory()
  const base = await root.getDirectoryHandle(rootName, { create: true })

  async function dirOf(path, { create = false, syscall = 'stat' } = {}) {
    const segs = parts(path)
    let dir = base
    for (const s of segs) {
      try {
        dir = await dir.getDirectoryHandle(s, { create })
      } catch (e) {
        if (create) throw e
        // exists as a file, or missing
        throw err(e.name === 'TypeMismatchError' ? 'ENOTDIR' : 'ENOENT', path, syscall)
      }
    }
    return dir
  }

  async function split(path) {
    const segs = parts(path)
    if (!segs.length) throw err('EINVAL', path, 'resolve')
    const parent = await dirOf(segs.slice(0, -1).join('/'), { syscall: 'stat' })
    return { parent, name: segs[segs.length - 1] }
  }

  async function resolve(path) {
    const { parent, name } = await split(path)
    try {
      const h = await parent.getFileHandle(name)
      return { kind: 'file', handle: h }
    } catch {}
    try {
      const h = await parent.getDirectoryHandle(name)
      return { kind: 'dir', handle: h }
    } catch {}
    throw err('ENOENT', path, 'stat')
  }

  function fileStats(file, path) {
    return {
      type: 'file',
      mode: FILE_MODE,
      size: file.size,
      mtimeMs: file.lastModified,
      ctimeMs: file.lastModified,
      mtime: new Date(file.lastModified),
      ctime: new Date(file.lastModified),
      // A browser File exposes no inode; a constant keeps
      // compareStats'(ino) term equal on both sides instead of NaN.
      ino: 1,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }
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
    }
  }

  const asBytes = d => (typeof d === 'string' ? new TextEncoder().encode(d) : d)

  const promises = {
    async readFile(path, options) {
      let r
      try {
        r = await resolve(path)
      } catch (e) {
        throw e
      }
      if (r.kind === 'dir') throw err('EISDIR', path, 'read')
      const file = await r.handle.getFile()
      // node's contract: { encoding } (or a string encoding) yields a string.
      // isomorphic-git's GitConfigManager.get() depends on this.
      const enc = typeof options === 'string' ? options : options && options.encoding
      if (enc) return file.text()
      return new Uint8Array(await file.arrayBuffer())
    },

    async writeFile(path, data) {
      const segs = parts(path)
      // create missing parents, like node would not -- but isomorphic-git's
      // FileSystem.write() retries after mkdir, so a plain ENOENT is fine.
      const parent = await dirOf(segs.slice(0, -1).join('/'), { syscall: 'write' })
      const name = segs[segs.length - 1]
      let fh
      try {
        fh = await parent.getFileHandle(name)
      } catch (e) {
        if (e.name !== 'NotFoundError') throw e
        fh = await parent.getFileHandle(name, { create: true })
      }
      const w = await fh.createWritable()
      try {
        await w.write(asBytes(data))
        await w.close()
      } catch (e) {
        try { await w.abort() } catch {}
        throw e
      }
    },

    async unlink(path) {
      const { parent, name } = await split(path)
      try {
        await parent.removeEntry(name)
      } catch (e) {
        throw err(e.name === 'NotFoundError' ? 'ENOENT' : 'EIO', path, 'unlink')
      }
    },

    async readdir(path) {
      const dir = await dirOf(path, { syscall: 'readdir' })
      const names = []
      for await (const key of dir.keys()) names.push(key)
      return names
    },

    async mkdir(path) {
      const segs = parts(path)
      if (!segs.length) return
      await dirOf(path, { create: true, syscall: 'mkdir' })
    },

    async rmdir(path, options = {}) {
      const { parent, name } = await split(path)
      try {
        await parent.removeEntry(name, { recursive: !!options.recursive })
      } catch (e) {
        // node's rmdir on a non-empty dir is ENOTEMPTY; OPFS says InvalidModificationError
        if (e.name === 'InvalidModificationError') throw err('ENOTEMPTY', path, 'rmdir')
        throw err(e.name === 'NotFoundError' ? 'ENOENT' : 'EIO', path, 'rmdir')
      }
    },

    async stat(path) {
      if (!parts(path).length) return dirStats()
      const r = await resolve(path)
      if (r.kind === 'dir') return dirStats()
      return fileStats(await r.handle.getFile(), path)
    },

    async lstat(path) {
      return promises.stat(path) // no symlinks in OPFS
    },

    // isomorphic-git's bindFs() unconditionally binds every command in its
    // list, so readlink/symlink must exist even though OPFS has neither.
    async readlink(path) {
      throw err('EINVAL', path, 'readlink')
    },

    async symlink() {
      throw err('ENOSYS', '', 'symlink')
    },

    async rename(from, to) {
      const r = await resolve(from)
      const { parent, name } = await split(to)
      const src = r.kind === 'file' ? await r.handle.getFile() : null
      if (r.kind === 'file') {
        const dst = await parent.getFileHandle(name, { create: true })
        const w = await dst.createWritable()
        await w.write(new Uint8Array(await src.arrayBuffer()))
        await w.close()
      } else {
        // OPFS has no recursive copy primitive; not on isomorphic-git's path
        throw err('ENOSYS', from, 'rename')
      }
      await promises.unlink(from)
    },
  }

  return { promises }
}
