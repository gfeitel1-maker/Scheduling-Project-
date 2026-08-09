import { useState, useEffect, useRef } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet, unescapeRow } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'
import ScreenIntro from '../components/ScreenIntro'

const POD_OPTIONS = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
]

function BlockRow({ block, role, onSave, onDelete }) {
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
    try {
      await onSave(block.id, { name: name.trim(), start_time: start, end_time: end, part_of_day: pod, sort_order: Number(sortOrder) })
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
          <button className="press-97" onClick={save} disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="press-97" onClick={() => { setName(block.name); setStart(block.start_time); setEnd(block.end_time); setPod(block.part_of_day); setSortOrder(block.sort_order); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
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
      <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>{POD_OPTIONS.find(o => o.value === block.part_of_day)?.label ?? '—'}</td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{block.sort_order}</td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button className="press-97" onClick={() => setEditing(true)} style={S.btnSecondary}>Edit</button>
        <button
          onClick={() => onDelete(block.id)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
        >Delete</button>
      </td>
    </tr>
  )
}

export default function TimeBlocksScreen({ campId, role, onNavigate }) {
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
  const [pendingDelete, setPendingDelete] = useState(null) // block being confirmed for delete
  const [deleting, setDeleting] = useState(false)
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
      const data = await localClient.list('time_blocks')
      // If a newer load() started (e.g. the user switched cohorts) while
      // this request was in flight, this response is stale — applying it
      // would overwrite the UI with the wrong cohort's blocks
      // (last-resolver-wins race). Bail out without touching state.
      if (requestId !== loadRequestRef.current) return
      const list = (data || [])
        .filter(b => b.camp_id === campId && b.cohort_id === cohortIdAtStart)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')))
      setBlocks(list)
    } catch {
      if (requestId !== loadRequestRef.current) return
      setError('Failed to load data — check your connection and refresh')
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }

  // Fires one write() per field (the op-log is field-level) and surfaces
  // the first failure rather than a silent partial write — see
  // DaysScreen.jsx/GroupsScreen.jsx's identical helper.
  async function writeFields(id, fields) {
    const token = localStorage.getItem('shoresh-token')
    for (const [field, value] of Object.entries(fields)) {
      const result = await localClient.write(token, 'time_blocks', id, field, value)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error(`write failed for field "${field}"`)
      }
    }
  }

  async function cleanupPartialRow(id) {
    try {
      const token = localStorage.getItem('shoresh-token')
      await localClient.deleteEntity(token, 'time_blocks', id)
    } catch {
      // best-effort only
    }
  }

  async function addBlock() {
    if (!newName.trim() || !newStart || !newEnd || !activeCohort) return
    const trimmedName = newName.trim()
    // Case/whitespace-normalized existing-name check, matching
    // confirmImport's dedupe — without this, the plain "+ Add" button had
    // zero dedupe check while import did, letting a same-named block slip
    // in through this path even before considering the cross-device race
    // the UNIQUE(camp_id, cohort_id, name) index below guards against.
    if (blocks.some(b => String(b.name ?? '').trim().toLowerCase() === trimmedName.toLowerCase())) {
      setError('A time block with this name already exists — choose a different name.')
      return
    }
    setAdding(true)
    try {
      const id = crypto.randomUUID()
      const sortVal = newSort !== '' ? Number(newSort) : (blocks.length + 1)
      try {
        // `name` written FIRST — mirrors GroupsScreen.jsx's addGroup
        // ordering. ensureExists creates the row as part of applying
        // whichever field write lands first, so a UNIQUE(camp_id,
        // cohort_id, name) collision on the `name` write fails atomically
        // before the row ever exists, rather than leaving a
        // camp_id/cohort_id-only orphan behind.
        await writeFields(id, {
          name: trimmedName,
          camp_id: campId,
          cohort_id: activeCohort.id,
          start_time: newStart,
          end_time: newEnd,
          part_of_day: newPod,
          sort_order: sortVal,
        })
      } catch (err) {
        await cleanupPartialRow(id)
        throw err
      }
      setNewName(''); setNewStart(''); setNewEnd(''); setNewSort('')
      await load()
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? 'A time block with this name already exists — choose a different name.'
          : describeWriteFailure(err, 'That time block could not be added.')
      )
    } finally {
      setAdding(false)
    }
  }

  async function saveBlock(id, fields) {
    try {
      await writeFields(id, fields)
      await load()
    } catch (err) {
      setError(describeWriteFailure(err, 'That time block could not be saved.'))
      throw err
    }
  }

  function deleteBlock(id) {
    const block = blocks.find(b => b.id === id)
    if (!block) return
    setPendingDelete(block)
  }

  async function confirmBlockDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const token = localStorage.getItem('shoresh-token')
      const result = await localClient.deleteEntity(token, 'time_blocks', pendingDelete.id)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
      setPendingDelete(null)
      await load()
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can delete time blocks.'
          : describeWriteFailure(err, 'That time block could not be deleted.')
      )
      setPendingDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  async function deleteAll() {
    if (!activeCohort) {
      setError('No program selected — add a program before deleting time blocks.')
      return
    }
    if (!window.confirm('Delete all time blocks? They can be restored from Trash.')) return
    const token = localStorage.getItem('shoresh-token')
    // Re-fetch immediately before building the id list rather than using the
    // closed-over `blocks` state — if another device synced in new blocks
    // between page-load and this click, the stale in-memory snapshot would
    // silently skip them with no indication anything was missed.
    const freshBlocks = await localClient.list('time_blocks')
    const ids = (freshBlocks || [])
      .filter(b => b.camp_id === campId && b.cohort_id === activeCohort.id)
      .map(b => b.id)
    let succeeded = 0
    let failedDueToRole = false
    for (const id of ids) {
      try {
        const result = await localClient.deleteEntity(token, 'time_blocks', id)
        if (result && (result.status === 'applied' || result.status === 'queued')) {
          succeeded++
        } else {
          console.error(`Failed to delete time block ${id}`)
        }
      } catch (err) {
        if (/admin role required/i.test(err?.message ?? '')) failedDueToRole = true
        console.error(`Failed to delete time block ${id}`, err)
      }
    }
    await load()
    const failed = ids.length - succeeded
    if (failed > 0) {
      setError(
        failedDueToRole
          ? 'Only an admin can delete time blocks — no time blocks were deleted.'
          : `Deleted ${succeeded} of ${ids.length} time blocks — please try again for the rest.`
      )
    }
  }

  function downloadTemplate() {
    const ws = aoaToSanitizedSheet([
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
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }).map(unescapeRow)
      const parsed = rows.map(r => {
        const name = String(r.name || '').trim()
        const start_time = String(r.start_time || '').trim()
        const end_time = String(r.end_time || '').trim()
        const pod = String(r.part_of_day || '').trim().toLowerCase()
        const sort_order = r.sort_order !== '' ? Number(r.sort_order) : null
        let warning = null
        if (!name) warning = 'Missing name'
        else if (typeof start_time !== 'string' || !start_time || typeof end_time !== 'string' || !end_time) warning = 'Missing time'
        else if (!['morning', 'afternoon', 'evening'].includes(pod)) warning = 'part_of_day must be morning/afternoon/evening'
        else if (sort_order !== null && !(Number.isInteger(sort_order) && sort_order >= 0)) warning = 'sort_order must be a whole number 0 or greater'
        return { name, start_time, end_time, part_of_day: pod, sort_order, warning }
      })
      setImportRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    if (!activeCohort) return
    setImporting(true)
    try {
      // Defense-in-depth: a row with a null/undefined name should never
      // reach this point (import parsing and load() both normalize name
      // to a string), but a stray malformed row here must not throw and
      // wedge the modal on "Importing…" forever — coerce rather than crash.
      const existingNames = new Set(blocks.map(b => String(b.name ?? '').toLowerCase()))
      let added = 0, skipped = 0
      for (const row of importRows) {
        if (!row.name || row.warning) { skipped++; continue }
        const lower = String(row.name).toLowerCase()
        if (existingNames.has(lower)) { skipped++; continue }
        const sortVal = row.sort_order !== null ? row.sort_order : (blocks.length + added + 1)
        try {
          const id = crypto.randomUUID()
          try {
            // `name` first — same collision-fails-atomically reasoning as addBlock.
            await writeFields(id, {
              name: row.name,
              camp_id: campId,
              cohort_id: activeCohort.id,
              start_time: row.start_time,
              end_time: row.end_time,
              part_of_day: row.part_of_day,
              sort_order: sortVal,
            })
          } catch (err) {
            await cleanupPartialRow(id)
            throw err
          }
          added++
          existingNames.add(lower)
        } catch (err) {
          console.error(`Failed to import time block "${row.name}"`, err)
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

  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)

  return (
    <div style={{ maxWidth: 780 }}>
      <ScreenIntro screen="timeblocks" />
      <CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />
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
          <button className="press-97" onClick={downloadTemplate} style={S.btnSecondary}>Download Template</button>
          <button className="press-97" onClick={() => fileRef.current.click()} style={S.btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          <button
            onClick={deleteAll}
            disabled={!activeCohort || role !== 'admin'}
            title={role !== 'admin' ? 'Admin only' : undefined}
            style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
          >Delete All</button>
        </div>
      </div>

      {showLoading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : !activeCohort ? (
        <div style={{ ...S.emptyState, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 16 }}>
          <div style={S.emptyStateTitle}>No programs yet</div>
          <div style={S.emptyStateBody}>Add a program before adding time blocks.</div>
        </div>
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
                <tr><td colSpan={6} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>No time blocks yet</div>
                  <div style={S.emptyStateBody}>Add your first time block below.</div>
                </td></tr>
              ) : blocks.map(b => (
                <BlockRow key={b.id} block={b} role={role} onSave={saveBlock} onDelete={deleteBlock} />
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
          <button className="press-97" onClick={addBlock} disabled={adding || !newName.trim() || !newStart || !newEnd || !activeCohort} style={{ ...S.btnPrimary, flexShrink: 0 }}>{adding ? 'Adding…' : '+ Add'}</button>
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

      {pendingDelete && (
        <div style={deleteOverlay}>
          <div style={deletePanel}>
            <div style={deleteTitle}>Delete "{pendingDelete.name}"?</div>
            <p style={deleteBody}>If this time block is used anywhere in your schedules, those cells will keep the old block's name until you edit them.</p>
            <div style={deleteRecovery}>"{pendingDelete.name}" goes to Trash, and you can put it back from there.</div>
            <div style={deleteActions}>
              <button className="press-97" onClick={() => setPendingDelete(null)} disabled={deleting} style={S.btnSecondary}>Cancel</button>
              <button onClick={confirmBlockDelete} disabled={deleting} style={S.btnDanger}>
                {deleting ? 'Working…' : 'Delete Time Block'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button className="press-97" onClick={() => onNavigate('activities')} style={S.btnPrimary}>Next: Activities →</button>
      </div>
    </div>
  )
}

// Local styled confirm modal reusing DeleteRecordDialog's visual chrome —
// see governance decision in docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md:
// the DeleteRecordDialog backend contract does not cover time blocks, so this
// is the honest in-scope fallback rather than a fabricated slot-count preview.
const deleteOverlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '24px 16px',
}

const deletePanel = {
  background: 'var(--surface-elevated)',
  borderRadius: 12,
  padding: 28,
  width: 520,
  maxWidth: '100%',
}

const deleteTitle = {
  fontFamily: 'var(--font-condensed)',
  fontWeight: 700,
  fontSize: 18,
  marginBottom: 14,
}

const deleteBody = { fontSize: 14, lineHeight: 1.55, margin: '0 0 14px' }

const deleteRecovery = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
}

const deleteActions = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
  marginTop: 22,
}
