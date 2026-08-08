import { useState, useEffect, useRef } from 'react'
import { describeWriteFailure, deleteRefusalMessage } from '../utils/writeErrorMessage'
import * as XLSX from 'xlsx'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import DeleteRecordDialog from '../components/DeleteRecordDialog'
import ScreenIntro from '../components/ScreenIntro'

const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

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
  const [days, setDays] = useState([])
  const [loading, setLoading] = useState(true)
  const [newLabel, setNewLabel] = useState('')
  const [newDow, setNewDow] = useState(1)
  const [newSort, setNewSort] = useState('')
  const [adding, setAdding] = useState(false)
  const [importStep, setImportStep] = useState(null)
  const [importRows, setImportRows] = useState([])
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const fileRef = useRef()

  useEffect(() => { load() }, [campId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await localClient.list('days_of_operation')
      const list = (data || [])
        .filter(d => d.camp_id === campId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.day_of_week ?? 0) - (b.day_of_week ?? 0))
      setDays(list)
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  // Fires one write() per field (the op-log is field-level) and surfaces
  // the first failure rather than a silent partial write — see
  // GroupsScreen.jsx's identical helper.
  async function writeFields(id, fields) {
    const token = localStorage.getItem('shoresh-token')
    for (const [field, value] of Object.entries(fields)) {
      const result = await localClient.write(token, 'days_of_operation', id, field, value)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error(`write failed for field "${field}"`)
      }
    }
  }

  async function cleanupPartialRow(id) {
    try {
      const token = localStorage.getItem('shoresh-token')
      await localClient.deleteEntity(token, 'days_of_operation', id)
    } catch {
      // best-effort only
    }
  }

  async function addDay() {
    if (!newLabel.trim()) return
    setAdding(true)
    try {
      const id = crypto.randomUUID()
      const sortVal = newSort !== '' ? Number(newSort) : (days.length + 1)
      try {
        await writeFields(id, {
          label: newLabel.trim(),
          camp_id: campId,
          day_of_week: Number(newDow),
          sort_order: sortVal,
        })
      } catch (err) {
        await cleanupPartialRow(id)
        throw err
      }
      setNewLabel(''); setNewSort('')
      await load()
    } catch (err) {
      setError(describeWriteFailure(err, 'That day could not be added.'))
    } finally {
      setAdding(false)
    }
  }

  async function saveDay(id, fields) {
    try {
      await writeFields(id, fields)
      await load()
    } catch (err) {
      setError(describeWriteFailure(err, 'That day could not be saved.'))
      throw err
    }
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

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
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
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
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
      // Defense-in-depth: a row with a null/undefined label should never
      // reach this point (import parsing and load() both normalize label
      // to a string), but a stray malformed row here must not throw and
      // wedge the modal on "Importing…" forever — coerce rather than crash.
      const existingLabels = new Set(days.map(d => String(d.label ?? '').toLowerCase()))
      let added = 0, skipped = 0
      for (const row of importRows) {
        if (!row.label || row.warning) { skipped++; continue }
        const lower = String(row.label).toLowerCase()
        if (existingLabels.has(lower)) { skipped++; continue }
        const sortVal = row.sort_order !== null ? row.sort_order : (days.length + added + 1)
        try {
          const id = crypto.randomUUID()
          try {
            await writeFields(id, {
              label: row.label,
              camp_id: campId,
              day_of_week: row.day_of_week,
              sort_order: sortVal,
            })
          } catch (err) {
            await cleanupPartialRow(id)
            throw err
          }
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
      setImporting(false); await load()
    }
  }

  const readyRows = importRows.filter(r => r.label && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.label)

  return (
    <div style={{ maxWidth: 680 }}>
      <ScreenIntro screen="days" />
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
        </div>
      </div>

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
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
                // 32px padding intentionally shorter than S.emptyState's 40px — single-line empty state, not a title+body block
                <tr><td colSpan={4} style={{ ...S.emptyState, padding: '32px 16px', color: 'var(--text-secondary)', fontSize: 13 }}>No days yet.</td></tr>
              ) : days.map(day => (
                <DayRow key={day.id} day={day} role={role} onSave={saveDay} onDelete={deleteDay} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
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

      {importStep && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 28, width: 520, maxHeight: '80vh', overflow: 'auto' }}>
            {importStep === 'preview' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>Import Preview</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{readyRows.length} ready{warnRows.length > 0 && `, ${warnRows.length} with warnings`}</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}><th style={S.th}>Label</th><th style={S.th}>Day</th><th style={S.th}>Order</th><th style={S.th}>Status</th></tr></thead>
                  <tbody>
                    {importRows.map((r, i) => (
                      <tr key={i} style={{ background: r.warning ? '#FFF8E7' : '', borderBottom: '1px solid var(--border)' }}>
                        <td style={S.td}>{r.label || '—'}</td>
                        <td style={S.td}>{DOW[r.day_of_week] || '—'}</td>
                        <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.sort_order ?? '—'}</td>
                        <td style={{ ...S.td, color: r.warning ? '#F5A623' : 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button className="press-97" onClick={() => { setImportStep(null); setImportRows([]) }} style={S.btnSecondary}>Cancel</button>
                  <button className="press-97" onClick={confirmImport} disabled={importing || readyRows.length === 0} style={S.btnPrimary}>{importing ? 'Importing…' : `Import ${readyRows.length}`}</button>
                </div>
              </>
            )}
            {importStep === 'done' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>Import Complete</div>
                <div style={{ fontSize: 14 }}><span style={{ color: 'var(--success)', fontWeight: 600 }}>{importResult.added} added</span>{importResult.skipped > 0 && <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{importResult.skipped} skipped</span>}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="press-97" onClick={() => { setImportStep(null); setImportRows([]) }} style={S.btnPrimary}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button className="press-97" onClick={() => onNavigate('timeblocks')} style={S.btnPrimary}>Next: Time Blocks →</button>
      </div>
      {pendingDelete && (
        <DeleteRecordDialog
          preview={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onDeleted={() => { setPendingDelete(null); load() }}
        />
      )}
    </div>
  )
}
