import { useState, useRef } from 'react'
import { describeWriteFailure, deleteRefusalMessage } from '../utils/writeErrorMessage'
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet, unescapeRow } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { S } from '../styles/shared'
import DeleteRecordDialog from '../components/DeleteRecordDialog'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import ImportModal from '../components/setup/ImportModal'
import { DOW } from './setup/setupHelpers'

const repository = createSetupCrudRepository({ localClient })
const scopeFilter = (row, campId) => row.camp_id === campId

function DayRow({ day, role, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(day.label)
  const [dow, setDow] = useState(day.day_of_week)
  const [sortOrder, setSortOrder] = useState(day.sort_order)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!label.trim()) return
    setSaving(true)
    await onSave(day.id, { label: label.trim(), day_of_week: Number(dow), sort_order: Number(sortOrder) })
    setSaving(false); setEditing(false)
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={S.td}><input autoFocus value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={S.input} /></td>
        <td style={S.td}>
          <select value={dow} onChange={e => setDow(e.target.value)} style={S.input}>
            {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
        </td>
        <td style={S.td}><input type="number" value={sortOrder} onChange={e => setSortOrder(e.target.value)} style={{ ...S.input, width: 70 }} /></td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button className="press-97" onClick={save} disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="press-97" onClick={() => { setLabel(day.label); setDow(day.day_of_week); setSortOrder(day.sort_order); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <td style={S.td}>{day.label}</td>
      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 13 }}>{DOW[day.day_of_week]}</td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{day.sort_order}</td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button className="press-97" onClick={() => setEditing(true)} style={S.btnSecondary}>Edit</button>
        <button
          onClick={() => onDelete(day.id)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
        >Delete</button>
      </td>
    </tr>
  )
}

export default function DaysScreen({ campId, role, onNavigate }) {
  const { rows: unsortedDays, loading, error, setError, adding, add, save, deleteAll: deleteAllRecords, importRows: importViaHook, reload } =
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
  const [newSort, setNewSort] = useState('')
  const [importStep, setImportStep] = useState(null)
  const [importRows, setImportRows] = useState([])
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const fileRef = useRef()

  async function addDay() {
    if (!newLabel.trim()) return
    const sortVal = newSort !== '' ? Number(newSort) : (days.length + 1)
    const succeeded = await add({ label: newLabel.trim(), dayOfWeek: Number(newDow), sortOrder: sortVal })
    if (succeeded) { setNewLabel(''); setNewSort('') }
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

  function onFileChange(e) {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }).map(unescapeRow)
      const parsed = rows.map(r => {
        const label = String(r.label || '').trim()
        const dow = Number(r.day_of_week)
        const sort = r.sort_order !== '' ? Number(r.sort_order) : null
        let warning = null
        if (!label) warning = 'Missing label'
        else if (!Number.isInteger(dow) || dow < 0 || dow > 6) warning = 'day_of_week must be a whole number 0–6'
        else if (sort !== null && !Number.isFinite(sort)) warning = 'sort_order must be a number'
        return { label, day_of_week: dow, sort_order: sort, warning }
      })
      setImportRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    try {
      const duplicateCheck = (existing, row) =>
        existing.some((r) => String(r.label ?? '').toLowerCase() === String(row.label).toLowerCase())
      const result = await importViaHook(importRows, {
        mapRow: (row, addedSoFar) => ({
          label: row.label,
          camp_id: campId,
          day_of_week: row.day_of_week,
          sort_order: row.sort_order !== null ? row.sort_order : (days.length + addedSoFar + 1),
        }),
        duplicateCheck,
      })
      setImportResult(result); setImportStep('done')
    } finally {
      setImporting(false)
    }
  }

  const readyRows = importRows.filter(r => r.label && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.label)

  return (
    <div style={{ maxWidth: 680 }}>
      {error && (
        <div style={S.errorBanner}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {days.length} day{days.length !== 1 ? 's' : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="press-97" onClick={downloadTemplate} style={S.btnSecondary}>Download Template</button>
          <button className="press-97" onClick={() => fileRef.current.click()} style={S.btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          <button
            onClick={deleteAll}
            disabled={role !== 'admin'}
            title={role !== 'admin' ? 'Admin only' : undefined}
            style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
          >Delete All</button>
        </div>
      </div>

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <th style={S.th}>Label</th>
                <th style={S.th}>Day of Week</th>
                <th style={S.th}>Sort Order</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {days.length === 0 ? (
                <tr><td colSpan={4} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>No days yet</div>
                  <div style={S.emptyStateBody}>Add your first day below or import from Excel.</div>
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
          <select value={newDow} onChange={e => setNewDow(e.target.value)} style={{ ...S.input, flex: '0 0 140px' }}>
            {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
          <input type="number" placeholder="Order" value={newSort} onChange={e => setNewSort(e.target.value)} style={{ ...S.input, flex: '0 0 80px' }} />
          <button className="press-97" onClick={addDay} disabled={adding || !newLabel.trim()} style={{ ...S.btnPrimary, flexShrink: 0 }}>{adding ? 'Adding…' : '+ Add'}</button>
        </div>
      </div>

      <ImportModal
        step={importStep}
        title={importStep === 'done' ? 'Import Complete' : 'Import Preview'}
        width={520}
        columns={[{ key: 'label', label: 'Label' }, { key: 'day_of_week', label: 'Day' }, { key: 'sort_order', label: 'Order', mono: true }, { key: 'status', label: 'Status' }]}
        rows={importRows}
        readyCount={readyRows.length}
        warnCount={warnRows.length}
        result={importResult}
        importing={importing}
        onConfirm={confirmImport}
        onCancel={() => { setImportStep(null); setImportRows([]) }}
        renderCell={(r, c) => {
          if (c.key === 'label') return r.label || '—'
          if (c.key === 'day_of_week') return DOW[r.day_of_week] || '—'
          if (c.key === 'sort_order') return r.sort_order ?? '—'
          if (c.key === 'status') return <span style={r.warning ? S.importWarnText : { color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</span>
        }}
      />

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button className="press-97" onClick={() => onNavigate('timeblocks')} style={S.btnPrimary}>Next: Time Blocks →</button>
      </div>
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
    </div>
  )
}
