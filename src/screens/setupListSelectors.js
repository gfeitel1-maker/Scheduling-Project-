// The rows each setup screen LISTS, as pure selectors. The screen and the Roots
// home card that names it both read through these, so the card's number is the
// screen's row count by construction (audit I4: "Activities 26" beside an
// Activities screen showing 18, because the card counted pinned-event rows).
import { filterFreeChoiceActivities } from '../engine/freeChoiceActivities'

const inCamp = (campId) => (row) => row.camp_id === campId

// Activities screen catalogue: this camp's free-choice activities. Pinned-event
// rows (catalog_role 'pinned_event') back fixed events and are not listed (T266).
export function activitiesListed(activities, { campId }) {
  return filterFreeChoiceActivities((activities || []).filter(inCamp(campId)))
}

// Fixed Events / Recurring Events screens: one kind, the active cohort.
export function fixedEventsListed(rows, { campId, cohortId, kind }) {
  return (rows || []).filter((r) => inCamp(campId)(r) && r.cohort_id === cohortId && r.kind === kind)
}

// Time Blocks screen: the active cohort's blocks.
export function timeBlocksListed(rows, { campId, cohortId }) {
  return (rows || []).filter((r) => inCamp(campId)(r) && r.cohort_id === cohortId)
}
