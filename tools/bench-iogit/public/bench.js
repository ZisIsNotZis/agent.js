import { makeOpfsFs } from './opfs-fs.js'
import { git } from './vendor/isomorphic-git.min.js'

const now = () => performance.now()

function mem() {
  const m = performance.memory
  return m
    ? { usedMB: +(m.usedJSHeapSize / 1048576).toFixed(1), totalMB: +(m.totalJSHeapSize / 1048576).toFixed(1) }
    : null
}

const CHUNK = 1400 // ~1.4 KB per file: task asked for ~1-2 KB average

function filetext(i) {
  const seed = `// file ${i} — bench fixture\n`
  let body = seed
  let k = 0
  while (body.length < CHUNK) {
    body += `export const v${k++} = ${i * 31 + k}; // ${'x'.repeat(48)}\n`
  }
  return body.slice(0, CHUNK)
}

// 10 files per directory: src/d<dirIdx>/f<i>.txt
function pathFor(i) {
  return `src/d${Math.floor(i / 10)}/f${i}.txt`
}

function withTimeout(promise, ms, label) {
  if (!ms) return promise
  let t
  return Promise.race([
    promise,
    new Promise(res => {
      t = setTimeout(() => res({ __timeout: true, label }), ms)
    }),
  ]).finally(() => clearTimeout(t))
}

async function estimate() {
  try {
    const e = await navigator.storage.estimate()
    return { usageMB: +(e.usage / 1048576).toFixed(2), quotaMB: +(e.quota / 1048576).toFixed(0) }
  } catch {
    return null
  }
}

async function wipe() {
  const root = await navigator.storage.getDirectory()
  try {
    await root.removeEntry('bench', { recursive: true })
  } catch {}
}

// One timed run. Returns every number plus which phases timed out.
export async function run({ files, phaseTimeoutMs = 600000, label = '' } = {}) {
  const R = { label, files, phases: {}, timedOut: [], meta: {} }
  const t = async (name, fn, timeoutMs = phaseTimeoutMs) => {
    const s = now()
    let v
    try {
      v = await withTimeout(Promise.resolve().then(fn), timeoutMs, name)
    } catch (e) {
      R.phases[name] = { ms: +(now() - s).toFixed(1), error: String(e && e.message || e) }
      R.timedOut.push(name + ':error')
      throw e
    }
    const ms = +(now() - s).toFixed(1)
    if (v && v.__timeout) {
      R.phases[name] = { ms, partial: true, limitMs: timeoutMs }
      R.timedOut.push(name)
      return undefined
    }
    R.phases[name] = { ms }
    return v
  }

  R.meta.estimateBefore = await estimate()
  R.meta.memBefore = mem()

  await t('wipe', wipe)

  const fs = await t('opfsAdapter', async () => {
    const f = await makeOpfsFs('bench')
    // verify the stat shape the task says must be verified, not assumed
    const probePath = '/shape-probe/a.txt'
    await f.promises.mkdir('/shape-probe')
    await f.promises.writeFile(probePath, 'hello')
    const st = await f.promises.lstat(probePath)
    const ds = await f.promises.stat('/shape-probe')
    R.meta.statShape = {
      file: { type: st.type, mode: '0o' + st.mode.toString(8), size: st.size, mtimeMs: st.mtimeMs },
      dir: { type: ds.type, mode: '0o' + ds.mode.toString(8), size: ds.size },
      readdir: await f.promises.readdir('/shape-probe'),
      readFile: new TextDecoder().decode(await f.promises.readFile(probePath)),
    }
    await f.promises.unlink(probePath)
    await f.promises.rmdir('/shape-probe')
    return f
  })
  if (!fs) return R

  const dir = '/'
  const cache = {}

  await t('init', () => git.init({ fs, dir, defaultBranch: 'main' }))

  // ---- generate ----
  const paths = Array.from({ length: files }, (_, i) => pathFor(i))
  const madeDirs = new Set()
  await t('gen', async () => {
    for (let i = 0; i < files; i++) {
      const d = 'src/d' + Math.floor(i / 10)
      if (!madeDirs.has(d)) {
        madeDirs.add(d)
        await fs.promises.mkdir('/' + d)
      }
      await fs.promises.writeFile('/' + paths[i], filetext(i))
    }
  })
  R.meta.statsAfterGen = mem()

  // ---- add + commit ----
  await t('add', () => git.add({ fs, dir, filepath: paths, cache }))
  await t('commit', () =>
    git.commit({
      fs, dir, cache,
      message: `add ${files} files`,
      author: { name: 'bench', email: 'bench@example.invalid' },
    })
  )
  R.meta.statsAfterCommit = mem()

  // ---- status (must be clean) ----
  const matrix = await t('status', () => git.statusMatrix({ fs, dir, cache }))
  if (matrix) {
    let dirty = 0
    for (const [, head, workdir, stage] of matrix) {
      if (!(head === 1 && workdir === 1 && stage === 1)) dirty++
    }
    R.meta.statusRows = matrix.length
    R.meta.statusDirty = dirty
  }

  // ---- log ----
  const log = await t('log', () => git.log({ fs, dir, depth: Infinity, cache }))
  if (log) R.meta.logEntries = log.length

  // ---- second commit, one file: the per-step cost M4 pays ----
  const victim = paths[Math.floor(files / 2)]
  R.meta.secondCommitPath = victim
  await t('second.write', () => fs.promises.writeFile('/' + victim, filetext(files + 1)))
  await t('second.add', () => git.add({ fs, dir, filepath: victim, cache }))
  await t('second.commit', () =>
    git.commit({
      fs, dir, cache,
      message: 'touch one file',
      author: { name: 'bench', email: 'bench@example.invalid' },
    })
  )
  R.meta.statsAfterSecond = mem()

  // read the index cost back: one more status proves the tree is still readable
  await t('status.after2', async () => {
    const m2 = await git.statusMatrix({ fs, dir, cache })
    let dirty = 0
    for (const [, head, workdir, stage] of m2) if (!(head === 1 && workdir === 1 && stage === 1)) dirty++
    R.meta.statusDirtyAfter2 = dirty
    R.meta.statusRowsAfter2 = m2.length
  })

  R.meta.estimateAfter = await estimate()
  R.meta.memAfter = mem()
  R.meta.bundle = performance.getEntriesByType('resource')
    .filter(e => e.name.includes('/vendor/'))
    .map(e => ({
      name: e.name.split('/').pop(),
      transferBytes: e.transferSize,
      encodedBytes: e.encodedBodySize,
      decodedBytes: e.decodedBodySize,
      durationMs: +e.duration.toFixed(1),
    }))
  R.meta.bufferShim = typeof Buffer !== 'undefined'
  R.meta.processShim = typeof process !== 'undefined'
  R.ok = true
  return R
}

window.BENCH = { run, git }
