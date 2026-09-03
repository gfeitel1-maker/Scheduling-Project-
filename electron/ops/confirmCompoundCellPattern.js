// confirmCompoundCellPattern — the single writer of compound_cell_decisions
// (T118 slice 2, host-local).
//
// docs/adr/2026-09-03-compound-cell-interpretation.md.
//
// Sibling to confirmAlias.js, same architectural shape — one
// db.transaction(), host-only — with NO appendOp call: compound_cell_decisions
// is never replicated and never replayed, so this is a direct, transactional
// SQL write, the same pattern confirmAlias.js and declinedSplits.js use for
// their own host-local tables. Admin-gating at the IPC boundary is slice 4's
// job (this module isn't wired to any IPC handler yet) — nothing here should
// be read as already enforcing that.

import { randomUUID } from 'node:crypto'

const INTERPRETATIONS = new Set(['as_written', 'wrapper', 'alternatives'])

export class ConfirmCompoundCellPatternError extends Error {
  constructor(reason, detail) {
    super(`confirmCompoundCellPattern: ${reason}`)
    this.reason = reason
    this.detail = detail ?? null
  }
}

/**
 * Confirm the director's interpretation of a compound schedule cell
 * (`pattern`, the literal cell text) for `camp_id`. A second confirmation
 * for the same `(camp_id, pattern)` UPDATES the existing row rather than
 * inserting a duplicate — the UNIQUE(camp_id, pattern) constraint is the
 * scope key.
 *
 * @returns {{ id: string }}
 */
export function confirmCompoundCellPattern(
  db,
  { camp_id, pattern, interpretation, anchor_name = null, wrapper_name = null, confirmed_by = null }
) {
  if (!camp_id) throw new ConfirmCompoundCellPatternError('camp_id_required')
  const patternText = String(pattern ?? '').trim()
  if (!patternText) throw new ConfirmCompoundCellPatternError('pattern_required')
  if (!INTERPRETATIONS.has(interpretation)) {
    throw new ConfirmCompoundCellPatternError('invalid_interpretation', { interpretation })
  }
  // Red Hat (T118 slice 2 review) — 'wrapper' without both names is a row
  // slice 3's extractEntities integration cannot resolve (anchor_name is what
  // it folds the wrapper cell onto); catching it here, at the one writer,
  // beats catching it downstream at read time with no trace back to this call.
  if (interpretation === 'wrapper' && (!String(anchor_name ?? '').trim() || !String(wrapper_name ?? '').trim())) {
    throw new ConfirmCompoundCellPatternError('wrapper_requires_names', { anchor_name, wrapper_name })
  }

  const run = db.transaction(() => {
    const existing = db
      .prepare('SELECT id FROM compound_cell_decisions WHERE camp_id = ? AND pattern = ?')
      .get(camp_id, patternText)

    const now = new Date().toISOString()

    if (existing) {
      db.prepare(
        `UPDATE compound_cell_decisions
           SET interpretation = ?, anchor_name = ?, wrapper_name = ?, confirmed_by = ?, confirmed_at = ?
           WHERE id = ?`
      ).run(interpretation, anchor_name, wrapper_name, confirmed_by ?? null, now, existing.id)
      return { id: existing.id }
    }

    const id = randomUUID()
    db.prepare(
      `INSERT INTO compound_cell_decisions
         (id, camp_id, pattern, interpretation, anchor_name, wrapper_name, confirmed_by, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, camp_id, patternText, interpretation, anchor_name, wrapper_name, confirmed_by ?? null, now)
    return { id }
  })

  return run()
}
