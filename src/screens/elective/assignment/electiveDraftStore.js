// Board item i-elective-attendance-residuals (a) -- an in-progress elective
// preference-sheet import exists only as AssignmentPanel's own useState: rows,
// mapping, parsed, result, occurrences, resolutions are all nulled the moment
// the panel unmounts. A DIVISION_ROSTER_MISMATCH finding's own message tells
// the director to go fix a camper's group -- and doing that (on the
// Campers/Groups screen) unmounts this panel and discards the whole parsed
// sheet, forcing a re-upload.
//
// This is a module-level, camp+set-scoped IN-MEMORY draft of the PRE-COMMIT
// inputs only -- never `result`/`findings`/`assignments`. Those are always
// recomputed by a fresh solve() against whatever the roster looks like when
// the panel remounts, which is the whole point: a corrected group must CLEAR
// a stale finding, not carry it over frozen from before the fix.
//
// Session-scoped by design (the ruled approach is explicit that this is NOT
// persistence across an app restart): it lives only as long as this Map does,
// i.e. the renderer process, and is never written to disk.
const drafts = new Map()

function draftKey(campId, electiveSetId) {
  return `${campId}:${electiveSetId}`
}

export function getDraft(campId, electiveSetId) {
  return drafts.get(draftKey(campId, electiveSetId)) ?? null
}

export function saveDraft(campId, electiveSetId, draft) {
  drafts.set(draftKey(campId, electiveSetId), draft)
}

export function clearDraft(campId, electiveSetId) {
  drafts.delete(draftKey(campId, electiveSetId))
}

// Test-only. `drafts` is a module singleton, so without this one test file's
// saved draft leaks into the next.
export function __clearAllElectiveDrafts() {
  drafts.clear()
}

// Round 2, Red Hat LOW — a Vite HMR update of this module keeps the OLD
// module instance's `drafts` Map alive (HMR replaces the module but the
// closure the old instance captured is not garbage until nothing references
// it), so a dev-only edit elsewhere in this directory can resurrect a stale
// draft from before the reload. Production bundles have no `import.meta.hot`.
if (import.meta.hot) {
  import.meta.hot.dispose(() => drafts.clear())
}
