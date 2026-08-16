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
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PROJECTIONS } from './ops/projections.js'
import { PARENT_SCOPED_ENTITIES } from './ops/campScopedEntities.js'
import { runScopedQuery } from './main.js'
import { openLocalDb } from './db/localDb.js'
import { MOCK_WRITE_ALLOWLIST, MOCK_SCOPE_KEYS, mockShoresh } from '../src/localClient.mock.js'

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
    // Observed: 52 keys (including the 6 test/dev-only trigger helpers).
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

  it('every localClient method has a mock implementation, except named non-channel wrappers', () => {
    // "Every localClient method needs a same-named mock method" is false for a
    // convenience wrapper whose name doesn't match the shoresh channel it
    // actually invokes — that wrapper needs no mock method of its own name,
    // because nothing ever calls shoresh.<wrapperName>(). Each entry below is
    // hardcoded (not a naming-convention/pattern match, matching the
    // MOCK_ONLY_HELPERS discipline) and names the channel it really invokes.
    const LOCAL_CLIENT_NON_CHANNEL_METHODS = [
      // deleteEntity calls shoresh.write({ ..., field: '__deleted__' }) — see
      // src/localClient.js — never shoresh.deleteEntity. mockShoresh.write
      // already covers it; no mockShoresh.deleteEntity should exist.
      'deleteEntity',
    ]
    const stale = LOCAL_CLIENT_NON_CHANNEL_METHODS.filter((name) => !localClientKeys.includes(name))
    expect(
      stale,
      `LOCAL_CLIENT_NON_CHANNEL_METHODS entry/entries [${stale.join(', ')}] no longer name a real localClient.js method — update the list.`
    ).toEqual([])

    const missing = localClientKeys.filter(
      (k) => !mockKeys.includes(k) && !LOCAL_CLIENT_NON_CHANNEL_METHODS.includes(k)
    )
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
// Project-lifecycle wrappers are exempt from camp-session authorization by
// recorded decision (docs/adr/2026-08-04-project-lifecycle-authorization-exemption.md)
// — they must thread no token. Guards against a well-meaning future
// "consistency" pass silently reintroducing one.
// ---------------------------------------------------------------------------
describe('project-lifecycle wrappers stay token-free (ADR exemption)', () => {
  const LIFECYCLE_WRAPPERS = [
    'getCurrentProject',
    'createProject',
    'openProject',
    'exportProject',
    'backupProject',
    'restoreProject',
    'listRecentProjects',
    'openRecentProject',
  ]

  it('no lifecycle wrapper body references currentToken() or token', () => {
    const localClientText = fs.readFileSync(LOCAL_CLIENT_FILE, 'utf8')
    const offenders = []
    for (const name of LIFECYCLE_WRAPPERS) {
      const lineMatch = localClientText.split('\n').find((line) => new RegExp(`^ {2}${name}:`).test(line))
      if (!lineMatch) {
        offenders.push(`${name} (wrapper not found)`)
        continue
      }
      if (/currentToken\(\)|\btoken\b/.test(lineMatch)) offenders.push(name)
    }
    expect(
      offenders,
      `Lifecycle wrapper(s) [${offenders.join(', ')}] in src/localClient.js reference a token. Per docs/adr/2026-08-04-project-lifecycle-authorization-exemption.md, the exemption is file-level only — these eight §9 project-file lifecycle wrappers are trusted local-device operations exempt from camp session authorization by recorded decision, and threading a token through them contradicts that decision.`
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

// ---------------------------------------------------------------------------
// C4 — MOCK_SCOPE_KEYS <-> PARENT_SCOPED_ENTITIES drift, both directions, for
// exactly the five entities main.js's SCOPED_LIST_ENTITIES targets.
// day_override_template_slots is deliberately excluded from both sides: it
// is in PARENT_SCOPED_ENTITIES but rejected by main.js's listByScope, so it
// must appear in neither MOCK_SCOPE_KEYS nor this comparison.
// ---------------------------------------------------------------------------
describe('MOCK_SCOPE_KEYS stays in sync with PARENT_SCOPED_ENTITIES (C4)', () => {
  const SCOPED_LIST_ENTITIES = [
    'template_slots',
    'template_overlays',
    'schedule_snapshots',
    'week_activity_exclusions',
    'week_group_exclusions',
    'week_location_exclusions',
  ]

  it('every SCOPED_LIST_ENTITIES entity has a matching parentKey in MOCK_SCOPE_KEYS', () => {
    const missing = []
    for (const entity of SCOPED_LIST_ENTITIES) {
      const realKey = PARENT_SCOPED_ENTITIES[entity]?.parentKey
      const mockKey = MOCK_SCOPE_KEYS[entity]
      if (!mockKey) missing.push(`entity '${entity}'`)
      else if (mockKey !== realKey) missing.push(`entity '${entity}' (mock: '${mockKey}', real: '${realKey}')`)
    }
    expect(
      missing,
      `MOCK_SCOPE_KEYS is missing or diverges on ${missing.join(', ')} — src/localClient.mock.js's listByScope would filter on the wrong column under 'npm run dev'. Update MOCK_SCOPE_KEYS in src/localClient.mock.js to match PARENT_SCOPED_ENTITIES's parentKey in electron/ops/campScopedEntities.js.`
    ).toEqual([])
  })

  it('MOCK_SCOPE_KEYS has no entries beyond the five SCOPED_LIST_ENTITIES', () => {
    const extra = Object.keys(MOCK_SCOPE_KEYS).filter((entity) => !SCOPED_LIST_ENTITIES.includes(entity))
    expect(
      extra,
      `MOCK_SCOPE_KEYS has extra entities [${extra.join(', ')}] beyond the five listByScope targets — including day_override_template_slots here would make it mock-scope-listable even though main.js's SCOPED_LIST_ENTITIES rejects it. Remove the extra entry/entries.`
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C4-R3 — mock/real parity: identical fixture data through the mock's
// listByScope and through the real query (runScopedQuery, extracted from
// main.js's listByScope handler) must produce identical output.
// ---------------------------------------------------------------------------
describe('listByScope: mock/real parity (C4-R3)', () => {
  function makeMemoryLocalStorage() {
    const store = new Map()
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    }
  }

  it('mock and real listByScope agree on template_slots for a scoped template, excluding a foreign camp row', async () => {
    const tmpFile = path.join(os.tmpdir(), `shoresh-parity-test-${Date.now()}-${Math.random()}.sqlite`)
    const db = openLocalDb(tmpFile)
    try {
      const myCampId = randomUUID()
      const foreignCampId = randomUUID()
      db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(myCampId, 'Mine', 'a'.repeat(64))
      db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(
        foreignCampId,
        'Foreign',
        'b'.repeat(64)
      )
      // openLocalDb's own bootstrap may have already created a camp row this
      // test doesn't control the id of — rebind "mine" to whichever camp
      // `SELECT id FROM camps LIMIT 1` actually returns, matching every other
      // list()/listByScope test's convention in main.test.js.
      const actualMyCampId = db.prepare('SELECT id FROM camps LIMIT 1').get().id
      const actualForeignCampId = actualMyCampId === myCampId ? foreignCampId : myCampId

      const myTemplateId = randomUUID()
      const foreignTemplateId = randomUUID()
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(
        myTemplateId,
        actualMyCampId,
        'Mine'
      )
      db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(
        foreignTemplateId,
        actualForeignCampId,
        'Foreign'
      )

      const myRowId = randomUUID()
      db.prepare('INSERT INTO template_slots (id, template_id) VALUES (?, ?)').run(myRowId, myTemplateId)
      db.prepare('INSERT INTO template_slots (id, template_id) VALUES (?, ?)').run(randomUUID(), foreignTemplateId)

      const realRows = runScopedQuery(db, 'template_slots', myTemplateId)

      const memoryStorage = makeMemoryLocalStorage()
      memoryStorage.setItem(
        'shoresh-mock-state',
        JSON.stringify({
          camp: { id: actualMyCampId },
          users: [],
          conflicts: [],
          devices: [],
          template_slots: [
            { id: myRowId, template_id: myTemplateId },
            { id: 'foreign-row', template_id: foreignTemplateId },
          ],
        })
      )
      const previousLocalStorage = globalThis.localStorage
      globalThis.localStorage = memoryStorage
      let mockRows
      try {
        mockRows = await mockShoresh.listByScope(null, 'template_slots', myTemplateId)
      } finally {
        globalThis.localStorage = previousLocalStorage
      }

      // Compare id/template_id only: the real row also carries the table's
      // other (all-null, unset) columns that the mock's plain fixture object
      // never had reason to declare — those aren't part of what this test is
      // checking. The mock has no notion of the camp JOIN (it filters purely
      // by parentKey), which is the one dimension real and mock intentionally
      // differ on structurally — the mock's fixture above is seeded to
      // already be "my camp only" data, so comparing the resulting row
      // identities is still a meaningful parity check on the scope-column
      // filtering itself, which is the part MOCK_SCOPE_KEYS governs.
      const identities = (rows) => rows.map((r) => ({ id: r.id, template_id: r.template_id }))
      expect(identities(realRows)).toEqual([{ id: myRowId, template_id: myTemplateId }])
      expect(identities(mockRows)).toEqual([{ id: myRowId, template_id: myTemplateId }])
    } finally {
      db.close()
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
    }
  })

  it('mock and real listByScope both return [] for an unminted (null) scopeId', async () => {
    const tmpFile = path.join(os.tmpdir(), `shoresh-parity-test-${Date.now()}-${Math.random()}.sqlite`)
    const db = openLocalDb(tmpFile)
    try {
      const realRows = runScopedQuery(db, 'template_slots', null)
      expect(realRows).toEqual([])

      const memoryStorage = makeMemoryLocalStorage()
      memoryStorage.setItem(
        'shoresh-mock-state',
        JSON.stringify({ camp: null, users: [], conflicts: [], devices: [], template_slots: [] })
      )
      const previousLocalStorage = globalThis.localStorage
      globalThis.localStorage = memoryStorage
      let mockRows
      try {
        mockRows = await mockShoresh.listByScope(null, 'template_slots', null)
      } finally {
        globalThis.localStorage = previousLocalStorage
      }
      expect(mockRows).toEqual([])
    } finally {
      db.close()
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
    }
  })
})
