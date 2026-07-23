import { localClient } from '../localClient'

// Fields a fully-created "Main" cohort must have. A row missing any of
// these (e.g. left behind by a losing concurrent ensureCohort call, see the
// "name" ordering note below, or any other partial-write cause) is treated
// as incomplete and repaired in place rather than triggering a duplicate.
const REQUIRED_FIELDS = ['name', 'session_week_start', 'session_week_end', 'capacity_source', 'anchor_model']

const DEFAULTS = {
  name: 'Main',
  session_week_start: 1,
  session_week_end: 1,
  capacity_source: 'groups_per_slot',
  anchor_model: 'fixed',
}

function isComplete(cohort) {
  return REQUIRED_FIELDS.every((field) => cohort[field] != null && cohort[field] !== '')
}

// Called once when a campId first becomes available.
// Creates a "Main" cohort if the camp has none — covers newly created camps.
// Existing camps are handled by migration 20260527050000.
//
// Round 2 Red Hat fix (Sub-plan B Task 2):
// - HIGH finding 1 (duplicate cohorts under concurrent mounts): `name` is
//   written FIRST, not last. Each field write is its own atomic SQLite
//   transaction (see appendOp/applyProjection in electron/ops/*.js) that
//   both creates the row (via ensureExists's placeholder INSERT OR IGNORE)
//   and applies the field UPDATE together. Writing `name` first means the
//   very first thing a new-cohort attempt does is collide with the
//   electron/db/schema.sql `UNIQUE(camp_id, name)` constraint (see the
//   version-11 migration in electron/db/localDb.js for pre-existing dbs) —
//   and because that collision happens inside the SAME transaction as the
//   row's own creation, a losing concurrent call's row creation rolls back
//   with it. So the loser never gets a row at all, instead of a duplicate.
// - HIGH finding 2 (torn/partial-write state): because the loser's very
//   first write (name) is what fails, no later field write ever runs for
//   it — there's nothing left half-populated. As a defensive backstop for
//   any other partial-write cause (e.g. an app crash mid-loop), the check
//   below treats an existing-but-incomplete cohort as needing completion
//   (reusing its id, writing only the missing fields) rather than
//   "a cohort row exists, skip".
// - Round 2 Security MEDIUM fix: the catch block below distinguishes a
//   genuine UNIQUE-constraint collision (the expected race outcome) from
//   any other error by matching the error message, not by re-listing and
//   assuming "a row exists now" means success — a re-listed row could be
//   this call's OWN incomplete work, which would wrongly mask a real
//   failure (IPC death, disk error) as success.
export async function ensureCohort(campId) {
  const cohorts = await localClient.list('cohorts')
  const mismatched = cohorts.some((c) => c.camp_id !== campId)
  if (mismatched) {
    throw new Error(`ensureCohort: device camp does not match campId ${campId}`)
  }

  const existing = cohorts.find((c) => c.camp_id === campId)
  if (existing && isComplete(existing)) return

  const token = localStorage.getItem('shoresh-token')
  const id = existing ? existing.id : crypto.randomUUID()
  const fields = existing
    ? Object.fromEntries(
        REQUIRED_FIELDS.filter((f) => existing[f] == null || existing[f] === '').map((f) => [f, DEFAULTS[f]])
      )
    : { ...DEFAULTS, camp_id: campId }

  try {
    for (const [field, value] of Object.entries(fields)) {
      await localClient.write(token, 'cohorts', id, field, value)
    }
  } catch (err) {
    // Only a genuine UNIQUE(camp_id, name) constraint violation is the
    // expected outcome of the race (a concurrent call's row-creation won
    // before this one's) — any OTHER error (IPC channel death, disk error,
    // etc.) is real and must propagate, regardless of what `list` happens
    // to return afterward (round-2 Security MEDIUM finding: don't infer
    // "someone else finished it" just because a row exists — that row could
    // be THIS call's own incomplete work, or unrelated). Matching on the
    // actual constraint-violation message, rather than on existence/
    // completeness of a re-listed row, is what makes this distinction safe:
    // since `name` is written first (see above), a UNIQUE violation can
    // only ever come from a genuine concurrent winner, never from this
    // call's own later fields.
    if (!/UNIQUE/i.test(err.message ?? '')) throw err
  }
}
