import { useState, useRef, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { describeWriteFailure, deleteRefusalMessage } from '../utils/writeErrorMessage'
import { aoaToSanitizedSheet, unescapeRow } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { createScheduleRepository } from '../data/scheduleRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { S, prefersReducedMotion, useEnterTransition } from '../styles/shared'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import DeleteRecordDialog from '../components/DeleteRecordDialog'
import ImportModal from '../components/setup/ImportModal'
import InlineAddRow from '../components/setup/InlineAddRow'
import WeekContextBar from '../components/schedule/WeekContextBar'
import ExclusionConfirmDialog from '../components/schedule/ExclusionConfirmDialog'
import { CapacityStepper } from '../components/CapacityStepper'
import {
  activeNearDuplicateGroups,
  defaultWinner,
  capacityDisagreementCopy,
  wasUnlimitedCopy,
  variantList,
} from './locationMigrationReview'

// M3a — the Locations setup screen. docs/work/specs/2026-08-15-m3-locations-design.md Part 1.
// M3c — the first-run migration review region (Part 3) + the delete path's
// re-home onto the shared host primitive (D2).
// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md
// M5 — per-week location availability (the toggle column), mirroring
// ActivitiesScreen/GroupsScreen's week-exclusion pattern exactly.
// M6 — the optional camp map (List | Map toggle, Part 1 of the M6 spec).
const repository = createSetupCrudRepository({ localClient })
const repo = createScheduleRepository({ localClient })
const scopeFilter = (row, campId) => row.camp_id === campId

function capacityWord(n) {
  return `${n} group${n === 1 ? '' : 's'}`
}

// CapacityStepper lives in ../components/CapacityStepper (promoted out of
// this file so ActivitiesScreen can reuse it with a distinct aria-label and
// min floor without importing a screen module). Re-exported here so the
// existing `import { CapacityStepper } from '../screens/LocationsScreen'`
// (LocationPicker) keeps working unchanged.
export { CapacityStepper } from '../components/CapacityStepper'

// ---------------------------------------------------------------------------
// M3c — the first-run migration review region. Pure grouping/copy helpers
// live in locationMigrationReview.js; this file keeps only the components.
// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md D3/D4/D5,
// docs/work/specs/2026-08-15-m3-locations-design.md Part 3.
// ---------------------------------------------------------------------------

// D-3 (hard requirement): a blocking modal — impossible to scroll past.
function NearDuplicateGate({ group, remaining, onMerge, onKeepSeparate, busy, error }) {
  // Design spec §5d — a heavier "Fade + Settle" entrance for this one
  // un-missable, blocking gate: translateY 12->0 over --motion-settle, not
  // the lighter 8px liftFade every other modal uses.
  const enter = useEnterTransition('settle')
  const winnerDefault = defaultWinner(group.variantRows)
  const [selectedName, setSelectedName] = useState(winnerDefault?.name)
  const [capacity, setCapacity] = useState(Math.max(...group.variantRows.map((v) => v.capacity)))
  // Local choices reset when the gate moves to a different pair because the
  // caller renders this with `key={group.key}` — a fresh mount, not a
  // render-time "adjusting state" reset.
  const winner = group.variantRows.find((v) => v.name === selectedName) ?? group.variantRows[0]

  return (
    <div style={gateStyles.scrim}>
      <div style={{ ...gateStyles.card, ...enter }}>
        <div style={gateStyles.top}>
          <div style={gateStyles.eyebrow}>
            Before you start
            <span style={gateStyles.prog}>{remaining} location{remaining === 1 ? '' : 's'} left to review</span>
          </div>
          <div style={gateStyles.title}>These look like the same location</div>
          <p style={gateStyles.lede}>
            Your old schedule used {variantList(group.variants)}. Shoresh kept them separate so it wouldn’t change
            your data without asking — but that splits how many groups fit. Merge them into one location, or say
            they’re genuinely different. The activities from both locations will move onto the name you keep.
          </p>
        </div>
        <div style={gateStyles.variants}>
          {group.variantRows.map((v) => (
            <button
              key={v.name}
              type="button"
              className="press-97"
              disabled={busy}
              onClick={() => setSelectedName(v.name)}
              style={{ ...gateStyles.vrow, ...(v.name === selectedName ? gateStyles.vrowPick : {}) }}
            >
              <span style={{ ...gateStyles.radio, ...(v.name === selectedName ? gateStyles.radioPick : {}) }} />
              <span style={gateStyles.vname}>{v.name}</span>
              <span style={gateStyles.vmeta}>
                {capacityWord(v.capacity)} at once
                <br />
                {v.activityCount} activit{v.activityCount === 1 ? 'y' : 'ies'} here
              </span>
            </button>
          ))}
        </div>
        <div style={gateStyles.capRow}>
          Room for <CapacityStepper value={capacity} onChange={setCapacity} disabled={busy} /> groups at once after
          merging.
        </div>
        {error && <div style={gateStyles.error}>{error}</div>}
        <div style={gateStyles.actions}>
          <button
            className="press-97"
            disabled={busy}
            onClick={() => onMerge({ group, winner, capacity })}
            style={{ ...gateStyles.merge, ...(busy ? S.buttonDisabled : {}) }}
          >
            {busy ? 'Merging…' : 'Merge into one location'}
          </button>
          <button
            className="press-97"
            disabled={busy}
            onClick={() => onKeepSeparate(group)}
            style={{ ...gateStyles.keep, ...(busy ? S.buttonDisabled : {}) }}
          >
            No — these are different locations
          </button>
          <div style={gateStyles.undo}>You can undo this. The merged location stays in Trash if you change your mind.</div>
        </div>
      </div>
    </div>
  )
}

// The softer, dismissible advisory strip for capacity_disagreement/was_unlimited.
function AdvisoryItem({ item, locations, onAccept, busy }) {
  const location = locations.find((l) => l.id === item.location_id)
  const [capacity, setCapacity] = useState(location?.capacity ?? item.detail?.seededCapacity ?? 1)
  const body = item.kind === 'capacity_disagreement' ? capacityDisagreementCopy(item.detail) : wasUnlimitedCopy(item.detail)

  return (
    <div style={stripStyles.item}>
      <div style={stripStyles.body}>
        <b>{item.name}</b> — {body}
      </div>
      <div style={stripStyles.ctl}>
        <CapacityStepper value={capacity} onChange={setCapacity} disabled={busy} />
        <button
          className="press-97"
          disabled={busy}
          onClick={() => onAccept(item, capacity)}
          style={{ ...stripStyles.lookOk, ...(busy ? S.buttonDisabled : {}) }}
        >
          {busy ? 'Saving…' : 'Looks right'}
        </button>
      </div>
    </div>
  )
}

function CapacityAdvisoryStrip({ items, locations, onAccept, busyId }) {
  const enter = useEnterTransition('liftFade')
  return (
    <div style={{ ...stripStyles.wrap, ...enter }}>
      <div style={stripStyles.head}>
        <span style={stripStyles.title}>Shoresh set a few capacities from your old schedule</span>
        <span style={stripStyles.sub}>{items.length} to look at</span>
      </div>
      {items.map((item) => (
        <AdvisoryItem key={item.id} item={item} locations={locations} onAccept={onAccept} busy={busyId === item.id} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// M6 — the optional camp map. docs/adr/2026-08-16-locations-optional-map.md,
// docs/work/specs/2026-08-16-m6-map-design.md.
// ---------------------------------------------------------------------------

// T119 — a quiet per-row marker on the capacity cell, matching the
// Activities-screen provenance-dot pattern: a small dot, not a banner, on a
// value the director is already looking at on the screen where they'd fix it.
function CapacityProvenanceMarker() {
  return (
    <span
      title="Imported — no one has confirmed how many groups fit here."
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: 'var(--accent)',
        marginLeft: 6,
        verticalAlign: 'middle',
      }}
    />
  )
}

function LocationRow({ location, role, onSave, onDelete, weekToggle, capacityUnconfirmed }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(location.name)
  const [capacity, setCapacity] = useState(location.capacity)
  const [notes, setNotes] = useState(location.notes || '')
  const [kind, setKind] = useState(location.kind || '')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      // T119: capacity is included only when it actually changed. Always
      // sending it (even unchanged) would re-write it as source='human' on
      // every save, silently confirming an unconfirmed imported value the
      // moment a director edits the NAME or NOTES of a room without ever
      // touching capacity — provenance must flip only on an actual change.
      const capacityChanged = Number(capacity) !== Number(location.capacity)
      await onSave(location.id, {
        name: name.trim(),
        ...(capacityChanged ? { capacity: Number(capacity) } : {}),
        notes: notes.trim() || null,
        kind: kind || null,
      })
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
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }} style={S.input} />
        </td>
        <td style={S.td}><CapacityStepper value={capacity} onChange={setCapacity} /></td>
        <td style={S.td}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ ...S.input, padding: '4px 6px' }}>
            <option value="">— none —</option>
            {KIND_OPTIONS.map(({ value, icon, label }) => (
              <option key={value} value={value}>{icon} {label}</option>
            ))}
          </select>
        </td>
        <td style={S.td}>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }} style={S.input} />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button className="press-97" onClick={save} disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="press-97" onClick={() => { setName(location.name); setCapacity(location.capacity); setNotes(location.notes || ''); setKind(location.kind || ''); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  const kindInfo = KIND_OPTIONS.find((k) => k.value === location.kind)

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={(e) => e.currentTarget.style.background = ''}
    >
      <td style={{ ...S.td, fontWeight: 500 }}>{location.name}</td>
      <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums' }}>
        {capacityWord(location.capacity)}
        {capacityUnconfirmed && <CapacityProvenanceMarker />}
      </td>
      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 12 }} title={kindInfo?.label}>{kindInfo ? `${kindInfo.icon} ${kindInfo.label}` : '—'}</td>
      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 12 }}>{location.notes || '—'}</td>
      {weekToggle}
      <td style={{ ...S.td, textAlign: 'right', borderLeft: weekToggle ? '1px solid var(--border)' : undefined }}>
        <button className="press-97" onClick={() => setEditing(true)} style={S.btnSecondary}>Edit</button>
        <button
          onClick={() => onDelete(location)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
        >Delete</button>
      </td>
    </tr>
  )
}

const KIND_OPTIONS = [
  { value: 'building', icon: '🏢', label: 'Building' },
  { value: 'classroom', icon: '🏫', label: 'Classroom / Group Space' },
  { value: 'pool', icon: '🏊', label: 'Pool' },
  { value: 'field', icon: '🌿', label: 'Field' },
  { value: 'cabin', icon: '🏕️', label: 'Cabin' },
  { value: 'court', icon: '🏀', label: 'Court' },
  { value: 'nature', icon: '🌲', label: 'Nature' },
  { value: 'office', icon: '🗂️', label: 'Office / Admin' },
  { value: 'generic', icon: '⬜', label: 'Generic' },
]

export default function LocationsScreen({ campId, role, onNavigate, weekId, weeks = [], onSelectWeek }) {
  const { rows: unsortedLocations, loading, error, setError, adding, add, save, deleteAll: deleteAllRecords, importRows, reload } =
    useCrudScreen({
      entity: 'locations',
      campId,
      localClient,
      repository,
      scopeFilter,
      // `name` MUST stay the first key: writeFields (setupCrudRepository.js)
      // writes fields in this object's insertion order, and a locations
      // create is the one entry point where that order is load-bearing, not
      // cosmetic (docs/adr/2026-08-15-locations-concurrent-create-collision.md
      // D3). If `name` collides, being first stops the sequential write loop
      // before capacity/notes ever go out — but more importantly, if ANY
      // field before `name` succeeded first, ensureExists
      // (electron/ops/projections.js) would INSERT OR IGNORE a blank-name
      // placeholder row for the new id BEFORE the collision on `name` ever
      // fires, reintroducing this ADR's orphan-row defect via a different
      // field. Pinned by a regression test in LocationsScreen.test.jsx.
      buildCreateFields: ({ name, capacity, notes, kind, map_geometry, map_id }) => ({
        name,
        camp_id: campId,
        capacity,
        notes: notes || null,
        // kind is optional on the List add path (the inline row supplies it);
        // spread only when present so the write shape stays minimal when it's
        // not chosen, matching notes' null-when-absent treatment above.
        ...(kind ? { kind } : {}),
        // Only the map's click-to-create path supplies these — the List add
        // form never does, so ...spread keeps that path's write shape
        // byte-identical to before this feature existed. map_id is stamped only
        // when a camp has two maps (v50 pair); NULL means the primary map.
        ...(map_geometry ? { map_geometry } : {}),
        ...(map_id ? { map_id } : {}),
      }),
      addFailedText: 'That location could not be added.',
      saveFailedText: 'That location could not be saved.',
      adminOnlyDeleteAllText: 'Only an admin can delete locations — no locations were deleted.',
      partialDeleteAllText: (succeeded, total, failed) => `Deleted ${succeeded} of ${total} locations (${failed} failed — see console).`,
    })
  const locations = [...unsortedLocations].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? '')))

  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [excludedLocationIds, setExcludedLocationIds] = useState(new Set())
  const [pendingExclusion, setPendingExclusion] = useState(null) // { location, slotCount }
  const [importStep, setImportStep] = useState(null)
  const [importPreviewRows, setImportPreviewRows] = useState([])
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef()
  const enter = useEnterTransition('liftFade')
  // T119 — { [locationId]: 'confirmed'|'unconfirmed' }, feeding the per-row
  // capacity provenance marker below.
  const [capacitySources, setCapacitySources] = useState({})

  // The IIFE wrapper is required by this repo's react-hooks/set-state-in-effect
  // lint rule — same reason as loadExclusions' mount effect below: it flags a
  // direct call to a named, in-scope function it can trace back to setState,
  // but not the same call wrapped this way.
  useEffect(() => {
    ;(async () => {
      const sources = await localClient.locationCapacityProvenance().catch(() => ({}))
      setCapacitySources(sources || {})
    })()
  }, [campId])


  async function loadExclusions() {
    if (!weekId) { setExcludedLocationIds(new Set()); return }
    try {
      const { locationExclusions } = await repo.loadWeekExclusions(weekId)
      setExcludedLocationIds(new Set(locationExclusions.map(e => e.location_id)))
    } catch {
      setExcludedLocationIds(new Set())
    }
  }

  // The IIFE wrapper is required by this repo's react-hooks/set-state-in-effect
  // lint rule — same reason as refreshReviewData's mount effect below: it
  // flags a direct call to a named, in-scope function it can trace back to
  // setState, but not the same call wrapped this way.
  useEffect(() => { (async () => { await loadExclusions() })() }, [weekId])

  async function handleToggleExclusion(location, currentlyExcluded) {
    if (!weekId) return
    if (currentlyExcluded) {
      // Turning ON — no confirmation needed
      await repo.toggleLocationExclusion(weekId, location.id, false)
      setExcludedLocationIds(prev => { const next = new Set(prev); next.delete(location.id); return next })
      return
    }
    // Turning OFF — count placed slots bound to this place (via its activities) first
    const [allSlots, templates, allActivities] = await Promise.all([
      localClient.list('template_slots'),
      localClient.list('schedule_templates'),
      localClient.list('activities'),
    ])
    const weekTemplateIds = new Set((templates || []).filter(t => t.week_id === weekId).map(t => t.id))
    const boundActivityIds = new Set((allActivities || []).filter(a => a.location_id === location.id).map(a => a.id))
    const slotCount = (allSlots || [])
      .filter(s => weekTemplateIds.has(s.template_id) && boundActivityIds.has(s.activity_id))
      .length
    if (slotCount === 0) {
      await repo.toggleLocationExclusion(weekId, location.id, true)
      setExcludedLocationIds(prev => new Set([...prev, location.id]))
    } else {
      setPendingExclusion({ location, slotCount })
    }
  }

  async function confirmExclusion() {
    if (!pendingExclusion || !weekId) return
    const { location } = pendingExclusion
    await repo.toggleLocationExclusion(weekId, location.id, true)
    setExcludedLocationIds(prev => new Set([...prev, location.id]))
    setPendingExclusion(null)
  }

  // M3c — the migration review region's own data. Loaded alongside, not
  // through useCrudScreen (which tracks only `locations`): the near-duplicate
  // gate needs the camp's activities (for per-place bound counts) and the
  // host-local journal, neither of which that hook fetches.
  const [activities, setActivities] = useState([])
  const [reviews, setReviews] = useState([])
  const [gateBusy, setGateBusy] = useState(false)
  const [gateError, setGateError] = useState(null)
  const [stripBusyId, setStripBusyId] = useState(null)

  // Single failure semantic shared by every caller (the mount effect below,
  // and handleMerge/handleKeepSeparate/handleAdvisoryAccept further down):
  // this never throws. It used to be duplicated with a DIFFERENT failure
  // semantic inside the mount effect (which swallowed to [] locally), so a
  // real failure here — reachable from handleMerge AFTER a merge had already
  // succeeded — propagated into that caller's own catch and reported a
  // merge that worked as a failed one.
  async function refreshReviewData() {
    try {
      const reviewData = (await localClient.listMigrationReviews()) || []
      // Advisory items (capacity_disagreement/was_unlimited) don't need
      // activities at all — only near_duplicate groups resolve variant rows
      // against them — so the common case (empty journal, no near-dups)
      // skips this full-table fetch entirely.
      const needsActivities = reviewData.some((r) => r.kind === 'near_duplicate')
      const actData = needsActivities ? await localClient.list('activities') : []
      setActivities((actData || []).filter((a) => a.camp_id === campId))
      setReviews(reviewData)
    } catch {
      setActivities([])
      setReviews([])
    }
  }

  useEffect(() => {
    // The IIFE wrapper (rather than calling refreshReviewData() directly) is
    // required by this repo's react-hooks/set-state-in-effect lint rule —
    // it flags a direct call to a named, in-scope function it can trace back
    // to setState, but not the same call wrapped this way. No duplicated
    // logic: this is still exactly one call to the one shared function.
    ;(async () => {
      await refreshReviewData()
    })()
  }, [campId])

  const nearDuplicateGroups = activeNearDuplicateGroups(reviews, campId, locations, activities)
  const advisoryItems = reviews.filter((r) => r.kind !== 'near_duplicate')

  async function handleMerge({ group, winner, capacity }) {
    setGateBusy(true)
    setGateError(null)
    try {
      for (const loser of group.variantRows.filter((v) => v.name !== winner.name)) {
        const result = await localClient.mergeLocation({
          loser_id: loser.locationId,
          winner_id: winner.locationId,
          winner_capacity: capacity,
          expected_ref_count: loser.activityCount,
        })
        // A loser already gone (a prior partial success in this same batch,
        // or a peer's concurrent merge) is not a failure — it's the outcome
        // this merge wanted. Treat it as already-done and keep going, rather
        // than abandoning a loser later in the list that could still merge.
        if (result?.error === 'no-record') continue
        if (!result || result.error) throw new Error(result?.error ?? 'merge-failed')
      }
      await localClient.dismissMigrationReviews(group.reviewIds)
      await reload()
      await refreshReviewData()
    } catch {
      setGateError('That merge could not be completed — someone may have changed these locations. Try again.')
      // A partial success (some losers merged before the failure) must not
      // leave the gate showing a stale group — without this, a group with 3+
      // variants keeps offering an already-deleted loser and every retry
      // dies on 'no-record' before reaching the one that could still merge.
      await reload()
      await refreshReviewData()
    } finally {
      setGateBusy(false)
    }
  }

  async function handleKeepSeparate(group) {
    setGateBusy(true)
    setGateError(null)
    try {
      await localClient.dismissMigrationReviews(group.reviewIds)
      await refreshReviewData()
    } catch {
      setGateError('That could not be saved — try again.')
    } finally {
      setGateBusy(false)
    }
  }

  async function handleAdvisoryAccept(item, capacity) {
    setStripBusyId(item.id)
    try {
      await repository.writeFields('locations', item.location_id, { capacity })
      await localClient.dismissMigrationReviews([item.id])
      await reload()
      await refreshReviewData()
    } catch {
      // Best-effort — leave the item visible so the director can retry.
    } finally {
      setStripBusyId(null)
    }
  }

  // The inline blank-row add (last row of the table) — name + capacity + kind.
  // Notes are edited in-row after creation. Wired to the same create path
  // (`add`) as the card form, so validation + describeWriteFailure are shared.
  async function handleInlineAdd(values) {
    const name = String(values.name ?? '').trim()
    if (!name) return false
    return add({
      name,
      capacity: Math.max(1, Math.round(Number(values.capacity)) || 1),
      kind: values.kind || null,
    })
  }

  // Standard Excel import, matching the other setup screens. Reuses the shared
  // importRows path (which skips warned rows, dedupes within the batch, and
  // reloads once). mapRow bypasses buildCreateFields, so `name` is written
  // first here too (the load-bearing collision-fails-atomically ordering).
  function downloadTemplate() {
    const ws = aoaToSanitizedSheet([
      ['name', 'capacity', 'kind'],
      ['Pool', 1, 'pool'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Locations')
    XLSX.writeFile(wb, 'locations_template.xlsx')
  }

  function onFileChange(e) {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }).map(unescapeRow)
      const validKinds = new Set(KIND_OPTIONS.map(k => k.value))
      const parsed = rows.map(r => {
        const name = String(r.name || '').trim()
        const rawCap = r.capacity
        const capacity = rawCap === '' || rawCap == null ? 1 : Number(rawCap)
        const kindRaw = String(r.kind || '').trim().toLowerCase()
        const kind = validKinds.has(kindRaw) ? kindRaw : null
        let warning = null
        if (!name) warning = 'Missing name'
        else if (!Number.isInteger(capacity) || capacity < 1) warning = 'Capacity must be a whole number 1 or greater'
        return { name, capacity, kind, warning }
      })
      setImportPreviewRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    try {
      const { added, skipped } = await importRows(importPreviewRows, {
        mapRow: (row) => ({
          name: row.name,
          camp_id: campId,
          capacity: row.capacity,
          ...(row.kind ? { kind: row.kind } : {}),
        }),
        duplicateCheck: (seen, row) => seen.some((s) => String(s.name ?? '').toLowerCase() === row.name.toLowerCase()),
      })
      setImportResult({ added, skipped }); setImportStep('done')
    } finally {
      setImporting(false)
    }
  }

  const importReadyRows = importPreviewRows.filter(r => r.name && !r.warning)
  const importWarnRows = importPreviewRows.filter(r => r.warning || !r.name)

  // Deleting a record a schedule uses: count first, confirm with the count
  // shown, then clear and delete in one Host-side transaction — the shared
  // host path (D2), not a bespoke in-screen unbind.
  // docs/adr/2026-08-15-locations-merge-and-delete-rehome.md
  async function deleteLocation(location) {
    setError(null)
    let preview
    try {
      preview = await localClient.previewDelete('locations', location.id)
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can delete locations.'
          : describeWriteFailure(err, 'That could not be checked before deleting.')
      )
      return
    }
    if (!preview || preview.error) {
      setError(deleteRefusalMessage(preview?.error ?? 'unknown', preview || {}))
      return
    }
    setPendingDelete(preview)
  }

  function deleteAll() {
    setPendingDeleteAll(true)
  }

  async function confirmDeleteAll() {
    setDeletingAll(true)
    try {
      await deleteAllRecords()
    } finally {
      setDeletingAll(false)
      setPendingDeleteAll(false)
    }
  }

  const currentGateGroup = nearDuplicateGroups[0]
  const currentWeek = weeks.find(w => w.id === weekId)

  return (
    <div style={{ maxWidth: 720 }}>
      {error && (
        <div style={S.errorBanner}>
          {error}
        </div>
      )}

      <>
          {weeks.length > 0 && (
            <WeekContextBar
              weekId={weekId}
              weeks={weeks}
              onSelectWeek={onSelectWeek}
              exclusionCount={excludedLocationIds.size}
              totalCount={locations.length}
              entityLabel="locations"
            />
          )}

          {/* D-3.3 — an absent/empty journal renders no review region at all. */}
          {nearDuplicateGroups.length === 0 && advisoryItems.length > 0 && (
            <CapacityAdvisoryStrip
              items={advisoryItems}
              locations={locations}
              onAccept={handleAdvisoryAccept}
              busyId={stripBusyId}
            />
          )}

          {loading ? (
            <div style={S.stateLoading}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div style={S.sectionCount}>
                  {locations.length} location{locations.length !== 1 ? 's' : ''}
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
                </div>
              </div>

              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                      <th style={S.th}>Name</th>
                      <th style={S.th}>Groups at once</th>
                      <th style={S.th}>Kind</th>
                      <th style={S.th}>Notes</th>
                      {weekId && <th style={{ ...S.th, textAlign: 'center' }}>{currentWeek?.name ?? 'Week'}</th>}
                      <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locations.length === 0 ? (
                      <tr><td colSpan={weekId ? 6 : 5} style={S.emptyState}>
                        <div style={enter}>
                          <div style={S.emptyStateTitle}>No locations yet</div>
                          <div style={S.emptyStateBody}>Add a location below to add your first one.</div>
                        </div>
                      </td></tr>
                    ) : locations.map((location) => (
                      <LocationRow
                        key={location.id}
                        location={location}
                        role={role}
                        onSave={save}
                        onDelete={deleteLocation}
                        capacityUnconfirmed={capacitySources[location.id] === 'unconfirmed'}
                        weekToggle={weekId ? (
                          <td style={{ ...S.td, textAlign: 'center' }}>
                            <WeekToggle
                              on={!excludedLocationIds.has(location.id)}
                              label={excludedLocationIds.has(location.id)
                                ? `Off in ${currentWeek?.name ?? 'this week'}`
                                : `Open in ${currentWeek?.name ?? 'this week'}`}
                              onToggle={() => handleToggleExclusion(location, excludedLocationIds.has(location.id))}
                            />
                          </td>
                        ) : null}
                      />
                    ))}
                    {/* The always-present blank "type here to add" row — lives as
                        the last row of the locations table (Excel-like inline add).
                        Notes are edited in-row after creation, so they aren't a
                        field here — an empty trailing cell keeps the columns aligned. */}
                    <InlineAddRow
                      fields={[
                        { key: 'name', type: 'text', placeholder: 'e.g. Pool, Gym, Beit Midrash', required: true },
                        { key: 'capacity', type: 'number', default: 1, width: 90 },
                        { key: 'kind', type: 'select', default: '', options: [
                          { value: '', label: '— none —' },
                          ...KIND_OPTIONS.map(k => ({ value: k.value, label: `${k.icon} ${k.label}` })),
                        ] },
                      ]}
                      onAdd={handleInlineAdd}
                      adding={adding}
                      trailingCells={<><td style={S.td} />{weekId ? <td style={S.td} /> : null}</>}
                    />
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="press-97" onClick={() => onNavigate('activities')} style={S.backBar}>← Back to Activities</button>
        <button className="press-97" onClick={() => onNavigate('anchors')} style={S.btnPrimary}>Next: Recurring Events →</button>
      </div>

      {pendingDelete && (
        <DeleteRecordDialog
          preview={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onDeleted={() => { setPendingDelete(null); reload() }}
        />
      )}

      {pendingDeleteAll && (
        <ConfirmDangerDialog
          title="Delete all locations?"
          recovery="They can be restored from Trash."
          confirmLabel="Delete All Locations"
          busy={deletingAll}
          onConfirm={confirmDeleteAll}
          onCancel={() => setPendingDeleteAll(false)}
        />
      )}

      <ImportModal
        step={importStep}
        title={importStep === 'done' ? 'Import Complete' : 'Import Preview'}
        width={560}
        columns={[{ key: 'name', label: 'Name' }, { key: 'capacity', label: 'Groups at once', mono: true }, { key: 'kind', label: 'Kind' }, { key: 'status', label: 'Status' }]}
        rows={importPreviewRows}
        readyCount={importReadyRows.length}
        warnCount={importWarnRows.length}
        result={importResult}
        importing={importing}
        onConfirm={confirmImport}
        onCancel={() => { setImportStep(null); setImportPreviewRows([]) }}
        previewSubtitle={<>{importReadyRows.length} ready{importWarnRows.length > 0 && `, ${importWarnRows.length} with warnings (skipped)`}</>}
        renderCell={(r, c) => {
          if (c.key === 'name') return r.name || <span style={{ color: 'var(--warning)' }}>—</span>
          if (c.key === 'capacity') return r.capacity
          if (c.key === 'kind') return KIND_OPTIONS.find(k => k.value === r.kind)?.label ?? '—'
          if (c.key === 'status') return <span style={r.warning ? S.importWarnText : { color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</span>
        }}
      />

      {pendingExclusion && (
        <ExclusionConfirmDialog
          entityName={pendingExclusion.location.name}
          weekName={currentWeek?.name ?? 'this week'}
          slotCount={pendingExclusion.slotCount}
          onCancel={() => setPendingExclusion(null)}
          onConfirm={confirmExclusion}
        />
      )}

      {/* D-3 — a blocking modal, impossible to scroll past. Renders above
          everything else on the screen while unresolved near_duplicate
          groups exist. */}
      {currentGateGroup && (
        <NearDuplicateGate
          key={currentGateGroup.key}
          group={currentGateGroup}
          remaining={nearDuplicateGroups.length}
          onMerge={handleMerge}
          onKeepSeparate={handleKeepSeparate}
          busy={gateBusy}
          error={gateError}
        />
      )}
    </div>
  )
}

function WeekToggle({ on, label, onToggle }) {
  const reduced = prefersReducedMotion()
  const W = 32, H = 18, PAD = 2, KNOB = H - PAD * 2
  const knobLeft = on ? W - KNOB - PAD : PAD
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        width: W,
        height: H,
        borderRadius: H / 2,
        background: on ? 'var(--primary)' : 'var(--border)',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        position: 'relative',
        transition: reduced ? 'none' : 'background-color 120ms ease',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        left: knobLeft,
        top: PAD,
        width: KNOB,
        height: KNOB,
        borderRadius: '50%',
        background: 'var(--surface-elevated)',
        transition: reduced ? 'none' : 'left 120ms ease',
      }} />
    </button>
  )
}

// docs/work/specs/m3-mockup.html §3.1 — the on-brand deep-navy scrim (not the
// standard black overlay every other modal in the app uses), deliberately:
// this is the one un-missable, un-dismissible gate in the app.
const gateStyles = {
  scrim: {
    position: 'fixed',
    inset: 0,
    background: 'color-mix(in srgb, var(--primary-dark) 50%, transparent)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '34px 16px',
    zIndex: 1000,
    overflowY: 'auto',
  },
  card: {
    background: 'var(--surface-elevated)',
    borderRadius: 12,
    width: 460,
    maxWidth: '100%',
    boxShadow: '0 8px 40px color-mix(in srgb, var(--text) 20%, transparent)',
    overflow: 'hidden',
  },
  top: { padding: '22px 24px 6px' },
  eyebrow: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: 'var(--accent)',
    display: 'flex',
    alignItems: 'center',
    gap: 7,
  },
  prog: { marginLeft: 'auto', color: 'var(--text-secondary)' },
  title: { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 19, margin: '12px 0 4px', letterSpacing: '-0.2px' },
  lede: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 },
  variants: { padding: '16px 24px 4px', display: 'flex', flexDirection: 'column', gap: 10 },
  vrow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    border: '1.5px solid var(--border)',
    borderRadius: 9,
    padding: '11px 13px',
    background: 'var(--surface)',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  vrowPick: { borderColor: 'var(--primary)', background: 'color-mix(in srgb, var(--primary) 6%, var(--surface))' },
  radio: { width: 16, height: 16, borderRadius: '50%', border: '1.5px solid var(--border)', flexShrink: 0 },
  radioPick: { borderColor: 'var(--primary)', background: 'var(--primary)', boxShadow: 'inset 0 0 0 3px var(--surface-elevated)' },
  vname: { fontWeight: 600, fontSize: 14 },
  vmeta: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginLeft: 'auto', textAlign: 'right' },
  capRow: { padding: '12px 24px 4px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text)' },
  error: { margin: '10px 24px 0', ...S.errorBanner },
  actions: { padding: '18px 24px 22px', display: 'flex', flexDirection: 'column', gap: 9 },
  merge: { ...S.btnPrimary, padding: '11px 0', borderRadius: 8, fontWeight: 700, fontSize: 14, width: '100%' },
  keep: { padding: '9px 0', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontWeight: 600, fontSize: 13, color: 'var(--text)', width: '100%', cursor: 'pointer' },
  undo: { textAlign: 'center', fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 },
}

// docs/work/specs/m3-mockup.html §3.2 — bronze/accent, never red: this is an
// advisory, not an error.
const stripStyles = {
  wrap: {
    border: '1px solid color-mix(in srgb, var(--accent) 32%, var(--border))',
    background: 'color-mix(in srgb, var(--accent) 7%, var(--surface))',
    borderRadius: 10,
    padding: '14px 16px',
    marginBottom: 20,
  },
  head: { display: 'flex', alignItems: 'center', gap: 9 },
  title: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 600,
    fontSize: 13.5,
    color: 'color-mix(in srgb, var(--accent) 55%, var(--text))',
  },
  sub: { fontSize: 12, color: 'var(--text-secondary)', marginLeft: 'auto' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 4px',
    borderTop: '1px solid color-mix(in srgb, var(--accent) 22%, var(--border))',
    marginTop: 12,
  },
  body: { flex: 1, fontSize: 13, lineHeight: 1.5 },
  ctl: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  lookOk: { padding: '6px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--text)', cursor: 'pointer' },
}

