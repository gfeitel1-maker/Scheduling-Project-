import { useRef, useState } from 'react'
import { describeWriteFailure, deleteRefusalMessage } from '../utils/writeErrorMessage'
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet, unescapeRow } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { S, useEnterTransition } from '../styles/shared'
import DeleteRecordDialog from '../components/DeleteRecordDialog'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import SetupScreenShell from '../components/setup/SetupScreenShell'
import ImportModal from '../components/setup/ImportModal'
import InlineAddRow from '../components/setup/InlineAddRow'
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

  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [importStep, setImportStep] = useState(null)
  const [importRows, setImportRows] = useState([])
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef()

  async function addDay(values) {
    const label = String(values.label ?? '').trim()
    if (!label) return false
    const dow = Number(values.day_of_week)
    return await add({ label, dayOfWeek: dow, sortOrder: dow })
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
        const dowRaw = r.day_of_week
        const day_of_week = dowRaw !== '' && dowRaw !== null && dowRaw !== undefined ? Number(dowRaw) : null
        const sort_order = r.sort_order !== '' ? Number(r.sort_order) : null
        let warning = null
        if (!label) warning = 'Missing label'
        else if (day_of_week === null || !Number.isInteger(day_of_week) || day_of_week < 0 || day_of_week > 6) warning = 'day_of_week must be a whole number 0–6'
        else if (sort_order !== null && !(Number.isInteger(sort_order) && sort_order >= 0)) warning = 'sort_order must be a whole number 0 or greater'
        return { label, day_of_week, sort_order, warning }
      })
      setImportRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    try {
      const existingLabels = new Set(days.map(d => String(d.label ?? '').toLowerCase()))
      let added = 0, skipped = 0
      for (const row of importRows) {
        if (!row.label || row.warning) { skipped++; continue }
        const lower = String(row.label).toLowerCase()
        if (existingLabels.has(lower)) { skipped++; continue }
        const sortVal = row.sort_order !== null ? row.sort_order : row.day_of_week
        try {
          const id = crypto.randomUUID()
          // `label` first — createRecord does the write-then-cleanup-on-failure
          // dance and requires the collision-guarded field first.
          await repository.createRecord('days_of_operation', id, {
            label: row.label,
            camp_id: campId,
            day_of_week: row.day_of_week,
            sort_order: sortVal,
          })
          added++
          existingLabels.add(lower)
        } catch (err) {
          console.error(`Failed to import day "${row.label}"`, err)
          skipped++
        }
      }
      setImportResult({ added, skipped }); setImportStep('done')
    } catch (err) {
      console.error('Import failed', err)
      setError(describeWriteFailure(err, 'That import could not be completed.'))
      setImportStep(null); setImportRows([])
    } finally {
      setImporting(false); await reload()
    }
  }

  const readyRows = importRows.filter(r => r.label && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.label)

  const enterStyle = useEnterTransition('liftFade')

  return (
    <>
    <div style={enterStyle}>
    <SetupScreenShell
      countLabel={`${days.length} day${days.length !== 1 ? 's' : ''}`}
      role={role}
      actions={{ onDownloadTemplate: downloadTemplate, onImport: () => fileRef.current.click(), onDeleteAll: deleteAll }}
      fileInputRef={fileRef}
      onFileChange={onFileChange}
      nextLabel="Next: Time Blocks →"
      onNext={() => onNavigate('timeblocks')}
      error={error}
    >
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
              {loading ? (
                <tr><td colSpan={3} style={S.stateLoading}>Loading…</td></tr>
              ) : (
                <>
                  {days.length === 0 && (
                    <tr><td colSpan={3} style={S.emptyState}>
                      <div style={S.emptyStateTitle}>No days yet</div>
                      <div style={S.emptyStateBody}>Type a day below to add your first one.</div>
                    </td></tr>
                  )}
                  {days.map(day => (
                    <DayRow key={day.id} day={day} role={role} onSave={save} onDelete={deleteDay} />
                  ))}
                  {/* The always-present blank "type here to add" row — lives as
                      the last row of the days table (Excel-like inline add).
                      Gated behind the loaded branch, like the sibling setup
                      screens (Groups/Tiers/TimeBlocks/Electives). */}
                  <InlineAddRow
                    fields={[
                      { key: 'label', type: 'text', placeholder: 'Label (e.g. Monday)', required: true },
                      { key: 'day_of_week', type: 'select', default: 1, options: DOW.map((d, i) => ({ value: i, label: d })) },
                    ]}
                    onAdd={addDay}
                    adding={adding}
                  />
                </>
              )}
            </tbody>
          </table>
        </div>
      </SetupScreenShell>
      </div>
      <ImportModal
        step={importStep}
        title={importStep === 'done' ? 'Import Complete' : 'Import Preview'}
        width={520}
        columns={[{ key: 'label', label: 'Label' }, { key: 'day_of_week', label: 'Day' }, { key: 'status', label: 'Status' }]}
        rows={importRows}
        readyCount={readyRows.length}
        warnCount={warnRows.length}
        result={importResult}
        importing={importing}
        onConfirm={confirmImport}
        onCancel={() => { setImportStep(null); setImportRows([]) }}
        renderCell={(r, c) => {
          if (c.key === 'label') return r.label || '—'
          if (c.key === 'day_of_week') return (r.day_of_week !== null && r.day_of_week >= 0 && r.day_of_week <= 6) ? DOW[r.day_of_week] : '—'
          if (c.key === 'status') return <span style={r.warning ? S.importWarnText : { color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</span>
        }}
      />
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
