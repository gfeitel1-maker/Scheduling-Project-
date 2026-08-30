// Whether a saved snapshot can actually be restored, and why not when it can't.
//
// T8: `restoreSnapshot` used to guard with a bare `if (!fullSnap?.slots) return`,
// which collapsed two genuinely different failures — "the row is gone" and "the
// row exists but its payload was never written" — into a silent no-op. A director
// clicked Restore and nothing happened, with no way to tell that anything was wrong.
//
// Snapshots written before the op-value coercion fix (af6a9d8) have NULL `slots`:
// the boolean `is_auto` threw at the better-sqlite3 bind, so every field after it
// in key order was never written. Those rows are permanently unrestorable — they
// contain nothing to restore.
//
// This lives apart from ScheduleScreen so the rule has one home and can be tested
// without standing up the whole screen. The list view and the restore action must
// agree on it: offering a snapshot the restore path will refuse is the bug.

export const UNRESTORABLE_MISSING = 'missing'
export const UNRESTORABLE_NO_PAYLOAD = 'no_payload'
export const UNRESTORABLE_UNREADABLE = 'unreadable'

// A payload is present only if `slots` holds a non-empty string. NULL, undefined,
// and '' all mean the write never landed. Note that '[]' IS restorable — a snapshot
// of a deliberately empty schedule is a legitimate thing to restore to.
export function hasPayload(snapshot) {
  return typeof snapshot?.slots === 'string' && snapshot.slots.length > 0
}

export function isRestorable(snapshot) {
  return Boolean(snapshot) && hasPayload(snapshot)
}

// Reason code for a snapshot that cannot be restored, or null if it can be.
export function unrestorableReason(snapshot) {
  if (!snapshot) return UNRESTORABLE_MISSING
  if (!hasPayload(snapshot)) return UNRESTORABLE_NO_PAYLOAD
  return null
}

// Director-facing copy. Says what happened and what they can do about it — never
// a bare failure. These strings are the only thing a director sees when a restore
// can't proceed, so they avoid naming columns, tables, or commits.
export function unrestorableMessage(reason) {
  switch (reason) {
    case UNRESTORABLE_MISSING:
      return 'That version could no longer be found. It may have been deleted on another device.'
    case UNRESTORABLE_NO_PAYLOAD:
      return 'This version was saved before a bug was fixed and did not record any schedule data, so there is nothing to restore. You can safely delete it.'
    case UNRESTORABLE_UNREADABLE:
      return 'This version appears to be corrupted and cannot be restored.'
    default:
      return 'This version cannot be restored.'
  }
}

// Parses a snapshot's stored payload into slots.
// Returns { ok: true, slots } or { ok: false, reason }.
// `slots` is JSON text (an explicitly scoped exception to field-level
// sync — see PLATFORM_STATE.md), so a parse failure is a real possibility and
// must surface rather than throw into a click handler.
export function parseSnapshotPayload(snapshot) {
  const reason = unrestorableReason(snapshot)
  if (reason) return { ok: false, reason }
  try {
    const slots = JSON.parse(snapshot.slots)
    if (!Array.isArray(slots)) {
      return { ok: false, reason: UNRESTORABLE_UNREADABLE }
    }
    return { ok: true, slots }
  } catch {
    return { ok: false, reason: UNRESTORABLE_UNREADABLE }
  }
}
