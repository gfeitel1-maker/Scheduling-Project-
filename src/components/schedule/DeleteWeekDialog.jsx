import { useState, useEffect } from 'react'
import { S, useEnterTransition } from '../../styles/shared'

// Confirmation dialog for permanently deleting a week.
// Queries real counts before rendering and shows only clauses whose count > 0.
// No type-to-confirm — named, counted button label matches the app's precedent.
export default function DeleteWeekDialog({ week, campId, localClient, repo, onConfirm, onCancel }) {
  const [counts, setCounts] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const enterStyle = useEnterTransition('liftFade')

  useEffect(() => {
    if (!week) return
    async function fetchCounts() {
      try {
        // Slot count: template_slots across both routes for this week
        const templateData = await repo.loadTemplateData()
        const weekTemplateIds = new Set(
          (templateData.templates || [])
            .filter(t => t.week_id === week.id)
            .map(t => t.id)
        )
        const slotCount = (templateData.slots || []).filter(s => weekTemplateIds.has(s.template_id)).length

        // Exclusion row count
        const { activityExclusions, groupExclusions } = await repo.loadWeekExclusions(week.id)
        const exclusionCount = (activityExclusions || []).length + (groupExclusions || []).length

        // Snapshot count across both routes
        const snapshotCount = (templateData.snapshots || []).filter(s => weekTemplateIds.has(s.template_id)).length

        setCounts({ slotCount, exclusionCount, snapshotCount })
      } catch {
        setCounts({ slotCount: 0, exclusionCount: 0, snapshotCount: 0 })
      }
    }
    fetchCounts()
  }, [week, repo])

  async function handleConfirm() {
    setConfirming(true)
    setDeleteError(null)
    try {
      const result = await localClient.deleteWeek({ weekId: week.id, campId })
      if (result?.error) {
        setConfirming(false)
        // T194 (owner ruling R3): elective assignment runs BLOCK the delete
        // rather than being cascaded or orphaned. "Please try again" would be a
        // lie here — retrying can never succeed — so this branch names the runs
        // and tells the director what to do instead.
        if (result.error === 'has-elective-runs') {
          const names = (result.runs ?? []).map((r) => r.name || 'Untitled run')
          setDeleteError(
            `Delete its elective runs first: ${names.join(', ')}.`
          )
          return
        }
        setDeleteError("Couldn't delete the week.")
        return
      }
      onConfirm(week.id)
    } catch {
      setConfirming(false)
      setDeleteError("Couldn't delete the week.")
    }
  }

  if (!counts) {
    return (
      <div style={{ ...S.overlay, ...enterStyle }}>
        <div style={dialogStyle}>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Loading…</p>
        </div>
      </div>
    )
  }

  const { slotCount, exclusionCount, snapshotCount } = counts

  // Build the detail sentence with only non-zero clauses.
  const clauses = []
  if (slotCount > 0) {
    clauses.push(`${slotCount} scheduled ${slotCount === 1 ? 'session' : 'sessions'} across your schedules`)
  }
  if (exclusionCount > 0) {
    clauses.push(`${exclusionCount} customized activity ${exclusionCount === 1 ? 'setting' : 'settings'}`)
  }
  if (snapshotCount > 0) {
    clauses.push(`${snapshotCount} saved ${snapshotCount === 1 ? 'version' : 'versions'}`)
  }

  const detailSentence = `Deletes ${joinClauses(clauses)}.`

  return (
    <div style={{ ...S.overlay, ...enterStyle }}>
      <div style={dialogStyle}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
          Permanently delete "{week.name}"?
        </h3>
        {clauses.length > 0 && (
          <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--text)', lineHeight: 1.5 }}>
            {detailSentence}
          </p>
        )}
        <p style={{ margin: '0 0 20px', fontSize: 14, fontWeight: 700, color: 'var(--danger)' }}>
          Can't be undone.
        </p>
        {deleteError && (
          <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--danger)', lineHeight: 1.5 }}>
            {deleteError}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="press-97"
            onClick={onCancel}
            disabled={confirming}
            style={{ ...S.btnSecondary, fontSize: 13 }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirming}
            style={{ ...S.btnDanger, fontSize: 13 }}
          >
            {confirming ? 'Deleting…' : `Delete "${week.name}" permanently`}
          </button>
        </div>
      </div>
    </div>
  )
}

function joinClauses(clauses) {
  if (clauses.length === 1) return clauses[0]
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`
}

const dialogStyle = {
  background: 'var(--surface)', borderRadius: 12,
  padding: '24px 28px', maxWidth: 440, width: '90%',
  boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
}
