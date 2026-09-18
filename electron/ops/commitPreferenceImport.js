// T195 — commit half of the preference import service.
//
// Runs inside ONE runAtomic (the commitPlan precedent, electron/ops/ingest.js):
// re-resolves against the CURRENT snapshot first (the caller's `resolutions`
// are advisory input from a trust boundary, never trusted as-is), aborts the
// whole batch on any drift since preview, then writes every participant row
// through appendOp — never a raw SQLite statement. Does NOT write
// elective_assignments (T196 entirely).
import { createHash } from 'node:crypto'
import { appendOp, findOpByClientWriteId, runAtomic } from './operations.js'
import { recordAuditEvent } from '../audit/auditLog.js'
import { resolvePreferenceImport, IDENTITY_STATUS, IDENTITY_REASONS, CHOICE_STATUS } from '../../src/ingest/preferenceImport/resolve.js'
import { loadRunSnapshot } from './preferenceImportPreview.js'
import {
  deriveElectiveChoiceId,
  electiveChoiceLabelKey,
  deriveElectiveChoiceOfferingId,
  deriveElectivePreferenceId,
} from './electiveDerivedIds.js'

const STALE = Symbol('PREVIEW_STALE')

function deriveFieldClientWriteId(outerClientWriteId, entity, entity_id, field) {
  return createHash('sha256').update(`prefimport|${outerClientWriteId}|${entity}|${entity_id}|${field}`).digest('hex')
}

// Writes are idempotent per (outer client_write_id, entity, entity_id, field):
// a retried commit call (same outer client_write_id) re-derives the SAME
// per-field id, finds it already applied, and skips — never a second op.
function makeWriter(db, { author_user_id, device_id, client_write_id }) {
  return (entity, entity_id, field, value) => {
    const fieldClientWriteId = deriveFieldClientWriteId(client_write_id, entity, entity_id, field)
    if (findOpByClientWriteId(db, fieldClientWriteId)) return
    appendOp(db, { entity, entity_id, field, value, author_user_id, device_id, client_write_id: fieldClientWriteId })
  }
}

function choiceLabelFor(slot) {
  const names = slot.members.map((m) => m.activityName).sort()
  return names.join('+')
}

function choicesEquivalent(fresh, caller) {
  if (fresh.status !== caller.status) return false
  if (fresh.status !== CHOICE_STATUS.RESOLVED) return true
  const fm = fresh.members ?? []
  const cm = caller.members ?? []
  if (fm.length !== cm.length) return false
  return fm.every((m, i) => m.activityId === cm[i].activityId && m.occurrenceId === cm[i].occurrenceId)
}

// Confirms the caller's (director-approved) row decision is still consistent
// with what the live snapshot resolves to RIGHT NOW. A row the director
// resolved manually (a disambiguation pick, a create-new, an exclude) is
// necessarily DIFFERENT from a fresh raw resolve() — this checks the
// underlying FACT that justified the decision still holds, not byte
// equality with the preview's own output.
function isRowConsistent(freshRow, callerRow) {
  const fresh = freshRow.camper
  const caller = callerRow.camper

  if (caller.status !== IDENTITY_STATUS.BLOCKED) {
    if (fresh.status === IDENTITY_STATUS.BLOCKED) {
      if (fresh.reason !== IDENTITY_REASONS.AMBIGUOUS_SAME_GROUP) return false
      const candidateIds = (fresh.disambiguation?.candidates ?? []).map((c) => c.camperId)
      if (!caller.camperId || !candidateIds.includes(caller.camperId)) return false
    } else if (fresh.camperId && fresh.camperId === caller.camperId) {
      // An idempotent retry: the row this commit already wrote now resolves
      // as 'matched'/'offered' against the very camper this call itself
      // created (e.g. caller.status was 'offered_new' on the first attempt).
      // Same camper id, so nothing has actually drifted.
    } else {
      if (fresh.status !== caller.status) return false
      if (fresh.groupId && fresh.groupId !== caller.groupId) return false
    }
  }
  // caller.status === 'blocked' (row excluded by the director) — always consistent.

  const freshChoices = freshRow.choices ?? []
  const callerChoices = callerRow.choices ?? []
  if (freshChoices.length !== callerChoices.length) return false
  for (let i = 0; i < freshChoices.length; i += 1) {
    if (callerChoices[i].excluded) continue
    if (!choicesEquivalent(freshChoices[i], callerChoices[i])) return false
  }
  return true
}

function activityNameLookup(activityIndex) {
  const byId = {}
  for (const [name, ids] of Object.entries(activityIndex)) {
    for (const id of ids) byId[id] = name
  }
  return byId
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function commitPreferenceImport(
  db,
  { camp_id, run_id, headers, rows, mapping, resolutions, source_filename, source_sha256, author_user_id, device_id, client_write_id }
) {
  let staleRows = null
  let campersWritten = 0
  let preferencesWritten = 0

  const outcome = runAtomic(db, () => {
    const { occurrences, offeringIndex, activityIndex, roster, groups } = loadRunSnapshot(db, { camp_id, run_id })
    const fresh = resolvePreferenceImport({
      rows,
      headers,
      mapping,
      roster,
      groups,
      occurrenceIndex: occurrences,
      offeringIndex,
      activityIndex,
    })

    const drift = []
    resolutions.rowResults.forEach((callerRow, i) => {
      if (!isRowConsistent(fresh.rowResults[i], callerRow)) drift.push(i)
    })
    if (drift.length > 0) {
      staleRows = drift
      return STALE
    }

    const nameById = activityNameLookup(activityIndex)
    const write = makeWriter(db, { author_user_id, device_id, client_write_id })

    // 3. elective_occurrences — the run's frozen premise (G1), written whole.
    for (const occ of occurrences) {
      write('elective_occurrences', occ.id, 'run_id', run_id)
      write('elective_occurrences', occ.id, 'elective_set_id', occ.elective_set_id)
      write('elective_occurrences', occ.id, 'day_id', occ.day_id)
      write('elective_occurrences', occ.id, 'time_block_id', occ.time_block_id)
      write('elective_occurrences', occ.id, 'tier_id', occ.tier_id)
    }

    resolutions.rowResults.forEach((callerRow) => {
      const camper = callerRow.camper
      if (camper.status === IDENTITY_STATUS.BLOCKED) return // excluded by the director

      let camperId = camper.camperId
      if (camper.status === IDENTITY_STATUS.OFFERED_NEW) {
        const rowData = rows[callerRow.rowIndex]
        const displayName = headers[mapping.displayName] ? rowData[headers[mapping.displayName]] : ''
        write('campers', camperId, 'camp_id', camp_id)
        write('campers', camperId, 'display_name', displayName)
        write('campers', camperId, 'group_id', camper.groupId)
        write('campers', camperId, 'is_active', 1)
        campersWritten += 1
      }

      callerRow.choices.forEach((slot) => {
        if (slot.excluded || slot.status !== CHOICE_STATUS.RESOLVED) return
        const membersWithNames = slot.members.map((m) => ({ ...m, activityName: nameById[m.activityId] }))
        const label = choiceLabelFor({ members: membersWithNames })
        const labelKey = electiveChoiceLabelKey(label)
        const choiceId = deriveElectiveChoiceId(run_id, labelKey)

        write('elective_choices', choiceId, 'run_id', run_id)
        write('elective_choices', choiceId, 'label', label)
        write('elective_choices', choiceId, 'is_linked', slot.isLinked ? 1 : 0)

        for (const member of membersWithNames) {
          const offeringId = deriveElectiveChoiceOfferingId(choiceId, member.occurrenceId, member.activityId)
          write('elective_choice_offerings', offeringId, 'choice_id', choiceId)
          write('elective_choice_offerings', offeringId, 'occurrence_id', member.occurrenceId)
          write('elective_choice_offerings', offeringId, 'activity_id', member.activityId)
        }

        const preferenceId = deriveElectivePreferenceId(run_id, camperId, choiceId)
        write('elective_preferences', preferenceId, 'run_id', run_id)
        write('elective_preferences', preferenceId, 'camper_id', camperId)
        write('elective_preferences', preferenceId, 'choice_id', choiceId)
        write('elective_preferences', preferenceId, 'rank', slot.rank)
        preferencesWritten += 1
      })
    })

    write('elective_assignment_runs', run_id, 'source_filename', source_filename)
    write('elective_assignment_runs', run_id, 'source_sha256', source_sha256)
    write('elective_assignment_runs', run_id, 'status', 'draft')

    return { committed: true }
  })

  if (outcome === STALE) {
    return { committed: false, reason: 'PREVIEW_STALE', staleRows }
  }

  recordAuditEvent(db, {
    campId: camp_id,
    actorUserId: author_user_id,
    deviceId: device_id,
    action: 'elective_import.commit',
    targetType: 'elective_assignment_runs',
    targetId: run_id,
    outcome: 'allow',
    metadata: { run_id, rowCount: rows.length, blockedCount: resolutions.rowResults.filter((r) => r.blocked).length, source_sha256 },
  })

  return { committed: true, run_id, campersWritten, preferencesWritten }
}
