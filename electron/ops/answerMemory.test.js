// @vitest-environment node
// Import answer memory, the store and the recall (docs/adr/2026-10-11-import-answer-memory.md).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { signatureOf } from '../../src/ingest/answerMemory.js'
import { deriveCampSeedlingId } from './electiveDerivedIds.js'
import { listDeleted } from './trash.js'
import { rememberColumnMapping } from './rememberColumnMapping.js'
import { recallColumnMapping } from '../../src/ingest/mappingSeedling.js'
import {
  rememberImportAnswers, liveRecords, matchImportAnswers, changeAnswer, forgetAnswer, forgetPattern,
  keepAnswer, listLearned, canonicalKey, runRetention, logUnreadablePayloads, ANSWER_KIND, VETO_KIND,
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
  vi.restoreAllMocks()
  db.close()
  if (file && fs.existsSync(file)) fs.unlinkSync(file)
})

const fixed = (name, over = {}) => ({
  id: `fixed_events:null:confirm_value:${name}`, kind: 'confirm_value', entity: 'fixed_events', entityId: null, entityName: name,
  timeBlock: '12:00-12:40', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], evidence: { basis: 'daily' }, ...over,
})
const exclusion = (name, over = {}) => ({
  id: `all_camp_override:${name}`, kind: 'all_camp_override', entity: 'activities', entityName: name,
  evidence: { day: 'Monday', block: '01:00-01:40', missingGroups: ['CIT'], insteadByGroup: { CIT: ['Swim'] }, attendingCount: 5, occurrences: 1, ...over },
})
const ACCEPT = { action: 'looks_right' }
const REJECT = { action: 'edited' }

let clock = Date.parse('2026-10-01T10:00:00Z')
const tick = () => new Date((clock += 60_000))
function remember(entries, { author = 'u-admin', importId = 'imp-1', now = tick, cap } = {}) {
  return rememberImportAnswers(db, { campId: CAMP, authorUserId: author, deviceId: 'dev-1', importId, entries, now, cap })
}
const one = (decision, answer, extra = {}) => ({ decision, answer, ...extra })
const matchOne = (decision, opts = {}) => matchImportAnswers(db, { campId: CAMP, decisions: [decision], ...opts })[decision.id]
const rows = () => db.prepare("SELECT * FROM camp_seedlings WHERE kind IN ('import_answer','import_rule_veto')").all()
const live = () => liveRecords(db, CAMP)

function forge(decision, { payload = {}, author = 'u-admin', status = 'active', kind = ANSWER_KIND, keyHash } = {}) {
  const sig = signatureOf(decision)
  const key = canonicalKey(sig)
  const body = {
    v: 1, qkind: sig.qkind, role: 'instance', seq: 1, import_id: 'imp-x', parts: key.parts, baseline: sig.baseline, refs: sig.refs,
    camp_shape: {}, features: sig.features, answer: { verdict: 'accept' }, supersedes: [], overrode: [], ...payload,
  }
  const id = randomUUID()
  const matchKey = `${keyHash ?? key.keyHash}-${id}`
  db.prepare('INSERT INTO camp_seedlings (id, camp_id, kind, match_key, payload, status, confirmed_by, confirmed_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(deriveCampSeedlingId(CAMP, kind, matchKey), CAMP, kind, matchKey, typeof body === 'string' ? body : JSON.stringify(body), status, author, '2026-10-01T00:00:00.000Z')
  return deriveCampSeedlingId(CAMP, kind, matchKey)
}

describe('writing an answer', () => {
  it('writes one record with a fresh id, key-hash prefixed match_key, and a JSON payload', () => {
    const r = remember([one(fixed('Lunch 1'), REJECT)])
    expect(r.written).toHaveLength(1)
    const [row] = rows()
    expect(row.kind).toBe('import_answer')
    expect(row.status).toBe('active')
    expect(row.confirmed_by).toBe('u-admin')
    const key = canonicalKey(signatureOf(fixed('Lunch 1')))
    expect(row.match_key.startsWith(`${key.keyHash}-`)).toBe(true)
    expect(row.id).toBe(deriveCampSeedlingId(CAMP, 'import_answer', row.match_key))
    const p = JSON.parse(row.payload)
    expect(p).toMatchObject({ v: 1, qkind: 'classify', role: 'instance', seq: 1, import_id: 'imp-1', answer: { verdict: 'reject' }, supersedes: [] })
  })
  it('costs fewer than 10 ops per answer', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    const n = db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'camp_seedlings'").get().c
    expect(n).toBeLessThan(10)
  })
  it('41 answers stay under a stated op budget (400)', () => {
    remember(Array.from({ length: 41 }, (_, i) => one(fixed(`Special ${i}x`), REJECT)))
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'camp_seedlings'").get().c).toBeLessThan(400)
  })
  it('a looks_right on a classify question is evidence, never instance memory; a value-create looks_right writes nothing', () => {
    remember([one(fixed('Lunch 1'), ACCEPT)])
    expect(live().answers[0].role).toBe('evidence')
    remember([one({ id: 'activities:null:create:Swim', kind: 'confirm_value', entity: 'activities', entityName: 'Swim', field: null }, ACCEPT)])
    expect(rows()).toHaveLength(1)
  })
  it('an unanswered or unremembered decision writes nothing', () => {
    remember([one(fixed('Lunch 1'), undefined), one({ id: 'c', kind: 'resolve_conflict', entity: 'groups', entityName: 'G' }, { choice: 'create' })])
    expect(rows()).toHaveLength(0)
  })
  it('ignores a camp_id or kind smuggled into an entry', () => {
    remember([{ ...one(fixed('Lunch 1'), REJECT), camp_id: 'other', kind: 'preference_column_roles' }])
    expect(rows()).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) c FROM camp_seedlings WHERE kind = 'preference_column_roles'").get().c).toBe(0)
    expect(rows()[0].camp_id).toBe(CAMP)
  })
  it('refuses a part equal to a camper name or external id; a payload carries no camper name', () => {
    db.prepare('INSERT INTO campers (id, camp_id, display_name, external_id) VALUES (?,?,?,?)').run('c1', CAMP, 'Noa Levi', 'X-9')
    const r = remember([one(fixed('Noa Levi'), REJECT), one(fixed('x-9'), REJECT), one(fixed('Lunch 1'), REJECT)])
    expect(r.written).toHaveLength(1)
    expect(r.skipped.map((s) => s.reason)).toEqual(['camper_name', 'camper_name'])
    for (const row of rows()) expect(row.payload.toLowerCase()).not.toContain('noa levi')
  })
})

describe('Tier 0: exact and near recall', () => {
  it('exact after normalization, labelled with date and author', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    const got = matchOne(fixed('LUNCH 1', { timeBlock: '12:00-12:40' }))
    expect(got).toMatchObject({ tier: 0, source: 'instance', match: 'exact', autoApply: false, answer: { action: 'edited' }, answeredBy: 'u-admin', answeredByName: 'Dana' })
    expect(got.answeredAt).toMatch(/^2026-10-01/)
    expect(got.why).toMatch(/Dana/)
  })
  it('a different day set is not recalled; a changed attending set is NEAR', () => {
    remember([one(fixed('Lunch 1'), REJECT), one(exclusion('Trip'), { choice: 'as_written' })])
    expect(matchOne(fixed('Lunch 1', { days: ['Monday'] }))?.match).toBe('near')
    const near = matchOne(exclusion('Trip', { attendingCount: 6 }))
    expect(near).toMatchObject({ match: 'near', autoApply: false })
    const grp = matchOne(exclusion('Trip', { missingGroups: ['CIT', 'Alufim 1'] }))
    expect(grp?.match).toBe('near')
    expect(grp.autoApply).toBe(false)
  })
  it('a stale entity id (row gone, or renamed) is NEAR', () => {
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?,?,?)').run('g1', CAMP, 'Alufim 1')
    const change = (id, name) => ({ id: `groups:${id}`, kind: 'confirm_change', entity: 'groups', entityId: id, entityName: name, field: ['unit'], proposedValue: 'U1', currentValue: 'U0' })
    remember([one(change('g1', 'Alufim 1'), { choice: 'keep' })])
    expect(matchOne(change('g1', 'Alufim 1'))?.match).toBe('exact')
    db.prepare("UPDATE groups SET name = 'Renamed' WHERE id = 'g1'").run()
    expect(matchOne(change('g1', 'Alufim 1'))?.match).toBe('near')
    db.prepare("DELETE FROM groups WHERE id = 'g1'").run()
    expect(matchOne(change('g1', 'Alufim 1'))?.match).toBe('near')
  })
  it('a recall of "keep" is recalled for confirm_change, and an ack for drift', () => {
    const ack = { id: 'drift', kind: 'confirm_change', entity: 'fixed_events', entityName: 'Lunch', field: null, from: 'a', to: 'b', timeBlock: '12:00-12:40', days: ['Monday'] }
    remember([one(ack, { ack: true })])
    expect(matchOne(ack)).toMatchObject({ match: 'exact', answer: { ack: true } })
  })
  // Tier 0 auto-applies only what the allow-list lets a pattern auto-apply: the ACCEPTING answer on
  // a fixed event. Every other exact recall pre-selects and still asks (Red Hat, PR #909).
  it('a rejection recalled exactly pre-selects but never auto-applies', () => {
    remember([one(exclusion('Trip'), { choice: 'as_written' })])
    expect(matchOne(exclusion('Trip'))).toMatchObject({ match: 'exact', autoApply: false, answer: { choice: 'as_written' } })
  })
  it('only an accepted fixed event auto-applies at tier 0; every other kind and verdict is pre-select only', () => {
    const nameKind = { id: 'nk', kind: 'name_kind', entity: 'activities', entityName: 'Swim', candidateEvents: [{ time_block: '02:25-03:15', days: ['Tuesday'] }] }
    const elective = { id: 'el', kind: 'elective_candidate', entity: 'activities', entityName: 'Electives A' }
    const backed = { id: 'bc', kind: 'confirm_change', entity: 'groups', entityId: 'g1', entityName: 'Alufim 1', field: ['unit'], proposedValue: 'U1', currentValue: 'U0' }
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?,?,?)').run('g1', CAMP, 'Alufim 1')
    const drift = { id: 'dr', kind: 'confirm_change', entity: 'fixed_events', entityName: 'Lunch', field: null, from: 'a', to: 'b', timeBlock: '12:00-12:40', days: ['Monday'] }
    const edited = { id: 'ev', kind: 'confirm_value', entity: 'activities', entityId: null, entityName: 'Archery', field: ['duration'], proposedValue: 40, currentValue: 30 }
    const never = [
      [fixed('Lunch 1'), REJECT], [exclusion('Trip'), { choice: 'all_camp' }], [exclusion('Hike'), { choice: 'as_written' }],
      [nameKind, { choice: 'fixed' }], [nameKind, { choice: 'activity' }], [elective, { choice: 'confirm' }], [elective, { choice: 'decline' }],
      [backed, { choice: 'accept' }], [backed, { choice: 'keep' }], [drift, { ack: true }], [edited, REJECT],
    ]
    for (const [d, a] of never) {
      remember([one(d, a, { tap: true })])
      expect(matchOne(d), `${d.kind}:${JSON.stringify(a)}`).toMatchObject({ match: 'exact', autoApply: false })
    }
    remember([one(fixed('Lunch 9'), ACCEPT, { tap: true })])
    expect(matchOne(fixed('Lunch 9'))).toMatchObject({ match: 'exact', autoApply: true })
  })
  it('a name-key near: same name, different key', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    const got = matchOne(fixed('Lunch 1', { timeBlock: '01:00-01:40' }))
    expect(got).toMatchObject({ match: 'near', autoApply: false })
  })
  it('suppressed decisions are not auto-applied again in the same session', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    const d = fixed('Lunch 1')
    const got = matchOne(d, { suppressed: [d.id] })
    expect(got.autoApply).toBe(false)
    expect(got.suppressed).toBe(true)
  })
  it('a decision with no memory returns null', () => {
    expect(matchOne(fixed('Never Seen 7'))).toBeNull()
  })
})

describe('name_kind (#889): fixed time or schedulable activity', () => {
  const nameKind = (name) => ({ id: `name_kind:${name}`, kind: 'name_kind', entity: 'activities', entityName: name, candidateEvents: [{ time_block: '02:25-03:15', days: ['Tuesday', 'Thursday'] }] })
  it('is remembered and recalled exactly, in the card\'s own answer vocabulary', () => {
    remember([one(nameKind('Swim'), { choice: 'activity' })])
    expect(matchOne(nameKind('Swim'))).toMatchObject({ match: 'exact', answer: { choice: 'activity' } })
  })
  it('a strong pattern pre-selects but never auto-applies (not on the allow-list)', () => {
    remember([one(nameKind('Block 1'), { choice: 'fixed' }, { tap: true })], { importId: 'a' })
    remember([one(nameKind('Block 2'), { choice: 'fixed' })], { importId: 'a' })
    remember([one(nameKind('Block 3'), { choice: 'fixed' })], { importId: 'b' })
    expect(matchOne(nameKind('Block 4'))).toMatchObject({ source: 'pattern', band: 'established', autoApply: false, answer: { choice: 'fixed' } })
  })
})

describe('Change, Forget, Remember this', () => {
  it('A -> B -> A: distinct ids, no self reference, one live head, recall is A', () => {
    const d = fixed('Lunch 1')
    remember([one(d, REJECT)])
    remember([one(d, ACCEPT)])
    remember([one(d, REJECT)])
    const all = rows()
    expect(new Set(all.map((r) => r.id)).size).toBe(3)
    for (const r of all) expect(JSON.parse(r.payload).supersedes).not.toContain(r.id)
    expect(all.filter((r) => r.status === 'active')).toHaveLength(1)
    expect(matchOne(d).answer).toEqual({ action: 'edited' })
    expect(live().answers).toHaveLength(1)
  })
  it('the same answer twice writes one record', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    remember([one(fixed('Lunch 1'), REJECT)])
    expect(rows()).toHaveLength(1)
  })
  it('forget then re-answer writes a fresh live record', () => {
    const d = fixed('Lunch 1')
    remember([one(d, REJECT)])
    const id = live().answers[0].id
    forgetAnswer(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', memoryId: id })
    expect(matchOne(d)).toBeNull()
    remember([one(d, REJECT)])
    expect(live().answers).toHaveLength(1)
    expect(live().answers[0].id).not.toBe(id)
  })
  it('a near card tapped through is kept as evidence that retires nothing; "Remember this" on a name-key near inserts and leaves the old live', () => {
    const d = fixed('Lunch 1')
    remember([one(d, REJECT)])
    const near = fixed('Lunch 1', { timeBlock: '01:00-01:40' })
    remember([one(near, REJECT, { recalled: { match: 'near' } })])
    expect(rows()).toHaveLength(2)
    expect(live().answers.map((a) => a.role).sort()).toEqual(['evidence', 'instance'])
    expect(rows().every((r) => r.status === 'active')).toBe(true)
    remember([one(near, REJECT, { recalled: { match: 'near' } })])
    expect(rows()).toHaveLength(2)
    remember([one(near, ACCEPT, { recalled: { match: 'near' }, rememberNear: true })])
    expect(rows()).toHaveLength(3)
    expect(rows().filter((r) => r.status === 'active')).toHaveLength(2)
  })
  it('"Remember this" on a baseline near retires ALL live heads for the key in one atomic step', () => {
    const d = exclusion('Trip')
    remember([one(d, { choice: 'as_written' })])
    const second = forge(d, { payload: { seq: 5, answer: { verdict: 'all_camp' } } })
    expect(live().answers.filter((a) => a.keyHash === canonicalKey(signatureOf(d)).keyHash)).toHaveLength(2)
    const near = exclusion('Trip', { attendingCount: 6 })
    remember([one(near, { choice: 'all_camp' }, { recalled: { match: 'near' }, rememberNear: true })])
    const heads = rows().filter((r) => r.status === 'active')
    expect(heads).toHaveLength(1)
    expect(JSON.parse(heads[0].payload).supersedes).toContain(second)
    expect(JSON.parse(heads[0].payload).supersedes).toHaveLength(2)
  })
  it('changeAnswer supersedes every live head and carries the signature over', () => {
    const d = fixed('Lunch 1')
    remember([one(d, REJECT)])
    const id = live().answers[0].id
    const r = changeAnswer(db, { campId: CAMP, authorUserId: 'u-staff', deviceId: 'dev-1', memoryId: id, verdict: 'accept' })
    expect(r.ok).toBe(true)
    const a = live().answers
    expect(a).toHaveLength(1)
    expect(a[0].answer.verdict).toBe('accept')
    expect(a[0].supersedes).toEqual([id])
    expect(a[0].confirmed_by).toBe('u-staff')
    expect(matchOne(d).answer).toEqual({ action: 'looks_right' })
  })
  it('changeAnswer refuses a verdict outside the question\'s vocabulary', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    const r = changeAnswer(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', memoryId: live().answers[0].id, verdict: 'all_camp' })
    expect(r.ok).toBe(false)
  })
})

describe('concurrent Change and ordering without clocks', () => {
  it('two live heads that agree are one answer; that disagree are a contradiction (NEAR, counted)', () => {
    const d = fixed('Lunch 1')
    forge(d, { payload: { seq: 1, answer: { verdict: 'reject' } } })
    forge(d, { payload: { seq: 2, answer: { verdict: 'reject' } } })
    expect(matchOne(d)).toMatchObject({ match: 'exact', autoApply: false })
    forge(d, { payload: { seq: 3, answer: { verdict: 'accept' } } })
    const got = matchOne(d)
    expect(got).toMatchObject({ match: 'near', autoApply: false, contradiction: 2 })
  })
  it('a third Change on a device that has seen both heads leaves one live head listing both', () => {
    const d = fixed('Lunch 1')
    const a = forge(d, { payload: { seq: 1, answer: { verdict: 'reject' } } })
    const b = forge(d, { payload: { seq: 1, answer: { verdict: 'accept' } } })
    remember([one(d, REJECT)])
    const active = rows().filter((r) => r.status === 'active')
    expect(active).toHaveLength(1)
    expect(JSON.parse(active[0].payload).supersedes.sort()).toEqual([a, b].sort())
  })
  it('a record named in a qualifying author\'s supersedes is dead even if its status still says active', () => {
    const d = fixed('Lunch 1')
    const old = forge(d, { payload: { seq: 1, answer: { verdict: 'accept' } } })
    forge(d, { payload: { seq: 2, answer: { verdict: 'reject' }, supersedes: [old] } })
    expect(live().answers.map((x) => x.answer.verdict)).toEqual(['reject'])
  })
  it('seq is 1 + the highest visible seq for the qkind (causal, clock-free)', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    forge(fixed('Lunch 2'), { payload: { seq: 40 } })
    remember([one(fixed('Lunch 3'), REJECT)])
    expect(Math.max(...live().answers.map((a) => a.seq))).toBe(41)
  })
  it('a clock-skewed confirmed_at does not win: the higher seq does', () => {
    const d = fixed('Lunch 1')
    const skewed = forge(d, { payload: { seq: 1, answer: { verdict: 'accept' } } })
    db.prepare("UPDATE camp_seedlings SET confirmed_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(skewed)
    forge(d, { payload: { seq: 2, answer: { verdict: 'reject' }, supersedes: [skewed] } })
    expect(matchOne(d).answer).toEqual({ action: 'edited' })
  })
})

describe('validation at read (liveRecords is the only reader)', () => {
  it('discards an oversize payload BEFORE parsing it', () => {
    const d = fixed('Lunch 1')
    forge(d)
    const id = rows()[0].id
    db.prepare('UPDATE camp_seedlings SET payload = ? WHERE id = ?').run(JSON.stringify({ pad: 'x'.repeat(5000) }), id)
    const spy = vi.spyOn(JSON, 'parse')
    const got = live()
    expect(got.answers).toHaveLength(0)
    expect(got.diagnostics.discarded).toBe(1)
    expect(spy.mock.calls.some(([s]) => typeof s === 'string' && s.length > 4096)).toBe(false)
  })
  it.each([
    ['unknown key', { extra: 1 }],
    ['wrong type for seq', { seq: '5' }],
    ['seq 0', { seq: 0 }],
    ['seq above 2^31-1', { seq: 2 ** 31 }],
    ['fractional seq', { seq: 1.5 }],
    ['bad qkind', { qkind: 'bogus' }],
    ['bad role', { role: 'boss' }],
    ['too many supersedes', { supersedes: Array.from({ length: 65 }, (_, i) => `id-${i}`) }],
    ['too many parts', { parts: Array.from({ length: 17 }, () => 'a') }],
    ['bad answer verdict for the qkind', { answer: { verdict: 'all_camp' } }],
    ['extra key inside answer', { answer: { verdict: 'accept', admin: true } }],
    ['bad version', { v: 2 }],
  ])('discards whole: %s', (_label, payload) => {
    forge(fixed('Lunch 1'), { payload })
    const got = live()
    expect(got.answers).toHaveLength(0)
    expect(got.diagnostics.discarded).toBe(1)
  })
  it('discards a record whose match_key hash does not match its own parts', () => {
    forge(fixed('Lunch 1'), { keyHash: 'a'.repeat(64) })
    expect(live().answers).toHaveLength(0)
  })
  it('accepts seq at the top of its range', () => {
    forge(fixed('Lunch 1'), { payload: { seq: 2 ** 31 - 1 } })
    expect(live().answers).toHaveLength(1)
  })
  it('discards a kind outside the allow-list', () => {
    forge(fixed('Lunch 1'), { kind: 'something_else' })
    expect(live().answers).toHaveLength(0)
  })
  it('logs the unreadable count as one line at startup and does not throw', () => {
    forge(fixed('Lunch 1'), { payload: { seq: 0 } })
    db.prepare("UPDATE camp_seedlings SET payload = 'not json' WHERE kind = 'import_answer'").run()
    const log = vi.fn()
    expect(() => logUnreadablePayloads(db, CAMP, log)).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toBe('camp_seedlings: 1 records this build cannot read')
    const quiet = vi.fn()
    db.prepare('DELETE FROM camp_seedlings').run()
    logUnreadablePayloads(db, CAMP, quiet)
    expect(quiet).not.toHaveBeenCalled()
  })
})

describe('trust: only current importers count', () => {
  const trio = () => ['Specialty 1', 'Specialty 2', 'Specialty 3'].map((n, i) => ({ n, imp: i % 2 ? 'imp-b' : 'imp-a' }))
  it('a record from a non-importer is NEAR-only, labelled "as recorded", and counts for nothing', () => {
    const d = fixed('Lunch 1')
    forge(d, { author: 'ghost-user', payload: { answer: { verdict: 'reject' } } })
    const got = matchOne(d)
    expect(got).toMatchObject({ match: 'near', asRecorded: true, autoApply: false })
    for (const { n, imp } of trio()) forge(fixed(n), { author: 'ghost-user', payload: { import_id: imp, answer: { verdict: 'accept', tap: true } } })
    expect(matchOne(fixed('Specialty 4'))?.source).not.toBe('pattern')
  })
  it('a user who stops holding groups.import stops counting at the next recall', () => {
    const d = fixed('Lunch 1')
    remember([one(d, REJECT)], { author: 'u-staff' })
    expect(matchOne(d).match).toBe('exact')
    const noImport = { admin: ['*'], staff: ['trash.read'] }
    const got = matchImportAnswers(db, { campId: CAMP, decisions: [d], permissions: noImport })[d.id]
    expect(got).toMatchObject({ match: 'near', asRecorded: true, autoApply: false })
  })
  it('a forged record cannot make an authority kind auto-apply through a pattern', () => {
    for (const { n, imp } of trio()) forge(exclusion(n), { author: 'u-admin', payload: { import_id: imp, answer: { verdict: 'as_written' } } })
    const got = matchOne(exclusion('Specialty 4'))
    expect(got.autoApply).toBe(false)
    expect(got.source).toBe('pattern')
  })
})

describe('tombstones and aliases exclude at read', () => {
  it('a record whose ref is tombstoned is excluded, including one that arrives AFTER the tombstone', () => {
    const change = (id) => ({ id: `groups:${id}`, kind: 'confirm_change', entity: 'groups', entityId: id, entityName: 'G', field: ['unit'], proposedValue: 'U1', currentValue: 'U0' })
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?,?,?)').run('g1', CAMP, 'G')
    db.prepare("INSERT INTO tombstones (id, entity, version, sig) VALUES ('g1','groups',1,'x')").run()
    forge(change('g1'), { payload: { answer: { verdict: 'keep' } } })
    expect(live().answers).toHaveLength(0)
  })
  it('an alias ref pointing at a tombstoned entity is excluded', () => {
    const d = fixed('Lunch 1')
    db.prepare("INSERT INTO source_aliases (id, camp_id, entity_type, source_label, entity_id, confirmed_at) VALUES ('al1', ?, 'groups', 'L', 'camper-9', 'x')").run(CAMP)
    db.prepare("INSERT INTO tombstones (id, entity, version, sig) VALUES ('camper-9','campers',1,'x')").run()
    forge(d, { payload: { refs: ['alias:al1'] } })
    expect(live().answers).toHaveLength(0)
  })
})

describe('retention, the cap and long histories', () => {
  it('write 100 answers, retire 90, run retention, write another: it validates and orders last', () => {
    remember(Array.from({ length: 100 }, (_, i) => one(fixed(`Event ${i}x`), REJECT)))
    // The OLDEST 90 are retired, so few records remain but their seq values are high: a count-based
    // cap (seq <= number of records) would discard every one of them and the next write.
    const ids = live().answers.slice(-90).map((a) => a.id)
    for (const id of ids) forgetAnswer(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', memoryId: id })
    db.prepare("UPDATE camp_seedlings SET confirmed_at = '2020-01-01T00:00:00.000Z' WHERE status = 'superseded'").run()
    runRetention(db, { campId: CAMP, deviceId: 'dev-1', authorUserId: 'u-admin', now: () => new Date('2026-10-11T00:00:00Z') })
    const maxBefore = Math.max(...live().answers.map((a) => a.seq))
    remember([one(fixed('Brand New 9'), REJECT)])
    const got = live()
    expect(got.diagnostics.discarded).toBe(0)
    const fresh = got.answers.find((a) => a.parts[0] === 'brand new 9')
    expect(fresh.seq).toBe(maxBefore + 1)
    expect(Math.max(...got.answers.map((a) => a.seq))).toBe(fresh.seq)
  })
  it('retention deletes only old superseded records beyond the newest 2 per key', () => {
    const d = fixed('Lunch 1')
    for (let i = 0; i < 5; i += 1) remember([one(d, i % 2 ? ACCEPT : REJECT)])
    db.prepare("UPDATE camp_seedlings SET confirmed_at = '2020-01-01T00:00:00.000Z'").run()
    runRetention(db, { campId: CAMP, deviceId: 'dev-1', authorUserId: 'u-admin', now: () => new Date('2026-10-11T00:00:00Z') })
    const left = rows()
    expect(left.filter((r) => r.status === 'active')).toHaveLength(1)
    expect(left.filter((r) => r.status === 'superseded')).toHaveLength(2)
  })
  it('a recent superseded record is never deleted', () => {
    const d = fixed('Lunch 1')
    for (let i = 0; i < 4; i += 1) remember([one(d, i % 2 ? ACCEPT : REJECT)])
    runRetention(db, { campId: CAMP, deviceId: 'dev-1', authorUserId: 'u-admin', now: () => new Date(clock) })
    expect(rows()).toHaveLength(4)
  })
  it('the 5,000 cap counts live records of every role: evidence and instance answers both stop at it', () => {
    remember([one(fixed('Lunch 1'), REJECT)], { cap: 1 })
    expect(remember([one(fixed('Lunch 2'), ACCEPT)], { cap: 1 }).skipped.map((s) => s.reason)).toEqual(['cap'])
    expect(remember([one(fixed('Lunch 3'), REJECT)], { cap: 1 }).skipped.map((s) => s.reason)).toEqual(['cap'])
  })
  it('retention-deleted answers are absent from the Trash listing', () => {
    remember([one(fixed('Lunch 1'), REJECT), one(fixed('Lunch 1'), ACCEPT, {})])
    db.prepare("UPDATE camp_seedlings SET confirmed_at = '2020-01-01T00:00:00.000Z'").run()
    for (let i = 0; i < 4; i += 1) remember([one(fixed('Lunch 1'), i % 2 ? ACCEPT : REJECT)])
    db.prepare("UPDATE camp_seedlings SET confirmed_at = '2020-01-01T00:00:00.000Z' WHERE status = 'superseded'").run()
    runRetention(db, { campId: CAMP, deviceId: 'dev-1', authorUserId: 'u-admin', now: () => new Date('2026-10-11T00:00:00Z') })
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'camp_seedlings' AND field = '__deleted__'").get().c).toBeGreaterThan(0)
    expect(listDeleted(db).filter((x) => x.entity === 'camp_seedlings')).toEqual([])
  })
})

describe('pattern writers and the view data', () => {
  const sibs = () => {
    remember([one(fixed('Specialty 1'), REJECT, { tap: true })], { importId: 'imp-a' })
    remember([one(fixed('Specialty 2'), REJECT)], { importId: 'imp-a' })
    remember([one(fixed('Specialty 3'), REJECT)], { importId: 'imp-b' })
  }
  it('three declines from two imports pre-select the fourth (rejections never auto-apply)', () => {
    sibs()
    const got = matchOne(fixed('Specialty 4'))
    expect(got).toMatchObject({ tier: 1, source: 'pattern', match: 'pattern', band: 'established', autoApply: false, answer: { action: 'edited' } })
    expect(got.why).toMatch(/Specialty/)
    expect(got.progress).toMatchObject({ neverAutoApply: true, neverReason: 'rejection' })
  })
  it('accepting answers across two imports with an explicit tap auto-apply the next (T1)', () => {
    remember([one(fixed('Specialty 1'), ACCEPT)], { importId: 'imp-a' })
    remember([one(fixed('Specialty 2'), ACCEPT)], { importId: 'imp-a' })
    remember([one(fixed('Specialty 3'), ACCEPT, { tap: true })], { importId: 'imp-b' })
    const got = matchOne(fixed('Specialty 4'))
    expect(got).toMatchObject({ band: 'established', autoApply: true, answer: { action: 'looks_right' } })
  })
  it('a bulk looks_right is stored flagged and counts toward nothing', () => {
    for (const n of ['Specialty 1', 'Specialty 2', 'Specialty 3']) remember([one(fixed(n), ACCEPT, { bulk: true })], { importId: `i-${n}` })
    expect(live().answers.every((a) => a.bulk)).toBe(true)
    expect(matchOne(fixed('Specialty 4'))?.source).not.toBe('pattern')
  })
  it('progress shows 2 of 3 for a growing pattern even when nothing is recalled', () => {
    remember([one(fixed('Specialty 1'), ACCEPT)], { importId: 'imp-a' })
    remember([one(fixed('Specialty 2'), ACCEPT)], { importId: 'imp-a' })
    const got = matchOne(fixed('Specialty 4'))
    expect(got.progress).toMatchObject({ agreeing: 2, needed: 3 })
    expect(got.progress.missing).toEqual(expect.arrayContaining(['more_answers', 'another_import', 'explicit']))
  })
  it('forgetPattern writes a veto covering exactly the answers it covered; the answers stay and keep resolving', () => {
    sibs()
    const covered = live().answers.map((a) => a.coverId)
    const r = forgetPattern(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', template: 'T1', key: 'fixed_event|specialty' })
    expect(r.ok).toBe(true)
    expect(rows().filter((x) => x.kind === VETO_KIND)).toHaveLength(1)
    expect(live().vetoes[0].covers.sort()).toEqual(covered.sort())
    expect(live().answers).toHaveLength(3)
    expect(matchOne(fixed('Specialty 4'))?.source).not.toBe('pattern')
    expect(matchOne(fixed('Specialty 1')).match).toBe('exact')
    remember([one(fixed('Specialty 9'), REJECT)], { importId: 'imp-c' })
    expect(matchOne(fixed('Specialty 4'))?.band).not.toBe('established')
  })
  it('listLearned groups answers and patterns for the view, counting former users', () => {
    sibs()
    forge(fixed('Lunch 7'), { author: 'ghost' })
    const view = listLearned(db, { campId: CAMP, viewerUserId: 'u-staff' })
    expect(view.answers.length).toBe(4)
    expect(view.patterns.length).toBeGreaterThan(0)
    expect(view.patterns[0].progress).toBeTruthy()
    expect(view.formerUserAnswers).toBe(1)
    expect(view.canWrite).toBe(true)
    expect(view.answers.find((a) => a.asRecorded)).toBeTruthy()
  })
  it('keepAnswer re-records under the keeper with a fresh id, and the former-user count drops', () => {
    const d = fixed('Lunch 7')
    const old = forge(d, { author: 'ghost', payload: { answer: { verdict: 'reject' } } })
    expect(listLearned(db, { campId: CAMP, viewerUserId: 'u-staff' }).formerUserAnswers).toBe(1)
    const r = keepAnswer(db, { campId: CAMP, authorUserId: 'u-staff', deviceId: 'dev-1', memoryId: old })
    expect(r.ok).toBe(true)
    const a = live().answers
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ confirmed_by: 'u-staff', qualifies: true, supersedes: [old] })
    expect(a[0].id).not.toBe(old)
    expect(a[0].answer.verdict).toBe('reject')
    expect(listLearned(db, { campId: CAMP, viewerUserId: 'u-staff' }).formerUserAnswers).toBe(0)
  })
})

describe('coexistence with column mappings', () => {
  it('a column mapping written before and after the answers still recalls; the mixed list is unchanged', () => {
    const header = ['Name', 'Choice 1']
    rememberColumnMapping(db, { campId: CAMP, matchKey: 'hdr-aa', payload: { Name: 'camper_name' }, authorUserId: 'u-admin', deviceId: 'dev-1' })
    remember([one(fixed('Lunch 1'), REJECT)])
    const list = db.prepare('SELECT * FROM camp_seedlings').all()
    expect(list).toHaveLength(2)
    expect(() => recallColumnMapping(list, header, null)).not.toThrow()
    expect(recallColumnMapping(list, header, null)).toEqual(recallColumnMapping(list.filter((s) => s.kind === 'preference_column_roles'), header, null))
  })
})

describe('keys and the projection', () => {
  it('two 200-character parts sharing a 100-character prefix get different keys (hashed whole, never truncated)', () => {
    const prefix = 'x'.repeat(100)
    const a = canonicalKey(signatureOf(fixed(prefix + 'a'.repeat(100))))
    const b = canonicalKey(signatureOf(fixed(prefix + 'b'.repeat(100))))
    expect(a.keyHash).not.toBe(b.keyHash)
    expect(a.parts[0]).toMatch(/^h:[0-9a-f]{64}$/)
    expect(canonicalKey(signatureOf(fixed('Lunch 1'))).parts[0]).toBe('lunch 1')
  })
  it('the replicated projection has no UNIQUE index beyond its primary key', () => {
    const unique = db.prepare("PRAGMA index_list('camp_seedlings')").all().filter((i) => i.unique && i.origin !== 'pk')
    expect(unique).toEqual([])
  })
  it('the view says a user without groups.import cannot write', () => {
    remember([one(fixed('Lunch 1'), REJECT)])
    const noImport = { admin: ['*'], staff: ['trash.read'] }
    expect(listLearned(db, { campId: CAMP, viewerUserId: 'u-staff', permissions: noImport }).canWrite).toBe(false)
    expect(listLearned(db, { campId: CAMP, viewerUserId: 'u-staff' }).canWrite).toBe(true)
  })
})

describe('guard: one reader', () => {
  const sources = () => {
    const root = process.cwd()
    const out = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) { if (!['node_modules', 'legacy', 'archive', 'dist'].includes(e.name)) walk(rel) } else if (/\.(js|jsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) {
          out.push({ rel, text: fs.readFileSync(path.join(root, rel), 'utf8') })
        }
      }
    }
    for (const d of ['electron', 'src', 'scripts']) walk(d)
    return out
  }
  it('no other source file names the answer kinds or imports their constants', () => {
    const allowed = new Set(['electron/ops/answerMemory.js'])
    const hits = sources()
      .filter(({ rel, text }) => !allowed.has(rel) && /\bimport_answer\b|\bimport_rule_veto\b|\bANSWER_KIND\b|\bVETO_KIND\b/.test(text))
      .map(({ rel }) => rel)
    expect(hits).toEqual([])
  })
  // A generic list('camp_seedlings') hands every row to the caller. listEntities drops the answer kinds
  // server-side (tested in answerMemory.redhat.test.js), which is what makes the column-mapping recall
  // below safe; any NEW generic read must be added here on purpose.
  it('no new generic camp_seedlings read appears', () => {
    const generic = /\.list\(\s*['"`]camp_seedlings['"`]\s*\)/
    const hits = sources().filter(({ text }) => generic.test(text)).map(({ rel }) => rel)
    expect(hits).toEqual(['src/screens/elective/assignment/AssignmentPanel.jsx'])
  })
})
