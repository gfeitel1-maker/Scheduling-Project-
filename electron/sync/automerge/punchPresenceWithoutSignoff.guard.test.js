// TIER-4 ENFORCEABLE BOUNDARY GUARD for the punch capability (T347, S1 of
// docs/adr/2026-10-08-relayless-cross-network-reconnect.md). Sibling to
// dcutrPresenceWithoutSignoff.guard.test.js, but with the opposite build posture: node-datachannel
// is PRESENT in the resolved tree while `punch.signoff` is null (the T327 signoff lands in S5), and
// the build must stay green. That is only safe if the package is provably unreachable at runtime
// except through one strictly-gated door. This file proves the door:
//
//   1. the registry row declares the presence as `inertPresence` (and signoff is still null);
//   2. syncStarter.js is the ONLY importer of punchTransport.js, and reaches it only behind
//      process.env.SHORESH_PUNCH_ENABLED === 'true' (exactly once, strict equality);
//   3. node-datachannel is named only by punchTransport.js, punchEnablement.js and the registry — transport.js,
//      syncNode.js and the rest of the sync/auth/main tree never touch it;
//   4. package.json pins it exactly.
//
// When S5 writes the signoff, the invariant flips to its second honest branch and these checks may
// be relaxed deliberately — not silently.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { forbiddenPackagesPresent, stripComments } from './internetRendezvousScan.js'
import { TRANSPORT_CAPABILITIES, ALL_FORBIDDEN_PACKAGES, forbiddenPackagesFor } from './transportCapabilities.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..')
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')

const GATE_RE = /process\.env\.SHORESH_PUNCH_ENABLED/g
const STRICT_GATE_RE = /process\.env\.SHORESH_PUNCH_ENABLED === 'true'/g

// Pure predicates, so the non-vacuity cases below can feed them planted sources.
export function gateIsStrict(source) {
  const code = stripComments(source)
  const all = code.match(GATE_RE) ?? []
  const strict = code.match(STRICT_GATE_RE) ?? []
  return all.length === 1 && strict.length === 1
}
export function importsPunchTransport(source) {
  return /['"]\.\/punchTransport\.js['"]/.test(stripComments(source))
}
// The dynamic import must sit INSIDE the block of the `if (punchRuntimeEligible(` gate, and be the only one.
export function importIsInsideGate(source) {
  const code = stripComments(source)
  const imports = [...code.matchAll(/import\(\s*['"]\.\/punchTransport\.js['"]\s*\)/g)]
  const gate = code.indexOf('if (punchRuntimeEligible(')
  if (imports.length !== 1 || gate < 0) return false
  let paren = 0
  let i0 = code.indexOf('(', gate)
  for (; i0 < code.length; i0++) {
    if (code[i0] === '(') paren++
    else if (code[i0] === ')' && --paren === 0) break
  }
  const open = code.indexOf('{', i0)
  let depth = 0
  let close = -1
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) { close = i; break }
  }
  return imports[0].index > open && imports[0].index < close
}
export function namesNativePackage(source) {
  return /['"]node-datachannel['"]/.test(stripComments(source))
}

function walkSources(dirs) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|jsx|mjs)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) out.push(relative(repoRoot, full))
    }
  }
  for (const d of dirs) walk(join(repoRoot, d))
  return out
}

describe('punch-present-without-signoff guard (T347)', () => {
  const lockfile = JSON.parse(read('package-lock.json'))
  const present = forbiddenPackagesPresent(lockfile.packages, ['node-datachannel'])

  it('non-vacuity precondition: node-datachannel IS in the resolved tree and punch.signoff IS still null', () => {
    expect(present).toEqual(['node-datachannel'])
    expect(TRANSPORT_CAPABILITIES.punch.signoff).toBeNull()
  })

  it('invariant: present => signed off, OR declared inertPresence with the gate proven below', () => {
    const row = TRANSPORT_CAPABILITIES.punch
    expect(row.packages).toEqual(['node-datachannel'])
    expect(present.length === 0 || row.signoff != null || row.inertPresence === true).toBe(true)
  })

  it('the tier-4 package scan tolerates the package ONLY because the row declares inertPresence', () => {
    expect(ALL_FORBIDDEN_PACKAGES()).not.toContain('node-datachannel')
    const withoutDeclaration = { punch: { ...TRANSPORT_CAPABILITIES.punch, inertPresence: false } }
    expect(forbiddenPackagesFor(withoutDeclaration)).toContain('node-datachannel')
    const signedOffInstead = { punch: { ...TRANSPORT_CAPABILITIES.punch, inertPresence: false, signoff: { date: 'x' } } }
    expect(forbiddenPackagesFor(signedOffInstead)).not.toContain('node-datachannel')
  })

  it('syncStarter.js gates on SHORESH_PUNCH_ENABLED exactly once, with strict equality to the string true', () => {
    expect(gateIsStrict(read('electron/sync/automerge/syncStarter.js'))).toBe(true)
  })

  it('the punchTransport.js import in syncStarter.js sits inside the punchRuntimeEligible gate block', () => {
    expect(importIsInsideGate(read('electron/sync/automerge/syncStarter.js'))).toBe(true)
  })

  it('inertPresence is declared on exactly the punch and portMapping rows (no other row may loosen the package scan)', () => {
    const declaring = Object.entries(TRANSPORT_CAPABILITIES).filter(([, c]) => c.inertPresence).map(([k]) => k)
    expect(declaring).toEqual(['punch', 'portMapping'])
  })

  it('only syncStarter.js imports punchTransport.js', () => {
    const importers = walkSources(['electron', 'src']).filter((f) => importsPunchTransport(readFileSync(join(repoRoot, f), 'utf8')))
    expect(importers).toEqual(['electron/sync/automerge/syncStarter.js'])
  })

  it('only punchTransport.js, punchEnablement.js and the capability registry name node-datachannel', () => {
    const namers = walkSources(['electron', 'src', 'scripts']).filter((f) => namesNativePackage(readFileSync(join(repoRoot, f), 'utf8')))
    expect(namers.sort()).toEqual([
      'electron/sync/automerge/punchEnablement.js',
      'electron/sync/automerge/punchTransport.js',
      'electron/sync/automerge/transportCapabilities.js',
    ])
  })

  it('package.json pins node-datachannel to an exact version', () => {
    const version = JSON.parse(read('package.json')).dependencies['node-datachannel']
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  describe('non-vacuity: planted defects the predicates above must catch', () => {
    it('a loose / coerced / duplicated gate is not strict', () => {
      expect(gateIsStrict(`if (process.env.SHORESH_PUNCH_ENABLED === 'true') {}`)).toBe(true)
      expect(gateIsStrict(`if (process.env.SHORESH_PUNCH_ENABLED) {}`)).toBe(false)
      expect(gateIsStrict(`if (Boolean(process.env.SHORESH_PUNCH_ENABLED)) {}`)).toBe(false)
      expect(gateIsStrict(`if (process.env.SHORESH_PUNCH_ENABLED == 'true') {}`)).toBe(false)
      expect(gateIsStrict(`if (process.env.SHORESH_PUNCH_ENABLED?.toLowerCase() === 'true') {}`)).toBe(false)
      expect(gateIsStrict(`a = process.env.SHORESH_PUNCH_ENABLED === 'true'\nb = process.env.SHORESH_PUNCH_ENABLED === 'true'`)).toBe(false)
      expect(gateIsStrict(`// process.env.SHORESH_PUNCH_ENABLED === 'true'\nconst x = 1`)).toBe(false)
    })

    it('a hoisted import (above the gate, or a second one) is detected', () => {
      const gated = `if (punchRuntimeEligible({})) {\n  m = await import('./punchTransport.js')\n}`
      expect(importIsInsideGate(gated)).toBe(true)
      expect(importIsInsideGate(`m = await import('./punchTransport.js')\n` + gated.replace(/m = await import\('\.\/punchTransport\.js'\)/, 'm = null'))).toBe(false)
      expect(importIsInsideGate(gated + `\nawait import('./punchTransport.js')`)).toBe(false)
      expect(importIsInsideGate(`if (other) {\n  await import('./punchTransport.js')\n}\nif (punchRuntimeEligible({})) {}`)).toBe(false)
    })

    it('a second importer of punchTransport.js or of node-datachannel is detected', () => {
      expect(importsPunchTransport(`import { punchTransport } from './punchTransport.js'`)).toBe(true)
      expect(importsPunchTransport(`await import("./punchTransport.js")`)).toBe(true)
      expect(importsPunchTransport(`import x from './transport.js'`)).toBe(false)
      expect(namesNativePackage(`import ndc from 'node-datachannel'`)).toBe(true)
      expect(namesNativePackage(`createRequire(import.meta.url)("node-datachannel")`)).toBe(true)
      expect(namesNativePackage(`// node-datachannel is mentioned only in prose\n`)).toBe(false)
    })
  })
})
