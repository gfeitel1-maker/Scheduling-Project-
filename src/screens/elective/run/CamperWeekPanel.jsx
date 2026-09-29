// T296 — one camper's elective week, on screen. Mounted on BOTH run screens
// (Draft and Final), below their own content and never in place of it: the
// occurrence-shaped view answers "who is at archery on Monday" and this one
// answers "what did this child get", and a director needs both in the same
// session (T296, "Notes for whoever takes this").
//
// Reads nothing. `rows` and `occurrences` are two facts useRunState already
// loaded from getElectiveRun, and the catalogs are the ones AssignmentPanel
// already threads down — so this adds no IPC, no new handler, and nothing to the
// database.
//
// `occurrences` IS THE RUN'S OWN SET (useRunState().occurrences), never the
// `templateOccurrences` prop the move dropdown uses. The two differ and the
// difference matters: templateOccurrences is AssignmentPanel React state set
// only by a fresh solve, so it is EMPTY for a run opened from the run list —
// which is how a director actually reaches this view — while the run's persisted
// rows are always there. Stated here once, because this is where the contract
// lives; the call sites just pass it.
//
// NOTHING HERE WRITES. Changing a camper's preferences is T297; the standing
// describeWriteFailure rule has no surface to apply to on this panel, and a
// control that looked like an edit would be the inert affordance the standing
// rule forbids.
import { useMemo, useState } from 'react'
import { S, useEnterTransition } from '../../../styles/shared'
import { buildCamperElectiveWeek, listRunCampers, rankLabel } from './camperElectiveWeek.js'

// The severity vocabulary this corner of the app already speaks
// (src/ingest/residueKinds.js's residueRailColor, ParseSummary's two summary
// styles): bronze --accent when something asks the director for a look, a
// neutral hairline when the row merely states a fact. A placement the camper
// never ranked is the former; one they ranked is the latter. Red is not in play
// — the solver did its job, and DESIGN_STANDARD §4 keeps --danger for
// destructive and error only.
const railColor = (isFallback) => (isFallback ? 'var(--accent)' : 'var(--border)')

function WeekRow({ entry }) {
  const when = [entry.dayName, entry.blockName].filter(Boolean).join(' · ')
  return (
    <div
      data-testid={`camper-week-row-${entry.assignmentId}`}
      data-fallback={String(entry.isFallback)}
      style={S.findingsRailRow(railColor(entry.isFallback))}
    >
      {/* Degrades to the occurrence id when a template edit removed the day or
          block this placement points at — an empty cell would read as a bug. */}
      <span data-testid={`camper-week-when-${entry.assignmentId}`} style={styles.when}>
        {when || entry.occurrenceId}
      </span>
      <span data-testid={`camper-week-activity-${entry.assignmentId}`} style={styles.activity}>
        {entry.activityName}
      </span>
      <span
        data-testid={`camper-week-rank-${entry.assignmentId}`}
        style={entry.isFallback ? styles.rankFallback : styles.rank}
      >
        {rankLabel(entry.rank)}
      </span>
    </div>
  )
}

function Week({ week, onClose }) {
  // A transition INTO a new state during an active session, which is what
  // DESIGN_STANDARD §8 and T250's own note reserve motion for — unlike the
  // run-state area, this panel really does arrive on a click. Its own component
  // so the hook fires on selection; inlined above it would never remount.
  const enter = useEnterTransition('liftFade')
  return (
    <div data-testid="camper-week" style={enter}>
      <button type="button" className="press-97" data-testid="camper-week-close" style={S.backBar} onClick={onClose}>
        &larr; All campers
      </button>
      <div style={styles.camperName}>{week.camperName}</div>
      <div style={styles.rows}>
        {week.entries.map((entry) => <WeekRow key={entry.assignmentId} entry={entry} />)}
      </div>
    </div>
  )
}

export default function CamperWeekPanel({ rows, occurrences, activities, days, timeBlocks }) {
  const [camperId, setCamperId] = useState(null)

  // Memoized for the reason AssignmentPanel memoizes deriveOccurrences: on the
  // Draft screen every move, lock and error re-renders this, and a run can hold
  // a few thousand rows — so an unmemoized roster pays a full scan plus a
  // locale-collated sort of every camper on each interaction.
  const campers = useMemo(() => listRunCampers(rows), [rows])
  const week = useMemo(
    () => (camperId == null
      ? null
      : buildCamperElectiveWeek({ camperId, rows, occurrences, activities, days, timeBlocks })),
    [camperId, rows, occurrences, activities, days, timeBlocks]
  )

  // Mounted only when it has campers to offer, matching RunList and
  // RunStateArea: a header over nothing reads as a broken screen.
  if (campers.length === 0) return null
  if (week) return <Week week={week} onClose={() => setCamperId(null)} />

  return (
    <div>
      <div style={styles.heading}>
        {campers.length} {campers.length === 1 ? 'camper' : 'campers'}
      </div>
      {campers.map((camper) => (
        <button
          key={camper.camperId}
          type="button"
          className="press-97"
          data-testid={`camper-week-open-${camper.camperId}`}
          style={camper.fallbackCount > 0 ? styles.camperRowAttention : S.listRow}
          onClick={() => setCamperId(camper.camperId)}
        >
          <span style={styles.camperRowName}>{camper.camperName}</span>
          <span style={S.listRowMeta}>
            {camper.placementCount} {camper.placementCount === 1 ? 'period' : 'periods'}
            {camper.fallbackCount > 0 ? ` · ${camper.fallbackCount} not requested` : ''}
          </span>
        </button>
      ))}
    </div>
  )
}

const styles = {
  heading: { ...S.sectionCount, marginBottom: 8, marginTop: 20 },
  // Same bronze cue the residue summary uses for "something here asks for you"
  // (A.residueSummaryDecide): a 3px left rail, so the director can find the
  // campers worth opening without opening all of them.
  camperRowAttention: { ...S.listRow, borderLeft: '3px solid var(--accent)' },
  camperRowName: { fontWeight: 600, fontSize: 13, color: 'var(--text)' },
  camperName: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 15,
    margin: '6px 0 10px',
  },
  rows: { border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' },
  when: { minWidth: 170, color: 'var(--text-secondary)', fontSize: 12 },
  activity: { flex: 1, fontWeight: 600 },
  rank: { fontSize: 12, color: 'var(--text-secondary)' },
  rankFallback: { fontSize: 12, color: 'color-mix(in srgb, var(--accent) 65%, var(--text))', fontWeight: 600 },
}
