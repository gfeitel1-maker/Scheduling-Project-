import { useState, useEffect } from 'react'
import { S } from '../../styles/shared'

// Confirmation dialog for permanently deleting a week.
// Queries real counts before rendering and shows only clauses whose count > 0.
// No type-to-confirm — named, counted button label matches the app's precedent.
export default function DeleteWeekDialog({ week, campId, localClient, repo, onConfirm, onCancel }) {
  const [counts, setCounts] = useState(null)
  const [confirming, setConfirming] = useState(false)

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
    try {
      const result = await localClient.deleteWeek({ weekId: week.id, campId })
      if (result?.error) {
        setConfirming(false)
        return
      }
      onConfirm(week.id)
    } catch {
      setConfirming(false)
    }
  }

  if (!counts) {
    return (
      <div style={overlayStyle}>
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

  const detailSentence = clauses.length > 0
    ? `Week ${week.name} has ${joinClauses(clauses)}. Deleting it removes all of that permanently — this cannot be undone.`
    : `Deleting it removes all of that permanently — this cannot be undone.`

  return (
    <div style={overlayStyle}>
      <div style={dialogStyle}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
          Permanently delete "{week.name}"?
        </h3>
        {clauses.length > 0 && (
          <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--text)', lineHeight: 1.5 }}>
            {detailSentence}
          </p>
        )}
        <p style={{ margin: '0 0 20px', fontSize: 14, fontWeight: 700, color: 'var(--warning)' }}>
          There is no way to get this week back.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
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

const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 1000,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

const dialogStyle = {
  background: 'var(--surface)', borderRadius: 12,
  padding: '24px 28px', maxWidth: 440, width: '90%',
  boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
}
