// Whether a saved version is the week currently on screen.
//
// The Versions list used to answer this positionally — the first row in the
// list (the newest snapshot) was labelled "current". That is a statement about
// list order, not about the schedule, and it was wrong in both of the cases
// that matter: the auto-save taken *before* a regeneration is the pre-regen
// week, and the week preserved by the v26 orphan-slot migration was never on
// screen at all. Worse, the dropdown used the same positional flag to hide
// Restore, so the newest version — including the preserved week — could not be
// restored at all.
//
// So the question is answered honestly here instead: a version is on screen
// only if its recorded payload describes the same week as the slots and
// overlays being displayed. It is entirely normal for NO version to match.
//
// Deliberately compared: which activity (or anchor) sits in each group/day/block,
// and the overlays drawn over them. Deliberately NOT compared: `flags`, which are
// audit annotations recomputed on every run and whose key order varies by write
// path — including them would produce false negatives on an identical week.
// A false negative merely omits a badge; a false positive would tell a director
// they are looking at a week they are not.

import { parseSnapshotPayload } from './snapshotRestore'

function slotKey(s) {
  return [
    s.group_id, s.day_id, s.time_block_id,
    s.activity_id ?? '', s.anchor_id ?? '',
    s.is_anchor ? '1' : '0',
  ].join('|')
}

function overlayKey(o) {
  return [
    o.unit_id, o.day_id,
    o.from_block_order == null ? '' : String(o.from_block_order),
    o.to_block_order == null ? '' : String(o.to_block_order),
    o.label ?? '',
  ].join('|')
}

function canonical(slots, overlays) {
  return JSON.stringify({
    slots: (slots || []).map(slotKey).sort(),
    overlays: (overlays || []).map(overlayKey).sort(),
  })
}

export function snapshotMatchesSchedule(snapshot, { slots, overlays } = {}) {
  const parsed = parseSnapshotPayload(snapshot)
  if (!parsed.ok) return false
  return canonical(parsed.slots, parsed.overlays) === canonical(slots, overlays)
}
