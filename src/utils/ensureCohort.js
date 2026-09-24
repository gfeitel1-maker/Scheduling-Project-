import { localClient } from '../localClient'
import { deriveMainCohortId } from './mainCohortId'

// Fields a fully-created "Main" cohort must have. A row missing any of
// these (e.g. left behind by an app crash mid-loop, or any other
// partial-write cause) is treated as incomplete and repaired in place
// rather than triggering a duplicate.
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
// T241 (docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md)
// relaxed `cohorts`' `UNIQUE(camp_id, name)` to a plain non-unique index (one
// of the ten free-text-name tables it relaxed, so a peer's same-named record
// projects instead of being silently discarded). That constraint is what the
// previous version of this function's concurrency-safety relied on: writing
// `name` first so a losing concurrent call's row-creation collided with it
// and rolled back inside the same transaction, leaving the loser with no row
// at all. With the constraint gone, two concurrent calls that each mint their
// own `crypto.randomUUID()` id now genuinely create two separate "Main" rows
// — see docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md
// for why cohorts specifically cannot get the constraint back.
//
// The fix here is to make the race structurally impossible instead of
// constraint-mediated: `deriveMainCohortId` (src/utils/mainCohortId.js) always
// derives the SAME id for a given campId, so two concurrent callers minting a
// brand-new Main cohort target the same row from the start (via the `cohorts`
// projection's `ensureExists` placeholder INSERT OR IGNORE) and their field
// writes converge onto it rather than each creating its own. This is the same
// pattern electron/ops/dayId.js, electron/ops/locationId.js and
// electron/ops/scheduleTemplateId.js use for the same class of problem.
//
// An existing cohort (found by `list`, whatever id it carries — a pre-fix
// camp's row is a random crypto.randomUUID(), not the derived id) always wins
// over minting a derived one: the lookup below finds it by camp_id, not by
// re-deriving the id and checking for a row there, so a pre-existing row is
// reused and completed in place rather than orphaned alongside a second,
// derived-id row.
//
// The completion path for a partial-write row (e.g. an app crash mid-loop)
// is unchanged: an existing-but-incomplete cohort has only its missing
// fields written, reusing its existing id.
export async function ensureCohort(campId) {
  const cohorts = await localClient.list('cohorts')
  const mismatched = cohorts.some((c) => c.camp_id !== campId)
  if (mismatched) {
    throw new Error(`ensureCohort: device camp does not match campId ${campId}`)
  }

  const existing = cohorts.find((c) => c.camp_id === campId)
  if (existing && isComplete(existing)) return

  const token = localStorage.getItem('shoresh-token')
  const id = existing ? existing.id : deriveMainCohortId(campId)
  const fields = existing
    ? Object.fromEntries(
        REQUIRED_FIELDS.filter((f) => existing[f] == null || existing[f] === '').map((f) => [f, DEFAULTS[f]])
      )
    : { ...DEFAULTS, camp_id: campId }

  // Each write is checked and the first failure stops the loop — the same
  // check-and-throw shape as the sibling per-field loops in
  // src/data/scheduleRepository.js, src/data/setupCrudRepository.js and
  // src/utils/seedDays.js. A refused write RESOLVES with
  // { status: 'rejected' }, it does not throw, so without this check it
  // flows past as success and the camp is left with no complete Main
  // cohort and nothing said about it. There is no longer a UNIQUE-collision
  // case to distinguish from a real failure (see above) — every error here
  // is real and propagates to the caller.
  for (const [field, value] of Object.entries(fields)) {
    const result = await localClient.write(token, 'cohorts', id, field, value)
    if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
      throw new Error(`write failed for field "${field}"`)
    }
  }
}
