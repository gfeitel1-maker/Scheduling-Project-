import { useState, useEffect, useRef } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet, unescapeRow } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { S, useEnterTransition } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import ImportModal from '../components/setup/ImportModal'
import SetupScreenShell from '../components/setup/SetupScreenShell'
import { LocationPicker } from '../components/LocationPicker'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { parseIdList, makeSerializeFieldValue } from './setup/setupHelpers'
import { createLocationRecord, updateLocationCapacityRecord } from '../lib/locationDedup'

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
const serializeFieldValue = makeSerializeFieldValue(BOOL_FIELDS, ARRAY_FIELDS)

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

function normalizeAnchor(row) {
  return {
    ...row,
    is_all_groups: row.is_all_groups === 1 || row.is_all_groups === true,
    group_ids: parseIdList(row.group_ids),
  }
}

function AnchorModal({ anchor, kind, tiers, groups, days, timeBlocks, locations, onSave, onClose, onCreateLocation, onUpdateLocationCapacity }) {
  const isNew = !anchor?.id
  // Fixed = all-camp by construction (docs/adr/2026-08-28-fixed-vs-recurring-
  // events.md §3 CHECK: kind='fixed' requires is_all_groups=1, unit_id/
  // group_ids empty) — the scope control below is hidden entirely on this
  // form, not merely defaulted, so an invalid Fixed row is unrepresentable in
  // the UI rather than caught only by the DB constraint after a save attempt
  // (ADR §7's recommended default).
  const isFixed = kind === 'fixed'
  // Threaded through this modal's copy so "Fixed" vs "Recurring" reads
  // consistently everywhere (docs/adr/2026-08-28-fixed-vs-recurring-events.md
  // §7: no explainer copy, but the label itself must not lie about which
  // kind of event this form is creating).
  const kindLabel = isFixed ? 'Fixed Event' : 'Recurring Event'
  const [name, setName] = useState(anchor?.name || '')
  // Fixed is always all-groups, Recurring is never all-groups (the CHECK
  // constraint forbids both other combinations) — this form never toggles
  // it, so it's a constant derived from `kind`, not React state.
  const isAllTiers = isFixed
  // Multi-day: editing an existing anchor pre-selects its single day
  const [selectedDays, setSelectedDays] = useState(anchor?.day_id ? [anchor.day_id] : [])
  const [blockId, setBlockId] = useState(anchor?.time_block_id || '')
  const [locationId, setLocationId] = useState(anchor?.location_id ?? null)
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
    const group_ids = isFixed
      ? []
      : groups.filter(g => selectedTiers.includes(g.tier_id)).map(g => g.id)
    // C5: a location_id left dangling (set, but the place it pointed at is
    // gone — deleted, cross-device race, stale import) is never persisted
    // silently on save — mirrors ActivityModal's identical guard.
    const resolvedLocationId = locationId && locations.some(l => l.id === locationId) ? locationId : null
    // kind is derived from which form the director used (this screen's fixed
    // `kind` prop), never toggled by hand — the CHECK constraint (ADR §3) is
    // the backstop, this is the by-construction guarantee (ADR §6).
    //
    // kind is placed BEFORE is_all_groups/group_ids in this object,
    // deliberately: writeFields (setupCrudRepository.js) fires ONE op-log
    // write per field, in this object's key order, each its own UPDATE — the
    // CHECK constraint is evaluated after every single-field write, not just
    // at the end. A fresh row's ensureExists stub defaults kind='fixed',
    // is_all_groups=1; writing kind='recurring' FIRST satisfies the CHECK's
    // first OR-branch unconditionally, so the is_all_groups=false/group_ids
    // write that follows never hits an intermediate state the CHECK rejects
    // (same reasoning as electron/ops/ingest.js's identical field ordering).
    // When editing, update only the existing record's day; when creating, one record per day
    try {
      await onSave(anchor?.id || null, {
        name: name.trim(),
        kind,
        is_all_groups: isAllTiers,
        group_ids,
        selectedDays,
        time_block_id: blockId,
        location_id: resolvedLocationId,
        notes: notes.trim() || null,
      })
    } catch (err) {
      setSaveError(
        err?.cleanupFailed
          ? `Save failed partway through and couldn't be fully rolled back (admin required) — ${err.orphanCount} incomplete recurring-event row(s) may remain; ask an admin to review/delete them.`
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
          {isNew ? `Add ${kindLabel}` : `Edit: ${anchor.name}`}
        </div>

        <Field label="Name">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={S.input} placeholder="e.g. Mifkad, Lunch, Swim" />
        </Field>

        <Field label={isNew ? 'Days (select all that apply)' : 'Day'}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {days.map(d => (
              <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 5,
                ...S.chip('var(--primary)', selectedDays.includes(d.id), { borderRadius: 5, padding: '5px 10px', border: '1px solid var(--border)' }),
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

        <Field label="Location (optional)">
          <LocationPicker value={locationId} locations={locations} onChange={setLocationId} onCreate={onCreateLocation} onUpdateCapacity={onUpdateLocationCapacity} />
        </Field>

        {!isFixed && (
          <Field label="Age Divisions">
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
          </Field>
        )}

        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...S.input, resize: 'vertical' }} />
        </Field>

        {isNew && selectedDays.length > 1 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, fontFamily: 'var(--font-mono)' }}>
            Will create {selectedDays.length} {isFixed ? 'fixed' : 'recurring'} events (one per day)
          </div>
        )}

        {saveError && (
          <div style={S.errorBanner}>
            {saveError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="press-97" onClick={onClose} style={S.btnSecondary}>Cancel</button>
          <button className="press-97" onClick={save} disabled={saving || !canSave} style={{ ...S.btnPrimary, opacity: (!canSave || saving) ? 0.5 : 1 }}>
            {saving ? 'Saving…' : isNew ? `Add ${kindLabel}${selectedDays.length > 1 ? ` (×${selectedDays.length})` : ''}` : 'Save Changes'}
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

export default function AnchorsScreen({ campId, role, onNavigate, kind = 'recurring' }) {
  // Threaded through this screen's copy (delete dialogs, error messages,
  // empty state) so "fixed" vs "recurring" reads consistently everywhere —
  // no stray hardcoded "recurring event" left over when kind='fixed'
  // (docs/adr/2026-08-28-fixed-vs-recurring-events.md §7).
  const eventLabel = kind === 'fixed' ? 'fixed event' : 'recurring event'
  const eventLabelPlural = kind === 'fixed' ? 'fixed events' : 'recurring events'
  const eventLabelCap = kind === 'fixed' ? 'Fixed Event' : 'Recurring Event'
  const eventLabelPluralCap = kind === 'fixed' ? 'Fixed Events' : 'Recurring Events'
  const [anchors, setAnchors] = useState([])
  const [days, setDays] = useState([])
  const [timeBlocks, setTimeBlocks] = useState([])
  const [tiers, setTiers] = useState([])
  const [groups, setGroups] = useState([])
  const [weeks, setWeeks] = useState([])
  const [locations, setLocations] = useState([])
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

  useEffect(() => {
    if (activeCohort) load()
  }, [campId, activeCohort?.id, kind])

  async function load() {
    if (!activeCohort) return
    setLoading(true)
    setError(null)
    try {
      const [aData, dData, bData, tData, gData, wData, lData] = await Promise.all([
        localClient.list('anchor_activities'),
        localClient.list('days_of_operation'),
        localClient.list('time_blocks'),
        localClient.list('tiers'),
        localClient.list('groups'),
        localClient.list('schedule_weeks'),
        localClient.list('locations'),
      ])
      const list = (aData || [])
        // kind is NOT NULL post-migration (v51 CHECK, docs/adr/2026-08-28-
        // fixed-vs-recurring-events.md §3) — no `?? 'fixed'` fallback here:
        // a row with a missing/mismatched kind is a real bug to surface
        // (an unfiltered row disappearing from both lists), not to mask.
        .filter(a => a.camp_id === campId && a.cohort_id === activeCohort.id && a.kind === kind)
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
      setWeeks((wData || [])
        .filter(w => w.camp_id === campId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)))
      setLocations((lData || []).filter(l => l.camp_id === campId))
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
          ? `Save failed partway through and couldn't be fully rolled back (admin required) — ${err.orphanCount} incomplete recurring-event row(s) may remain; ask an admin to review/delete them.`
          : describeWriteFailure(err, `That ${eventLabel} could not be saved.`)
      )
      throw err
    }
    await load()
    setModal(null)
  }

  // Slice 2 — per-anchor "which weeks" control. '' selects "All weeks" and
  // writes NULL, preserving today's implicit all-weeks meaning; picking a
  // specific week writes that week's id. Optimistic local update (mirrors
  // load()'s row shape) so the select reflects the change immediately rather
  // than waiting on a full reload.
  async function changeAnchorWeek(id, scheduleWeekId) {
    try {
      await writeFields(id, { schedule_week_id: scheduleWeekId })
      setAnchors(prev => prev.map(a => a.id === id ? { ...a, schedule_week_id: scheduleWeekId } : a))
    } catch (err) {
      setError(describeWriteFailure(err, 'That week could not be saved.'))
    }
  }

  // Contextual create from the LocationPicker's "create new" row — mirrors
  // ActivitiesScreen.createLocation exactly (same case-insensitive dedupe
  // rationale; see that screen's comment for the full ADR reasoning).
  async function createLocation(name) {
    const result = await createLocationRecord({ repository, campId, name, existing: locations })
    if (!result) return null
    if (result.created) setLocations(prev => [...prev, result.location])
    return result.location.id
  }

  async function updateLocationCapacity(locationId, capacity) {
    await updateLocationCapacityRecord({ repository, locationId, capacity })
    setLocations(prev => prev.map(l => l.id === locationId ? { ...l, capacity } : l))
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
          ? `Only an admin can delete ${eventLabelPlural}.`
          : describeWriteFailure(err, `That ${eventLabel} could not be deleted.`)
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
            ? `Only an admin can delete ${eventLabelPlural} — no ${eventLabelPlural} were deleted.`
            : `Deleted ${succeeded} of ${ids.length} ${eventLabelPlural} — please try again for the rest.`
        )
      }
    } catch (err) {
      setError(describeWriteFailure(err, `Those ${eventLabelPlural} could not be deleted.`))
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

        // kind follows the ROW'S OWN scope (the §1 decision table's is_all_groups
        // test), NOT which nav entry (Fixed vs Recurring) launched this import —
        // it CANNOT be forced to the screen's kind, or a scoped row would be
        // written kind='fixed' with a non-empty group_ids and violate the v51
        // CHECK constraint (docs/adr/2026-08-28-fixed-vs-recurring-events.md §3).
        // A row whose derived kind differs from this screen's `kind` prop still
        // imports correctly, but is filed onto the OTHER list — surfaced to the
        // director in confirmImport's result (`filedElsewhere`), not silently.
        // kind is placed FIRST in these objects (also enforced structurally by
        // REQUIRED_FIRST_ON_WRITE in setupCrudRepository.js — see that file's
        // comment for why per-call-site ordering alone isn't trusted): each
        // field lands as its own op-log UPDATE, and the CHECK is evaluated
        // after every one, so kind must be applied before is_all_groups/
        // group_ids narrow a fresh row's scope.
        const rowKind = isAllTiers ? 'fixed' : 'recurring'
        if (dayLabels.length === 0) {
          parsed.push({
            kind: rowKind, name, day_id: null, time_block_id, is_all_groups: isAllTiers, group_ids,
            notes: String(r.notes || '').trim() || null,
            warning: baseWarning || 'Missing day_label',
            _dayLabel: '—', _blockName: blockName, _tierNames: tierLabel,
          })
        } else {
          for (const dayLabel of dayLabels) {
            const day_id = dayMap[dayLabel.toLowerCase()] || null
            const warning = baseWarning || (!day_id ? `Day "${dayLabel}" not found` : null)
            parsed.push({
              kind: rowKind, name, day_id, time_block_id, is_all_groups: isAllTiers, group_ids,
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
      let added = 0, skipped = 0, skippedWithOrphan = 0, filedElsewhere = 0
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
        // A scoped row's kind can differ from this screen's `kind` (see the
        // comment above rowKind's derivation) — never silent: the director
        // sees a count of how many landed on the other list.
        if (record.kind !== kind) filedElsewhere++
      }
      setImportResult({ added, skipped, skippedWithOrphan, filedElsewhere }); setImportStep('done')
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
      <SetupScreenShell
        countLabel={`${anchors.length} ${kind} event${anchors.length !== 1 ? 's' : ''}`}
        role={role}
        actions={{ onDownloadTemplate: downloadTemplate, onImport: () => fileRef.current.click(), onDeleteAll: deleteAll }}
        fileInputRef={fileRef}
        onFileChange={onFileChange}
        maxWidth={760}
        nextLabel="Go to Schedule"
        onNext={() => onNavigate('schedule')}
        error={error}
        cohortPicker={<CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />}
      >
      {timeBlocks.length === 0 && !loading && (
        <div style={S.cautionBanner}>
          No time blocks found. Set these up before adding {eventLabelPlural}.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="press-97" onClick={() => setModal({ anchor: null })} style={S.btnPrimary}>
          + Add {kind === 'fixed' ? 'Fixed' : 'Recurring'} Event
        </button>
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
                <th style={S.th}>Weeks</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {anchors.length === 0 ? (
                <tr><td colSpan={6} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>No {kind} events yet</div>
                  <div style={S.emptyStateBody}>Add your first {kind} event below.</div>
                </td></tr>
              ) : anchors.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                  onClick={() => setModal({ anchor: a })}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                  onFocus={e => e.currentTarget.style.background = 'var(--bg)'}
                  onBlur={e => e.currentTarget.style.background = ''}
                >
                  <td style={{ ...S.td, fontWeight: 500 }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--anchor)', marginRight: 8 }} />
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit ${a.name}`}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModal({ anchor: a }) } }}
                      style={{ cursor: 'pointer' }}
                    >{a.name}</span>
                  </td>
                  <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 13 }}>{dayMap[a.day_id] || '—'}</td>
                  <td style={{ ...S.td, fontSize: 12, fontFamily: 'var(--font-mono)' }}>{blockMap[a.time_block_id] || '—'}</td>
                  <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>{anchorTierLabel(a)}</td>
                  <td style={{ ...S.td, fontSize: 12 }}>
                    <select
                      value={a.schedule_week_id || ''}
                      onChange={e => changeAnchorWeek(a.id, e.target.value || null)}
                      onClick={e => e.stopPropagation()}
                      style={{ ...S.input, padding: '5px 8px', fontSize: 12, width: 'auto' }}
                    >
                      <option value="">All weeks</option>
                      {weeks.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <button
                      onClick={e => { e.stopPropagation(); deleteAnchor(a.id) }}
                      disabled={role !== 'admin'}
                      title={role !== 'admin' ? 'Admin only' : undefined}
                      style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
                    >Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {anchors.length > 0 && (
            <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--text-secondary)', borderTop: '1px solid var(--border)' }}>
              Changing a {eventLabel}'s week won't move it on weeks already built — regenerate or re-place those to pick up the change.
            </div>
          )}
        </div>
      )}
      </SetupScreenShell>

      {modal && (
        <AnchorModal
          anchor={modal.anchor}
          kind={kind}
          tiers={tiers}
          groups={groups}
          days={days}
          timeBlocks={timeBlocks}
          locations={locations}
          onSave={saveAnchor}
          onClose={() => setModal(null)}
          onCreateLocation={createLocation}
          onUpdateLocationCapacity={updateLocationCapacity}
        />
      )}

      <ImportModal
        step={importStep}
        title={importStep === 'done' ? 'Import Complete' : 'Import Preview'}
        width={620}
        columns={[{ key: 'name', label: 'Name' }, { key: 'day', label: 'Day' }, { key: 'block', label: 'Block' }, { key: 'tiers', label: 'Age Divisions' }, { key: 'status', label: 'Status' }]}
        rows={importRows}
        readyCount={readyRows.length}
        warnCount={warnRows.length}
        result={importResult}
        importing={importing}
        onConfirm={confirmImport}
        onCancel={() => { setImportStep(null); setImportRows([]) }}
        doneExtra={(
          <>
            {importResult?.skippedWithOrphan > 0 && (
              <span style={{ color: 'var(--warning)', marginLeft: 10 }}>
                {importResult.skippedWithOrphan} skipped but couldn't be fully rolled back (admin required) — stray row(s) may remain
              </span>
            )}
            {importResult?.filedElsewhere > 0 && (
              <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>
                {importResult.filedElsewhere} were group-scoped and filed under {kind === 'fixed' ? 'Recurring Events' : 'Fixed Events'} instead
              </span>
            )}
          </>
        )}
        renderCell={(r, c) => {
          if (c.key === 'name') return r.name || '—'
          if (c.key === 'day') return r._dayLabel || '—'
          if (c.key === 'block') return r._blockName || '—'
          if (c.key === 'tiers') return r._tierNames
          if (c.key === 'status') return <span style={r.warning ? S.importWarnText : { color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</span>
        }}
      />

      {pendingDelete && (
        <ConfirmDangerDialog
          title={`Delete "${pendingDelete.name}"?`}
          body={`This ${eventLabel} will be removed from your schedules.`}
          recovery={`"${pendingDelete.name}" goes to Trash, and you can put it back from there.`}
          confirmLabel={`Delete ${eventLabelCap}`}
          busy={deleting}
          onConfirm={confirmAnchorDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingDeleteAll && (
        <ConfirmDangerDialog
          title={`Delete all ${eventLabelPlural}?`}
          recovery="They can be restored from Trash."
          confirmLabel={`Delete All ${eventLabelPluralCap}`}
          busy={deletingAll}
          onConfirm={confirmDeleteAll}
          onCancel={() => setPendingDeleteAll(false)}
        />
      )}
    </div>
  )
}
