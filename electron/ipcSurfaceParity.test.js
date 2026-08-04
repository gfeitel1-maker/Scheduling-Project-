// @vitest-environment node
//
// Phase B — IPC surface parity. Guards two independent bug classes:
//
//   1. A preload channel (electron/preload.js) with no localClient.js wrapper,
//      or a localClient method with no mock implementation in
//      localClient.mock.js — either gap means a screen calling that method
//      breaks in `npm run dev` (no wrapper) or silently no-ops there (no
//      mock), while working fine under electron:dev. Sidebar.jsx bypassing
//      localClient for getCurrentProject/backupProject was exactly this.
//   2. MOCK_WRITE_ALLOWLIST (src/localClient.mock.js) drifting from
//      PROJECTIONS (electron/ops/projections.js) — it is a hand-maintained
//      independent copy (src/ must never import electron/), so nothing else
//      keeps them in sync.
//
// Lives in electron/ (never bundled) because it is the one place allowed to
// read both src/ and electron/. Kept as its own file, separate from
// projectionsCoverage.test.js, so Phase B is one self-contained,
// independently revertible unit (Governor ruling).
//
// Three independent static scanners (fs.readFileSync + regex), one per file,
// because each file's object-literal style differs: preload.js and
// localClient.js use `key: value` (colon) form throughout; localClient.mock.js
// uses ES method-shorthand (`name(...) {` / `async name(...) {`) throughout.
//
// ANTI-VACUITY: a regex scanner's worst failure mode is silently matching
// nothing while staying green. The floor assertions below exist purely to
// make total/near-total scanner breakage loud; the canary assertions catch a
// single extraction pattern regressing while the aggregate counts still look
// fine. Do not weaken either to make a refactor easier — fix the scanner.
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECTIONS } from './ops/projections.js'
import { MOCK_WRITE_ALLOWLIST } from '../src/localClient.mock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')

const PRELOAD_FILE = path.join(REPO_ROOT, 'electron', 'preload.js')
const LOCAL_CLIENT_FILE = path.join(REPO_ROOT, 'src', 'localClient.js')
const MOCK_FILE = path.join(REPO_ROOT, 'src', 'localClient.mock.js')

// ---------------------------------------------------------------------------
// Bracket-balanced block extraction — finds the object literal opened right
// after `afterText` in `text` and returns its inner content.
// ---------------------------------------------------------------------------
function extractBlock(text, afterText) {
  const anchorIdx = text.indexOf(afterText)
  if (anchorIdx === -1) throw new Error(`extractBlock: anchor '${afterText}' not found`)
  const openIdx = text.indexOf('{', anchorIdx + afterText.length - 1)
  if (openIdx === -1) throw new Error(`extractBlock: no '{' found after anchor '${afterText}'`)
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    // Comments can contain apostrophes (e.g. "onOpApplied's") that would
    // otherwise be misread as string delimiters and desync the brace count.
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i === -1) break
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(openIdx + 1, i)
    }
  }
  throw new Error(`extractBlock: unbalanced braces after anchor '${afterText}'`)
}

// preload.js / localClient.js: `  keyName: ...` (colon form), top-level only
// (2-space indent — nested object literals like an event-wrapper body are
// indented further and must not match).
function extractColonKeys(block) {
  const keys = []
  for (const m of block.matchAll(/^ {2}(\w+):/gm)) keys.push(m[1])
  return keys
}

// localClient.mock.js: ES method shorthand, `  name(...) {` or
// `  async name(...) {`, top-level only (2-space indent).
function extractMethodShorthandKeys(block) {
  const keys = []
  for (const m of block.matchAll(/^ {2}(?:async\s+)?(\w+)\s*\(/gm)) keys.push(m[1])
  return keys
}

let preloadKeys, localClientKeys, mockKeys

beforeAll(() => {
  const preloadText = fs.readFileSync(PRELOAD_FILE, 'utf8')
  const preloadBlock = extractBlock(preloadText, "contextBridge.exposeInMainWorld('shoresh', {")
  preloadKeys = extractColonKeys(preloadBlock)

  const localClientText = fs.readFileSync(LOCAL_CLIENT_FILE, 'utf8')
  const localClientBlock = extractBlock(localClientText, 'export const localClient = {')
  localClientKeys = extractColonKeys(localClientBlock)

  const mockText = fs.readFileSync(MOCK_FILE, 'utf8')
  const mockBlock = extractBlock(mockText, 'export const mockShoresh = {')
  mockKeys = extractMethodShorthandKeys(mockBlock)
})

// ---------------------------------------------------------------------------
// Anti-vacuity floors and canaries
// ---------------------------------------------------------------------------
describe('scanner anti-vacuity floors', () => {
  it('preload.js: found at least a floor number of channels', () => {
    // Observed: 46 keys. Floor set to 30 — comfortably below observed, well
    // above "the scanner matched almost nothing".
    expect(preloadKeys.length).toBeGreaterThanOrEqual(30)
  })

  it('localClient.js: found at least a floor number of methods', () => {
    // Observed: 47 keys. Floor set to 30, same margin logic.
    expect(localClientKeys.length).toBeGreaterThanOrEqual(30)
  })

  it('localClient.mock.js: found at least a floor number of methods', () => {
    // Observed: 49 keys (including the 6 test/dev-only trigger helpers).
    // Floor set to 30, same margin logic.
    expect(mockKeys.length).toBeGreaterThanOrEqual(30)
  })

  it('preload.js canaries: write (colon+arrow) and onOpApplied', () => {
    expect(preloadKeys, 'expected preload.js scanner to find write').toContain('write')
    expect(preloadKeys, 'expected preload.js scanner to find onOpApplied').toContain('onOpApplied')
  })

  it('localClient.js canary: bulkReplace', () => {
    expect(localClientKeys, 'expected localClient.js scanner to find bulkReplace').toContain('bulkReplace')
  })

  it('localClient.mock.js canaries: write (async shorthand) and onPairingRequest (plain shorthand)', () => {
    expect(mockKeys, 'expected localClient.mock.js scanner to find write').toContain('write')
    expect(mockKeys, 'expected localClient.mock.js scanner to find onPairingRequest').toContain('onPairingRequest')
  })
})

// ---------------------------------------------------------------------------
// MOCK_ONLY_HELPERS — explicit name list (NOT an `_`-prefix convention: a
// naming convention is an escape hatch that lets real drift be laundered by
// renaming a method to start with `_`). Each of these exists on mockShoresh
// only to let a dev/test session synthesize an event manually — none is a
// real wrapper target in localClient.js.
// ---------------------------------------------------------------------------
const MOCK_ONLY_HELPERS = [
  '_triggerOpApplied',
  '_triggerOpConflict',
  '_triggerPairingRequest',
  '_triggerPairingApproved',
  '_triggerPairingDenied',
  '_triggerTokenRenewed',
]

// ---------------------------------------------------------------------------
// Assertion set 1: preload <-> localClient <-> mock parity
// ---------------------------------------------------------------------------
describe('IPC surface parity', () => {
  it('every preload channel has a localClient wrapper', () => {
    const missing = preloadKeys.filter((k) => !localClientKeys.includes(k))
    expect(
      missing,
      `Preload channel(s) [${missing.join(', ')}] have no localClient.js wrapper — a caller reaching window.shoresh.<name> directly bypasses the browser-dev mock fallback and breaks under 'npm run dev'. Add a wrapper in src/localClient.js.`
    ).toEqual([])
  })

  it('every localClient method has a mock implementation', () => {
    const missing = localClientKeys.filter((k) => !mockKeys.includes(k))
    expect(
      missing,
      `localClient method(s) [${missing.join(', ')}] have no mockShoresh implementation in src/localClient.mock.js — calling them under 'npm run dev' throws (shoresh.<name> is not a function). Add a mock implementation.`
    ).toEqual([])
  })

  it('every mock method is a real wrapper target or a hardcoded MOCK_ONLY_HELPERS entry', () => {
    const unexplained = mockKeys.filter(
      (k) => !localClientKeys.includes(k) && !MOCK_ONLY_HELPERS.includes(k)
    )
    expect(
      unexplained,
      `mockShoresh method(s) [${unexplained.join(', ')}] correspond to no localClient.js method and are not in the hardcoded MOCK_ONLY_HELPERS list — either add the missing localClient.js wrapper, or add the method to MOCK_ONLY_HELPERS with a reason if it is genuinely a dev/test-only helper.`
    ).toEqual([])
  })

  it('MOCK_ONLY_HELPERS has no stale entries', () => {
    const stale = MOCK_ONLY_HELPERS.filter(
      (name) => !mockKeys.includes(name) || localClientKeys.includes(name)
    )
    expect(
      stale,
      `MOCK_ONLY_HELPERS entry/entries [${stale.join(', ')}] no longer describe a real mock-only method (either removed from the mock, or a localClient.js wrapper now exists for them) — update the list.`
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Assertion set 2: MOCK_WRITE_ALLOWLIST <-> PROJECTIONS drift, both
// directions independently, so a missing entity and an extra one can't
// cancel each other out in a single set-equality check.
// ---------------------------------------------------------------------------
describe('MOCK_WRITE_ALLOWLIST stays in sync with PROJECTIONS', () => {
  it('every PROJECTIONS entity/field is present in MOCK_WRITE_ALLOWLIST', () => {
    const missing = []
    for (const [entity, projection] of Object.entries(PROJECTIONS)) {
      const allowed = MOCK_WRITE_ALLOWLIST[entity]
      if (!allowed) {
        missing.push(`entity '${entity}'`)
        continue
      }
      for (const field of projection.fields) {
        if (!allowed.includes(field)) missing.push(`field '${entity}.${field}'`)
      }
    }
    expect(
      missing,
      `MOCK_WRITE_ALLOWLIST is missing ${missing.join(', ')} — a real write that PROJECTIONS allows would be wrongly REJECTED by the mock under 'npm run dev'. Update MOCK_WRITE_ALLOWLIST in src/localClient.mock.js to match electron/ops/projections.js.`
    ).toEqual([])
  })

  it('every MOCK_WRITE_ALLOWLIST entity/field is present in PROJECTIONS', () => {
    const extra = []
    for (const [entity, fields] of Object.entries(MOCK_WRITE_ALLOWLIST)) {
      const projection = PROJECTIONS[entity]
      if (!projection) {
        extra.push(`entity '${entity}'`)
        continue
      }
      for (const field of fields) {
        if (!projection.fields.includes(field)) extra.push(`field '${entity}.${field}'`)
      }
    }
    expect(
      extra,
      `MOCK_WRITE_ALLOWLIST has ${extra.join(', ')} which PROJECTIONS does not — a write the mock wrongly ACCEPTS under 'npm run dev' would be silently discarded by the real path (applyProjection's no-op). Remove from MOCK_WRITE_ALLOWLIST or add to electron/ops/projections.js.`
    ).toEqual([])
  })
})
