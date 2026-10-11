// An unanswered question keeps the file's meaning: a low-confidence event the
// file shows on a daily or weekly pattern (All Camp, Ruach, Shabbat), and any
// meal ("Lunch 3", "Menucha"), still imports. A sibling-basis event that is
// not a meal ("Specialty 4", "Snack Shack") is held. One predicate, shared by
// the hold-back (reconciliationResolutions) and the backing activity row
// (buildPlan), so the row and its event can never disagree.
const MEAL_NAME = /^(lunch|menucha|breakfast|dinner|snack)(\s*\d+)?$/i

export function eventKeptWhenUnanswered(fe) {
  return fe?.support?.basis === 'daily' || fe?.support?.basis === 'weekly' || MEAL_NAME.test(String(fe?.name ?? '').trim())
}
