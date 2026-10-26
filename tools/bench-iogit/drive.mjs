import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = '/home/z/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell'
const URL0 = 'http://127.0.0.1:8140/'

const files = Number(process.argv[2] || 20)
const phaseTimeoutMs = Number(process.argv[3] || 600000)
const outfile = process.argv[4] || `raw-${files}.json`

async function launch(profileDir) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 800, height: 600 },
    args: ['--no-sandbox', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  })
  const page = await ctx.newPage()
  page.on('console', m => console.log(`  [page:${m.type()}] ${m.text()}`))
  page.on('pageerror', e => console.log('  [pageerror] ' + e.message))
  await page.goto(URL0, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__ready === true || window.__bootError, null, { timeout: 30000 })
  const bootErr = await page.evaluate(() => window.__bootError || null)
  if (bootErr) throw new Error('boot failed: ' + bootErr)
  return { ctx, page }
}

async function oneRun(page, label) {
  const t0 = Date.now()
  const r = await page.evaluate(
    ([n, t]) => window.BENCH.run({ files: n, phaseTimeoutMs: t, label: '' }),
    [files, phaseTimeoutMs]
  )
  r.wallMs = Date.now() - t0
  r.label = label
  console.log(`  ${label}: wall ${(r.wallMs / 1000).toFixed(1)}s ` +
    Object.entries(r.phases).map(([k, v]) => `${k}=${v.ms}${v.partial ? '(partial)' : ''}${v.error ? '(ERR:' + v.error + ')' : ''}`).join(' '))
  return r
}

const results = []

// cold #1: brand-new profile
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `prof-c1-${files}-`))
  const { ctx, page } = await launch(dir)
  results.push(await oneRun(page, 'cold1'))
  await ctx.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

// cold #2 + warm in the same profile
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `prof-c2-${files}-`))
  const { ctx, page } = await launch(dir)
  results.push(await oneRun(page, 'cold2'))
  results.push(await oneRun(page, 'warm'))
  await ctx.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

fs.writeFileSync(outfile, JSON.stringify({ files, results }, null, 2))
console.log('wrote ' + outfile)
