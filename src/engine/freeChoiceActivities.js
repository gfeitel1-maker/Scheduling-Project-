// The ONE place the question "is this activity a free choice?" is answered.
//
// Ingest walks the schedule three times: pass 1 pulls FIXED events (carpool),
// pass 2 pulls RECURRING events (lunch), pass 3 pulls ACTIVITIES. The product
// owner's rule, in his words: "once something is pulled from the first or second
// pass it should no longer be available to be pulled out in the third."
//
// Pass 1/2 record their claim as `activities.catalog_role = 'pinned_event'`
// (schema v75, T266). The row is NOT deleted — that is the whole point. An
// anchor references its activity BY NAME (src/engine/anchorActivityLink.js;
// there is no activity_id column), and both don't-schedule-twice suppressions
// resolve through that name. Remove the row and the suppression becomes a silent
// no-op and the event is placed twice, with no error and no finding. So pass 1/2
// leaves a MARKER, NOT A HOLE: present for name resolution, absent from every
// menu.
//
// WHY THIS IS ONE SHARED FUNCTION AND NOT A FILTER WRITTEN AT EACH SITE.
// `electiveGenerationVisibleFragment` exists for the same reason: a second
// hand-written copy of a visibility rule is how the UI and the export come to
// disagree about what exists. There are seven readers of the free-choice pool
// and they must not drift. Add a reader, call this; do not re-derive it.
//
// THIS PREDICATE ANSWERS EXACTLY ONE QUESTION AND MUST NOT ACQUIRE A SECOND.
// In particular it is NOT a group-eligibility check and must never become one.
// Whether a group is eligible for an activity is a separate, deliberately
// inconsistent concern (the inline typeahead narrows by eligibility as a
// convenience; the drag palette does not, and that asymmetry is intended — the
// owner ruled on 2026-09-26 that a director dragging an activity onto a group
// knows whether that group does it, and that a guard presuming otherwise removes
// a capability rather than a hazard). "Hide pinned events" and "hide ineligible
// activities" are both loosely describable as "narrow the list" and they are not
// the same thing. Keep them separate at every call site: pass this predicate
// alongside whatever eligibility logic a site already has, never folded into it.
//
// Lives in src/engine/ and imports nothing, so the engine keeps its
// no-dependencies purity and every other layer can read it.

// NULL / undefined / '' all mean "an ordinary free-choice activity". Only an
// explicit claim excludes. Defaulting the OTHER way would hide the entire
// catalogue on any pre-v75 row, which is the loud failure — but it would also
// mean a column read failure silently empties the palette, so the permissive
// default is deliberate: an unmarked row is a free choice.
export const PINNED_EVENT_ROLE = 'pinned_event'

export function isFreeChoiceActivity(activity) {
  return activity?.catalog_role !== PINNED_EVENT_ROLE
}

// The list form, for the call sites that hold an array. Returns a NEW array and
// never mutates its input. A null/undefined list yields [].
export function filterFreeChoiceActivities(activities) {
  return (activities || []).filter(isFreeChoiceActivity)
}

// The inverse, for the places that want to SHOW pinned events as pinned events
// (an anchors/events screen), rather than hide them.
export function isPinnedEventActivity(activity) {
  return activity?.catalog_role === PINNED_EVENT_ROLE
}
