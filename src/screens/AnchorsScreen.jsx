import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'

function AnchorModal({ anchor, tiers, groups, days, timeBlocks, onSave, onClose }) {
  const isNew = !anchor?.id
  const [name, setName] = useState(anchor?.name || '')
  const [isAllTiers, setIsAllTiers] = useState(anchor?.is_all_groups ?? true)
  // Multi-day: editing an existing anchor pre-selects its single day
  const [selectedDays, setSelectedDays] = useState(anchor?.day_id ? [anchor.day_id] : [])
  const [blockId, setBlockId] = useState(anchor?.time_block_id || '')
  const [notes, setNotes] = useState(anchor?.notes || '')
  const [saving, setSaving] = useState(false)

  const [selectedTiers, setSelectedTiers] = useState(() => {
    if (!anchor?.group_ids?.length) return []
    const ids = new Set(
      anchor.group_ids.map(gid => groups.find(g => g.id === gid)?.tier_id).filter(Boolean)
    )
    return [...ids]
  })

  function toggleTier(id) {
    setSelectedTiers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  function toggleDay(id) {
    setSelectedDays(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const canSave = name.trim() && selectedDays.length > 0 && blockId

  async function save() {
    if (!canSave) return
    setSaving(true)
    const group_ids = isAllTiers
      ? []
      : groups.filter(g => selectedTiers.includes(g.tier_id)).map(g => g.id)
    // When editing, update only the existing record's day; when creating, one record per day
    await onSave(anchor?.id || null, {
      name: name.trim(),
      is_all_groups: isAllTiers,
      group_ids,
      selectedDays,
      time_block_id: blockId,
      notes: notes.trim() || null,
    })
    setSaving(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 }}>
      <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 28, width: 520, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, marginBottom: 20 }}>
          {isNew ? 'Add Anchor' : `Edit: ${anchor.name}`}
        </div>

        <Field label="Name">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={inputStyle} placeholder="e.g. Mifkad, Lunch, Swim" />
        </Field>

        <Field label={isNew ? 'Days (select all that apply)' : 'Day'}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {days.map(d => (
              <label key={d.id} style={{ fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 10px', borderRadius: 5, border: '1px solid var(--border)',
                background: selectedDays.includes(d.id) ? 'var(--primary)' : 'var(--surface)',
                color: selectedDays.includes(d.id) ? '#fff' : 'var(--text)',
                fontWeight: selectedDays.includes(d.id) ? 600 : 400,
              }}>
                <input type="checkbox" checked={selectedDays.includes(d.id)} onChange={() => toggleDay(d.id)} style={{ display: 'none' }} />
                {d.label}
              </label>
            ))}
          </div>
        </Field>

        <Field label="Time Block">
          <select value={blockId} onChange={e => setBlockId(e.target.value)} style={inputStyle}>
            <option value="">— Select block —</option>
            {timeBlocks.map(b => <option key={b.id} value={b.id}>{b.name} ({b.start_time?.slice(0,5)}–{b.end_time?.slice(0,5)})</option>)}
          </select>
        </Field>

        <Field label="Tiers">
          <label style={{ fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input type="checkbox" checked={isAllTiers} onChange={e => setIsAllTiers(e.target.checked)} />
            All tiers
          </label>
          {!isAllTiers && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingLeft: 4 }}>
              {tiers.length === 0
                ? <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No tiers set up yet</span>
                : tiers.map(t => (
                  <label key={t.id} style={{ fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <input type="checkbox" checked={selectedTiers.includes(t.id)} onChange={() => toggleTier(t.id)} />{t.name}
                  </label>
                ))
              }
            </div>
          )}
        </Field>

        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
        </Field>

        {isNew && selectedDays.length > 1 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, fontFamily: 'var(--font-mono)' }}>
            Will create {selectedDays.length} anchors (one per day)
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={save} disabled={saving || !canSave} style={{ ...btnPrimary, opacity: (!canSave || saving) ? 0.5 : 1 }}>
            {saving ? 'Saving…' : isNew ? `Add Anchor${selectedDays.length > 1 ? ` (×${selectedDays.length})` : ''}` : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}

export default function AnchorsScreen({ campId, onNavigate }) {
  const [anchors, setAnchors] = useState([])
  const [days, setDays] = useState([])
  const [timeBlocks, setTimeBlocks] = useState([])
  const [tiers, setTiers] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [importStep, setImportStep] = useState(null)
  const [importRows, setImportRows] = useState([])
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef()

  useEffect(() => { load() }, [campId])

  async function load() {
    setLoading(true)
    const [{ data: aData }, { data: dData }, { data: bData }, { data: tData }, { data: gData }] = await Promise.all([
      supabase.from('anchor_activities').select('*').eq('camp_id', campId).order('name'),
      supabase.from('days_of_operation').select('*').eq('camp_id', campId).order('sort_order'),
      supabase.from('time_blocks').select('*').eq('camp_id', campId).order('sort_order'),
      supabase.from('tiers').select('*').eq('camp_id', campId).order('sort_order'),
      supabase.from('groups').select('*').eq('camp_id', campId).order('name'),
    ])
    setAnchors(aData || [])
    // Deduplicate days by day_of_week in case seed ran more than once
    const uniqueDays = (dData || []).filter((d, i, arr) => arr.findIndex(x => x.day_of_week === d.day_of_week) === i)
    setDays(uniqueDays)
    setTimeBlocks(bData || [])
    setTiers(tData || [])
    setGroups(gData || [])
    setLoading(false)
  }

  async function saveAnchor(id, fields) {
    const { selectedDays, ...base } = fields
    if (id) {
      // Editing: update existing record, use first selected day
      await supabase.from('anchor_activities').update({ ...base, day_id: selectedDays[0] }).eq('id', id)
    } else {
      // New: insert one record per selected day
      await Promise.all(
        selectedDays.map(dayId =>
          supabase.from('anchor_activities').insert({ ...base, day_id: dayId, camp_id: campId })
        )
      )
    }
    setModal(null); load()
  }

  async function deleteAnchor(id) {
    if (!window.confirm('Delete this anchor?')) return
    await supabase.from('anchor_activities').delete().eq('id', id); load()
  }

  async function deleteAll() {
    if (!window.confirm('Delete all anchors? This cannot be undone.')) return
    await supabase.from('anchor_activities').delete().eq('camp_id', campId)
    load()
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      ['name', 'day_label', 'time_block_name', 'is_all_tiers', 'tier_names', 'notes'],
      ['Mifkad', 'Monday,Tuesday,Wednesday,Thursday,Friday', 'Mifkad Block', 'TRUE', '', ''],
      ['Swim', 'Monday,Wednesday,Friday', 'Afternoon Swim', 'FALSE', 'Yeladim,Tzofim', ''],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Anchors')
    XLSX.writeFile(wb, 'anchors_template.xlsx')
  }

  async function onFileChange(e) {
    const file = e.target.files[0]; if (!file) return
    e.target.value = ''

    // Always fetch fresh lookups to avoid stale closure
    const [{ data: freshDays }, { data: freshBlocks }, { data: freshTiers }, { data: freshGroups }] = await Promise.all([
      supabase.from('days_of_operation').select('*').eq('camp_id', campId).order('sort_order'),
      supabase.from('time_blocks').select('*').eq('camp_id', campId).order('sort_order'),
      supabase.from('tiers').select('*').eq('camp_id', campId).order('sort_order'),
      supabase.from('groups').select('*').eq('camp_id', campId).order('name'),
    ])

    const uniqueFreshDays = (freshDays || []).filter((d, i, arr) => arr.findIndex(x => x.day_of_week === d.day_of_week) === i)
    const dayMap = Object.fromEntries(uniqueFreshDays.map(d => [d.label.toLowerCase(), d.id]))
    const blockMap = Object.fromEntries((freshBlocks || []).map(b => [b.name.toLowerCase(), b.id]))
    const tierMap = Object.fromEntries((freshTiers || []).map(t => [t.name.toLowerCase(), t.id]))
    const groupsByTier = Object.fromEntries(
      (freshTiers || []).map(t => [t.id, (freshGroups || []).filter(g => g.tier_id === t.id).map(g => g.id)])
    )

    const buffer = await file.arrayBuffer()
    const wb = XLSX.read(buffer, { type: 'array' })
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })

    // Expand each row into one record per day
    const parsed = []
    for (const r of rows) {
      const name = String(r.name || '').trim()
      const dayRaw = String(r.day_label || '').trim()
      const dayLabels = dayRaw.toLowerCase() === 'all'
        ? uniqueFreshDays.map(d => d.label)
        : dayRaw.split(',').map(s => s.trim()).filter(Boolean)
      const blockName = String(r.time_block_name || '').trim()
      const isAllTiers = String(r.is_all_tiers || '').toUpperCase() === 'TRUE'
      const tierNames = String(r.tier_names || '').split(',').map(s => s.trim()).filter(Boolean)

      let baseWarning = null
      if (!name) baseWarning = 'Missing name'

      const time_block_id = blockName ? (blockMap[blockName.toLowerCase()] || null) : null
      if (!time_block_id) baseWarning = baseWarning || `Time block "${blockName}" not found`

      const resolvedTierIds = tierNames.map(n => tierMap[n.toLowerCase()]).filter(Boolean)
      if (!isAllTiers && tierNames.length && resolvedTierIds.length < tierNames.length) {
        const missing = tierNames.filter(n => !tierMap[n.toLowerCase()])
        baseWarning = baseWarning || `Tier(s) not found: ${missing.join(', ')}`
      }

      const group_ids = isAllTiers
        ? []
        : resolvedTierIds.flatMap(tid => groupsByTier[tid] || [])

      const tierLabel = tierNames.join(', ') || (isAllTiers ? 'All tiers' : '—')

      if (dayLabels.length === 0) {
        parsed.push({
          name, day_id: null, time_block_id, is_all_groups: isAllTiers, group_ids,
          notes: String(r.notes || '').trim() || null,
          warning: baseWarning || 'Missing day_label',
          _dayLabel: '—', _blockName: blockName, _tierNames: tierLabel,
        })
      } else {
        for (const dayLabel of dayLabels) {
          const day_id = dayMap[dayLabel.toLowerCase()] || null
          const warning = baseWarning || (!day_id ? `Day "${dayLabel}" not found` : null)
          parsed.push({
            name, day_id, time_block_id, is_all_groups: isAllTiers, group_ids,
            notes: String(r.notes || '').trim() || null,
            warning,
            _dayLabel: dayLabel, _blockName: blockName, _tierNames: tierLabel,
          })
        }
      }
    }

    setImportRows(parsed); setImportStep('preview')
  }

  async function confirmImport() {
    setImporting(true)
    let added = 0, skipped = 0
    for (const row of importRows) {
      if (!row.name || row.warning) { skipped++; continue }
      const { warning, _dayLabel, _blockName, _tierNames, ...record } = row
      await supabase.from('anchor_activities').insert({ ...record, camp_id: campId })
      added++
    }
    setImportResult({ added, skipped }); setImportStep('done')
    setImporting(false); load()
  }

  // Display helpers
  const dayMap = Object.fromEntries(days.map(d => [d.id, d.label]))
  const blockMap = Object.fromEntries(timeBlocks.map(b => [b.id, `${b.name} (${b.start_time?.slice(0,5)}–${b.end_time?.slice(0,5)})`]))
  const tierById = Object.fromEntries(tiers.map(t => [t.id, t.name]))
  const groupTierMap = Object.fromEntries(groups.map(g => [g.id, g.tier_id]))

  function anchorTierLabel(a) {
    if (a.is_all_groups) return 'All tiers'
    const tierIds = [...new Set((a.group_ids || []).map(gid => groupTierMap[gid]).filter(Boolean))]
    const names = tierIds.map(tid => tierById[tid]).filter(Boolean)
    return names.length ? names.join(', ') : '—'
  }

  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)

  return (
    <div style={{ maxWidth: 760 }}>
      {timeBlocks.length === 0 && !loading && (
        <div style={{ background: '#FFF8E7', border: '1px solid #F5A623', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#7a5100' }}>
          No time blocks found. Set these up before adding anchors.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {anchors.length} anchor{anchors.length !== 1 ? 's' : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={downloadTemplate} style={btnSecondary}>Download Template</button>
          <button onClick={() => fileRef.current.click()} style={btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          <button onClick={deleteAll} style={btnDanger}>Delete All</button>
          <button onClick={() => setModal({ anchor: null })} style={btnPrimary}>+ Add Anchor</button>
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
                <th style={th}>Day</th>
                <th style={th}>Time Block</th>
                <th style={th}>Tiers</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {anchors.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No anchors yet.</td></tr>
              ) : anchors.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <td style={{ ...td, fontWeight: 500 }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--purple)', marginRight: 8 }} />
                    {a.name}
                  </td>
                  <td style={{ ...td, color: 'var(--text-secondary)', fontSize: 13 }}>{dayMap[a.day_id] || '—'}</td>
                  <td style={{ ...td, fontSize: 12, fontFamily: 'var(--font-mono)' }}>{blockMap[a.time_block_id] || '—'}</td>
                  <td style={{ ...td, fontSize: 12, color: 'var(--text-secondary)' }}>{anchorTierLabel(a)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => setModal({ anchor: a })} style={btnSecondary}>Edit</button>
                    <button onClick={() => deleteAnchor(a.id)} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <AnchorModal
          anchor={modal.anchor}
          tiers={tiers}
          groups={groups}
          days={days}
          timeBlocks={timeBlocks}
          onSave={saveAnchor}
          onClose={() => setModal(null)}
        />
      )}

      {importStep && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 28, width: 620, maxHeight: '80vh', overflow: 'auto' }}>
            {importStep === 'preview' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>Import Preview</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{readyRows.length} ready{warnRows.length > 0 && `, ${warnRows.length} with warnings`}</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}><th style={th}>Name</th><th style={th}>Day</th><th style={th}>Block</th><th style={th}>Tiers</th><th style={th}>Status</th></tr></thead>
                  <tbody>
                    {importRows.map((r, i) => (
                      <tr key={i} style={{ background: r.warning ? '#FFF8E7' : '', borderBottom: '1px solid var(--border)' }}>
                        <td style={td}>{r.name || '—'}</td>
                        <td style={td}>{r._dayLabel || '—'}</td>
                        <td style={td}>{r._blockName || '—'}</td>
                        <td style={td}>{r._tierNames}</td>
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
        <button onClick={() => onNavigate('schedule')} style={btnPrimary}>Next: Schedule →</button>
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
