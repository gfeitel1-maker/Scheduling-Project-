// @vitest-environment node
// Red Hat's findings on PR #909 (answer memory, PR 1), each pinned red-first.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { signatureOf } from '../../src/ingest/answerMemory.js'
import { deriveCampSeedlingId } from './electiveDerivedIds.js'
import { listEntities } from './read.js'
import {
  rememberImportAnswers, liveRecords, matchImportAnswers, forgetAnswer, forgetPattern, canonicalKey, ANSWER_KIND, VETO_KIND,
} from './answerMemory.js'

afterAll(() => cleanupTemplatedDbs())

const CAMP = 'camp-1'
let db, file
beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  file = t.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP, 'Camp One')
  db.prepare("INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES ('dev-1', 'Laptop', ?, 'sec-1', 'authorized')").run(new Date().toISOString())
  for (const [id, role, name] of [['u-admin', 'admin', 'Dana'], ['u-staff', 'staff', 'Sam']]) {
    db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)').run(id, CAMP, name, 'h', 's', role)
  }
})
afterEach(() => {
  db.close()
  if (file && fs.existsSync(file)) fs.unlinkSync(file)
})

const fixed = (name, over = {}) => ({
  id: `fixed_events:null:confirm_value:${name}`, kind: 'confirm_value', entity: 'fixed_events', entityId: null, entityName: name,
  timeBlock: '12:00-12:40', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], evidence: { basis: 'daily' }, ...over,
})
const groupsNamed = (n) => Array.from({ length: n }, (_, i) => `Bunk Group Number ${i + 1} With A Long Name`)
const bigExclusion = (name, n) => {
  const g = groupsNamed(n)
  return {
    id: `all_camp_override:${name}`, kind: 'all_camp_override', entity: 'activities', entityName: name,
    evidence: { day: 'Monday', block: '01:00-01:40', missingGroups: g, insteadByGroup: Object.fromEntries(g.map((x) => [x, ['Swim', 'Arts And Crafts']])), attendingCount: 5, occurrences: 1 },
  }
}
const ACCEPT = { action: 'looks_right' }
const REJECT = { action: 'edited' }

let clock = Date.parse('2026-10-01T10:00:00Z')
const tick = () => new Date((clock += 60_000))
function remember(entries, { author = 'u-admin', importId = 'imp-1', cap } = {}) {
  return rememberImportAnswers(db, { campId: CAMP, authorUserId: author, deviceId: 'dev-1', importId, entries, now: tick, cap })
}
const one = (decision, answer, extra = {}) => ({ decision, answer, ...extra })
const matchOne = (decision) => matchImportAnswers(db, { campId: CAMP, decisions: [decision] })[decision.id]
const live = () => liveRecords(db, CAMP)

function forge(decision, { payload = {}, author = 'u-admin', status = 'active' } = {}) {
  const sig = signatureOf(decision)
  const key = canonicalKey(sig)
  const body = {
    v: 1, qkind: sig.qkind, role: 'instance', seq: 1, import_id: 'imp-x', parts: key.parts, baseline: sig.baseline, refs: sig.refs,
    camp_shape: {}, features: sig.features, answer: { verdict: 'accept' }, supersedes: [], overrode: [], ...payload,
  }
  const matchKey = `${key.keyHash}-${randomUUID()}`
  const id = deriveCampSeedlingId(CAMP, ANSWER_KIND, matchKey)
  db.prepare('INSERT INTO camp_seedlings (id, camp_id, kind, match_key, payload, status, confirmed_by, confirmed_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, CAMP, ANSWER_KIND, matchKey, JSON.stringify(body), status, author, '2026-10-01T00:00:00.000Z')
  return id
}

describe('1. the writer never emits what the reader rejects', () => {
  it.each([[12], [20]])('a %i-group all-camp-except answer is written, read back and recalled exactly', (n) => {
    const d = bigExclusion('Trip', n)
    const r = remember([one(d, { choice: 'all_camp' })])
    expect(r.skipped).toEqual([])
    expect(r.written).toHaveLength(1)
    expect(live().answers).toHaveLength(1)
    expect(live().diagnostics.discarded).toBe(0)
    expect(matchOne(d)).toMatchObject({ tier: 0, match: 'exact', answer: { choice: 'all_camp' } })
  })
  it('the same big exclusion set still forms a T3 pattern for another activity', () => {
    remember([one(bigExclusion('Trip A', 12), { choice: 'all_camp' })], { importId: 'a' })
    remember([one(bigExclusion('Trip B', 12), { choice: 'all_camp' })], { importId: 'b' })
    expect(matchOne(bigExclusion('Trip C', 12))).toMatchObject({ source: 'pattern', answer: { choice: 'all_camp' } })
  })
  it('an answer the reader would reject is reported skipped, never written', () => {
    const d = { id: 'v', kind: 'confirm_change', entity: 'groups', entityId: 'g'.repeat(300), entityName: 'Alufim 1', field: ['unit'], proposedValue: 'U1', currentValue: 'U0' }
    const r = remember([one(d, { choice: 'keep' })])
    expect(r.written).toEqual([])
    expect(r.skipped.map((s) => s.reason)).toEqual(['unwritable'])
    expect(db.prepare('SELECT COUNT(*) c FROM camp_seedlings').get().c).toBe(0)
  })
})

describe('4. forgetting a pattern covers every supporter', () => {
  it('250 supporters: every one is vetoed, the vetoes are readable, and the pattern is gone', () => {
    for (let i = 1; i <= 250; i += 1) forge(fixed(`Specialty ${i}`), { payload: { seq: i, import_id: i % 2 ? 'a' : 'b' } })
    expect(matchOne(fixed('Specialty 251'))).toMatchObject({ source: 'pattern' })
    const r = forgetPattern(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', template: 'T1', key: 'fixed_event|specialty', now: tick })
    expect(r.ok).toBe(true)
    expect(live().diagnostics.discarded).toBe(0)
    expect(live().vetoes.length).toBeGreaterThan(1)
    expect(matchOne(fixed('Specialty 251'))?.source).not.toBe('pattern')
  })
})

describe('5. a retire counts only from a qualifying author', () => {
  const forgeMarker = (answer, author) => {
    const payload = { v: 1, qkind: answer.qkind, role: 'instance', seq: 9, parts: ['RETIRE', answer.keyHash], covers: [answer.coverId] }
    const matchKey = `${createHash('sha256').update(JSON.stringify([answer.qkind, payload.parts])).digest('hex')}-${randomUUID()}`
    db.prepare('INSERT INTO camp_seedlings (id, camp_id, kind, match_key, payload, status, confirmed_by, confirmed_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(deriveCampSeedlingId(CAMP, VETO_KIND, matchKey), CAMP, VETO_KIND, matchKey, JSON.stringify(payload), 'active', author, '2026-10-01T00:00:00.000Z')
  }
  it("a bare status flip and a non-importer's Forget marker are both ignored", () => {
    const a = forge(fixed('Lunch 1'), { payload: { answer: { verdict: 'reject' } } })
    const b = forge(fixed('Lunch 2'), { payload: { answer: { verdict: 'reject' } } })
    db.prepare("UPDATE camp_seedlings SET status = 'superseded' WHERE id = ?").run(a)
    forgeMarker(live().answers.find((x) => x.id === b), 'ghost-user')
    expect(live().answers.map((x) => x.id).sort()).toEqual([a, b].sort())
  })
  it("a qualifying author's Forget retires it and the marker carries the author", () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    const id = live().answers[0].id
    forgetAnswer(db, { campId: CAMP, authorUserId: 'u-staff', deviceId: 'dev-1', memoryId: id })
    expect(live().answers).toHaveLength(0)
    const marker = db.prepare("SELECT confirmed_by FROM camp_seedlings WHERE kind = 'import_rule_veto'").get()
    expect(marker.confirmed_by).toBe('u-staff')
  })
  it('a forgotten answer is not a pattern veto and does not count as one', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    forgetAnswer(db, { campId: CAMP, authorUserId: 'u-staff', deviceId: 'dev-1', memoryId: live().answers[0].id })
    expect(live().vetoes).toHaveLength(0)
  })
})

describe('6. growth is capped for every role', () => {
  it('instance answers count against the cap; a changed answer on an existing key does not', () => {
    remember([one(fixed('Lunch 1'), REJECT)], { cap: 1 })
    const r = remember([one(fixed('Lunch 2'), REJECT)], { cap: 1 })
    expect(r.skipped.map((s) => s.reason)).toEqual(['cap'])
    expect(remember([one(fixed('Lunch 1'), ACCEPT, { tap: true })], { cap: 1 }).written).toHaveLength(1)
  })
  it('an unchanged re-answer writes nothing', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    const r = remember([one(fixed('Lunch 1'), REJECT)])
    expect(r.skipped.map((s) => s.reason)).toEqual(['unchanged'])
    expect(db.prepare('SELECT COUNT(*) c FROM camp_seedlings').get().c).toBe(1)
  })
})

describe('7. seq counts qualifying records only', () => {
  it('a forged huge seq from a non-importer does not move the writer', () => {
    forge(fixed('Lunch 9'), { author: 'ghost-user', payload: { seq: 2 ** 31 - 2 } })
    remember([one(fixed('Lunch 1'), REJECT)])
    expect(live().answers.find((a) => a.parts[0] === 'lunch 1').seq).toBe(1)
  })
})

describe('9. edge cases at write', () => {
  it('an import id over 64 characters is shortened, not left to make the record unreadable', () => {
    const r = remember([one(fixed('Lunch 1'), REJECT)], { importId: 'i'.repeat(100) })
    expect(r.written).toHaveLength(1)
    expect(live().answers[0].import_id.length).toBeLessThanOrEqual(64)
  })
  it('one malformed entry skips itself and the rest of the batch is written', () => {
    const bad = { get entityName() { throw new Error('boom') }, id: 'x', kind: 'confirm_value', entity: 'fixed_events' }
    const r = remember([one(fixed('Lunch 1'), REJECT), one(bad, REJECT), one(fixed('Lunch 2'), REJECT)])
    expect(r.written).toHaveLength(2)
    expect(r.skipped.map((s) => s.reason)).toEqual(['malformed'])
  })
})

describe('8. generic reads never carry the answer kinds', () => {
  it('listEntities("camp_seedlings") excludes both answer kinds and keeps column mappings', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    db.prepare("INSERT INTO camp_seedlings (id, camp_id, kind, match_key, payload, status, confirmed_at) VALUES ('m1', ?, 'preference_column_roles', 'k', '{}', 'active', 'x')").run(CAMP)
    expect(listEntities(db, 'camp_seedlings').map((r) => r.kind)).toEqual(['preference_column_roles'])
  })
})
