import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'

const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

function DayRow({ day, onSave, onDelete }) {
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
        <td style={td}><input autoFocus value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={inputStyle} /></td>
        <td style={td}>
          <select value={dow} onChange={e => setDow(e.target.value)} style={inputStyle}>
            {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
        </td>
        <td style={td}><input type="number" value={sortOrder} onChange={e => setSortOrder(e.target.value)} style={{ ...inputStyle, width: 70 }} /></td>
        <td style={{ ...td, textAlign: 'right' }}>
          <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button onClick={() => { setLabel(day.label); setDow(day.day_of_week); setSortOrder(day.sort_order); setEditing(false) }} style={{ ...btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <td style={td}>{day.label}</td>
      <td style={{ ...td, color: 'var(--text-secondary)', fontSize: 13 }}>{DOW[day.day_of_week]}</td>
      <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{day.sort_order}</td>
      <td style={{ ...td, textAlign: 'right' }}>
        <button onClick={() => setEditing(true)} style={btnSecondary}>Edit</button>
        <button onClick={() => onDelete(day.id)} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
      </td>
    </tr>
  )
}

export default function DaysScreen({ campId, onNavigate }) {
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
  const fileRef = useRef()

  useEffect(() => { load() }, [campId])

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('days_of_operation').select('*').eq('camp_id', campId).order('sort_order').order('day_of_week')
    setDays(data || [])
    setLoading(false)
  }

  async function addDay() {
    if (!newLabel.trim()) return
    setAdding(true)
    const sortVal = newSort !== '' ? Number(newSort) : (days.length + 1)
    await supabase.from('days_of_operation').insert({ camp_id: campId, label: newLabel.trim(), day_of_week: Number(newDow), sort_order: sortVal })
    setNewLabel(''); setNewSort('')
    setAdding(false); load()
  }

  async function saveDay(id, fields) {
    await supabase.from('days_of_operation').update(fields).eq('id', id); load()
  }

  async function deleteDay(id) {
    if (!window.confirm('Delete this day?')) return
    await supabase.from('days_of_operation').delete().eq('id', id); load()
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
        else if (isNaN(dow) || dow < 0 || dow > 6) warning = 'day_of_week must be 0–6'
        return { label, day_of_week: dow, sort_order: sort, warning }
      })
      setImportRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    const existingLabels = new Set(days.map(d => d.label.toLowerCase()))
    let added = 0, skipped = 0
    for (const row of importRows) {
      if (!row.label || row.warning) { skipped++; continue }
      if (existingLabels.has(row.label.toLowerCase())) { skipped++; continue }
      const sortVal = row.sort_order !== null ? row.sort_order : (days.length + added + 1)
      await supabase.from('days_of_operation').insert({ camp_id: campId, label: row.label, day_of_week: row.day_of_week, sort_order: sortVal })
      added++
    }
    setImportResult({ added, skipped }); setImportStep('done')
    setImporting(false); load()
  }

  const readyRows = importRows.filter(r => r.label && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.label)

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {days.length} day{days.length !== 1 ? 's' : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={downloadTemplate} style={btnSecondary}>Download Template</button>
          <button onClick={() => fileRef.current.click()} style={btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <th style={th}>Label</th>
                <th style={th}>Day of Week</th>
                <th style={th}>Sort Order</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {days.length === 0 ? (
                <tr><td colSpan={4} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No days yet.</td></tr>
              ) : days.map(day => (
                <DayRow key={day.id} day={day} onSave={saveDay} onDelete={deleteDay} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Day</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input placeholder="Label (e.g. Monday)" value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && addDay()} style={{ ...inputStyle, flex: '1 1 150px' }} />
          <select value={newDow} onChange={e => setNewDow(e.target.value)} style={{ ...inputStyle, flex: '0 0 140px' }}>
            {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
          <input type="number" placeholder="Order" value={newSort} onChange={e => setNewSort(e.target.value)} style={{ ...inputStyle, flex: '0 0 80px' }} />
          <button onClick={addDay} disabled={adding || !newLabel.trim()} style={{ ...btnPrimary, flexShrink: 0 }}>{adding ? 'Adding…' : '+ Add'}</button>
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
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}><th style={th}>Label</th><th style={th}>Day</th><th style={th}>Order</th><th style={th}>Status</th></tr></thead>
                  <tbody>
                    {importRows.map((r, i) => (
                      <tr key={i} style={{ background: r.warning ? '#FFF8E7' : '', borderBottom: '1px solid var(--border)' }}>
                        <td style={td}>{r.label || '—'}</td>
                        <td style={td}>{DOW[r.day_of_week] || '—'}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.sort_order ?? '—'}</td>
                        <td style={{ ...td, color: r.warning ? '#F5A623' : 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setImportStep(null); setImportRows([]) }} style={btnSecondary}>Cancel</button>
                  <button onClick={confirmImport} disabled={importing || readyRows.length === 0} style={btnPrimary}>{importing ? 'Importing…' : `Import ${readyRows.length}`}</button>
                </div>
              </>
            )}
            {importStep === 'done' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>Import Complete</div>
                <div style={{ fontSize: 14 }}><span style={{ color: 'var(--success)', fontWeight: 600 }}>{importResult.added} added</span>{importResult.skipped > 0 && <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{importResult.skipped} skipped</span>}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button onClick={() => { setImportStep(null); setImportRows([]) }} style={btnPrimary}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => onNavigate('timeblocks')} style={btnPrimary}>Next: Time Blocks →</button>
      </div>
    </div>
  )
}

const td = { padding: '10px 14px', textAlign: 'left', fontSize: 13 }
const th = { padding: '9px 14px', textAlign: 'left', fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }
const inputStyle = { padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 5, fontSize: 13, outline: 'none', background: 'var(--surface)', width: '100%' }
const btnPrimary = { padding: '7px 14px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 5, fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const btnSecondary = { padding: '7px 14px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, fontWeight: 500, fontSize: 13, cursor: 'pointer' }
const btnDanger = { padding: '7px 14px', background: 'none', color: 'var(--warning)', border: '1px solid var(--warning)', borderRadius: 5, fontWeight: 500, fontSize: 13, cursor: 'pointer' }
