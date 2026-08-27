import { useState } from 'react'
import { describeWriteFailure, deleteRefusalMessage } from '../utils/writeErrorMessage'
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { S } from '../styles/shared'
import DeleteRecordDialog from '../components/DeleteRecordDialog'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import SetupScreenShell from '../components/setup/SetupScreenShell'
import { DOW } from './setup/setupHelpers'

const repository = createSetupCrudRepository({ localClient })
const scopeFilter = (row, campId) => row.camp_id === campId

// Edit-mode Save/Cancel (and Delete, where present) must sit on one line —
// never wrap/stack — at the screen's normal width.
const rowActionsFlex = { display: 'flex', flexWrap: 'nowrap', gap: 6, justifyContent: 'flex-end' }

function DayRow({ day, role, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(day.label)
  const [dow, setDow] = useState(day.day_of_week)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!label.trim()) return
    setSaving(true)
    await onSave(day.id, { label: label.trim(), day_of_week: Number(dow), sort_order: Number(dow) })
    setSaving(false); setEditing(false)
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={S.td}><input autoFocus value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }} style={S.input} /></td>
        <td style={S.td}>
          <select value={dow} onChange={e => setDow(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }} style={S.input}>
            {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <div style={rowActionsFlex}>
            <button className="press-97" onClick={save} disabled={saving} style={{ ...S.btnPrimary, whiteSpace: 'nowrap' }}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="press-97" onClick={() => { setLabel(day.label); setDow(day.day_of_week); setEditing(false) }} style={{ ...S.btnSecondary, whiteSpace: 'nowrap' }}>Cancel</button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
      onClick={() => setEditing(true)}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
      onFocus={e => e.currentTarget.style.background = 'var(--bg)'}
      onBlur={e => e.currentTarget.style.background = ''}
    >
      <td style={S.td}>
        <span
          role="button"
          tabIndex={0}
          aria-label={`Edit ${day.label}`}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true) } }}
          style={{ cursor: 'pointer' }}
        >{day.label}</span>
      </td>
      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 13 }}>{DOW[day.day_of_week]}</td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button
          onClick={e => { e.stopPropagation(); onDelete(day.id) }}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
        >Delete</button>
      </td>
    </tr>
  )
}

export default function DaysScreen({ campId, role, onNavigate }) {
  const { rows: unsortedDays, loading, error, setError, adding, add, save, deleteAll: deleteAllRecords, reload } =
    useCrudScreen({
      entity: 'days_of_operation',
      campId,
      localClient,
      repository,
      scopeFilter,
      buildCreateFields: ({ label, dayOfWeek, sortOrder }) => ({
        label,
        camp_id: campId,
        day_of_week: dayOfWeek,
        sort_order: sortOrder,
      }),
      addFailedText: 'That day could not be added.',
      saveFailedText: 'That day could not be saved.',
      adminOnlyDeleteAllText: 'Only an admin can delete days — no days were deleted.',
      partialDeleteAllText: (succeeded, total, failed) => `Deleted ${succeeded} of ${total} days (${failed} failed — see console).`,
      deleteAllFailedText: 'Those days could not be deleted.',
    })
  const days = [...unsortedDays].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.day_of_week ?? 0) - (b.day_of_week ?? 0))

  const [newLabel, setNewLabel] = useState('')
  const [newDow, setNewDow] = useState(1)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)

  async function addDay() {
    if (!newLabel.trim()) return
    const succeeded = await add({ label: newLabel.trim(), dayOfWeek: Number(newDow), sortOrder: Number(newDow) })
    if (succeeded) { setNewLabel('') }
  }

  // Deleting a record a schedule uses: count first, confirm with the count
  // shown, then clear and delete in one Host-side transaction.
  // docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
  async function deleteDay(id) {
    setError(null)
    let preview
    try {
      preview = await localClient.previewDelete('days_of_operation', id)
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can delete days.'
          : describeWriteFailure(err, 'That could not be checked before deleting.')
      )
      return
    }
    if (!preview || preview.error) {
      setError(deleteRefusalMessage(preview?.error ?? 'unknown', preview || {}))
      return
    }
    setPendingDelete(preview)
  }

  function deleteAll() {
    setPendingDeleteAll(true)
  }

  async function confirmDeleteAll() {
    setDeletingAll(true)
    try {
      await deleteAllRecords()
    } finally {
      setDeletingAll(false)
      setPendingDeleteAll(false)
    }
  }

  function downloadTemplate() {
    const ws = aoaToSanitizedSheet([
      ['label', 'day_of_week', 'sort_order'],
      ['Monday', 1, 1],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Days')
    XLSX.writeFile(wb, 'days_template.xlsx')
  }

  return (
    <>
    <SetupScreenShell
      countLabel={`${days.length} day${days.length !== 1 ? 's' : ''}`}
      role={role}
      actions={{ onDownloadTemplate: downloadTemplate, onDeleteAll: deleteAll, deleteAllProminent: false }}
      nextLabel="Next: Time Blocks →"
      onNext={() => onNavigate('timeblocks')}
      error={error}
    >
      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <th style={S.th}>Label</th>
                <th style={S.th}>Day of Week</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {days.length === 0 ? (
                <tr><td colSpan={3} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>No days yet</div>
                  <div style={S.emptyStateBody}>Add your first day below.</div>
                </td></tr>
              ) : days.map(day => (
                <DayRow key={day.id} day={day} role={role} onSave={save} onDelete={deleteDay} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Day</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input placeholder="Label (e.g. Monday)" value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && addDay()} style={{ ...S.input, flex: '1 1 150px' }} />
          <select value={newDow} onChange={e => setNewDow(e.target.value)} onKeyDown={e => e.key === 'Enter' && addDay()} style={{ ...S.input, flex: '0 0 140px' }}>
            {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
          <button className="press-97" onClick={addDay} disabled={adding || !newLabel.trim()} style={{ ...S.btnPrimary, flexShrink: 0 }}>{adding ? 'Adding…' : '+ Add'}</button>
        </div>
      </div>
      </SetupScreenShell>
      {pendingDelete && (
        <DeleteRecordDialog
          preview={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onDeleted={() => { setPendingDelete(null); reload() }}
        />
      )}
      {pendingDeleteAll && (
        <ConfirmDangerDialog
          title="Delete all days?"
          recovery="They can be restored from Trash."
          confirmLabel="Delete All Days"
          busy={deletingAll}
          onConfirm={confirmDeleteAll}
          onCancel={() => setPendingDeleteAll(false)}
        />
      )}
    </>
  )
}
