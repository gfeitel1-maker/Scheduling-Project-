import { useState, useEffect, useRef } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet, unescapeRow } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { S, useEnterTransition } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import { createSetupCrudRepository } from '../data/setupCrudRepository'

// Repository-only migration (not the full useCrudScreen hook): load() fans out
// across five parallel list() calls with per-cohort scoping, and the create
// path is a per-day fan-out with granular orphan reporting that the shared
// createRecord's swallow-and-rethrow cleanup cannot express — so saveAnchor's
// rollback bookkeeping and cleanupPartialRow stay screen-local. The seam owns
// the field-level write loop (writeFields) and the delete-all loop.
// See docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md.
const repository = createSetupCrudRepository({ localClient })

// operations.value only accepts strings/null (better-sqlite3 throws on a raw
// boolean/array) — every write must pre-serialize through these before
// hitting localClient.write. Mirrors ActivitiesScreen.jsx's identical pattern.
const BOOL_FIELDS = new Set(['is_all_groups'])
const ARRAY_FIELDS = new Set(['group_ids'])

function serializeFieldValue(field, value) {
  if (BOOL_FIELDS.has(field)) return value ? 1 : 0
  if (ARRAY_FIELDS.has(field)) return JSON.stringify(value ?? [])
  return value ?? null
}

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024

// GOVERNOR judgment call (round 2->3 boundary, Sub-plan D Task 1): a
// client-side Promise.race timeout was tried here and reverted. localClient's
// underlying IPC call has no AbortController/cancellation — racing it against
// a timer only stops the RENDERER from waiting, the real write/delete keeps
// running in the main process and can complete (and, via ensureExists'
// INSERT OR IGNORE, resurrect a row) *after* the UI has already told the user
// it was rolled back or failed. That's a worse correctness risk (silently
// wrong "it's gone" state) than the unbounded-hang UX gap it was meant to
// fix, and no sibling migrated screen (ActivitiesScreen/TiersScreen/etc.) has
// this timeout pattern either — reverting keeps this file consistent with
// every other screen's already-accepted "IPC calls can hang, no timeout"
// behavior. A real fix needs request cancellation or an idempotency-safe
// generation fence at the localClient/IPC layer, which is out of scope for a
// single-screen migration task — flagged as a genuine, not-yet-scheduled
// follow-up (project memory).

// Defense-in-depth: malformed JSON in group_ids (e.g. from a corrupted/
// tampered op) must not crash the list render — default to [].
function parseIdList(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeAnchor(row) {
  return {
    ...row,
    is_all_groups: row.is_all_groups === 1 || row.is_all_groups === true,
    group_ids: parseIdList(row.group_ids),
  }
}

function AnchorModal({ anchor, tiers, groups, days, timeBlocks, onSave, onClose }) {
  const isNew = !anchor?.id
  const [name, setName] = useState(anchor?.name || '')
  const [isAllTiers, setIsAllTiers] = useState(anchor?.is_all_groups ?? true)
  // Multi-day: editing an existing anchor pre-selects its single day
  const [selectedDays, setSelectedDays] = useState(anchor?.day_id ? [anchor.day_id] : [])
  const [blockId, setBlockId] = useState(anchor?.time_block_id || '')
  const [notes, setNotes] = useState(anchor?.notes || '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const enterStyle = useEnterTransition('liftFade')

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
    setSaveError(null)
    const group_ids = isAllTiers
      ? []
      : groups.filter(g => selectedTiers.includes(g.tier_id)).map(g => g.id)
    // When editing, update only the existing record's day; when creating, one record per day
    try {
      await onSave(anchor?.id || null, {
        name: name.trim(),
        is_all_groups: isAllTiers,
        group_ids,
        selectedDays,
        time_block_id: blockId,
        notes: notes.trim() || null,
      })
    } catch (err) {
      setSaveError(
        err?.cleanupFailed
          ? `Save failed partway through and couldn't be fully rolled back (admin required) — ${err.orphanCount} incomplete fixed-event row(s) may remain; ask an admin to review/delete them.`
          : describeWriteFailure(err, 'Your changes could not be saved.')
      )
      setSaving(false)
      return
    }
    setSaving(false)
  }

  return (
    <div style={{ ...S.overlay, ...enterStyle }}>
      <div style={{ ...S.modalLg, width: 520 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, marginBottom: 20 }}>
          {isNew ? 'Add Fixed Event' : `Edit: ${anchor.name}`}
        </div>

        <Field label="Name">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={S.input} placeholder="e.g. Mifkad, Lunch, Swim" />
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
          <select value={blockId} onChange={e => setBlockId(e.target.value)} style={S.input}>
            <option value="">— Select block —</option>
            {timeBlocks.map(b => <option key={b.id} value={b.id}>{b.name} ({b.start_time?.slice(0,5)}–{b.end_time?.slice(0,5)})</option>)}
          </select>
        </Field>

        <Field label="Age Divisions">
          <label style={{ fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input type="checkbox" checked={isAllTiers} onChange={e => setIsAllTiers(e.target.checked)} />
            All age divisions
          </label>
          {!isAllTiers && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingLeft: 4 }}>
              {tiers.length === 0
                ? <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No age divisions set up yet</span>
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
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...S.input, resize: 'vertical' }} />
        </Field>

        {isNew && selectedDays.length > 1 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, fontFamily: 'var(--font-mono)' }}>
            Will create {selectedDays.length} fixed events (one per day)
          </div>
        )}

        {saveError && (
          <div style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 10, padding: '8px 10px', background: '#fff5f5', borderRadius: 5, border: '1px solid #f5c6c6' }}>
            {saveError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="press-97" onClick={onClose} style={S.btnSecondary}>Cancel</button>
          <button className="press-97" onClick={save} disabled={saving || !canSave} style={{ ...S.btnPrimary, opacity: (!canSave || saving) ? 0.5 : 1 }}>
            {saving ? 'Saving…' : isNew ? `Add Fixed Event${selectedDays.length > 1 ? ` (×${selectedDays.length})` : ''}` : 'Save Changes'}
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

export default function AnchorsScreen({ campId, role, onNavigate }) {
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
  const [error, setError] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null) // anchor being confirmed for delete
  const [deleting, setDeleting] = useState(false)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const deleteInFlight = useRef(false)
  const fileRef = useRef()
  const { cohorts, activeCohort, setActiveCohortId } = useCohorts(campId)
  const importEnterStyle = useEnterTransition('liftFade')

  useEffect(() => {
    if (activeCohort) load()
  }, [campId, activeCohort?.id])

  async function load() {
    if (!activeCohort) return
    setLoading(true)
    setError(null)
    try {
      const [aData, dData, bData, tData, gData] = await Promise.all([
        localClient.list('anchor_activities'),
        localClient.list('days_of_operation'),
        localClient.list('time_blocks'),
        localClient.list('tiers'),
        localClient.list('groups'),
      ])
      const list = (aData || [])
        .filter(a => a.camp_id === campId && a.cohort_id === activeCohort.id)
        .map(normalizeAnchor)
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
      setAnchors(list)
      // Deduplicate days by day_of_week in case seed ran more than once
      const uniqueDays = (dData || [])
        .filter(d => d.camp_id === campId)
        .filter((d, i, arr) => arr.findIndex(x => x.day_of_week === d.day_of_week) === i)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      setDays(uniqueDays)
      setTimeBlocks((bData || [])
        .filter(b => b.camp_id === campId && b.cohort_id === activeCohort.id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)))
      setTiers((tData || [])
        .filter(t => t.camp_id === campId && t.cohort_id === activeCohort.id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)))
      setGroups((gData || [])
        .filter(g => g.camp_id === campId)
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))))
    } catch {
      setError("Couldn't load your camp setup — check your connection and refresh.")
    } finally {
      setLoading(false)
    }
  }

  // Boolean/array fields are serialized here since operations.value only
  // accepts strings/null — the shared repository writes whatever value it's
  // given. Mirrors ActivitiesScreen.jsx's serializeFields.
  function serializeFields(fields) {
    return Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [field, serializeFieldValue(field, value)])
    )
  }

  // Thin wrapper, not a reimplementation: composes Anchors-only serialization
  // then delegates the field-level write loop to the shared repository.
  async function writeFields(id, fields) {
    await repository.writeFields('anchor_activities', id, serializeFields(fields))
  }

  // Best-effort rollback of a row from a mid-fan-out failure. Returns
  // whether the delete actually succeeded — deleteEntity routes to a
  // DELETE_FIELD write, which electron/main.js gates to admin-only, so a
  // non-admin's cleanup attempt is *correctly* refused. Callers must not
  // treat a refused cleanup as if nothing went wrong: the row is real and
  // orphaned, and the user needs to be told, not reassured.
  async function cleanupPartialRow(id) {
    try {
      const token = localStorage.getItem('shoresh-token')
      const result = await localClient.deleteEntity(token, 'anchor_activities', id)
      return !!(result && (result.status === 'applied' || result.status === 'queued'))
    } catch {
      return false
    }
  }

  async function saveAnchor(id, fields) {
    if (!activeCohort) return
    const { selectedDays, ...base } = fields
    try {
      if (id) {
        // Editing: update existing record, use first selected day
        await writeFields(id, { ...base, day_id: selectedDays[0] })
      } else {
        // New: insert one record per selected day — each row gets its own id
        // and its own full set of field writes (day_id differs per row,
        // everything else is identical). Preserves the fan-out-per-day
        // semantics of the pre-migration Supabase code exactly.
        const createdIds = []
        try {
          for (const dayId of selectedDays) {
            const newId = crypto.randomUUID()
            createdIds.push(newId)
            await writeFields(newId, { ...base, day_id: dayId, camp_id: campId, cohort_id: activeCohort.id })
          }
        } catch (err) {
          // Known, accepted residual (Red Hat, round 2 re-review): a refused
          // cleanup delete (admin-gated) is reported as "may remain" even in
          // the rare case the failed write never actually reached the DB
          // (e.g. the very first write of the very first row rejects before
          // touching applyProjection) — the admin gate fires on the delete
          // attempt regardless of whether a row exists to delete. The
          // message is deliberately hedged ("may remain", not "remains") for
          // exactly this reason; a precise existence check would need a
          // dedicated read-before-cleanup IPC round trip, out of scope here.
          const cleanupResults = await Promise.all(createdIds.map(cleanupPartialRow))
          const cleanupFailed = cleanupResults.some(ok => !ok)
          err.cleanupFailed = cleanupFailed
          err.orphanCount = cleanupFailed ? cleanupResults.filter(ok => !ok).length : 0
          throw err
        }
      }
    } catch (err) {
      setError(
        err.cleanupFailed
          ? `Save failed partway through and couldn't be fully rolled back (admin required) — ${err.orphanCount} incomplete fixed-event row(s) may remain; ask an admin to review/delete them.`
          : describeWriteFailure(err, 'That fixed event could not be saved.')
      )
      throw err
    }
    await load()
    setModal(null)
  }

  function deleteAnchor(id) {
    const anchor = anchors.find(a => a.id === id)
    if (!anchor) return
    setPendingDelete(anchor)
  }

  async function confirmAnchorDelete() {
    if (!pendingDelete || deleteInFlight.current) return
    deleteInFlight.current = true
    setDeleting(true)
    try {
      const token = localStorage.getItem('shoresh-token')
      const result = await localClient.deleteEntity(token, 'anchor_activities', pendingDelete.id)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
      setPendingDelete(null)
      await load()
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can delete fixed events.'
          : describeWriteFailure(err, 'That fixed event could not be deleted.')
      )
      setPendingDelete(null)
    } finally {
      setDeleting(false)
      deleteInFlight.current = false
    }
  }

  function deleteAll() {
    setPendingDeleteAll(true)
  }

  async function confirmDeleteAll() {
    setDeletingAll(true)
    try {
      // Re-fetch immediately rather than using the closed-over `anchors`
      // state — a row synced in from another device between page-load and
      // this click must not be silently skipped. The delete loop itself now
      // lives in the shared repository; scoping (camp + cohort) stays here.
      const freshAnchors = await localClient.list('anchor_activities')
      const ids = (freshAnchors || [])
        .filter(a => a.camp_id === campId && a.cohort_id === activeCohort?.id)
        .map(a => a.id)
      const { succeeded, failed, failedDueToRole } = await repository.deleteAllRecords('anchor_activities', ids)
      await load()
      if (failed > 0) {
        setError(
          failedDueToRole
            ? 'Only an admin can delete fixed events — no fixed events were deleted.'
            : `Deleted ${succeeded} of ${ids.length} fixed events — please try again for the rest.`
        )
      }
    } catch (err) {
      setError(describeWriteFailure(err, 'That fixed events could not be deleted.'))
    } finally {
      setDeletingAll(false)
      setPendingDeleteAll(false)
    }
  }

  function downloadTemplate() {
    const ws = aoaToSanitizedSheet([
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

    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setError('Import file is too large (max 5MB) — please split it into smaller files')
      return
    }

    try {
      // Always fetch fresh lookups to avoid stale closure
      const [freshDays, freshBlocks, freshTiers, freshGroups] = await Promise.all([
        localClient.list('days_of_operation'),
        localClient.list('time_blocks'),
        localClient.list('tiers'),
        localClient.list('groups'),
      ])

      const uniqueFreshDays = (freshDays || [])
        .filter(d => d.camp_id === campId)
        .filter((d, i, arr) => arr.findIndex(x => x.day_of_week === d.day_of_week) === i)
      const dayMap = Object.fromEntries(uniqueFreshDays.map(d => [d.label.toLowerCase(), d.id]))
      const blockMap = Object.fromEntries(
        (freshBlocks || [])
          .filter(b => b.camp_id === campId && b.cohort_id === activeCohort?.id)
          .map(b => [b.name.toLowerCase(), b.id])
      )
      const scopedTiers = (freshTiers || []).filter(t => t.camp_id === campId && t.cohort_id === activeCohort?.id)
      const tierMap = Object.fromEntries(scopedTiers.map(t => [t.name.toLowerCase(), t.id]))
      const scopedGroups = (freshGroups || []).filter(g => g.camp_id === campId)
      const groupsByTier = Object.fromEntries(
        scopedTiers.map(t => [t.id, scopedGroups.filter(g => g.tier_id === t.id).map(g => g.id)])
      )

      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }).map(unescapeRow)

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
          baseWarning = baseWarning || `Age Division(s) not found: ${missing.join(', ')}`
        }

        const group_ids = isAllTiers
          ? []
          : resolvedTierIds.flatMap(tid => groupsByTier[tid] || [])

        const tierLabel = tierNames.join(', ') || (isAllTiers ? 'All age divisions' : '—')

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
    } catch (err) {
      setError(describeWriteFailure(err, 'That import file could not be read.'))
    }
  }

  async function confirmImport() {
    if (!activeCohort) return
    setImporting(true)
    try {
      let added = 0, skipped = 0, skippedWithOrphan = 0
      for (const row of importRows) {
        if (!row.name || row.warning) { skipped++; continue }
        const { warning: _warning, _dayLabel, _blockName, _tierNames, ...record } = row
        const newId = crypto.randomUUID()
        try {
          await writeFields(newId, { ...record, camp_id: campId, cohort_id: activeCohort.id })
        } catch {
          const cleanedUp = await cleanupPartialRow(newId)
          if (cleanedUp) {
            skipped++
          } else {
            skippedWithOrphan++
          }
          continue
        }
        added++
      }
      setImportResult({ added, skipped, skippedWithOrphan }); setImportStep('done')
    } catch (err) {
      setError(describeWriteFailure(err, 'That import could not be completed.'))
      setImportStep(null); setImportRows([])
    } finally {
      setImporting(false); await load()
    }
  }

  // Display helpers
  const dayMap = Object.fromEntries(days.map(d => [d.id, d.label]))
  const blockMap = Object.fromEntries(timeBlocks.map(b => [b.id, `${b.name} (${b.start_time?.slice(0,5)}–${b.end_time?.slice(0,5)})`]))
  const tierById = Object.fromEntries(tiers.map(t => [t.id, t.name]))
  const groupTierMap = Object.fromEntries(groups.map(g => [g.id, g.tier_id]))

  function anchorTierLabel(a) {
    if (a.is_all_groups) return 'All age divisions'
    const tierIds = [...new Set((a.group_ids || []).map(gid => groupTierMap[gid]).filter(Boolean))]
    const names = tierIds.map(tid => tierById[tid]).filter(Boolean)
    return names.length ? names.join(', ') : '—'
  }

  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)

  return (
    <div style={{ maxWidth: 760 }}>
      <CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />
      {error && (
        <div style={S.errorBanner}>
          {error}
        </div>
      )}
      {timeBlocks.length === 0 && !loading && (
        <div style={{ background: '#FFF8E7', border: '1px solid #F5A623', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#7a5100' }}>
          No time blocks found. Set these up before adding fixed events.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {anchors.length} fixed event{anchors.length !== 1 ? 's' : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="press-97" onClick={downloadTemplate} style={S.btnSecondary}>Download Template</button>
          <button className="press-97" onClick={() => fileRef.current.click()} style={S.btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          <button
            onClick={deleteAll}
            disabled={role !== 'admin'}
            title={role !== 'admin' ? 'Admin only' : undefined}
            style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
          >Delete All</button>
          <button className="press-97" onClick={() => setModal({ anchor: null })} style={S.btnPrimary}>+ Add Fixed Event</button>
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
                <th style={S.th}>Day</th>
                <th style={S.th}>Time Block</th>
                <th style={S.th}>Age Divisions</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {anchors.length === 0 ? (
                <tr><td colSpan={5} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>No fixed events yet</div>
                  <div style={S.emptyStateBody}>Add your first fixed event below.</div>
                </td></tr>
              ) : anchors.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <td style={{ ...S.td, fontWeight: 500 }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--anchor)', marginRight: 8 }} />
                    {a.name}
                  </td>
                  <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 13 }}>{dayMap[a.day_id] || '—'}</td>
                  <td style={{ ...S.td, fontSize: 12, fontFamily: 'var(--font-mono)' }}>{blockMap[a.time_block_id] || '—'}</td>
                  <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>{anchorTierLabel(a)}</td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <button className="press-97" onClick={() => setModal({ anchor: a })} style={S.btnSecondary}>Edit</button>
                    <button
                      onClick={() => deleteAnchor(a.id)}
                      disabled={role !== 'admin'}
                      title={role !== 'admin' ? 'Admin only' : undefined}
                      style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
                    >Delete</button>
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
        <div style={{ ...S.overlay, ...importEnterStyle }}>
          <div style={{ ...S.modalLg, width: 620 }}>
            {importStep === 'preview' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>Import Preview</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{readyRows.length} ready{warnRows.length > 0 && `, ${warnRows.length} with warnings`}</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}><th style={S.th}>Name</th><th style={S.th}>Day</th><th style={S.th}>Block</th><th style={S.th}>Age Divisions</th><th style={S.th}>Status</th></tr></thead>
                  <tbody>
                    {importRows.map((r, i) => (
                      <tr key={i} style={{ background: r.warning ? '#FFF8E7' : '', borderBottom: '1px solid var(--border)' }}>
                        <td style={S.td}>{r.name || '—'}</td>
                        <td style={S.td}>{r._dayLabel || '—'}</td>
                        <td style={S.td}>{r._blockName || '—'}</td>
                        <td style={S.td}>{r._tierNames}</td>
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
                <div style={{ fontSize: 14 }}>
                  <span style={{ color: 'var(--success)', fontWeight: 600 }}>{importResult.added} added</span>
                  {importResult.skipped > 0 && <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{importResult.skipped} skipped</span>}
                  {importResult.skippedWithOrphan > 0 && (
                    <span style={{ color: 'var(--warning)', marginLeft: 10 }}>
                      {importResult.skippedWithOrphan} skipped but couldn't be fully rolled back (admin required) — stray row(s) may remain
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="press-97" onClick={() => { setImportStep(null); setImportRows([]) }} style={S.btnPrimary}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDangerDialog
          title={`Delete "${pendingDelete.name}"?`}
          body="This fixed event will be removed from your schedules."
          recovery={`"${pendingDelete.name}" goes to Trash, and you can put it back from there.`}
          confirmLabel="Delete Fixed Event"
          busy={deleting}
          onConfirm={confirmAnchorDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingDeleteAll && (
        <ConfirmDangerDialog
          title="Delete all fixed events?"
          recovery="They can be restored from Trash."
          confirmLabel="Delete All Fixed Events"
          busy={deletingAll}
          onConfirm={confirmDeleteAll}
          onCancel={() => setPendingDeleteAll(false)}
        />
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button className="press-97" onClick={() => onNavigate('schedule')} style={S.btnPrimary}>Go to Schedule</button>
      </div>
    </div>
  )
}
