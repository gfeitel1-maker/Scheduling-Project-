/**
 * Scenario 39 — T264: a lock that had not merged when another device
 * regenerated the run is never lost silently.
 *
 * Scenario 34 commits AND locks on one device, so the regenerating device
 * always sees the lock and its local skip protects the row. This scenario is
 * the case that skip cannot reach: clientA locks a seat while PARTITIONED from
 * clientB, and clientB regenerates the same run through the real
 * commitElectiveRun. B's local `is_locked` is 0 for the seat, asserted before
 * the heal, otherwise nothing below would be evidence.
 *
 * Two passes, because which writer wins each key is decided by Automerge's op
 * id order (counter, then a random actor id):
 *   - solver wins: B's commit performs far more ops than A's lock, so every
 *     contested key resolves to B's value. The row then reads is_locked=1 /
 *     source='solver' / the solver's activity. The director must be shown ONE
 *     item with a one-tap Restore.
 *   - lock wins: A pads its op counter first, so A's lock wins every key.
 *     Nothing is overwritten and no item may appear (non-vacuity of the
 *     detector: it must not fire on a healthy lock).
 * The mixed per-key outcomes (source='solver' with a stale generation, and
 * source='manual' holding the solver's activity) need op counters to line up
 * exactly and actor ids to tie-break a particular way; they cannot be forced
 * deterministically through a real merge. They are pinned at the detector
 * (getElectiveRun.test.js) and the reconciler (reconcile.test.js) instead.
 */
import {
  setupTwoJoinedDevices, partitionClients, healPartition, cleanupDirs, waitFor, configureDualWrite,
} from '../harnessAutomerge.js'
import { commitElectiveRun } from '../../../electron/ops/commitElectiveRun.js'
import { setElectiveAssignment } from '../../../electron/ops/setElectiveAssignment.js'
import { getElectiveRun } from '../../../electron/ops/getElectiveRun.js'
import { deriveElectiveAssignmentId } from '../../../electron/ops/electiveDerivedIds.js'
import { listPendingConflicts } from '../../../electron/ops/operations.js'
import { activitySideText } from '../../../src/screens/conflictSideCopy.js'
import { electiveGenerationVisibleFragment } from '../../../electron/ops/electiveGenerationPredicate.js'

const RUN = 'run-1'
const OCC = 'occ-1'
const SET = 'set-1'
const X = 'cam-1'
const SEAT = deriveElectiveAssignmentId(RUN, X, OCC)
const P = 'act-archery'
const Q = 'act-gaga'

const PARSED = {
  campers: [
    { id: X, display_name: 'Ari Green', external_id: null },
    { id: 'cam-2', display_name: 'Noa Katz', external_id: null },
  ],
  choices: [
    { label: 'Swim', labelKey: 'swim' }, { label: 'Archery', labelKey: 'archery' }, { label: 'Gaga', labelKey: 'gaga' },
  ],
  preferences: [
    { camper_id: X, occurrence_id: OCC, label: 'Swim', labelKey: 'swim', rank: 1 },
    { camper_id: 'cam-2', occurrence_id: OCC, label: 'Gaga', labelKey: 'gaga', rank: 1 },
  ],
  sameNameCampers: [],
  skippedRows: [],
}
const FIRST = [
  { camper_id: X, occurrence_id: OCC, labelKey: 'swim', activity_id: 'act-swim', preference_rank: 1 },
  { camper_id: 'cam-2', occurrence_id: OCC, labelKey: 'gaga', activity_id: Q, preference_rank: 1 },
]
const REGENERATED = [
  { camper_id: X, occurrence_id: OCC, labelKey: 'gaga', activity_id: Q, preference_rank: null },
  { camper_id: 'cam-2', occurrence_id: OCC, labelKey: 'gaga', activity_id: Q, preference_rank: 1 },
]
const OCCURRENCES = [{ id: OCC, elective_set_id: SET, day_id: 'day-1', time_block_id: 'tb-1', tier_id: null }]

const seatRow = (d) => d.db.prepare('SELECT * FROM elective_assignments WHERE id = ?').get(SEAT)
const gen = (d) => d.db.prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?').get(RUN)?.solver_generation ?? null
const visible = (d) => !!d.db
  .prepare(`SELECT 1 FROM elective_assignments a WHERE a.id = :id AND ${electiveGenerationVisibleFragment('a')}`)
  .get({ id: SEAT, gen: gen(d) })
const findings = (d) => getElectiveRun(d.db, { runId: RUN }).lockedSeatFindings
const seatConflictFields = (d) => d.db
  .prepare("SELECT field FROM conflicts WHERE resolved_at IS NULL AND entity = 'elective_assignments' AND entity_id = ? ORDER BY field")
  .all(SEAT).map((r) => r.field)
const lockedChoice = (d) => d.db
  .prepare("SELECT id FROM elective_choices WHERE run_id = ? AND label = 'Archery'").get(RUN)?.id
const hiddenLockedSeats = (d) => d.db
  .prepare(
    `SELECT COUNT(*) c FROM elective_assignments a
      WHERE a.run_id = :runId AND a.is_locked = 1 AND NOT ${electiveGenerationVisibleFragment('a')}`
  ).get({ runId: RUN, gen: gen(d) }).c

async function pass({ lockWins }) {
  const dirs = []
  let host, clientA, clientB
  const tag = lockWins ? '[lock wins]' : '[solver wins]'
  try {
    // CI only (3/3 runs, never locally): the very first join's Noise handshake is reset
    // (EncryptionFailedError: read ECONNRESET) before anything this scenario tests has run.
    // One retry of the SETUP, on that error alone; anything else fails. Root cause: T373.
    let setup
    try { setup = await setupTwoJoinedDevices() } catch (err) {
      if (err?.name !== 'EncryptionFailedError' && !/EncryptionFailed/.test(String(err?.stack))) throw err
      setup = await setupTwoJoinedDevices()
    }
    host = setup.host
    clientA = setup.clientA
    clientB = setup.clientB
    const { tmpDir, campId } = setup
    dirs.push(tmpDir)
    configureDualWrite(tmpDir)
    const devices = [['host', host], ['clientA', clientA], ['clientB', clientB]]

    const seed = [
      ['elective_sets', SET, { camp_id: campId, name: 'Electives' }],
      ['activities', 'act-swim', { camp_id: campId, name: 'Swim' }],
      ['activities', P, { camp_id: campId, name: 'Archery' }],
      ['activities', Q, { camp_id: campId, name: 'Gaga' }],
      ['elective_set_activities', 'esa-swim', { elective_set_id: SET, activity_id: 'act-swim', status: 'confirmed', capacity_mode: 'unlimited' }],
      ['elective_set_activities', 'esa-archery', { elective_set_id: SET, activity_id: P, status: 'confirmed', capacity_mode: 'unlimited' }],
      ['elective_set_activities', 'esa-gaga', { elective_set_id: SET, activity_id: Q, status: 'confirmed', capacity_mode: 'unlimited' }],
    ]
    for (const [entity, id, fields] of seed) {
      for (const [field, value] of Object.entries(fields)) await host.write({ entity, entity_id: id, field, value })
    }
    for (const [label, d] of [['clientA', clientA], ['clientB', clientB]]) {
      await waitFor(() => d.domainRow('elective_set_activities', 'esa-gaga')?.capacity_mode === 'unlimited', 10000)
        .catch(() => { throw new Error(`${tag} ${label} never received the elective set`) })
    }

    const commit = (client, assignments) => commitElectiveRun(client.db, {
      campId, deviceId: client.deviceId, name: 'Week 1 electives', runId: RUN,
      parsed: PARSED, assignments, occurrences: OCCURRENCES,
    })
    const first = commit(clientA, FIRST)
    if (!first.ok) throw new Error(`${tag} the first commit was refused: ${first.error}`)
    // A's commit reaches the Host; B's sync link is then restarted so that it
    // pulls the base state (a plain broadcast does not reach B in this harness).
    await waitFor(() => seatRow(host)?.source === 'solver', 20000)
    // The restart's redial can meet the old connection being torn down (ECONNRESET on CI);
    // retry like production's redial rather than fail the scenario on transport timing.
    await clientB.restart(`${tmpDir}/clientB-base`, campId)
    for (let attempt = 1; ; attempt++) {
      try { await clientB.reconnect(host); break } catch (err) {
        if (attempt >= 3 || !/ECONNRESET|AbortError|closed/i.test(String(err?.message ?? err))) throw err
        await new Promise((r) => setTimeout(r, 250 * attempt))
      }
    }
    for (const [label, d] of [['clientB', clientB], ['host', host]]) {
      await waitFor(() => seatRow(d)?.source === 'solver' && gen(d) != null, 15000)
        .catch(() => {
          throw new Error(`${tag} ${label} never received the solver-placed seat: ${JSON.stringify(seatRow(d))}`)
        })
    }

    await partitionClients({ tmpDir, clientA, clientB, campId })

    if (lockWins) {
      for (let i = 0; i < 400; i++) await clientA.write({ entity: 'elective_sets', entity_id: SET, field: 'name', value: `Electives ${i}` })
    }
    const lock = setElectiveAssignment(clientA.db, {
      runId: RUN, camperId: X, occurrenceId: OCC, activityId: P, locked: true, deviceId: clientA.deviceId,
    })
    if (!lock.ok) throw new Error(`${tag} the lock was refused: ${lock.error}`)
    const regen = commit(clientB, REGENERATED)
    if (!regen.ok) throw new Error(`${tag} the regeneration was refused: ${regen.error}`)

    const b = seatRow(clientB)
    if (b.is_locked !== 0 || b.activity_id !== Q || b.source !== 'solver') {
      throw new Error(`${tag} clientB should not have seen the lock before the heal (vacuous otherwise): ${JSON.stringify(b)}`)
    }
    if (seatRow(clientA).is_locked !== 1) throw new Error(`${tag} clientA did not record its own lock`)

    await healPartition({ host, clientA, clientB })

    for (const [label, d] of devices) {
      await waitFor(() => seatRow(d)?.is_locked === 1 && seatConflictFields(d).includes('activity_id'), 15000)
        .catch(() => { throw new Error(`${tag} ${label} never merged the lock and the regeneration: ${JSON.stringify(seatRow(d))} ${JSON.stringify(seatConflictFields(d))}`) })
    }
    // Every device must agree on the merged row before anything is asserted of it.
    await waitFor(() => new Set(devices.map(([, d]) => JSON.stringify(seatRow(d)))).size === 1, 10000)
      .catch(() => { throw new Error(`${tag} devices never converged on one row`) })

    // (b) the solver-owned keys (source, solver_generation) and choice_id, which
    // follows the activity, are not separate cards: the labelled activity card
    // is the only conflict the seat holds.
    for (const [label, d] of devices) {
      const fields = seatConflictFields(d)
      if (fields.join(',') !== 'activity_id') {
        throw new Error(`${tag} ${label} should hold only the activity card, got: ${fields.join(',')}`)
      }
    }

    const merged = seatRow(host)
    if (lockWins) {
      if (merged.source !== 'manual' || merged.activity_id !== P) {
        throw new Error(`${tag} could not force the lock to win every key: ${JSON.stringify(merged)}`)
      }
      for (const [label, d] of devices) {
        if (findings(d).length !== 0) throw new Error(`${tag} ${label} raised an item for a lock that survived`)
        if (!visible(d)) throw new Error(`${tag} ${label}: the locked seat is hidden`)
      }
      return
    }

    if (merged.source !== 'solver' || merged.activity_id !== Q || merged.is_locked !== 1) {
      throw new Error(`${tag} could not force the solver to win every key: ${JSON.stringify(merged)}`)
    }

    // (b2) the activity card reads names with the lock and the solver marked,
    // never a raw id.
    for (const [label, d] of devices) {
      const card = listPendingConflicts(d.db).find((m) => m.existingOp?.entity === 'elective_assignments'
        && m.existingOp.entity_id === SEAT && m.existingOp.field === 'activity_id')
      const nameOf = (id) => d.db.prepare('SELECT name FROM activities WHERE id = ?').get(id)?.name
      const texts = card ? [card.incomingOp, card.existingOp].map((side) => activitySideText(side, nameOf)).sort() : []
      if (texts.join('|') !== 'Archery (the lock)|Gaga (the solver)' || texts.some((t) => t.includes('act-'))) {
        throw new Error(`${tag} ${label}: the activity card does not read as names: ${JSON.stringify(texts)}`)
      }
    }

    // (a) exactly one item, naming the camper, the locked activity and the solver's.
    for (const [label, d] of devices) {
      const f = findings(d)
      if (f.length !== 1) throw new Error(`${tag} ${label}: expected exactly one item, got ${JSON.stringify(f)}`)
      const [item] = f
      if (item.kind !== 'LOCKED_SEAT_OVERWRITTEN' || item.camper_id !== X || item.occurrence_id !== OCC
        || item.locked_activity_id !== P || item.solver_activity_id !== Q
        || item.camper_name !== 'Ari Green' || item.locked_activity_name !== 'Archery' || item.solver_activity_name !== 'Gaga') {
        throw new Error(`${tag} ${label}: the item does not name camper, locked and solver activity: ${JSON.stringify(item)}`)
      }
    }

    // (d) one-tap Restore through the existing handler, from one device.
    const [item] = findings(clientB)
    const restored = setElectiveAssignment(clientB.db, {
      runId: RUN, camperId: item.camper_id, occurrenceId: item.occurrence_id,
      activityId: item.locked_activity_id, locked: true, deviceId: clientB.deviceId,
    })
    if (!restored.ok) throw new Error(`${tag} Restore was refused: ${restored.error}`)
    for (const [label, d] of devices) {
      await waitFor(() => {
        const r = seatRow(d)
        return r?.source === 'manual' && r.activity_id === P && r.choice_id === lockedChoice(d) && r.is_locked === 1 && visible(d)
          && findings(d).length === 0 && seatConflictFields(d).length === 0
      }, 15000).catch(() => {
        throw new Error(`${tag} ${label} did not end restored: ${JSON.stringify(seatRow(d))} items=${findings(d).length} conflicts=${seatConflictFields(d)}`)
      })
      // (e) no seat left hidden.
      if (hiddenLockedSeats(d) !== 0) throw new Error(`${tag} ${label} still has a hidden locked seat`)
    }
  } finally {
    await host?.close()
    await clientA?.close()
    await clientB?.close()
    cleanupDirs(dirs)
  }
}

export async function run() {
  await pass({ lockWins: false })
  await pass({ lockWins: true })
  return 'PASS'
}
