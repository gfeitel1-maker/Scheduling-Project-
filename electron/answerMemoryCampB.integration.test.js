// @vitest-environment node
//
// Packaged final audit (HIGH): on campB, "Add Sports as an activity?" answered "Add it" and committed was
// asked again on re-import ("0 of N answered"), and "What Shoresh has learned" stayed empty. This drives the
// REAL handlers end to end, building the entries exactly as ReconciliationScreen.apply() does.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { appendOp } from './ops/operations.js'
import { makeHandlers } from './main.js'
import { parseTextGrid } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { derivePinOnlyActivityNames } from '../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../src/ingest/activityRules.js'
import { buildReconciliationReport } from '../src/ingest/reconciliationReport.js'
import { foldTriageInputs } from '../src/screens/reconciliationTriage.js'
import { answerMemoryEntries, attachRecall } from '../src/ingest/answerRecall.js'
import { classifyDecision } from '../src/ingest/answerMemory.js'

const campB = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt'), 'utf8')

let db, handlers, token

beforeEach(async () => {
  db = openTemplatedDb().db
  const deviceId = getOrCreateDeviceId(db)
  const hostKey = ensureHostSigningKey(db)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret, signing_public_key) VALUES (?, ?, ?, ?)').run(campId, 'Camp B', 'a'.repeat(64), hostKey.public_key)
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(deviceId, deviceId)
  const write = async (args) => ({ status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: deviceId, parent_op_id: null }) })
  await createUser(db, { camp_id: campId, name: 'Dir', pin: '246810', role: 'admin' }, write)
  db.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized' WHERE id = ?").run(new Date().toISOString(), deviceId)
  handlers = makeHandlers(db, deviceId, { getAutomergeSyncNode: () => null })
  await handlers.chooseMode({ mode: 'client' })
  ;({ token } = await handlers.login({ name: 'Dir', pin: '246810' }))
})
afterEach(() => { try { db.close() } catch { /* already closed */ } })
afterAll(() => { cleanupTemplatedDbs() })

function campBInputs(lowActivities = []) {
  const p = parseTextGrid(campB)
  const prop = extractEntities(p)
  const inferred = inferFixedEvents({ pages: p.pages }, prop, {})
  const pin = derivePinOnlyActivityNames(inferred.fixedEvents, inferred.dualUseNames ?? [])
  const seenCounts = JSON.parse(JSON.stringify(prop.seenCounts ?? {}))
  for (const n of lowActivities) { seenCounts.activities = { ...(seenCounts.activities ?? {}), [n]: 1 }; seenCounts.activityUnitShare = { ...(seenCounts.activityUnitShare ?? {}), [n.toLowerCase()]: 0 } }
  return {
    approved: { groups: prop.entities.groups, days_of_operation: prop.entities.days_of_operation, time_blocks: prop.entities.time_blocks, activities: prop.entities.activities },
    fixedEvents: inferred.fixedEvents,
    ambiguousEvents: inferred.ambiguousEvents ?? [],
    activityRules: inferActivityRules(prop.entities.activities, prop.activityPages, prop.seenCounts, prop.entities.days_of_operation.length, prop.entities.groups, pin),
    pinOnlyActivityNames: [...pin],
    seenCounts,
  }
}

async function reconcile(base) {
  const r = await handlers.ingestReconcile({ token, ...base })
  return buildReconciliationReport({ planItems: r.planItems, ambiguousEvents: base.ambiguousEvents, fixedEventsReport: r.fixedEventsReport })
}

// The positive UI answer each card's primary button produces.
function primaryAnswer(d) {
  if (d.kind === 'confirm_value') return { action: 'looks_right' }
  if (d.kind === 'confirm_change') return { choice: 'accept' }
  if (d.kind === 'name_kind') return { choice: 'fixed' }
  if (d.kind === 'elective_candidate') return { choice: 'confirm' }
  if (d.kind === 'all_camp_override') return { choice: 'all_camp' }
  return null
}

describe('campB answer memory through the real handlers', () => {
  async function answerAndCommit(base, answerOf) {
    const report = await reconcile(base)
    const answers = Object.fromEntries(report.decisions.map((d) => [d.id, answerOf(d)]).filter(([, a]) => a))
    const outcome = await handlers.ingestCommit({ token, ...foldTriageInputs(base, report.decisions, answers) })
    expect(outcome.held).toBe(false)
    const entries = answerMemoryEntries(report.decisions, answers, { bulkIds: new Set() })
    const res = await handlers.rememberImportAnswers({ token, importId: randomUUID(), entries })
    return { report, answers, res }
  }
  const recalledOn = async (base) => {
    const again = await reconcile(base)
    const recallMap = await handlers.matchImportAnswers({ token, decisions: again.decisions, mode: 'add' })
    return { again, attached: attachRecall(again, recallMap) }
  }
  const learnedNames = async () => (await handlers.listLearned({ token })).answers.map((a) => a.name).sort()

  it('every card campB raises and the director answers is remembered, recalled on re-import, and listed as learned, except an accepted create (state-derived by design)', async () => {
    const base = campBInputs(['Sports'])
    const { report, res } = await answerAndCommit(base, primaryAnswer)
    const names = report.decisions.map((d) => d.entityName)
    expect(names).toContain('Sports')
    const skippedSports = res.skipped.map((s) => s.reason)
    expect(skippedSports).toEqual(['state_derived'])
    expect(await learnedNames()).toEqual(['All Camp Activity', 'Ruach', 'Shabbat'])
    // The accepted create exists now, so the next import does not ask it again; nothing to recall.
    const { again } = await recalledOn(base)
    expect(again.decisions.map((d) => d.entityName)).not.toContain('Sports')
  })

  it('a declined create ("Don\'t add") is remembered, listed, and recalled when campB is imported again', async () => {
    const base = campBInputs(['Sports'])
    const { res } = await answerAndCommit(base, (d) => (d.entity === 'activities' ? { action: 'edited' } : primaryAnswer(d)))
    expect(res.skipped).toEqual([])
    expect(await learnedNames()).toContain('Sports')
    const { again, attached } = await recalledOn(base)
    const sports = attached.decisions.find((d) => d.entityName === 'Sports')
    expect(again.decisions.map((d) => d.entityName)).toContain('Sports')
    expect(sports.recalled?.answer).toEqual({ action: 'edited' })
    expect(sports.recalled?.match).toBe('exact')
    // Declining one activity must not pre-answer a different activity of the same entity.
    const other = { ...again.decisions.find((d) => d.entityName === 'Sports'), id: 'activities:null:create:Archery', entityName: 'Archery' }
    const map = await handlers.matchImportAnswers({ token, decisions: [other], mode: 'add' })
    expect(map[other.id]?.answer ?? null).toBeNull()
  })

  it('every decision kind campB raises goes through classifyDecision to a remembered answer', async () => {
    const base = campBInputs(['Sports'])
    const report = await reconcile(base)
    for (const d of report.decisions) expect(classifyDecision(d), `${d.kind}/${d.entity}`).toBeTruthy()
  })

  it('the three fixed-event cards: Add it and Don\'t add are each remembered by name, listed, and recalled on the next import', async () => {
    const base = campBInputs()
    const first = await reconcile(base)
    const events = first.decisions.filter((d) => d.entity === 'fixed_events')
    expect(events).toHaveLength(3)
    const declined = events[2]
    const answerOf = (d) => (d.id === declined.id ? { action: 'edited' } : { action: 'looks_right' })
    const answers = Object.fromEntries(events.map((d) => [d.id, answerOf(d)]))
    const outcome = await handlers.ingestCommit({ token, ...foldTriageInputs(base, first.decisions, answers) })
    expect(outcome.held).toBe(false)
    const entries = answerMemoryEntries(first.decisions, answers, { bulkIds: new Set() })
    const res = await handlers.rememberImportAnswers({ token, importId: randomUUID(), entries })
    expect(res.skipped).toEqual([])
    expect(await learnedNames()).toEqual(events.map((d) => d.entityName).sort())

    // Accepted events now exist, so the next import does not ask them (state-derived); only the declined one returns.
    const { again, attached } = await recalledOn(base)
    expect(again.decisions.filter((d) => d.entity === 'fixed_events').map((d) => d.entityName)).toEqual([declined.entityName])
    // The memory itself holds all three: the cards as first raised recall each answer, by name, exactly.
    const recallMap = await handlers.matchImportAnswers({ token, decisions: first.decisions, mode: 'add' })
    const recalled = attachRecall(first, recallMap)
    for (const d of events) {
      const got = recalled.decisions.find((x) => x.id === d.id)
      expect(got.recalled?.answer, d.entityName).toEqual(answerOf(d))
      expect(got.recalled?.match, d.entityName).toBe('exact')
    }
    const back = attached.decisions.find((x) => x.entityName === declined.entityName)
    expect(back.recalled?.answer).toEqual({ action: 'edited' })
  })
})
