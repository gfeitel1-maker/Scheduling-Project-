// T264. The two sides of an elective_assignments.activity_id conflict are
// activity ids; a director reads names, and reconcile.js marks which side was
// the lock ('manual') and which the solver's ('solver').
const SOURCE_MARK = { manual: 'the lock', solver: 'the solver' }

export function activitySideText(side, activityName) {
  const name = activityName(side.value)
  const mark = SOURCE_MARK[side.source]
  return mark ? `${name} (${mark})` : name
}
