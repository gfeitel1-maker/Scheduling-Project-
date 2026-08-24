// The dedicated elective sub-schedule screen — Electives Slice 1
// (docs/adr/2026-08-22-nested-schedules-electives-and-events.md §2,
// docs/work/specs/2026-08-22-electives-nested-schedule-slices.md Slice 1).
//
// "The somewhere else that holds the data and is editable." A director
// builds an elective SET (a named period's worth of offerings) and, inside
// it, manages OFFERINGS — member activities, each carrying location/staff/
// eligibility (read from the activity, never duplicated) plus an editable
// capacity (camper_headcount, v39). Reuses the shared setup-CRUD seam
// (setupCrudRepository/useCrudScreen, PR #53 pattern) exactly like every
// other setup screen.
//
// No campers roster, no solver (ADR §2) — this screen only holds and
// displays what the director decides.
import { useState, useRef } from 'react'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { S, useEnterTransition } from '../styles/shared'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'

const repository = createSetupCrudRepository({ localClient })
const setScopeFilter = (row, campId) => row.camp_id === campId

function ElectiveSetRow({ set, onBuild, onSave, onDelete, role }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(set.name)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(set.id, { name: name.trim() })
      setEditing(false)
    } catch {
      // onSave already surfaced the error; stay in edit mode so nothing is lost.
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={S.td}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            style={S.input}
          />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button className="press-97" onClick={save} disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="press-97" onClick={() => { setName(set.name); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ ...S.td, fontWeight: 500 }}>
        {set.name || '(untitled set)'}
      </td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button className="press-97" onClick={() => onBuild(set)} style={S.btnSecondary} title="Build this set's offerings from Electives under Schedule">Open</button>
        <button className="press-97" onClick={() => setEditing(true)} style={{ ...S.btnSecondary, marginLeft: 6 }}>Rename</button>
        <button
          onClick={() => onDelete(set)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
        >
          Delete
        </button>
      </td>
    </tr>
  )
}

export default function ElectivesScreen({ campId, role, onNavigate }) {
  const { rows: sets, loading, error, setError, adding, add, save, reload } = useCrudScreen({
    entity: 'elective_sets',
    campId,
    localClient,
    repository,
    scopeFilter: setScopeFilter,
    // name FIRST — elective_sets is UNIQUE_FIRST_FIELD-registered (UNIQUE(camp_id,
    // name)); the unique field must write first so a collision is detectable and
    // no orphaned blank-name row can be materialized. See setupCrudRepository.
    buildCreateFields: ({ name }) => ({ name, camp_id: campId }),
    addFailedText: 'That elective set could not be added.',
    saveFailedText: 'That elective set could not be saved.',
  })

  const [newName, setNewName] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const nameRef = useRef()
  const enter = useEnterTransition('liftFade')

  async function addSet() {
    if (!newName.trim()) return
    const succeeded = await add({ name: newName.trim() })
    if (succeeded) setNewName('')
  }

  async function confirmDeleteSet() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const result = await localClient.deleteElectiveSet({ electiveSetId: pendingDelete.id })
      if (!result || result.error) throw new Error(result?.error ?? 'delete-failed')
      await reload()
    } catch (err) {
      setError(describeWriteFailure(err, 'That elective set could not be deleted.'))
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      {error && <div style={S.errorBanner}>{error}</div>}

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : sets.length === 0 ? (
        <div style={{ ...emptyStyles.wrap, ...enter }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M8 10h8M8 14h5" />
          </svg>
          <div style={emptyStyles.title}>No elective sets yet</div>
          <div style={emptyStyles.body}>
            An elective set is a named period's worth of choices — like "Afternoon Chugim". Add one below, then pick
            which activities are offered.
          </div>
          <button className="press-97" onClick={() => nameRef.current?.focus()} style={{ ...S.btnPrimary, marginTop: 14 }}>
            Add your first elective set
          </button>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <th style={S.th}>Name</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sets.map((set) => (
                <ElectiveSetRow
                  key={set.id}
                  set={set}
                  role={role}
                  onBuild={(s) => onNavigate?.('schedule:electives', { electiveSetId: s.id })}
                  onSave={save}
                  onDelete={setPendingDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Elective Set</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <label style={fieldLabel}>Name</label>
            <input
              ref={nameRef}
              placeholder="e.g. Afternoon Chugim"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addSet()}
              style={S.input}
            />
          </div>
          <button className="press-97" onClick={addSet} disabled={adding || !newName.trim()} style={{ ...S.btnPrimary, flexShrink: 0 }}>
            {adding ? 'Adding…' : '+ Add'}
          </button>
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDangerDialog
          title={`Delete "${pendingDelete.name || 'this elective set'}"?`}
          recovery="Its offerings go with it. Any schedule cell pointing at it falls back to showing nothing scheduled — the same handling as any deleted reference."
          confirmLabel="Delete Elective Set"
          busy={deleting}
          onConfirm={confirmDeleteSet}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}

const fieldLabel = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
  marginBottom: 5,
  display: 'block',
}

// Calm, no-card empty block — DESIGN_STANDARD §5a, same treatment
// LocationsScreen.jsx uses for its own optional-entity empty state.
const emptyStyles = {
  wrap: {
    padding: '60px 16px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text)',
    marginTop: 8,
  },
  body: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    maxWidth: '56ch',
  },
}
