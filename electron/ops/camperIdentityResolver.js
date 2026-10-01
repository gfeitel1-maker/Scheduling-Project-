// T321 — the shared resolve-or-mint entry point for a camper id, per ADR
// docs/adr/2026-10-01-camper-id-high-entropy-format.md Option B.
//
// WHY THIS IS ONE MODULE, used from attributeElectiveSubject.js,
// src/ingest/preferenceSheet.js (x2) and src/localClient.mock.js: the ADR's
// whole mechanism is "resolve through camper_identity_keys before minting",
// and writing that logic four times would be four chances for it to drift —
// one site forgetting the orphan-rekey check, or hashing the lookup
// differently. Every real camper-id-minting call site in the app goes through
// here instead.
//
// THE SHAPE. `deriveCamperId` (unchanged body, electiveDerivedIds.js) computes
// the LOOKUP key — a deterministic function of (camp_id, key_mode, key_value).
// If `camper_identity_keys` already has a row for that key, its `camper_id` is
// the answer (a cache hit — no new campers row is implied; the caller already
// knows the camper or is about to create one under this exact id). If not, a
// fresh random `camper_id` (mintCamperId) is minted and the mapping row is
// written — a cache miss, the genuinely-new-camper path.
//
// THE OPTION-B CONVERGENCE MECHANISM: because the mapping row's OWN id is
// `deriveCamperId`'s output, two devices racing to mint the SAME logical
// camper before syncing write to the SAME Automerge map key — a per-field
// conflict the existing reconciler already serializes, not two independent
// rows. See the ADR's "Convergence, worked through explicitly".
import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic, DELETE_FIELD } from './operations.js'
import { isHumanOwned } from './fieldProvenance.js'
import {
  deriveCamperId,
  mintCamperId,
  electiveChoiceLabelKey,
  deriveElectivePreferenceId,
  deriveElectiveAssignmentId,
} from './electiveDerivedIds.js'

// Mirrors deriveCamperId's own mode precedence (sub > ext > name) exactly —
// this function exists only to also capture the human-readable `key_value`
// deriveCamperId's opaque output deliberately does not expose.
function keyModeAndValue({ submissionKey, externalId, displayName }) {
  const submission = String(submissionKey ?? '').trim()
  if (submission.length > 0) return { keyMode: 'sub', keyValue: submission }
  const external = String(externalId ?? '').trim()
  if (external.length > 0) return { keyMode: 'ext', keyValue: external }
  // ADR decision 5: the CANONICAL key (lowercased, whitespace-stripped), not
  // the raw display name — the same value the migration back-fill writes, so
  // a pre- and post-migration row for the same camper carry the identical
  // key_value.
  return { keyMode: 'name', keyValue: electiveChoiceLabelKey(String(displayName ?? '')) }
}

function writeOp(db, { deviceId, authorUserId }) {
  return (entity, entity_id, fields, { source = null } = {}) => {
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue
      appendOp(db, {
        entity, entity_id, field, value,
        author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
        source,
      })
    }
  }
}

/**
 * Resolve a sheet-import lookup key (sub/ext/name) to a camper id, minting a
 * fresh one only on a genuine cache miss. On a cache HIT, also detects and
 * repairs the cross-device orphan case (ADR decision 3): a local `campers`
 * row this device minted for the same logical camper, under a DIFFERENT
 * random id, before this device ever saw the now-converged mapping row — its
 * preferences/assignments are moved onto the winning camper id and the
 * orphan row is deleted, following attributeElectiveSubject.js's existing
 * rekey discipline.
 *
 * @returns {{camperId: string, lookupId: string, minted: boolean, rekeyed: {camperId: string, moved: {preferences: number, assignments: number}}[]}}
 */
export function resolveOrMintCamperId(db, {
  campId, deviceId, authorUserId = null,
  submissionKey = null, arrivalId = null, externalId = null, displayName = null,
}) {
  const lookupId = deriveCamperId(campId, { submissionKey, arrivalId, externalId, displayName })
  const write = writeOp(db, { deviceId, authorUserId })

  const existing = db.prepare('SELECT camper_id FROM camper_identity_keys WHERE id = ?').get(lookupId)
  if (existing) {
    const { keyMode, keyValue } = keyModeAndValue({ submissionKey, externalId, displayName })
    const rekeyed = rekeyOrphans(db, {
      campId, deviceId, authorUserId,
      camperId: existing.camper_id, keyMode, keyValue,
    })
    return { camperId: existing.camper_id, lookupId, minted: false, rekeyed }
  }

  const camperId = mintCamperId()
  const { keyMode, keyValue } = keyModeAndValue({ submissionKey, externalId, displayName })
  runAtomic(db, () => {
    write('camper_identity_keys', lookupId, {
      camp_id: campId, key_mode: keyMode, key_value: keyValue, camper_id: camperId,
    })
  })
  return { camperId, lookupId, minted: true, rekeyed: [] }
}

// The orphan-rekey half of ADR decision 3 ("silent background rekey on next
// touch"). Scans this device's LOCAL `campers` rows for the same camp and the
// same logical key (key_mode/key_value) that are NOT the winning camper id —
// a row this device itself minted before it ever saw the now-converged
// mapping — and moves each one's preferences/assignments onto the winner,
// then deletes the orphan row. Structurally identical to
// attributeElectiveSubject.js's rekey: read-before-transaction, one
// transaction, named row last.
//
// Matched in JS, not SQL, because the canonicalization (name mode) is a JS
// function (electiveChoiceLabelKey) — the same reason the migration back-fill
// re-derives in JS rather than in a SQL expression.
function findOrphans(db, { campId, camperId, keyMode, keyValue }) {
  const candidates = db
    .prepare(
      `SELECT id, external_id, display_name FROM campers
        WHERE camp_id = ? AND id != ? AND is_unattributed IS NOT 1`
    )
    .all(campId, camperId)
  return candidates.filter((c) => {
    if (keyMode === 'ext') return String(c.external_id ?? '').trim() === keyValue
    if (keyMode === 'name') {
      // Only when the camper has no external_id — an ext-mode camper's
      // display_name is incidental, not the key it was found by, so it must
      // never be matched as a name-mode orphan of itself.
      if (String(c.external_id ?? '').trim().length > 0) return false
      return electiveChoiceLabelKey(String(c.display_name ?? '')) === keyValue
    }
    // 'sub' mode: nothing to re-derive from committed campers columns (a
    // provisional subject's identity lives in the submission, not a camper
    // row field) — sub-mode orphans cannot arise here because a provisional
    // subject is never looked up by a second device under the SAME lookup
    // key without also carrying the same (submissionKey, arrivalId), which
    // is already handled by ordinary per-field conflict resolution on the
    // camper_identity_keys row itself; nothing further to detect.
    return false
  })
}

function rekeyOrphans(db, { campId, deviceId, authorUserId, camperId, keyMode, keyValue }) {
  const orphans = findOrphans(db, { campId, camperId, keyMode, keyValue })
  if (orphans.length === 0) return []

  const write = writeOp(db, { deviceId, authorUserId })
  const remove = (entity, entity_id) =>
    appendOp(db, {
      entity, entity_id, field: DELETE_FIELD, value: 1,
      author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
    })

  const results = []
  for (const orphan of orphans) {
    const preferences = db
      .prepare(
        `SELECT id, run_id, occurrence_id, choice_id, rank, rank_kind,
                coordinate_day_label, coordinate_period_label
           FROM elective_preferences WHERE camper_id = ?`
      )
      .all(orphan.id)
      .map((p) => ({
        ...p,
        source: isHumanOwned(db, 'elective_preferences', p.id, 'choice_id') ? 'human' : 'import',
      }))
    const assignments = db
      .prepare(
        `SELECT id, run_id, occurrence_id, activity_id, choice_id, preference_rank, source, solver_generation, is_locked
           FROM elective_assignments WHERE camper_id = ?`
      )
      .all(orphan.id)

    runAtomic(db, () => {
      for (const p of preferences) {
        const coordinate =
          p.coordinate_day_label != null || p.coordinate_period_label != null
            ? { dayName: p.coordinate_day_label, periodLabel: p.coordinate_period_label }
            : null
        write(
          'elective_preferences',
          deriveElectivePreferenceId(p.run_id, camperId, p.occurrence_id ?? null, p.choice_id, coordinate),
          {
            run_id: p.run_id,
            camper_id: camperId,
            occurrence_id: p.occurrence_id ?? null,
            choice_id: p.choice_id,
            rank: p.rank,
            rank_kind: p.rank_kind,
            coordinate_day_label: p.coordinate_day_label,
            coordinate_period_label: p.coordinate_period_label,
          },
          { source: p.source }
        )
        remove('elective_preferences', p.id)
      }

      for (const a of assignments) {
        write('elective_assignments', deriveElectiveAssignmentId(a.run_id, camperId, a.occurrence_id), {
          run_id: a.run_id,
          occurrence_id: a.occurrence_id,
          camper_id: camperId,
          activity_id: a.activity_id,
          choice_id: a.choice_id,
          preference_rank: a.preference_rank,
          source: a.source,
          solver_generation: a.solver_generation,
          is_locked: a.is_locked,
        })
        remove('elective_assignments', a.id)
      }

      // The orphan's own campers row goes LAST, once nothing points at it.
      remove('campers', orphan.id)
    })

    results.push({ camperId: orphan.id, moved: { preferences: preferences.length, assignments: assignments.length } })
  }
  return results
}
