import React, { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'

const AVAIL_OPTIONS = [
  { value: 'all', label: 'All Day' },
  { value: 'morning', label: 'Morning Only' },
  { value: 'afternoon', label: 'Afternoon Only' },
]

function GroupRow({ group, tiers, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  const [tierId, setTierId] = useState(group.tier_id || '')
  const [avail, setAvail] = useState(group.availability)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await onSave(group.id, { name: name.trim(), tier_id: tierId || null, availability: avail })
    setSaving(false)
    setEditing(false)
  }

  const tierName = tiers.find(t => t.id === group.tier_id)?.name || '—'

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={td}><input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={inputStyle} /></td>
        <td style={td}>
          <select value={tierId} onChange={e => setTierId(e.target.value)} style={inputStyle}>
            <option value="">— No tier —</option>
            {tiers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </td>
        <td style={td}>
          <select value={avail} onChange={e => setAvail(e.target.value)} style={inputStyle}>
            {AVAIL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </td>
        <td style={{ ...td, textAlign: 'right' }}>
          <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button onClick={() => { setName(group.name); setTierId(group.tier_id||''); setAvail(group.availability); setEditing(false) }} style={{ ...btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <td style={td}>{group.name}</td>
      <td style={{ ...td, color: 'var(--text-secondary)', fontSize: 13 }}>{tierName}</td>
      <td style={{ ...td, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{AVAIL_OPTIONS.find(o => o.value === group.availability)?.label || group.availability}</td>
      <td style={{ ...td, textAlign: 'right' }}>
        <button onClick={() => setEditing(true)} style={btnSecondary}>Edit</button>
        <button onClick={() => onDelete(group.id)} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
      </td>
    </tr>
  )
}

export default function GroupsScreen({ campId, onNavigate }) {
  const [groups, setGroups] = useState([])
  const [tiers, setTiers] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newTierId, setNewTierId] = useState('')
  const [newAvail, setNewAvail] = useState('all')
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
      const [{ data: gData }, { data: tData }] = await Promise.all([
        supabase.from('groups').select('*').eq('camp_id', campId).order('name'),
        supabase.from('tiers').select('*').eq('camp_id', campId).order('sort_order'),
      ])
      setGroups(gData || [])
      setTiers(tData || [])
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  async function addGroup() {
    if (!newName.trim()) return
    setAdding(true)
    await supabase.from('groups').insert({ camp_id: campId, name: newName.trim(), tier_id: newTierId || null, availability: newAvail })
    setNewName(''); setNewTierId(''); setNewAvail('all')
    setAdding(false)
    load()
  }

  async function saveGroup(id, fields) {
    await supabase.from('groups').update(fields).eq('id', id)
    load()
  }

  async function deleteGroup(id) {
    if (!window.confirm('Delete this group?')) return
    await supabase.from('groups').delete().eq('id', id)
    load()
  }

  async function deleteAll() {
    if (!window.confirm('Delete all groups? This cannot be undone.')) return
    await supabase.from('groups').delete().eq('camp_id', campId)
    load()
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      ['name', 'tier_name', 'availability'],
      ['Yeladim 1', 'Yeladim', 'all'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Groups')
    XLSX.writeFile(wb, 'groups_template.xlsx')
  }

  function onFileChange(e) {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      const tierMap = Object.fromEntries(tiers.map(t => [t.name.toLowerCase(), t.id]))
      const parsed = rows.map(r => {
        const name = String(r.name || '').trim()
        const tierName = String(r.tier_name || '').trim()
        const avail = String(r.availability || 'all').trim().toLowerCase()
        let warning = null
        if (!name) warning = 'Missing name'
        const tierId = tierName ? tierMap[tierName.toLowerCase()] : null
        if (tierName && !tierId) warning = `Tier "${tierName}" not found`
        const availability = ['all','morning','afternoon'].includes(avail) ? avail : 'all'
        return { name, tierName, tierId: tierId || null, availability, warning }
      })
      setImportRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    const existingNames = new Set(groups.map(g => g.name.toLowerCase()))
    let added = 0, skipped = 0
    for (const row of importRows) {
      if (!row.name || row.warning) { skipped++; continue }
      if (existingNames.has(row.name.toLowerCase())) { skipped++; continue }
      await supabase.from('groups').insert({ camp_id: campId, name: row.name, tier_id: row.tierId, availability: row.availability })
      added++
    }
    setImportResult({ added, skipped }); setImportStep('done')
    setImporting(false); load()
  }

  // Group by tier
  const grouped = {}
  const noTier = []
  for (const g of groups) {
    if (g.tier_id) {
      if (!grouped[g.tier_id]) grouped[g.tier_id] = []
      grouped[g.tier_id].push(g)
    } else {
      noTier.push(g)
    }
  }

  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)

  return (
    <div style={{ maxWidth: 720 }}>
      {error && (
        <div style={{ background: '#fff5f5', border: '1px solid #f5c6c6', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: 'var(--warning)' }}>
          {error}
        </div>
      )}
      {tiers.length === 0 && !loading && (
        <div style={{ background: '#FFF8E7', border: '1px solid #F5A623', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#7a5100' }}>
          No tiers found. Set up tiers first so you can assign groups to them.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {groups.length} group{groups.length !== 1 ? 's' : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={downloadTemplate} style={btnSecondary}>Download Template</button>
          <button onClick={() => fileRef.current.click()} style={btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          <button onClick={deleteAll} style={btnDanger}>Delete All</button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <th style={th}>Name</th>
                <th style={th}>Tier</th>
                <th style={th}>Availability</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr><td colSpan={4} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No groups yet.</td></tr>
              ) : (
                <>
                  {tiers.map(tier => {
                    const tierGroups = grouped[tier.id] || []
                    if (!tierGroups.length) return null
                    return (
                      <React.Fragment key={tier.id}>
                        <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1px solid var(--border)' }}>
                          <td colSpan={4} style={{ padding: '6px 14px', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                            {tier.name}
                          </td>
                        </tr>
                        {tierGroups.map(g => (
                          <GroupRow key={g.id} group={g} tiers={tiers} onSave={saveGroup} onDelete={deleteGroup} />
                        ))}
                      </React.Fragment>
                    )
                  })}
                  {noTier.length > 0 && (
                    <>
                      <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1px solid var(--border)' }}>
                        <td colSpan={4} style={{ padding: '6px 14px', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                          No Tier
                        </td>
                      </tr>
                      {noTier.map(g => (
                        <GroupRow key={g.id} group={g} tiers={tiers} onSave={saveGroup} onDelete={deleteGroup} />
                      ))}
                    </>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Group</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input placeholder="Group name" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGroup()} style={{ ...inputStyle, flex: '1 1 160px', minWidth: 120 }} />
          <select value={newTierId} onChange={e => setNewTierId(e.target.value)} style={{ ...inputStyle, flex: '0 0 140px' }}>
            <option value="">— No tier —</option>
            {tiers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={newAvail} onChange={e => setNewAvail(e.target.value)} style={{ ...inputStyle, flex: '0 0 150px' }}>
            {AVAIL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={addGroup} disabled={adding || !newName.trim()} style={{ ...btnPrimary, flexShrink: 0 }}>
            {adding ? 'Adding…' : '+ Add'}
          </button>
        </div>
      </div>

      {importStep && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 28, width: 560, maxHeight: '80vh', overflow: 'auto' }}>
            {importStep === 'preview' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>Import Preview</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
                  {readyRows.length} ready{warnRows.length > 0 && `, ${warnRows.length} with warnings (skipped)`}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}><th style={th}>Name</th><th style={th}>Tier</th><th style={th}>Availability</th><th style={th}>Status</th></tr></thead>
                  <tbody>
                    {importRows.map((r, i) => (
                      <tr key={i} style={{ background: r.warning ? '#FFF8E7' : '', borderBottom: '1px solid var(--border)' }}>
                        <td style={td}>{r.name || <span style={{ color: 'var(--warning)' }}>—</span>}</td>
                        <td style={td}>{r.tierName || '—'}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.availability}</td>
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
                <div style={{ fontSize: 14, marginBottom: 6 }}>
                  <span style={{ color: 'var(--success)', fontWeight: 600 }}>{importResult.added} added</span>
                  {importResult.skipped > 0 && <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{importResult.skipped} skipped</span>}
                </div>
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
