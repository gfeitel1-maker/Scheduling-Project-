import { useState, useEffect } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { localClient } from '../localClient'
import { S } from '../styles/shared'

const ANCHOR_MODELS = [
  { value: 'none',     label: 'None — no fixed events' },
  { value: 'fixed',    label: 'Fixed — fixed events happen at the same time every day' },
  { value: 'floating', label: 'Floating — fixed events can move within the day (coming soon)' },
]

const CAPACITY_SOURCES = [
  { value: 'groups_per_slot',  label: 'How many groups share a period' },
  { value: 'camper_headcount', label: 'Camper headcount (coming soon)' },
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
    try {
      await onSave(cohort.id, {
        name: name.trim(),
        session_week_start: Number(weekStart),
        session_week_end: Number(weekEnd),
        anchor_model: anchorModel,
        capacity_source: capacitySource,
        sort_order: Number(sortOrder),
      })
      setEditing(false)
    } catch {
      // onSave already surfaced the failure via the screen's error banner;
      // stay in edit mode (don't revert to read-only) so the user's
      // in-progress changes aren't silently discarded as if they'd saved.
    } finally {
      setSaving(false)
    }
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
        {ANCHOR_MODELS.find(o => o.value === cohort.anchor_model)?.label ?? '—'}
      </td>
      <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
        {CAPACITY_SOURCES.find(o => o.value === cohort.capacity_source)?.label ?? '—'}
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
      const data = await localClient.list('cohorts')
      const list = (data || [])
        .filter((c) => c.camp_id === campId)
        .sort((a, b) => {
          const sortDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0)
          if (sortDiff !== 0) return sortDiff
          return (a.name ?? '').localeCompare(b.name ?? '')
        })
      setCohorts(list)
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  // Fires one write() per field (the op-log is field-level — see
  // CLAUDE.md's op-log note) and surfaces the first failure rather than a
  // silent partial write, per the project convention of checking
  // `result.status !== 'applied'`/'queued' after each write.
  async function writeFields(id, fields) {
    const token = localStorage.getItem('shoresh-token')
    for (const [field, value] of Object.entries(fields)) {
      const result = await localClient.write(token, 'cohorts', id, field, value)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error(`write failed for field "${field}"`)
      }
    }
  }

  async function addCohort() {
    if (!newName.trim()) return
    setAdding(true)
    const sortVal = newSort !== '' ? Number(newSort) : (cohorts.length + 1)
    try {
      const id = crypto.randomUUID()
      // `name` is written FIRST — see ensureCohort.js's identical ordering
      // note. cohorts.ensureExists (electron/ops/projections.js) creates the
      // row as part of applying whichever field write lands first, so if
      // `camp_id` went first a UNIQUE(camp_id, name) collision on the later
      // `name` write would leave an orphaned camp_id-only row behind.
      // Writing `name` first means a collision fails on the very first
      // write, and the row-creation + failed UPDATE are the same SQLite
      // transaction (see appendOp), so nothing is left behind at all.
      await writeFields(id, {
        name: newName.trim(),
        camp_id: campId,
        session_week_start: Number(newWeekStart),
        session_week_end: Number(newWeekEnd),
        anchor_model: newAnchorModel,
        capacity_source: newCapacitySource,
        sort_order: sortVal,
      })
      setNewName('')
      setNewWeekStart(1)
      setNewWeekEnd(1)
      setNewSort('')
      setNewAnchorModel('fixed')
      setNewCapacitySource('groups_per_slot')
      await load()
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? 'A program with this name already exists — choose a different name.'
          : describeWriteFailure(err, 'That program could not be added.')
      )
    } finally {
      setAdding(false)
    }
  }

  async function saveCohort(id, fields) {
    try {
      await writeFields(id, fields)
      await load()
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? 'A program with this name already exists — choose a different name.'
          : describeWriteFailure(err, 'That program could not be saved.')
      )
      throw err
    }
  }

  async function deleteCohort(id) {
    if (cohorts.length <= 1) {
      alert('Cannot delete the last program — every camp must have at least one.')
      return
    }
    if (!window.confirm('Delete this program? Units and time blocks assigned to it will lose their program reference.')) return
    try {
      const token = localStorage.getItem('shoresh-token')
      const result = await localClient.deleteEntity(token, 'cohorts', id)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
      await load()
    } catch (err) {
      setError(
        /FOREIGN KEY/i.test(err?.message ?? '')
          ? "Can't delete — other data (time blocks or fixed events) still references this program. Remove those first."
          : describeWriteFailure(err, 'That program could not be deleted.')
      )
    }
  }

  return (
    <div style={{ maxWidth: 900 }}>
      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {cohorts.length} program{cohorts.length !== 1 ? 's' : ''}
        </div>
      </div>

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Session Weeks</th>
                <th style={S.th}>Fixed Events</th>
                <th style={S.th}>Capacity Source</th>
                <th style={S.th}>Order</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cohorts.length === 0 ? (
                <tr><td colSpan={6} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>No programs yet</div>
                  <div style={S.emptyStateBody}>Add your first program below.</div>
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
          Add Program
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
            {adding ? 'Adding…' : '+ Add Program'}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        A program groups units, time blocks, and fixed events that share a schedule structure.
        Most camps have one program ("Main"). Add a second for specialty programs with a different time grid.
      </div>
    </div>
  )
}
