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
// T297 ADDS THE EDIT, and this is where it belongs: this is the screen where a
// director notices "that is wrong about this child", so it is the screen where
// they fix it. The occurrence-shaped table above answers "who is at archery on
// Monday" and cannot be the place, because the question an edit answers is about
// one camper's own week.
//
// STILL NO IPC HERE. The writes are `onSetPreference`/`onRemovePreference`,
// owned by DraftRunView beside its existing writeAssignment, so the
// describeWriteFailure discipline lives in ONE place per screen rather than
// being re-implemented in a child. Both are absent on the Final screen — a
// finalized run is immutable — and the affordance is absent with them rather
// than rendered inert, per the standing rule against a control that cannot act.
import { useMemo, useState } from 'react'
import { S, useEnterTransition } from '../../../styles/shared'
import { buildCamperElectiveWeek, listRunCampers, rankLabel } from './camperElectiveWeek.js'
import { resolveCamperDisambiguators } from './runStateCopy.js'

// The severity vocabulary this corner of the app already speaks
// (src/ingest/residueKinds.js's residueRailColor, ParseSummary's two summary
// styles): bronze --accent when something asks the director for a look, a
// neutral hairline when the row merely states a fact. A placement the camper
// never ranked is the former; one they ranked is the latter. Red is not in play
// — the solver did its job, and DESIGN_STANDARD §4 keeps --danger for
// destructive and error only.
const railColor = (isFallback) => (isFallback ? 'var(--accent)' : 'var(--border)')

// Module-level, for the same reason camperElectiveWeek.js keeps its own NONE: an
// inline `= []` default mints a fresh array identity every render, and
// `preferences` is a dependency of the week useMemo below. FinalRunView passes
// neither, so an inline default made that memo miss on EVERY render of the Final
// screen — re-running a filter, a locale-collated sort and four Map builds over a
// run's whole row set, which is exactly what the memo exists to prevent.
const NONE = []
const EMPTY_OFFERINGS = {}

function WeekRow({ entry, choices, editing, onEdit, onSetPreference, onRemovePreference }) {
  const when = [entry.dayName, entry.blockName].filter(Boolean).join(' · ')
  const id = entry.assignmentId
  return (
    <div
      data-testid={`camper-week-row-${id}`}
      data-fallback={String(entry.isFallback)}
      style={S.findingsRailRow(railColor(entry.isFallback))}
    >
      {/* Degrades to the occurrence id when a template edit removed the day or
          block this placement points at — an empty cell would read as a bug. */}
      <span data-testid={`camper-week-when-${id}`} style={styles.when}>
        {when || entry.occurrenceId}
      </span>
      {editing ? (
        <>
          {/* Writes on change, the same gesture DraftRunView's own placement and
              lock controls use — no separate Save to forget. */}
          <select
            data-testid={`camper-week-choice-${id}`}
            aria-label={`Choice for ${when || entry.occurrenceId}`}
            style={styles.choiceSelect}
            defaultValue={entry.choiceId ?? ''}
            onChange={(e) => onSetPreference(entry, e.target.value)}
          >
            {/* Present ONLY when this placement matches no choice the run knows
                (the "not requested" case). Otherwise it would be a selectable
                blank that means nothing. */}
            {entry.choiceId == null ? <option value="">Not requested</option> : null}
            {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          {/* Offered only when there IS a statement to withdraw. */}
          {entry.preferenceId != null ? (
            <button
              type="button"
              className="press-97"
              data-testid={`camper-week-remove-${id}`}
              style={S.btnUtility}
              onClick={() => onRemovePreference(entry)}
            >
              Remove
            </button>
          ) : null}
          <button
            type="button"
            className="press-97"
            data-testid={`camper-week-cancel-${id}`}
            style={S.btnUtility}
            onClick={() => onEdit(null)}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <span data-testid={`camper-week-activity-${id}`} style={styles.activity}>
            {entry.activityName}
          </span>
          <span
            data-testid={`camper-week-rank-${id}`}
            style={entry.isFallback ? styles.rankFallback : styles.rank}
          >
            {rankLabel(entry.rank, entry.rankKind)}
          </span>
          {onSetPreference ? (
            <button
              type="button"
              className="press-97"
              data-testid={`camper-week-edit-${id}`}
              style={S.btnUtility}
              onClick={() => onEdit(id)}
            >
              Change
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

function Week({ week, onClose, choices, editing, onEdit, onSetPreference, onRemovePreference }) {
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
        {week.entries.map((entry) => (
          <WeekRow
            key={entry.assignmentId}
            entry={entry}
            choices={choices}
            editing={editing === entry.assignmentId}
            onEdit={onEdit}
            onSetPreference={onSetPreference}
            onRemovePreference={onRemovePreference}
          />
        ))}
      </div>
    </div>
  )
}

export default function CamperWeekPanel({
  rows, occurrences, activities, days, timeBlocks,
  // T297. All four default to their absent value, so FinalRunView's existing
  // call renders exactly the read-only week it rendered before.
  preferences = NONE, choices = NONE, onSetPreference = null, onRemovePreference = null,
  // T250 B3 — the run's own camper roster (A0.2, useRunState().campers),
  // absent-safe like the four above: a caller that hasn't been updated yet
  // renders exactly the same list it rendered before, with no disambiguator.
  campers: rosterCampers = NONE,
  // 1A (docs/work/specs/2026-10-02-elective-run-mismatch-null-identity-and-anchor-design.md)
  // — threaded straight through to buildCamperElectiveWeek; see that
  // function's own comment. Absent-safe: a caller that hasn't been updated
  // yet renders exactly the same week it rendered before.
  offeringOccurrencesByChoiceId = EMPTY_OFFERINGS,
}) {
  const [camperId, setCamperId] = useState(null)
  // Which ROW is open for editing, at most one. A week of open selects would be
  // a bulk editor, which this ticket's non-goals rule out: one camper, one
  // preference, deliberately.
  const [editing, setEditing] = useState(null)

  // Memoized for the reason AssignmentPanel memoizes deriveOccurrences: on the
  // Draft screen every move, lock and error re-renders this, and a run can hold
  // a few thousand rows — so an unmemoized roster pays a full scan plus a
  // locale-collated sort of every camper on each interaction.
  const campers = useMemo(() => listRunCampers(rows), [rows])
  // Round 2 FIX 3 — resolved once across the WHOLE picker list, so a tier
  // value is only shown when it actually tells two same-named campers apart
  // (see resolveCamperDisambiguators' own comment in runStateCopy.js).
  const disambiguators = useMemo(() => resolveCamperDisambiguators(
    campers.map((c) => {
      const roster = rosterCampers.find((r) => r.id === c.camperId)
      return { id: c.camperId, name: c.camperName, groupName: roster?.group_name, externalId: roster?.external_id }
    })
  ), [campers, rosterCampers])
  const week = useMemo(
    () => (camperId == null
      ? null
      : buildCamperElectiveWeek({
          camperId, rows, occurrences, activities, days, timeBlocks, preferences, offeringOccurrencesByChoiceId,
        })),
    [camperId, rows, occurrences, activities, days, timeBlocks, preferences, offeringOccurrencesByChoiceId]
  )

  // Mounted only when it has campers to offer, matching RunList and
  // RunStateArea: a header over nothing reads as a broken screen.
  if (campers.length === 0) return null
  if (week) {
    return (
      <Week
        week={week}
        onClose={() => { setEditing(null); setCamperId(null) }}
        choices={choices}
        editing={editing}
        onEdit={setEditing}
        onSetPreference={onSetPreference
          ? async (entry, choiceId) => {
            // The blank "Not requested" option carries no choice, so selecting
            // it is not an edit — there is nothing to state.
            if (!choiceId) return
            if (await onSetPreference({ camperId: week.camperId, entry, choiceId })) setEditing(null)
          }
          : null}
        onRemovePreference={onRemovePreference
          ? async (entry) => {
            if (await onRemovePreference({ camperId: week.camperId, entry })) setEditing(null)
          }
          : null}
      />
    )
  }

  return (
    <div>
      <div style={styles.heading}>
        {campers.length} {campers.length === 1 ? 'camper' : 'campers'}
      </div>
      {campers.map((camper) => {
        // T250 B3 / Round 2 FIX 3 — the same ' · ' separator RunIdentity
        // already uses; the value itself is collision-aware (see the
        // `disambiguators` memo above).
        const disambiguator = disambiguators.get(camper.camperId) ?? null
        return (
        <button
          key={camper.camperId}
          type="button"
          className="press-97"
          data-testid={`camper-week-open-${camper.camperId}`}
          style={camper.fallbackCount > 0 ? styles.camperRowAttention : S.listRow}
          onClick={() => setCamperId(camper.camperId)}
        >
          <span style={styles.camperRowName}>
            {camper.camperName}{disambiguator ? ` · ${disambiguator}` : ''}
          </span>
          <span style={S.listRowMeta}>
            {camper.placementCount} {camper.placementCount === 1 ? 'period' : 'periods'}
            {camper.fallbackCount > 0 ? ` · ${camper.fallbackCount} not requested` : ''}
          </span>
        </button>
        )
      })}
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
  // S.input, the app's one field chrome (every other select in the app spreads it
  // the same way — ActivitiesScreen, LocationsScreen, TimeBlocksScreen…), with
  // only the geometry overridden: `flex: 1` takes the row's flexible space so the
  // editor occupies the same band the activity name and rank did, rather than
  // reflowing the week when it opens.
  choiceSelect: { ...S.input, flex: 1, width: 'auto', padding: '3px 6px' },
  rankFallback: { fontSize: 12, color: 'color-mix(in srgb, var(--accent) 65%, var(--text))', fontWeight: 600 },
}
