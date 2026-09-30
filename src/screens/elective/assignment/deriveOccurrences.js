// T229 CORRECTION 1 -- occurrences for an elective set are the distinct
// (day_id, time_block_id, tier_id) cells in `template_slots` where
// `elective_set_id` matches, NOT `elective_sets.day_id`/`time_block_id`
// (nothing reads those columns for placement; schema.sql's own comment on
// `elective_occurrences` says occurrences are "re-derived from live
// template_slots on every generation (D6)").
//
// Several groups of the same tier in the same cell collapse to ONE
// occurrence -- `elective_occurrences` carries `tier_id`, not `group_id`. A
// slot whose group has no tier is excluded and emits an `UNTIERED_GROUP`
// finding rather than crashing or silently dropping the slot.
//
// Each occurrence also carries a DERIVED, NEVER-PERSISTED `group_ids`: the
// sorted, distinct list of every group whose slot created or joined that
// cell. buildAttendance.js uses it to tell a camper's own group apart from a
// same-tier sibling group that happens to share the cell; nothing else reads
// it. `elective_occurrences` writes (electron/ops/commitElectiveRun.js,
// finalizeElectiveRun.js) and `deriveElectiveOccurrenceId` both take an
// explicit field/argument list rather than spreading the occurrence object,
// so `group_ids` never reaches a persisted row or an id -- keep it that way.
//
// Pure, no IPC, no db. Grouped by `template_id` because two schedule
// templates (manual/generated) may both place this set, and neither route is
// canonical (CLAUDE.md) -- the caller decides which template's occurrences to
// solve against.
import { deriveElectiveOccurrenceId } from '../../../../electron/ops/electiveDerivedIds.js'

export function deriveOccurrences({ slots = [], groups = [], electiveSetId, runId = 'preview' } = {}) {
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const findings = []
  // template_id -> Map(cellKey -> occurrence)
  const byTemplate = new Map()

  for (const slot of slots) {
    if (slot.elective_set_id !== electiveSetId) continue
    const templateId = slot.template_id
    if (!byTemplate.has(templateId)) byTemplate.set(templateId, new Map())
    const cells = byTemplate.get(templateId)

    const group = groupById.get(slot.group_id)
    const tierId = group?.tier_id ?? null
    if (!tierId) {
      findings.push({
        kind: 'UNTIERED_GROUP',
        group_id: slot.group_id,
        message: `Group ${slot.group_id} has no division/tier -- it was skipped for assignment.`,
      })
      continue
    }

    // day_id/time_block_id are nullable on template_slots (H2). A null here
    // would throw inside deriveElectiveOccurrenceId's opaque() guard, which
    // runs unconditionally in AssignmentPanel's render body -- skip the slot
    // and surface it instead of taking the whole panel down.
    if (slot.day_id == null || slot.time_block_id == null) {
      findings.push({
        kind: 'INCOMPLETE_PLACEMENT',
        group_id: slot.group_id,
        message: `A placement of this set is missing a day or time block -- it was skipped for assignment.`,
      })
      continue
    }

    const cellKey = `${slot.day_id} ${slot.time_block_id} ${tierId}`
    if (!cells.has(cellKey)) {
      cells.set(cellKey, {
        id: deriveElectiveOccurrenceId(runId, electiveSetId, slot.day_id, slot.time_block_id, tierId),
        elective_set_id: electiveSetId,
        day_id: slot.day_id,
        time_block_id: slot.time_block_id,
        tier_id: tierId,
        group_ids: new Set(),
      })
    }
    cells.get(cellKey).group_ids.add(slot.group_id)
  }

  const templates = {}
  for (const [templateId, cells] of byTemplate) {
    templates[templateId] = {
      occurrences: [...cells.values()].map((occ) => ({ ...occ, group_ids: [...occ.group_ids].sort() })),
    }
  }
  return { templates, findings }
}
