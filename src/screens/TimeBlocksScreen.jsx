import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import { S } from '../styles/shared'

const POD_OPTIONS = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
]

function BlockRow({ block, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(block.name)
  const [start, setStart] = useState(block.start_time)
  const [end, setEnd] = useState(block.end_time)
  const [pod, setPod] = useState(block.part_of_day)
  const [sortOrder, setSortOrder] = useState(block.sort_order)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await onSave(block.id, { name: name.trim(), start_time: start, end_time: end, part_of_day: pod, sort_order: Number(sortOrder) })
    setSaving(false); setEditing(false)
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={S.td}><input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={S.input} /></td>
        <td style={S.td}><input type="time" value={start} onChange={e => setStart(e.target.value)} style={{ ...S.input, width: 110 }} /></td>
        <td style={S.td}><input type="time" value={end} onChange={e => setEnd(e.target.value)} style={{ ...S.input, width: 110 }} /></td>
        <td style={S.td}>
          <select value={pod} onChange={e => setPod(e.target.value)} style={{ ...S.input, width: 120 }}>
            {POD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </td>
        <td style={S.td}><input type="number" value={sortOrder} onChange={e => setSortOrder(e.target.value)} style={{ ...S.input, width: 60 }} /></td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button onClick={save} disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button onClick={() => { setName(block.name); setStart(block.start_time); setEnd(block.end_time); setPod(block.part_of_day); setSortOrder(block.sort_order); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  function fmt(t) {
    if (!t) return '—'
    const [h, m] = t.split(':')
    const hr = parseInt(h); const ampm = hr >= 12 ? 'PM' : 'AM'
    return `${hr > 12 ? hr - 12 : hr || 12}:${m} ${ampm}`
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <td style={S.td}>{block.name}</td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{fmt(block.start_time)}</td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{fmt(block.end_time)}</td>
      <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>{block.part_of_day}</td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{block.sort_order}</td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button onClick={() => setEditing(true)} style={S.btnSecondary}>Edit</button>
        <button onClick={() => onDelete(block.id)} style={{ ...S.btnDanger, marginLeft: 6 }}>Delete</button>
      </td>
    </tr>
  )
}

export default function TimeBlocksScreen({ campId, onNavigate }) {
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')
  const [newPod, setNewPod] = useState('morning')
  const [newSort, setNewSort] = useState('')
  const [adding, setAdding] = useState(false)
  const [importStep, setImportStep] = useState(null)
  const [importRows, setImportRows] = useState([])
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef()

  useEffect(() => { load() }, [campId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const { data } = await supabase.from('time_blocks').select('*').eq('camp_id', campId).order('sort_order').order('start_time')
      setBlocks(data || [])
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  async function addBlock() {
    if (!newName.trim() || !newStart || !newEnd) return
    setAdding(true)
    const sortVal = newSort !== '' ? Number(newSort) : (blocks.length + 1)
    await supabase.from('time_blocks').insert({ camp_id: campId, name: newName.trim(), start_time: newStart, end_time: newEnd, part_of_day: newPod, sort_order: sortVal })
    setNewName(''); setNewStart(''); setNewEnd(''); setNewSort('')
    setAdding(false); load()
  }

  async function saveBlock(id, fields) {
    await supabase.from('time_blocks').update(fields).eq('id', id); load()
  }

  async function deleteBlock(id) {
    if (!window.confirm('Delete this time block?')) return
    await supabase.from('time_blocks').delete().eq('id', id); load()
  }

  async function deleteAll() {
    if (!window.confirm('Delete all time blocks? This cannot be undone.')) return
    await supabase.from('time_blocks').delete().eq('camp_id', campId)
    load()
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      ['name', 'start_time', 'end_time', 'part_of_day', 'sort_order'],
      ['Block 1', '09:45', '10:25', 'morning', 1],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Time Blocks')
    XLSX.writeFile(wb, 'time_blocks_template.xlsx')
  }

  function onFileChange(e) {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      const parsed = rows.map(r => {
        const name = String(r.name || '').trim()
        const start_time = String(r.start_time || '').trim()
        const end_time = String(r.end_time || '').trim()
        const pod = String(r.part_of_day || '').trim().toLowerCase()
        const sort_order = r.sort_order !== '' ? Number(r.sort_order) : null
        let warning = null
        if (!name) warning = 'Missing name'
        else if (!start_time || !end_time) warning = 'Missing time'
        else if (!['morning','afternoon','evening'].includes(pod)) warning = 'part_of_day must be morning/afternoon/evening'
        return { name, start_time, end_time, part_of_day: pod, sort_order, warning }
      })
      setImportRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    const existingNames = new Set(blocks.map(b => b.name.toLowerCase()))
    let added = 0, skipped = 0
    for (const row of importRows) {
      if (!row.name || row.warning) { skipped++; continue }
      if (existingNames.has(row.name.toLowerCase())) { skipped++; continue }
      const sortVal = row.sort_order !== null ? row.sort_order : (blocks.length + added + 1)
      await supabase.from('time_blocks').insert({ camp_id: campId, name: row.name, start_time: row.start_time, end_time: row.end_time, part_of_day: row.part_of_day, sort_order: sortVal })
      added++
    }
    setImportResult({ added, skipped }); setImportStep('done')
    setImporting(false); load()
  }

  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)

  return (
    <div style={{ maxWidth: 780 }}>
      {error && (
        <div style={S.errorBanner}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {blocks.length} block{blocks.length !== 1 ? 's' : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={downloadTemplate} style={S.btnSecondary}>Download Template</button>
          <button onClick={() => fileRef.current.click()} style={S.btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          <button onClick={deleteAll} style={S.btnDanger}>Delete All</button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Start</th>
                <th style={S.th}>End</th>
                <th style={S.th}>Part of Day</th>
                <th style={S.th}>Order</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {blocks.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '40px 16px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No time blocks yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first time block below.</div>
                </td></tr>
              ) : blocks.map(b => (
                <BlockRow key={b.id} block={b} onSave={saveBlock} onDelete={deleteBlock} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Time Block</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input placeholder="Name (e.g. Block 1)" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addBlock()} style={{ ...S.input, flex: '1 1 120px' }} />
          <input type="time" value={newStart} onChange={e => setNewStart(e.target.value)} style={{ ...S.input, flex: '0 0 120px' }} />
          <input type="time" value={newEnd} onChange={e => setNewEnd(e.target.value)} style={{ ...S.input, flex: '0 0 120px' }} />
          <select value={newPod} onChange={e => setNewPod(e.target.value)} style={{ ...S.input, flex: '0 0 130px' }}>
            {POD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input type="number" placeholder="Order" value={newSort} onChange={e => setNewSort(e.target.value)} style={{ ...S.input, flex: '0 0 70px' }} />
          <button onClick={addBlock} disabled={adding || !newName.trim() || !newStart || !newEnd} style={{ ...S.btnPrimary, flexShrink: 0 }}>{adding ? 'Adding…' : '+ Add'}</button>
        </div>
      </div>

      {importStep && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, width: 580, maxHeight: '80vh', overflow: 'auto' }}>
            {importStep === 'preview' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>Import Preview</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{readyRows.length} ready{warnRows.length > 0 && `, ${warnRows.length} with warnings`}</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}><th style={S.th}>Name</th><th style={S.th}>Start</th><th style={S.th}>End</th><th style={S.th}>Part</th><th style={S.th}>Status</th></tr></thead>
                  <tbody>
                    {importRows.map((r, i) => (
                      <tr key={i} style={{ background: r.warning ? '#FFF8E7' : '', borderBottom: '1px solid var(--border)' }}>
                        <td style={S.td}>{r.name || '—'}</td>
                        <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.start_time || '—'}</td>
                        <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.end_time || '—'}</td>
                        <td style={S.td}>{r.part_of_day || '—'}</td>
                        <td style={{ ...S.td, color: r.warning ? '#F5A623' : 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setImportStep(null); setImportRows([]) }} style={S.btnSecondary}>Cancel</button>
                  <button onClick={confirmImport} disabled={importing || readyRows.length === 0} style={S.btnPrimary}>{importing ? 'Importing…' : `Import ${readyRows.length}`}</button>
                </div>
              </>
            )}
            {importStep === 'done' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>Import Complete</div>
                <div style={{ fontSize: 14 }}><span style={{ color: 'var(--success)', fontWeight: 600 }}>{importResult.added} added</span>{importResult.skipped > 0 && <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{importResult.skipped} skipped</span>}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button onClick={() => { setImportStep(null); setImportRows([]) }} style={S.btnPrimary}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => onNavigate('activities')} style={S.btnPrimary}>Next: Activities →</button>
      </div>
    </div>
  )
}

