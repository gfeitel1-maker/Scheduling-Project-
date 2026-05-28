import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { S } from '../styles/shared'

const ANCHOR_MODELS = [
  { value: 'none',     label: 'None — no anchors' },
  { value: 'fixed',    label: 'Fixed — anchors locked to day + block' },
  { value: 'floating', label: 'Floating — anchors constrained to a day window' },
]

const CAPACITY_SOURCES = [
  { value: 'groups_per_slot',  label: 'Groups per slot (default)' },
  { value: 'camper_headcount', label: 'Camper headcount' },
]

function CohortRow({ cohort, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(cohort.name)
  const [weekStart, setWeekStart] = useState(cohort.session_week_start)
  const [weekEnd, setWeekEnd] = useState(cohort.session_week_end)
  const [anchorModel, setAnchorModel] = useState(cohort.anchor_model)
  const [capacitySource, setCapacitySource] = useState(cohort.capacity_source)
  const [sortOrder, setSortOrder] = useState(cohort.sort_order)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await onSave(cohort.id, {
      name: name.trim(),
      session_week_start: Number(weekStart),
      session_week_end: Number(weekEnd),
      anchor_model: anchorModel,
      capacity_source: capacitySource,
      sort_order: Number(sortOrder),
    })
    setSaving(false)
    setEditing(false)
  }

  function cancel() {
    setName(cohort.name)
    setWeekStart(cohort.session_week_start)
    setWeekEnd(cohort.session_week_end)
    setAnchorModel(cohort.anchor_model)
    setCapacitySource(cohort.capacity_source)
    setSortOrder(cohort.sort_order)
    setEditing(false)
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={S.td}>
          <input autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()} style={S.input} />
        </td>
        <td style={S.td}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="number" min="1" value={weekStart}
              onChange={e => setWeekStart(e.target.value)}
              style={{ ...S.input, width: 56 }} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>–</span>
            <input type="number" min="1" value={weekEnd}
              onChange={e => setWeekEnd(e.target.value)}
              style={{ ...S.input, width: 56 }} />
          </div>
        </td>
        <td style={S.td}>
          <select value={anchorModel} onChange={e => setAnchorModel(e.target.value)} style={S.input}>
            {ANCHOR_MODELS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </td>
        <td style={S.td}>
          <select value={capacitySource} onChange={e => setCapacitySource(e.target.value)} style={S.input}>
            {CAPACITY_SOURCES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </td>
        <td style={S.td}>
          <input type="number" value={sortOrder} onChange={e => setSortOrder(e.target.value)}
            style={{ ...S.input, width: 60 }} />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button onClick={save} disabled={saving} style={S.btnPrimary}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={cancel} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <td style={{ ...S.td, fontWeight: 500 }}>{cohort.name}</td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {cohort.session_week_start}–{cohort.session_week_end}
      </td>
      <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
        {ANCHOR_MODELS.find(o => o.value === cohort.anchor_model)?.label ?? cohort.anchor_model}
      </td>
      <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
        {CAPACITY_SOURCES.find(o => o.value === cohort.capacity_source)?.label ?? cohort.capacity_source}
      </td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{cohort.sort_order}</td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button onClick={() => setEditing(true)} style={S.btnSecondary}>Edit</button>
        <button onClick={() => onDelete(cohort.id)} style={{ ...S.btnDanger, marginLeft: 6 }}>Delete</button>
      </td>
    </tr>
  )
}

export default function CohortsScreen({ campId }) {
  const [cohorts, setCohorts] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newWeekStart, setNewWeekStart] = useState(1)
  const [newWeekEnd, setNewWeekEnd] = useState(1)
  const [newAnchorModel, setNewAnchorModel] = useState('fixed')
  const [newCapacitySource, setNewCapacitySource] = useState('groups_per_slot')
  const [newSort, setNewSort] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => { load() }, [campId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const { data } = await supabase.from('cohorts').select('*')
        .eq('camp_id', campId).order('sort_order').order('name')
      setCohorts(data || [])
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  async function addCohort() {
    if (!newName.trim()) return
    setAdding(true)
    const sortVal = newSort !== '' ? Number(newSort) : (cohorts.length + 1)
    await supabase.from('cohorts').insert({
      camp_id: campId,
      name: newName.trim(),
      session_week_start: Number(newWeekStart),
      session_week_end: Number(newWeekEnd),
      anchor_model: newAnchorModel,
      capacity_source: newCapacitySource,
      sort_order: sortVal,
    })
    setNewName('')
    setNewWeekStart(1)
    setNewWeekEnd(1)
    setAdding(false)
    load()
  }

  async function saveCohort(id, fields) {
    await supabase.from('cohorts').update(fields).eq('id', id)
    load()
  }

  async function deleteCohort(id) {
    if (cohorts.length <= 1) {
      alert('Cannot delete the last cohort — every camp must have at least one.')
      return
    }
    if (!window.confirm('Delete this cohort? Tiers and time blocks assigned to it will lose their cohort reference.')) return
    await supabase.from('cohorts').delete().eq('id', id)
    load()
  }

  return (
    <div style={{ maxWidth: 900 }}>
      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {cohorts.length} cohort{cohorts.length !== 1 ? 's' : ''}
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
                <th style={S.th}>Session Weeks</th>
                <th style={S.th}>Anchor Model</th>
                <th style={S.th}>Capacity Source</th>
                <th style={S.th}>Order</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cohorts.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '40px 16px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No cohorts yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first cohort below.</div>
                </td></tr>
              ) : cohorts.map(c => (
                <CohortRow key={c.id} cohort={c} onSave={saveCohort} onDelete={deleteCohort} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Add Cohort
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <input placeholder="Name (e.g. Main, Specialty)" value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addCohort()}
            style={{ ...S.input, flex: '1 1 160px' }} />
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Weeks</span>
            <input type="number" min="1" value={newWeekStart}
              onChange={e => setNewWeekStart(e.target.value)}
              style={{ ...S.input, width: 56 }} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>–</span>
            <input type="number" min="1" value={newWeekEnd}
              onChange={e => setNewWeekEnd(e.target.value)}
              style={{ ...S.input, width: 56 }} />
          </div>
          <input type="number" placeholder="Order" value={newSort}
            onChange={e => setNewSort(e.target.value)}
            style={{ ...S.input, width: 70 }} />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={newAnchorModel} onChange={e => setNewAnchorModel(e.target.value)}
            style={{ ...S.input, flex: '1 1 220px' }}>
            {ANCHOR_MODELS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={newCapacitySource} onChange={e => setNewCapacitySource(e.target.value)}
            style={{ ...S.input, flex: '1 1 200px' }}>
            {CAPACITY_SOURCES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={addCohort} disabled={adding || !newName.trim()}
            style={{ ...S.btnPrimary, flexShrink: 0 }}>
            {adding ? 'Adding…' : '+ Add Cohort'}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        A cohort groups tiers, time blocks, and anchors that share a schedule structure.
        Most camps have one cohort ("Main"). Add a second for specialty programs with a different time grid.
      </div>
    </div>
  )
}
