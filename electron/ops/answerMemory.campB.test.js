// @vitest-environment node
// Predicates 1-4 of docs/adr/2026-10-11-import-answer-memory.md on the real campB file, at the data
// level: the decisions the reconciliation report raises for campB, answered, remembered, and recalled
// on a re-import of the same bytes. (The pure part of the pipeline: file -> entities -> fixed events ->
// report. Plan-item decisions need a camp database and are exercised in answerMemory.test.js.)
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { parseTextGrid } from '../../src/ingest/textGrid.js'
import { extractEntities } from '../../src/ingest/extractEntities.js'
import { capturePlacements } from '../../src/ingest/capturePlacements.js'
import { detectAllCampOverrides } from '../../src/ingest/allCampOverrides.js'
import { inferFixedEvents } from '../../src/ingest/fixedEvents.js'
import { buildReconciliationReport } from '../../src/ingest/reconciliationReport.js'
import { signatureOfOther } from '../../src/ingest/answerMemory.js'
import { rememberImportAnswers, matchImportAnswers, forgetAnswer, changeAnswer, liveRecords } from './answerMemory.js'

afterAll(() => cleanupTemplatedDbs())

const CAMP = 'camp-1'
const campB = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt'), 'utf8')

// What a director is asked about campB, built the way the review screen builds it. Since main's
// #889/#903 the questions are few: a meal is kept whether answered or not, and a probable all-camp
// override of a name that is itself a pinned event is folded into that event's one question. So
// campB now asks about three events (All Camp Activity, Ruach, Shabbat) and nothing else.
function campBParts() {
  const parsed = parseTextGrid(campB)
  const proposal = extractEntities(parsed)
  const { placements } = capturePlacements(parsed, proposal)
  const findings = detectAllCampOverrides(placements, proposal.entities.groups)
  const { fixedEvents, ambiguousEvents } = inferFixedEvents(parsed, proposal, {})
  return { findings, fixedEvents, ambiguousEvents }
}

function campBDecisions() {
  const { findings, fixedEvents, ambiguousEvents } = campBParts()
  const report = buildReconciliationReport({
    planItems: [], readiness: [], allCampOverrides: findings, ambiguousEvents,
    fixedEventsReport: { created: fixedEvents.map((f) => ({ name: f.name, confidence: f.confidence, time_block: f.time_block, days: f.days })) },
  })
  return report.decisions
}

// campB's own all-camp findings as questions, for the exclusion variants. The review no longer asks
// them for campB (their names are pinned events), but the same findings are what a camp that does not
// pin the name is asked, so they are the honest source of an exclusion decision here.
function campBExclusionDecisions() {
  const { findings } = campBParts()
  return buildReconciliationReport({ planItems: [], readiness: [], allCampOverrides: findings }).decisions.filter((d) => d.kind === 'all_camp_override')
}

// Answers a thoughtful director might give: a mix of accepting and rejecting.
function answerFor(d, i) {
  if (d.kind === 'all_camp_override') return { choice: i % 2 ? 'all_camp' : 'as_written' }
  return i % 3 === 0 ? { action: 'edited' } : { action: 'looks_right' }
}

let db, file, clock = Date.parse('2026-10-01T10:00:00Z')
const tick = () => new Date((clock += 60_000))
beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  file = t.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP, 'Camp B')
  db.prepare("INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES ('dev-1', 'Laptop', ?, 'sec', 'authorized')").run(new Date().toISOString())
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('u-admin', ?, 'Dana', 'h', 's', 'admin')").run(CAMP)
})
afterEach(() => {
  db.close()
  if (file && fs.existsSync(file)) fs.unlinkSync(file)
})

const answerAll = (decisions, importId = 'imp-1') => rememberImportAnswers(db, {
  campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', importId, now: tick,
  entries: decisions.map((decision, i) => ({ decision, answer: answerFor(decision, i) })),
})
const recall = (decisions) => matchImportAnswers(db, { campId: CAMP, decisions })

describe('predicate 1: answer campB, re-import it, zero repeat questions', () => {
  it('asks N questions on the first import, and remembers every one', () => {
    const decisions = campBDecisions()
    expect(decisions.length).toBeGreaterThanOrEqual(3)
    expect(decisions.every((d) => d.entity === 'fixed_events')).toBe(true)
    const first = recall(decisions)
    expect(Object.values(first).filter((r) => r?.autoApply)).toHaveLength(0)
    const w = answerAll(decisions)
    expect(w.written).toHaveLength(decisions.length)
  })

  it('on the same bytes: identical decision ids, every answered decision exact, none unresolved, each with date and author', () => {
    const decisions = campBDecisions()
    answerAll(decisions)
    const again = campBDecisions()
    expect(again.map((d) => d.id)).toEqual(decisions.map((d) => d.id))
    const got = recall(again)
    for (const [i, d] of again.entries()) {
      const r = got[d.id]
      expect(r, d.id).toMatchObject({ tier: 0, match: 'exact', autoApply: true, answeredBy: 'u-admin', answeredByName: 'Dana' })
      expect(r.answeredAt).toMatch(/^2026-10-01/)
      expect(r.answer).toEqual(answerFor(d, i))
    }
  })

  it('looks_right is stored only as evidence, never as instance memory', () => {
    answerAll(campBDecisions())
    const { answers } = liveRecords(db, CAMP)
    const accepted = answers.filter((a) => a.answer.verdict === 'accept')
    expect(accepted.length).toBeGreaterThan(0)
    expect(accepted.every((a) => a.role === 'evidence')).toBe(true)
    expect(answers.filter((a) => a.role === 'instance').every((a) => a.answer.verdict !== 'accept')).toBe(true)
  })

  it('next season: re-importing the same camp after other answers still applies the memory (no carry code exists)', () => {
    const decisions = campBDecisions()
    answerAll(decisions, 'imp-2025')
    answerAll([{ id: 'x', kind: 'confirm_value', entity: 'fixed_events', entityName: 'Something Else', timeBlock: '09:00-09:40', days: ['Monday'] }], 'imp-other')
    const got = recall(campBDecisions())
    expect(Object.values(got).every((r) => r?.match === 'exact')).toBe(true)
  })

  it('no camper name appears in any payload written from a campB import', () => {
    for (const [id, name] of [['c1', 'Rivka Stern'], ['c2', 'Ari Katz']]) db.prepare('INSERT INTO campers (id, camp_id, display_name) VALUES (?, ?, ?)').run(id, CAMP, name)
    answerAll(campBDecisions())
    for (const row of db.prepare('SELECT payload FROM camp_seedlings').all()) {
      expect(row.payload).not.toMatch(/rivka|stern|ari katz/i)
    }
  })
})

describe('predicate 2: a variant file asks only what is genuinely new', () => {
  it('a renamed day and a reformatted time are still exact; an extra group or a new excluded group is a near; a new activity asks', () => {
    const decisions = campBDecisions()
    answerAll(decisions)
    const fixed = decisions.find((d) => d.entity === 'fixed_events' && d.days.includes('Thursday'))
    const variant = { ...fixed, days: fixed.days.map((x) => (x === 'Thursday' ? 'Thurs' : x)), timeBlock: fixed.timeBlock.replace(/^0/, '') }
    expect(recall([variant])[fixed.id]).toMatchObject({ match: 'exact', autoApply: true })

    const [ex] = campBExclusionDecisions()
    expect(ex.kind).toBe('all_camp_override')
    answerAll([ex])
    const moreAttending = { ...ex, evidence: { ...ex.evidence, attendingCount: ex.evidence.attendingCount + 1 } }
    expect(recall([moreAttending])[ex.id]).toMatchObject({ match: 'near', autoApply: false })
    const newGroup = { ...ex, evidence: { ...ex.evidence, missingGroups: [...ex.evidence.missingGroups, 'Brand New Group'] } }
    expect(recall([newGroup])[ex.id]).toMatchObject({ match: 'near', autoApply: false })

    const fresh = { id: 'fresh', kind: 'confirm_value', entity: 'fixed_events', entityName: 'Totally New Event', timeBlock: '10:00-10:40', days: ['Monday'] }
    expect(recall([fresh]).fresh).toBeNull()
  })
})

describe('predicate 3: changing an answer updates the memory', () => {
  it('Change updates recall; Forget makes that question ask again; the rest are untouched', () => {
    const decisions = campBDecisions()
    answerAll(decisions)
    const target = decisions.find((d) => d.entity === 'fixed_events')
    const before = recall([target])[target.id]
    const mem = liveRecords(db, CAMP).answers.find((a) => a.id === before.memoryId)
    const flip = mem.answer.verdict === 'accept' ? 'reject' : 'accept'
    expect(changeAnswer(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', memoryId: mem.id, verdict: flip, now: tick }).ok).toBe(true)
    const after = recall([target])[target.id]
    expect(after.answer).not.toEqual(before.answer)
    expect(after.match).toBe('exact')
    forgetAnswer(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', memoryId: after.memoryId })
    expect(recall([target])[target.id]).toBeNull()
    const others = decisions.filter((d) => d.id !== target.id)
    expect(Object.values(recall(others)).filter((r) => r?.match === 'exact')).toHaveLength(others.length)
  })
})

describe('predicate 4: every kind of thing is remembered', () => {
  it('fixed event, recurring event, elective, activity change, drift acknowledgement and exclusion each round-trip', () => {
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-1', ?, 'Swim')").run(CAMP)
    const cases = [
      [{ id: 'a', kind: 'confirm_value', entity: 'fixed_events', entityName: 'Lunch 1', timeBlock: '12:00-12:40', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], evidence: { basis: 'daily' } }, { action: 'edited' }],
      [{ id: 'b', kind: 'confirm_value', entity: 'fixed_events', entityName: 'Swim Meet', timeBlock: '12:00-12:40', days: ['Tuesday', 'Thursday'], evidence: { basis: 'weekly' } }, { action: 'edited' }],
      [{ id: 'c', kind: 'elective_candidate', entity: 'elective_sets', entityName: 'Elective Block' }, { choice: 'decline' }],
      [{ id: 'd', kind: 'confirm_change', entity: 'activities', entityId: 'act-1', entityName: 'Swim', field: ['priority'], proposedValue: 'high', currentValue: 'low' }, { choice: 'keep' }],
      [{ id: 'e', kind: 'confirm_change', entity: 'fixed_events', entityName: 'Lunch 1', field: null, from: 'a', to: 'b', timeBlock: '12:00-12:40', days: ['Monday'] }, { ack: true }],
      [{ id: 'f', kind: 'all_camp_override', entity: 'activities', entityName: 'Trip', evidence: { day: 'Monday', block: '01:00-01:40', missingGroups: ['CIT'], insteadByGroup: {}, attendingCount: 5, occurrences: 1 } }, { choice: 'as_written' }],
    ]
    rememberImportAnswers(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', importId: 'i', now: tick, entries: cases.map(([decision, answer]) => ({ decision, answer })) })
    const got = recall(cases.map(([d]) => d))
    for (const [d, answer] of cases) expect(got[d.id], d.id).toMatchObject({ match: 'exact', answer })
  })

  it('split, merge and residue (session-state questions) round-trip through a signature', () => {
    const entries = [
      { other: { qkind: 'split', name: 'Swim Return', patterns: { days: ['Monday'] } }, answer: { verdict: 'accept' } },
      { other: { qkind: 'merge', variants: ['Arts & Crafts', 'Arts and Crafts'], target: 'act-9' }, answer: { verdict: 'decline' } },
      { other: { qkind: 'residue', name: 'Mystery Cell', candidates: ['act-1', 'act-2'] }, answer: { verdict: 'mapped' } },
    ]
    const w = rememberImportAnswers(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', importId: 'i', now: tick, entries })
    expect(w.written).toHaveLength(3)
    const others = entries.map((e, i) => ({ id: `o${i}`, ...e.other }))
    const got = matchImportAnswers(db, { campId: CAMP, others })
    entries.forEach((e, i) => expect(got[`o${i}`]).toMatchObject({ match: 'exact', answer: e.answer }))
    expect(signatureOfOther('split', { name: 'x' }).qkind).toBe('split')
  })
})
