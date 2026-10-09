// The saved-version shape of a template_slots row: every content column, so a
// restore writes the cell back exactly as it was. Shared by the Versions panel
// (useSnapshots) and deleteRecord's safety snapshot so the two cannot drift.
export function toSnapshotSlot(s) {
  return {
    group_id: s.group_id,
    day_id: s.day_id,
    time_block_id: s.time_block_id,
    activity_id: s.activity_id,
    fixed_event_id: s.fixed_event_id,
    is_fixed_event: s.is_fixed_event,
    is_span_head: s.is_span_head,
    is_released: s.is_released,
    elective_set_id: s.elective_set_id ?? null,
    event_id: s.event_id ?? null,
    flags: s.flags || {},
  }
}
