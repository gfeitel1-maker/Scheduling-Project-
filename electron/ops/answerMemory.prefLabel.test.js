// @vitest-environment node
// T280 — the elective preference import's questions in the camp's answer memory.
//
// A sheet label this camp has no activity for ("Quidditch") is a resolver miss: the director maps it to
// an activity, splits a packed cell, or adds it. That answer is now remembered (qkind `pref_label`), so
// a re-import of the same sheet asks nothing already answered, and the column layouts a director
// confirmed (`preference_column_roles`) are listed in "What Shoresh has learned" beside every other answer.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { rememberColumnMapping } from './rememberColumnMapping.js'
import { rememberImportAnswers, matchImportAnswers, listLearned } from './answerMemory.js'

afterAll(() => cleanupTemplatedDbs())

const CAMP = 'camp-1'
let db, file
beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  file = t.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP, 'Camp One')
  db.prepare("INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES ('dev-1', 'Laptop', ?, 'sec-1', 'authorized')").run(new Date().toISOString())
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('u-admin', ?, 'Dana', 'h', 's', 'admin')").run(CAMP)
})
afterEach(() => {
  db.close()
  if (file && fs.existsSync(file)) fs.unlinkSync(file)
})

let clock = Date.parse('2026-10-01T10:00:00Z')
const tick = () => new Date((clock += 60_000))
const remember = (entries) => rememberImportAnswers(db, { campId: CAMP, authorUserId: 'u-admin', deviceId: 'dev-1', importId: 'imp-1', entries, now: tick })
const label = (name, answer) => ({ other: { qkind: 'pref_label', name }, answer })
const recall = (names) => matchImportAnswers(db, { campId: CAMP, others: names.map((name) => ({ id: name, qkind: 'pref_label', name })) })

describe('pref_label: a sheet label the director resolved is remembered', () => {
  it('recalls the activity a label was mapped to, exactly', () => {
    expect(remember([label('Quidditch', { verdict: 'mapped', activity: 'Archery' })]).written).toHaveLength(1)
    const got = recall(['Quidditch', 'Broomball'])
    expect(got.Quidditch).toMatchObject({ match: 'exact', answer: { verdict: 'mapped', activity: 'Archery' } })
    expect(got.Quidditch.why).toMatch(/^Remembered from Dana's answer on /)
    expect(got.Broomball).toBeNull()
  })

  it('matches a label however the sheet capitalises or spaces it', () => {
    remember([label('Quidditch', { verdict: 'mapped', activity: 'Archery' })])
    expect(recall(['  quidditch '])['  quidditch '].answer).toEqual({ verdict: 'mapped', activity: 'Archery' })
  })

  it('remembers a split packed cell', () => {
    remember([label('Swim, Archery', { verdict: 'split' })])
    expect(recall(['Swim, Archery'])['Swim, Archery'].answer).toEqual({ verdict: 'split' })
  })

  it('the same answer again writes nothing; a different activity replaces the old one', () => {
    remember([label('Quidditch', { verdict: 'mapped', activity: 'Archery' })])
    expect(remember([label('Quidditch', { verdict: 'mapped', activity: 'Archery' })]).skipped.map((s) => s.reason)).toEqual(['unchanged'])
    expect(remember([label('Quidditch', { verdict: 'mapped', activity: 'Swim' })]).written).toHaveLength(1)
    expect(recall(['Quidditch']).Quidditch).toMatchObject({ match: 'exact', answer: { verdict: 'mapped', activity: 'Swim' } })
  })

  it('refuses a mapping with no activity, and an activity that is a camper’s name', () => {
    db.prepare("INSERT INTO campers (id, camp_id, display_name) VALUES ('c1', ?, 'Ari Feldspar')").run(CAMP)
    const out = remember([
      label('Quidditch', { verdict: 'mapped' }),
      label('Broomball', { verdict: 'mapped', activity: 'Ari Feldspar' }),
    ])
    expect(out.written).toHaveLength(0)
    expect(recall(['Quidditch', 'Broomball'])).toEqual({ Quidditch: null, Broomball: null })
  })
})

describe('What Shoresh has learned lists the elective sheet answers', () => {
  it('lists a remembered label answer with the activity it means', () => {
    remember([label('Quidditch', { verdict: 'mapped', activity: 'Archery' })])
    const learned = listLearned(db, { campId: CAMP, viewerUserId: 'u-admin' })
    expect(learned.answers).toEqual([expect.objectContaining({ qkind: 'pref_label', name: 'Quidditch', verdict: 'mapped', activity: 'Archery' })])
  })

  it('lists each confirmed column layout', () => {
    rememberColumnMapping(db, {
      campId: CAMP, matchKey: 'hdr-aa', authorUserId: 'u-admin', deviceId: 'dev-1',
      payload: { name: 'Camper', externalId: null, division: 'Bunk', ranks: [{ rank: 1, header: 'Pick A' }, { rank: 2, header: 'Pick B' }] },
    })
    const { columnLayouts } = listLearned(db, { campId: CAMP, viewerUserId: 'u-admin' })
    expect(columnLayouts).toEqual([expect.objectContaining({
      name: 'Camper', division: 'Bunk', ranks: ['Pick A', 'Pick B'], confirmedByName: 'Dana',
    })])
  })
})
