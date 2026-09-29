// RESOLVER 5's second half: a (day label, period label) COORDINATE bound onto an
// `occurrence_id`, against ONE chosen template's occurrences.
//
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md
// §3.1 (the canonical record names a coordinate, never an occurrence_id), §11.2
// (the day/period set is KNOWN, so binding is MATCHING with mechanical checks, not
// inference), §13.2 (resolution is SOLVE-TIME and TEMPLATE-SCOPED).
//
// WHY THIS MODULE EXISTS, stated plainly because it is a regression story. T279
// round 2 made storage carry the coordinate — and nothing ever read it back. ADR
// §3.1 and `schema.sql` both said "the caller resolves the coordinate to an
// occurrence at solve time"; no caller did. The consequence was not a missing
// feature, it was a WRONG ANSWER: the engine has exactly two scopes
// (`occurrence_id`, and one whole-run scalar), so every cell of a planner
// collapsed onto that scalar, campers were placed in activities they had not
// chosen for that cell, and `preference_rank` reported a first choice that had not
// been honoured. Before the branch those sheets were refused — loudly and wrongly.
// We had replaced a loud failure with a confident wrong answer, which is the exact
// defect class this whole program exists to remove.
//
// PURE, and it does not MUTATE its input. That is not tidiness:
//
//   The stored preference row keeps its coordinate and never gains a resolved
//   `occurrence_id`, because the coordinate set is PER-TEMPLATE and the two
//   candidate schedule routes may bind one coordinate differently. Writing a
//   resolved occurrence back onto the row would make one route canonical, and
//   CLAUDE.md forbids the app designating either. So resolution is in-memory, per
//   solve, per template.
//
// That also answers the dual-row hazard a review raised (`deriveElectivePreferenceId`'s
// `occ` arm ignores the coordinate, and `commitElectiveRun` never prunes a run's
// existing preference rows, so committing one run twice — once coordinate-scoped and
// once occurrence-scoped — would leave BOTH rows live for one logical preference).
// Nothing here writes, so there is no second row to reconcile. The `at` arm stays
// the stored truth and the `occ` arm stays for callers that genuinely had an
// occurrence to begin with.

// T297 moved `key`/`periodAliases` into src/ingest/preferenceCoordinateKeys.js
// unchanged, so the EDIT path (electron/ops/setElectivePreference.js) recognises
// a cell's stored rows by exactly the rule this module binds them by. Two copies
// would let the edit path miss a row the solver does bind to that cell, leaving
// the superseded row live to tie with the correction.
import { coordinateKey as key, periodAliases } from '../../../ingest/preferenceCoordinateKeys.js'

/**
 * Bind each preference's coordinate onto an occurrence of ONE template.
 *
 * @param {object}  args
 * @param {Array}   args.preferences  parsed preferences; a `coordinate` is
 *   `{dayName, periodLabel}` with either leg nullable, and an existing
 *   `occurrence_id` is left untouched.
 * @param {Array}   args.occurrences  that template's occurrences, from
 *   `deriveOccurrences(...).templates[chosenTemplateId].occurrences`.
 * @param {Array}   args.days         the camp's `days_of_operation` ({id, label}).
 * @param {Array}   args.timeBlocks   the camp's `time_blocks` ({id, name}).
 * @param {string}  [args.templateId] named in residue, because §13.2's answer is
 *   per-template and two routes may disagree.
 *
 * @returns {{preferences: Array, residue: Array}} new preference objects, plus the
 *   loud half: a coordinate that bound to nothing is REPORTED, never dropped and
 *   never guessed at.
 */
export function resolvePreferenceCoordinates({
  preferences = [],
  occurrences = [],
  days = [],
  timeBlocks = [],
  templateId = null,
} = {}) {
  const dayIdByLabel = new Map(days.map((d) => [key(d.label), d.id]))
  const blockIdByLabel = new Map(timeBlocks.map((b) => [key(b.name), b.id]))

  // (day_id, time_block_id) -> occurrence. A tier-spanning set can place the same
  // coordinate for several tiers; `buildAttendance` is what scopes a camper to a
  // tier, so the FIRST occurrence at a cell is taken here and tier selection stays
  // where it already lives rather than being re-decided in two places.
  const occurrenceAtCell = new Map()
  for (const o of occurrences) {
    const cell = `${o.day_id}\u0000${o.time_block_id}`
    if (!occurrenceAtCell.has(cell)) occurrenceAtCell.set(cell, o)
  }

  const residue = []
  const reported = new Set()
  const report = (kind, message, extra) => {
    // One item per distinct coordinate, not per preference: a 100-camper sheet
    // naming the same missing cell produces one sentence a director can act on,
    // not a hundred.
    const dedupe = `${kind}\u0000${extra.dayName ?? ''}\u0000${extra.periodLabel ?? ''}`
    if (reported.has(dedupe)) return
    reported.add(dedupe)
    residue.push({ kind, message, templateId, ...extra })
  }

  const resolved = preferences.map((p) => {
    if (p.occurrence_id != null) return p
    const coordinate = p.coordinate
    if (!coordinate || (coordinate.dayName == null && coordinate.periodLabel == null)) return p

    const { dayName, periodLabel } = coordinate
    const dayId = dayName == null ? null : dayIdByLabel.get(key(dayName)) ?? null
    const blockId =
      periodLabel == null
        ? null
        : periodAliases(periodLabel).map((k) => blockIdByLabel.get(k)).find((v) => v != null) ?? null

    // THE DOMAIN CHECK (§11.2 check 1). Electives are a schedule INSIDE an
    // already-defined day, so the day and period sets are known: a coordinate
    // naming one this camp does not have is PROVABLY wrong, not ambiguous. Refuse
    // to bind it and say so — never bind it to the nearest thing.
    const missing = []
    if (dayName != null && dayId == null) missing.push(`day “${dayName}”`)
    if (periodLabel != null && blockId == null) missing.push(`period “${periodLabel}”`)
    if (missing.length > 0) {
      report(
        'COORDINATE_NOT_IN_CAMP',
        `A choice was written for ${missing.join(' and ')}, which this camp does not have, so it ` +
          'could not be placed. Nothing was guessed at — check the day and period names on the ' +
          'sheet against the ones this camp uses.',
        { dayName, periodLabel }
      )
      return p
    }

    // Both legs are needed to name a cell. A half-coordinate (a day with no
    // period) cannot pick one occurrence out of that day's several, and choosing
    // arbitrarily is the silent wrong answer this module exists to stop.
    if (dayId == null || blockId == null) {
      report(
        'COORDINATE_INCOMPLETE',
        `A choice was written for ${dayName ?? 'an unnamed day'} ${periodLabel ?? '(no period given)'}, ` +
          'which names only half of a cell — a day without a period, or a period without a day, ' +
          'does not say which session it means, so it was left unplaced rather than assigned to a ' +
          'guess.',
        { dayName, periodLabel }
      )
      return p
    }

    const occurrence = occurrenceAtCell.get(`${dayId}\u0000${blockId}`)
    if (!occurrence) {
      // A real day and a real period, but THIS template puts no elective cell
      // there. The camper asked for a session this schedule does not have, which
      // the director needs to know — and the other candidate route may well have
      // it, which is why the template is named (§13.2).
      report(
        'COORDINATE_NOT_IN_TEMPLATE',
        `A choice was written for ${dayName} ${periodLabel}, which is a real day and period at this ` +
          'camp but has no elective session in the schedule being filled. That choice could not be ' +
          'placed here — the other schedule may have that session.',
        { dayName, periodLabel }
      )
      return p
    }

    return { ...p, occurrence_id: occurrence.id }
  })

  return { preferences: resolved, residue }
}
