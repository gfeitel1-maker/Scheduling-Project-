import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import { S } from '../styles/shared'

function TierRow({ tier, groupCount, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tier.name)
  const [sortOrder, setSortOrder] = useState(tier.sort_order)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await onSave(tier.id, name.trim(), Number(sortOrder))
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={S.td}>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            style={S.input}
          />
        </td>
        <td style={S.td}>
          <input
            type="number"
            value={sortOrder}
            onChange={e => setSortOrder(e.target.value)}
            style={{ ...S.input, width: 70 }}
          />
        </td>
        <td style={S.td}>{groupCount}</td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button onClick={save} disabled={saving} style={S.btnPrimary}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => { setName(tier.name); setSortOrder(tier.sort_order); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>
            Cancel
          </button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <td style={S.td}>{tier.name}</td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{tier.sort_order}</td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{groupCount}</td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button onClick={() => setEditing(true)} style={S.btnSecondary}>Edit</button>
        <button onClick={() => onDelete(tier.id)} style={{ ...S.btnDanger, marginLeft: 6 }}
          disabled={groupCount > 0}
          title={groupCount > 0 ? 'Remove groups from this tier first' : ''}
        >Delete</button>
      </td>
    </tr>
  )
}

export default function TiersScreen({ campId, onNavigate }) {
  const [tiers, setTiers] = useState([])
  const [groupCounts, setGroupCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newSort, setNewSort] = useState('')
  const [adding, setAdding] = useState(false)
  const [importStep, setImportStep] = useState(null) // null | 'preview' | 'done'
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
      const [{ data: tierData }, { data: groupData }] = await Promise.all([
        supabase.from('tiers').select('*').eq('camp_id', campId).order('sort_order').order('name'),
        supabase.from('groups').select('id, tier_id').eq('camp_id', campId),
      ])
      setTiers(tierData || [])
      const counts = {}
      for (const g of groupData || []) {
        counts[g.tier_id] = (counts[g.tier_id] || 0) + 1
      }
      setGroupCounts(counts)
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  async function addTier() {
    if (!newName.trim()) return
    setAdding(true)
    const sortVal = newSort !== '' ? Number(newSort) : (tiers.length + 1)
    await supabase.from('tiers').insert({ camp_id: campId, name: newName.trim(), sort_order: sortVal })
    setNewName('')
    setNewSort('')
    setAdding(false)
    load()
  }

  async function saveTier(id, name, sort_order) {
    await supabase.from('tiers').update({ name, sort_order }).eq('id', id)
    load()
  }

  async function deleteTier(id) {
    if (!window.confirm('Delete this tier?')) return
    await supabase.from('tiers').delete().eq('id', id)
    load()
  }

  async function deleteAll() {
    if (!window.confirm('Delete all tiers? This cannot be undone.')) return
    await supabase.from('tiers').delete().eq('camp_id', campId)
    load()
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      ['name', 'sort_order'],
      ['Yeladim', 1],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Tiers')
    XLSX.writeFile(wb, 'tiers_template.xlsx')
  }

  function onFileChange(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
      const parsed = rows.map(r => ({
        name: String(r.name || '').trim(),
        sort_order: r.sort_order !== '' ? Number(r.sort_order) : null,
        warning: !String(r.name || '').trim() ? 'Missing name' : null,
      }))
      setImportRows(parsed)
      setImportStep('preview')
    }
    reader.readAsArrayBuffer(file)
    e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    const existingNames = new Set(tiers.map(t => t.name.toLowerCase()))
    let added = 0, skipped = 0
    for (const row of importRows) {
      if (!row.name || row.warning) { skipped++; continue }
      if (existingNames.has(row.name.toLowerCase())) { skipped++; continue }
      const sortVal = row.sort_order !== null ? row.sort_order : (tiers.length + added + 1)
      await supabase.from('tiers').insert({ camp_id: campId, name: row.name, sort_order: sortVal })
      added++
    }
    setImportResult({ added, skipped })
    setImportStep('done')
    setImporting(false)
    load()
  }

  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)

  return (
    <div style={{ maxWidth: 700 }}>
      {error && (
        <div style={S.errorBanner}>
          {error}
        </div>
      )}
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          {tiers.length} tier{tiers.length !== 1 ? 's' : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={downloadTemplate} style={S.btnSecondary}>Download Template</button>
          <button onClick={() => fileRef.current.click()} style={S.btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          <button onClick={deleteAll} style={S.btnDanger}>Delete All</button>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Sort Order</th>
                <th style={S.th}>Groups</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tiers.length === 0 ? (
                <tr><td colSpan={4} style={{ padding: '40px 16px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No tiers yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first tier below or import from Excel.</div>
                </td></tr>
              ) : tiers.map(tier => (
                <TierRow
                  key={tier.id}
                  tier={tier}
                  groupCount={groupCounts[tier.id] || 0}
                  onSave={saveTier}
                  onDelete={deleteTier}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add row */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Add Tier
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            placeholder="Tier name (e.g. Yeladim)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTier()}
            style={{ ...S.input, flex: 1 }}
          />
          <input
            type="number"
            placeholder="Order"
            value={newSort}
            onChange={e => setNewSort(e.target.value)}
            style={{ ...S.input, width: 80 }}
          />
          <button onClick={addTier} disabled={adding || !newName.trim()} style={S.btnPrimary}>
            {adding ? 'Adding…' : '+ Add'}
          </button>
        </div>
      </div>

      {/* Import modal */}
      {importStep && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{ background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, width: 520, maxHeight: '80vh', overflow: 'auto' }}>
            {importStep === 'preview' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>Import Preview</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
                  {readyRows.length} row{readyRows.length !== 1 ? 's' : ''} ready
                  {warnRows.length > 0 && `, ${warnRows.length} with warnings (will be skipped)`}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={S.th}>Name</th><th style={S.th}>Sort Order</th><th style={S.th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importRows.map((r, i) => (
                      <tr key={i} style={{ background: r.warning ? '#FFF8E7' : '', borderBottom: '1px solid var(--border)' }}>
                        <td style={S.td}>{r.name || <span style={{ color: 'var(--warning)' }}>—</span>}</td>
                        <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.sort_order ?? '—'}</td>
                        <td style={{ ...S.td, color: r.warning ? '#F5A623' : 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {r.warning || '✓ Ready'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setImportStep(null); setImportRows([]) }} style={S.btnSecondary}>Cancel</button>
                  <button onClick={confirmImport} disabled={importing || readyRows.length === 0} style={S.btnPrimary}>
                    {importing ? 'Importing…' : `Import ${readyRows.length} tier${readyRows.length !== 1 ? 's' : ''}`}
                  </button>
                </div>
              </>
            )}
            {importStep === 'done' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>Import Complete</div>
                <div style={{ fontSize: 14, marginBottom: 6 }}>
                  <span style={{ color: 'var(--success)', fontWeight: 600 }}>{importResult.added} added</span>
                  {importResult.skipped > 0 && <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{importResult.skipped} skipped (duplicate or invalid)</span>}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button onClick={() => { setImportStep(null); setImportRows([]) }} style={S.btnPrimary}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => onNavigate('groups')} style={S.btnPrimary}>Next: Groups →</button>
      </div>
    </div>
  )
}
