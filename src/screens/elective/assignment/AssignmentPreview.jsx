// T229 -- summary-first accordion preview of a solved assignment run: run
// summary + findings, one collapsed row per occurrence, expand to see
// per-activity camper rosters with flag chips. Never a flat table.
import { useState } from 'react'
import { S, prefersReducedMotion } from '../../../styles/shared'
import { ChevronIcon } from '../../../components/icons/index.jsx'

const FLAG_COPY = {
  NOT_TOP_CHOICE: (rank) => `Not top choice (got #${rank})`,
  NOT_REQUESTED: () => 'Not requested',
}
const FLAG_COLOR = {
  NOT_TOP_CHOICE: 'var(--accent)',
  NOT_REQUESTED: 'var(--danger)',
}

function OccurrencePanel({ occurrence, day, timeBlock, tierName, assignments, activities, campers, open, onToggle, unplacedCount }) {
  const byActivity = new Map()
  for (const a of assignments) {
    if (!byActivity.has(a.activity_id)) byActivity.set(a.activity_id, [])
    byActivity.get(a.activity_id).push(a)
  }
  const camperById = new Map(campers.map((c) => [c.id, c]))
  const activityById = new Map(activities.map((a) => [a.id, a]))
  const panelId = `occ-panel-${occurrence.id}`

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        style={{ ...S.btnSecondary, width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>{day}, {timeBlock}{tierName ? ` · ${tierName}` : ''}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {assignments.length} camper{assignments.length === 1 ? '' : 's'} · {byActivity.size} offering{byActivity.size === 1 ? '' : 's'}
          </span>
          {unplacedCount > 0 && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{unplacedCount} unplaced</span>}
          <ChevronIcon expanded={open} />
        </span>
      </button>
      <div
        id={panelId}
        style={{
          overflow: 'hidden',
          maxHeight: open ? 2000 : 0,
          opacity: open ? 1 : 0,
          transition: prefersReducedMotion() ? 'none' : 'max-height var(--motion-base) var(--ease-out), opacity var(--motion-base) var(--ease-out)',
        }}
      >
        <div style={{ padding: '10px 4px' }}>
          {[...byActivity.entries()].map(([activityId, list]) => (
            <div key={activityId} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                {activityById.get(activityId)?.name ?? '(deleted activity)'} · {list.length}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {list.map((a) => (
                  <span key={a.camper_id} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {camperById.get(a.camper_id)?.display_name ?? a.camper_id}
                    {(a.flags ?? []).map((flag) => (
                      <span key={flag} style={S.chip(FLAG_COLOR[flag] ?? 'var(--text-secondary)', true, { padding: '2px 8px', fontSize: 11 })}>
                        {FLAG_COPY[flag] ? FLAG_COPY[flag](a.preference_rank) : flag}
                      </span>
                    ))}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function AssignmentPreview({
  assignments = [], findings = [], occurrences = [], days = [], timeBlocks = [], tiers = [],
  activities = [], campers = [], role, onCommit, committing = false,
}) {
  const [openOccurrenceId, setOpenOccurrenceId] = useState(null)
  const dayById = new Map(days.map((d) => [d.id, d]))
  const timeBlockById = new Map(timeBlocks.map((t) => [t.id, t]))
  // L1 -- same day/time-block, different tier occurrences rendered an
  // IDENTICAL label, which is exactly what hid the H4 double-placement bug.
  const tierById = new Map(tiers.map((t) => [t.id, t]))

  if (assignments.length === 0) {
    return (
      <div style={S.emptyState}>
        <div style={S.emptyStateTitle}>No campers could be placed</div>
        <div style={S.emptyStateBody}>
          Check that this set has confirmed offerings with capacity, and that the sheet&apos;s ranks map to activity names that match.
        </div>
      </div>
    )
  }

  const assignmentsByOccurrence = new Map()
  for (const a of assignments) {
    if (!assignmentsByOccurrence.has(a.occurrence_id)) assignmentsByOccurrence.set(a.occurrence_id, [])
    assignmentsByOccurrence.get(a.occurrence_id).push(a)
  }
  const unplacedByOccurrence = new Map()
  for (const f of findings) {
    if (f.kind === 'NO_CAPACITY') unplacedByOccurrence.set(f.occurrence_id, (f.camper_ids ?? []).length)
  }
  const camperCount = new Set(assignments.map((a) => a.camper_id)).size

  return (
    <div>
      <div style={{ marginBottom: 12, fontSize: 13 }}>
        {camperCount} campers placed · {occurrences.length} occurrences · {findings.length} findings
      </div>
      {findings.length > 0 && (
        <ul style={{ margin: '0 0 14px', paddingLeft: 0, listStyle: 'none' }}>
          {findings.map((f, i) => (
            <li key={i} style={S.findingsRailRow('var(--danger)')}>{f.message}</li>
          ))}
        </ul>
      )}
      {occurrences.map((occ) => (
        <OccurrencePanel
          key={occ.id}
          occurrence={occ}
          day={(dayById.get(occ.day_id)?.label ?? dayById.get(occ.day_id)?.name) ?? occ.day_id}
          timeBlock={timeBlockById.get(occ.time_block_id)?.name ?? occ.time_block_id}
          tierName={tierById.get(occ.tier_id)?.name ?? null}
          assignments={assignmentsByOccurrence.get(occ.id) ?? []}
          activities={activities}
          campers={campers}
          open={openOccurrenceId === occ.id}
          onToggle={() => setOpenOccurrenceId(openOccurrenceId === occ.id ? null : occ.id)}
          unplacedCount={unplacedByOccurrence.get(occ.id) ?? 0}
        />
      ))}
      <div style={{ marginTop: 16 }}>
        <button
          className="press-97"
          onClick={onCommit}
          disabled={role !== 'admin' || committing}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnPrimary, ...S.buttonDisabled } : S.btnPrimary}
        >
          {committing ? 'Working…' : 'Commit Assignments'}
        </button>
      </div>
    </div>
  )
}
