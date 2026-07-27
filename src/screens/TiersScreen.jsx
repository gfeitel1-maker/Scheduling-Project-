import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'

function TierRow({ tier, groupCount, role, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tier.name)
  const [sortOrder, setSortOrder] = useState(tier.sort_order)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(tier.id, { name: name.trim(), sort_order: Number(sortOrder) })
      setEditing(false)
    } catch {
      // onSave already surfaced the error; stay in edit mode so nothing is lost.
    } finally {
      setSaving(false)
    }
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
        <button onClick={() => onDelete(tier.id)}
          style={groupCount > 0 || role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
          disabled={groupCount > 0 || role !== 'admin'}
          title={groupCount > 0 ? 'Remove groups from this unit first' : role !== 'admin' ? 'Admin only' : ''}
        >Delete</button>
      </td>
    </tr>
  )
}

export default function TiersScreen({ campId, role, onNavigate }) {
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
  const { cohorts, activeCohort, loading: cohortsLoading, setActiveCohortId } = useCohorts(campId)

  // Guards against a stale load() overwriting the UI after the user has
  // already switched cohorts — see the request-id ref comment on load().
  const loadRequestRef = useRef(0)

  useEffect(() => {
    if (activeCohort) load()
  }, [campId, activeCohort?.id])

  // Once useCohorts has finished loading with no cohort available, there is
  // nothing for load() to fetch and it will never resolve loading to false
  // on its own — fall back to the cohorts hook's own loading state instead
  // of leaving the screen stuck on "Loading…" forever.
  const showLoading = activeCohort ? loading : cohortsLoading

  async function load() {
    if (!activeCohort) return
    const cohortIdAtStart = activeCohort.id
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setError(null)
    try {
      const [tierData, groupData] = await Promise.all([
        localClient.list('tiers'),
        localClient.list('groups'),
      ])
      // If a newer load() started (e.g. the user switched cohorts) while
      // this request was in flight, this response is stale — applying it
      // would overwrite the UI with the wrong cohort's units
      // (last-resolver-wins race). Bail out without touching state.
      if (requestId !== loadRequestRef.current) return
      const list = (tierData || [])
        .filter(t => t.camp_id === campId && t.cohort_id === cohortIdAtStart)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? '')))
      setTiers(list)
      const counts = {}
      for (const g of (groupData || []).filter(g => g.camp_id === campId)) {
        counts[g.tier_id] = (counts[g.tier_id] || 0) + 1
      }
      setGroupCounts(counts)
    } catch {
      if (requestId !== loadRequestRef.current) return
      setError('Failed to load data — check your connection and refresh')
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }

  // Fires one write() per field (the op-log is field-level) and surfaces
  // the first failure rather than a silent partial write — see
  // DaysScreen.jsx/TimeBlocksScreen.jsx's identical helper.
  async function writeFields(id, fields) {
    const token = localStorage.getItem('shoresh-token')
    for (const [field, value] of Object.entries(fields)) {
      const result = await localClient.write(token, 'tiers', id, field, value)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error(`write failed for field "${field}"`)
      }
    }
  }

  async function cleanupPartialRow(id) {
    try {
      const token = localStorage.getItem('shoresh-token')
      await localClient.deleteEntity(token, 'tiers', id)
    } catch {
      // best-effort only
    }
  }

  async function addTier() {
    if (!newName.trim() || !activeCohort) return
    const trimmedName = newName.trim()
    // Case/whitespace-normalized existing-name check, matching
    // confirmImport's dedupe — without this, the plain "+ Add" button had
    // zero dedupe check while import did.
    if (tiers.some(t => String(t.name ?? '').trim().toLowerCase() === trimmedName.toLowerCase())) {
      setError('A unit with this name already exists — choose a different name.')
      return
    }
    setAdding(true)
    try {
      const id = crypto.randomUUID()
      const sortVal = newSort !== '' ? Number(newSort) : (tiers.length + 1)
      try {
        // `name` written FIRST — ensureExists creates the row as part of
        // applying whichever field write lands first, so a UNIQUE(camp_id,
        // cohort_id, name) collision on the `name` write fails atomically
        // before the row ever exists, rather than leaving a
        // camp_id/cohort_id-only orphan behind.
        await writeFields(id, {
          name: trimmedName,
          camp_id: campId,
          cohort_id: activeCohort.id,
          sort_order: sortVal,
        })
      } catch (err) {
        await cleanupPartialRow(id)
        throw err
      }
      setNewName('')
      setNewSort('')
      await load()
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? 'A unit with this name already exists — choose a different name.'
          : 'Failed to add unit — check your connection and try again'
      )
    } finally {
      setAdding(false)
    }
  }

  async function saveTier(id, fields) {
    try {
      await writeFields(id, fields)
      await load()
    } catch (err) {
      setError('Failed to save unit — check your connection and try again')
      throw err
    }
  }

  async function deleteTier(id) {
    if (!window.confirm('Delete this unit?')) return
    try {
      const token = localStorage.getItem('shoresh-token')
      const result = await localClient.deleteEntity(token, 'tiers', id)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
      await load()
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can delete units.'
          : 'Failed to delete unit — check your connection and try again'
      )
    }
  }

  async function deleteAll() {
    if (!activeCohort) {
      setError('No program selected — add a program before deleting units.')
      return
    }
    if (!window.confirm('Delete all units? This cannot be undone.')) return
    const token = localStorage.getItem('shoresh-token')
    // Re-fetch immediately before building the id list rather than using the
    // closed-over `tiers` state — if another device synced in new units
    // between page-load and this click, the stale in-memory snapshot would
    // silently skip them with no indication anything was missed.
    const freshTiers = await localClient.list('tiers')
    const ids = (freshTiers || [])
      .filter(t => t.camp_id === campId && t.cohort_id === activeCohort.id)
      .map(t => t.id)
    let succeeded = 0
    let failedDueToRole = false
    for (const id of ids) {
      try {
        const result = await localClient.deleteEntity(token, 'tiers', id)
        if (result && (result.status === 'applied' || result.status === 'queued')) {
          succeeded++
        }
      } catch (err) {
        if (/admin role required/i.test(err?.message ?? '')) failedDueToRole = true
      }
    }
    await load()
    const failed = ids.length - succeeded
    if (failed > 0) {
      setError(
        failedDueToRole
          ? 'Only an admin can delete units — no units were deleted.'
          : `Deleted ${succeeded} of ${ids.length} units — please try again for the rest.`
      )
    }
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      ['name', 'sort_order'],
      ['Yeladim', 1],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Units')
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
      const parsed = rows.map(r => {
        const name = String(r.name || '').trim()
        const sort_order = r.sort_order !== '' ? Number(r.sort_order) : null
        let warning = null
        if (!name) warning = 'Missing name'
        else if (sort_order !== null && !(Number.isInteger(sort_order) && sort_order >= 0)) warning = 'sort_order must be a whole number 0 or greater'
        return { name, sort_order, warning }
      })
      setImportRows(parsed)
      setImportStep('preview')
    }
    reader.readAsArrayBuffer(file)
    e.target.value = ''
  }

  async function confirmImport() {
    if (!activeCohort) return
    setImporting(true)
    try {
      // Defense-in-depth: a row with a null/undefined name should never
      // reach this point (import parsing and load() both normalize name
      // to a string), but a stray malformed row here must not throw and
      // wedge the modal on "Importing…" forever — coerce rather than crash.
      const existingNames = new Set(tiers.map(t => String(t.name ?? '').toLowerCase()))
      let added = 0, skipped = 0
      for (const row of importRows) {
        if (!row.name || row.warning) { skipped++; continue }
        const lower = String(row.name).toLowerCase()
        if (existingNames.has(lower)) { skipped++; continue }
        const sortVal = row.sort_order !== null ? row.sort_order : (tiers.length + added + 1)
        try {
          const id = crypto.randomUUID()
          try {
            // `name` first — same collision-fails-atomically reasoning as addTier.
            await writeFields(id, {
              name: row.name,
              camp_id: campId,
              cohort_id: activeCohort.id,
              sort_order: sortVal,
            })
          } catch (err) {
            await cleanupPartialRow(id)
            throw err
          }
          added++
          existingNames.add(lower)
        } catch {
          skipped++
        }
      }
      setImportResult({ added, skipped })
      setImportStep('done')
    } catch {
      setError('Import failed — check your connection and try again')
      setImportStep(null); setImportRows([])
    } finally {
      setImporting(false); await load()
    }
  }

  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)

  return (
    <div style={{ maxWidth: 700 }}>
      <CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />
      {error && (
        <div style={S.errorBanner}>
          {error}
        </div>
      )}
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          {tiers.length} unit{tiers.length !== 1 ? 's' : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={downloadTemplate} style={S.btnSecondary}>Download Template</button>
          <button onClick={() => fileRef.current.click()} style={S.btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          <button
            onClick={deleteAll}
            disabled={!activeCohort || role !== 'admin'}
            title={role !== 'admin' ? 'Admin only' : undefined}
            style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
          >Delete All</button>
        </div>
      </div>

      {/* Table */}
      {showLoading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : !activeCohort ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '40px 16px', textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No programs yet</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add a program before adding units.</div>
        </div>
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
                  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No units yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first unit below or import from Excel.</div>
                </td></tr>
              ) : tiers.map(tier => (
                <TierRow
                  key={tier.id}
                  tier={tier}
                  groupCount={groupCounts[tier.id] || 0}
                  role={role}
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
          Add Unit
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            placeholder="Unit name (e.g. Yeladim)"
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
          <button onClick={addTier} disabled={adding || !newName.trim() || !activeCohort} style={S.btnPrimary}>
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
                    {importing ? 'Importing…' : `Import ${readyRows.length} unit${readyRows.length !== 1 ? 's' : ''}`}
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
