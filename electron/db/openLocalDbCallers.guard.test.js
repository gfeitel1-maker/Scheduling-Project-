// @vitest-environment node
//
// CHOKE-POINT GUARD (T175; docs/adr/2026-10-08-director-authorized-tool-connections.md).
// With at-rest encryption default ON, every non-test caller of openLocalDb must be ONE of:
//   (a) KEYED  — passes `key` (in-app: acquireDbKey; headless: the key the authorized unlock path released),
//   (b) PINNED OFF — a throwaway-DB script that pins SHORESH_AT_REST_ENCRYPTION=off before localDb loads
//       (a first-import `pinAtRestOff.js`, or a package.json script that sets the env for that file),
//   (c) `plaintext: true` (test harness only; the existing gate keeps that under test/).
// A fourth, unclassified caller would die at runtime with the opaque db_key_unavailable on a default-ON
// device, or worse be added keyless by someone who assumed plaintext. The second half of the file guards
// that the key can only leave the keychain through the authorization checkpoint.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCAN_DIRS = ['scripts', 'electron', 'test/integration']
const SKIP_DIRS = new Set(['node_modules', '.git', 'legacy'])
// Defined/consumed only by vitest, whose setup pins plaintext (vitest.setup.js); not a runtime caller.
const NOT_RUNTIME_CALLERS = new Set(['electron/db/localDb.js', 'electron/db/testDbTemplate.js'])
const PIN_IMPORT = /^import\s+['"][^'"]*pinAtRestOff\.js['"]/m

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) walk(rel, out)
    else if (/\.(js|mjs|cjs|jsx)$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name)) out.push(rel)
  }
  return out
}

export function nonTestSources() {
  return SCAN_DIRS.flatMap((d) => walk(d)).filter((f) => !f.endsWith('openLocalDbCallers.guard.test.js'))
}

function callArgs(src, openParen) {
  let depth = 0
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(openParen + 1, i)
  }
  return ''
}

export function findCalls(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const calls = []
  const re = /\bopenLocalDb\s*\(/g
  let m
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const prefix = src.slice(lineStart, m.index)
    if (/^\s*(\/\/|\*)/.test(prefix) || /function\s*$/.test(prefix) || /^\s*import\b/.test(prefix)) continue
    calls.push(callArgs(src, m.index + m[0].length - 1))
  }
  return { src, calls }
}

function packageJsonPins() {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts
  return Object.values(scripts).filter((c) => /SHORESH_AT_REST_ENCRYPTION=off/.test(c))
}

export function classify(file) {
  const { src, calls } = findCalls(file)
  if (calls.length === 0 || NOT_RUNTIME_CALLERS.has(file)) return null
  const pinned = PIN_IMPORT.test(src) || packageJsonPins().some((c) => c.includes(file))
  const unclassified = calls.filter((a) => !/\bkey\b/.test(a) && !/plaintext:\s*true/.test(a) && !pinned)
  return { file, calls: calls.length, unclassified: unclassified.length, pinned }
}

describe('every non-test openLocalDb caller is keyed or off-pinned', () => {
  const callers = nonTestSources().map(classify).filter(Boolean)

  it('finds the known callers (the scan is not vacuous)', () => {
    const files = callers.map((c) => c.file)
    for (const f of ['electron/main.js', 'scripts/mcp/tools.js', 'scripts/ingestCli.js', 'scripts/ingest-sweep.mjs',
      'scripts/preferenceCorpusProbe.mjs', 'scripts/fixtures/make-era-fixtures.mjs',
      'scripts/fixtures/electiveAcceptanceCamp.mjs', 'test/integration/harnessAutomerge.js']) {
      expect(files).toContain(f)
    }
  })

  it('no caller is neither keyed nor pinned', () => {
    const bad = callers.filter((c) => c.unclassified > 0).map((c) => `${c.file} (${c.unclassified} unclassified call(s))`)
    expect(bad).toEqual([])
  })

  it('a pin import must be the FIRST import, or it loads after localDb has already read the env', () => {
    for (const { file } of callers) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
      if (!PIN_IMPORT.test(src)) continue
      const firstImport = src.match(/^import\s.*$/m)[0]
      expect(firstImport, file).toMatch(/pinAtRestOff\.js/)
    }
  })

  it('non-vacuity: the classifier flags an unkeyed, unpinned caller', () => {
    const tmp = 'scripts/__guardProbe.mjs'
    fs.writeFileSync(path.join(ROOT, tmp), "import { openLocalDb } from '../electron/db/localDb.js'\nopenLocalDb('/x')\n")
    try {
      expect(classify(tmp).unclassified).toBe(1)
      fs.writeFileSync(path.join(ROOT, tmp), "import './pinAtRestOff.js'\nimport { openLocalDb } from '../electron/db/localDb.js'\nopenLocalDb('/x')\n")
      expect(classify(tmp).unclassified).toBe(0)
      fs.writeFileSync(path.join(ROOT, tmp), "import { openLocalDb } from '../electron/db/localDb.js'\nopenLocalDb('/x', { key })\n")
      expect(classify(tmp).unclassified).toBe(0)
    } finally {
      fs.rmSync(path.join(ROOT, tmp))
    }
  })
})

describe('headless entry points get their key only through the authorized path', () => {
  const sources = nonTestSources()
  it('no script reads the raw key env directly; entry points use resolveAuthorizedHeadlessDbKey', () => {
    const raw = sources.filter((f) => f !== 'electron/db/headlessDbKey.js' && /\bresolveHeadlessDbKey\s*\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    expect(raw).toEqual([])
    for (const f of ['scripts/mcp/server.js', 'scripts/ingest.js', 'scripts/electives.js']) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).toMatch(/resolveAuthorizedHeadlessDbKey\s*\(/)
    }
  })
})

describe('key release cannot bypass the authorization checkpoint', () => {
  const sources = nonTestSources()
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

  it('getOrCreateDbKey / acquireDbKey / acquireDocCipher are called only by the in-app key path and the unlock helper', () => {
    const allowed = new Set(['electron/db/dbEncryptionKey.js', 'electron/db/atRestEncryption.js', 'electron/main.js', 'electron/unlockDbKey.js'])
    const offenders = sources.filter((f) => !allowed.has(f) && /\b(getOrCreateDbKey|acquireDbKey|acquireDocCipher)\s*\(/.test(read(f)))
    expect(offenders).toEqual([])
  })

  it('only the unlock helper puts the key into a child environment', () => {
    const offenders = sources.filter((f) => f !== 'electron/unlockDbKey.js' && /SHORESH_DB_KEY\s*[:=]/.test(read(f).replace(/\/\/.*$/gm, '')))
    expect(offenders).toEqual([])
  })

  it('the unlock helper unseals the key only inside releaseKeyToTool, after the checkpoint', () => {
    const src = read('electron/unlockDbKey.js').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/\bgetOrCreateDbKey\s*\(/)
    const body = src.slice(src.indexOf('export function releaseKeyToTool'))
    const check = body.indexOf('checkToolAuthorization(')
    const unseal = body.indexOf('getKey(')
    expect(check).toBeGreaterThan(-1)
    expect(unseal).toBeGreaterThan(check)
    const glue = src.slice(src.indexOf('invokedDirectly'))
    expect(glue).toMatch(/releaseKeyToTool\(/)
    expect(glue).not.toMatch(/safeStorage\)\.toString/)
  })
})
