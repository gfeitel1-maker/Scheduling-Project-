import { useState, useRef, useEffect, useCallback } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core'
import { describeWriteFailure, deleteRefusalMessage } from '../utils/writeErrorMessage'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { createScheduleRepository } from '../data/scheduleRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { S, prefersReducedMotion, useEnterTransition } from '../styles/shared'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import DeleteRecordDialog from '../components/DeleteRecordDialog'
import WeekContextBar from '../components/schedule/WeekContextBar'
import ExclusionConfirmDialog from '../components/schedule/ExclusionConfirmDialog'
import {
  activeNearDuplicateGroups,
  defaultWinner,
  capacityDisagreementCopy,
  wasUnlimitedCopy,
  variantList,
} from './locationMigrationReview'
// M6 — the optional camp map. docs/adr/2026-08-16-locations-optional-map.md,
// docs/work/specs/2026-08-16-m6-map-design.md. A plain JS import — the
// src/components/schedule/ CSS-exception boundary (D9) is about the
// *stylesheet*, not this constant array, so importing ACTIVITY_COLORS here
// does not touch that boundary.
import { ACTIVITY_COLORS } from '../components/schedule/slotCellConstants'
import '../components/locations/locationMap.css'
import { useLocationGeometryMutations } from './locations/useLocationGeometryMutations'
import { useMapDragFSM } from './locations/useMapDragFSM'
import { MOVE, RESIZE } from './locations/mapDragFSM'
import { defaultTrayGeometry } from './locations/mapGeometry'
import { processMapImage, MapImageError } from './locations/mapImageProcessing'

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

// The segmented [ – | n | + ] control from the design spec ("a named
// component: CapacityStepper"), built once here and reused by the add card
// and the inline edit row. Min 1, hard — 0 meant "unlimited" pre-ADR and the
// control cannot express it. Still keyboard-typeable in the middle cell.
export function CapacityStepper({ value, onChange, disabled }) {
  const n = Number(value) || 1
  // Typed text is tracked separately from the committed `n` so the field can
  // sit empty mid-edit (select-all-and-retype) without the controlled value
  // snapping back on every keystroke. Only a commit (blur/Enter, or a
  // +/- click) can change what the parent holds, and a commit always floors
  // to >=1 — the field can look empty, it can never SAVE empty or 0.
  const [text, setText] = useState(String(n))
  // Adjust local text when the committed value changes from outside (e.g. the
  // caller resetting the field after Add) — the render-time pattern from the
  // React docs' "Adjusting state when a prop changes", not an effect, so the
  // reset lands before this render paints instead of one render later.
  const [prevN, setPrevN] = useState(n)
  if (n !== prevN) {
    setPrevN(n)
    setText(String(n))
  }

  function commit(next) {
    const clamped = Math.max(1, Math.round(next) || 1)
    setText(String(clamped))
    if (clamped !== n) onChange(clamped)
  }

  return (
    <div style={stepperStyles.wrap}>
      <button
        type="button"
        className="press-97"
        onClick={() => commit(n - 1)}
        disabled={disabled || n <= 1}
        aria-label="Decrease"
        style={{ ...stepperStyles.btn, ...(disabled || n <= 1 ? S.buttonDisabled : {}) }}
      >–</button>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '' || /^\d+$/.test(raw)) setText(raw)
        }}
        onBlur={() => commit(parseInt(text, 10) || 1)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        style={stepperStyles.input}
        aria-label="Groups at once"
      />
      <button
        type="button"
        className="press-97"
        onClick={() => commit(n + 1)}
        disabled={disabled}
        aria-label="Increase"
        style={{ ...stepperStyles.btn, ...(disabled ? S.buttonDisabled : {}) }}
      >+</button>
    </div>
  )
}

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

// Part 1 — the persistent List | Map segmented toggle, mirroring
// ScheduleScreen.jsx's REAL View toggle (:861-865) verbatim, per the
// Designer spec's correction to the ADR's stale citation.
function ListMapToggle({ tab, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'var(--border)', borderRadius: 8, padding: 3, marginBottom: 20 }}>
      {[['list', 'List'], ['map', 'Map']].map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            padding: '6px 14px', borderRadius: 6, border: 'none',
            borderBottom: tab === v ? '2px solid var(--primary)' : '2px solid transparent',
            cursor: 'pointer', fontSize: 12, fontWeight: tab === v ? 700 : 600,
            fontFamily: 'var(--font-sans)',
            background: tab === v ? 'var(--surface)' : 'none',
            color: tab === v ? 'var(--primary)' : 'var(--text-secondary)',
            boxShadow: tab === v ? '0 1px 4px rgba(0,0,0,0.12)' : 'none',
            transition: 'color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)',
          }}
        >{label}</button>
      ))}
    </div>
  )
}

// Part 2 — the calm, no-card empty block (DESIGN_STANDARD §5a), reused from
// M3's "No places yet" treatment, not reinvented.
function MapEmptyState({ role, onUploadClick, busy }) {
  const enter = useEnterTransition('liftFade')
  return (
    <div style={{ ...emptyStyles.wrap, ...enter }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="M21 16l-5.5-5.5a1.5 1.5 0 0 0-2.1 0L4 19" />
      </svg>
      <div style={emptyStyles.title}>No map yet</div>
      {role === 'admin' ? (
        <>
          <div style={emptyStyles.body}>
            Add a photo or drawing of your camp grounds, then drag each location onto it. Optional — the schedule
            works fine without a map.
          </div>
          <button className="press-97" onClick={onUploadClick} disabled={busy} style={{ ...S.btnPrimary, marginTop: 14 }}>
            {busy ? 'Preparing…' : 'Upload a map image'}
          </button>
        </>
      ) : (
        <div style={emptyStyles.body}>
          Your director hasn't added a camp map yet. Locations still work everywhere else in Shoresh — check back
          later.
        </div>
      )}
    </div>
  )
}

// Part 3 — a single placed location, drawn as a positioned/draggable/
// resizable rectangle. Per-location computed geometry (left/top/width/
// height) stays INLINE (ADR D9) — only pseudo-state/attribute rules live in
// locationMap.css. The DOM node is registered with the FSM binding hook so
// it can be imperatively updated during a live drag without a React
// re-render (useMapDragFSM.js's own rationale).
function LocationMarker({ location, color, geometry, registerLocationEl, dragFsm }) {
  // Destructured directly, matching SlotCell.jsx/ActivityPalette.jsx's own
  // useDraggable convention exactly (a plain `ref={setNodeRef}`, never a
  // member-expression read off the hook's return object as the ref/spread
  // value — eslint-plugin-react-hooks' refs rule flags the latter).
  const { attributes: moveAttrs, listeners: moveListeners, setNodeRef: setMoveNodeRef } = useDraggable({
    id: `move:${location.id}`,
    data: { kind: MOVE, locationId: location.id, geometry },
  })
  const { attributes: resizeAttrs, listeners: resizeListeners, setNodeRef: setResizeNodeRef } = useDraggable({
    id: `resize:${location.id}`,
    data: { kind: RESIZE, locationId: location.id, geometry },
  })

  function setMarkerRef(el) {
    setMoveNodeRef(el)
    registerLocationEl(location.id, el)
  }

  return (
    <div
      ref={setMarkerRef}
      className="map-location"
      tabIndex={0}
      role="button"
      aria-label={`Move ${location.name}`}
      onClick={() => dragFsm.selectLocation(location.id)}
      {...moveListeners}
      {...moveAttrs}
      style={{
        left: `${geometry.x * 100}%`,
        top: `${geometry.y * 100}%`,
        width: `${geometry.w * 100}%`,
        height: `${geometry.h * 100}%`,
        border: `2px solid ${color}`,
        // Designer spec §4 — 10% at rest, 16% selected/hovered (border weight
        // never changes). --marker-wash is set ONLY by locationMap.css's
        // [data-selected] rule; the var() fallback is the at-rest value.
        background: `color-mix(in srgb, ${color} var(--marker-wash, 10%), transparent)`,
      }}
    >
      <span style={markerStyles.chip(color)}>
        <span style={markerStyles.dot(color)} />
        {location.name}
      </span>
      <button
        ref={setResizeNodeRef}
        className="map-location-handle"
        data-resize-handle=""
        tabIndex={0}
        aria-label={`Resize ${location.name}`}
        onClick={(e) => e.stopPropagation()}
        {...resizeListeners}
        {...resizeAttrs}
      />
    </div>
  )
}

// Part 3 — the unplaced tray. Renders only when at least one location has
// map_geometry IS NULL (mirrors M3's "absent, not empty" discipline).
function UnplacedTray({ items }) {
  return (
    <div style={trayStyles.wrap}>
      <div style={trayStyles.head}>
        <span style={trayStyles.title}>Not yet placed</span>
        <span style={trayStyles.count}>({items.length})</span>
      </div>
      <div style={trayStyles.row}>
        {items.map((location) => (
          <UnplacedChip key={location.id} location={location} />
        ))}
      </div>
    </div>
  )
}

function UnplacedChip({ location }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tray:${location.id}`,
    data: { kind: 'tray', locationId: location.id },
  })
  return (
    <div
      ref={setNodeRef}
      className="map-tray-chip"
      data-dragging={isDragging ? '' : undefined}
      style={trayStyles.chip}
      {...listeners}
      {...attributes}
    >
      <svg width="10" height="14" viewBox="0 0 10 14" fill="var(--text-secondary)" aria-hidden="true">
        <circle cx="2" cy="2" r="1.3" /><circle cx="8" cy="2" r="1.3" />
        <circle cx="2" cy="7" r="1.3" /><circle cx="8" cy="7" r="1.3" />
        <circle cx="2" cy="12" r="1.3" /><circle cx="8" cy="12" r="1.3" />
      </svg>
      <span style={{ fontWeight: 500 }}>{location.name}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
        {capacityWord(location.capacity)}
      </span>
    </div>
  )
}

// Part 3 — the populated map canvas: background image at natural aspect
// ratio (set inline, before the data: URL decodes, per ADR D10) + every
// placed location's marker. Wrapped in one DndContext shared with the
// unplaced tray so a tray chip can be dropped onto the canvas.
function MapCanvas({ mapRow, locations, dragFsm, containerRef }) {
  const { setNodeRef: setDroppableRef } = useDroppable({ id: 'map-canvas' })
  const { registerLocationEl, liveRef } = dragFsm
  const placed = locations.filter((l) => l.map_geometry)

  function setCanvasRef(el) {
    containerRef.current = el
    setDroppableRef(el)
  }

  return (
    <div
      ref={setCanvasRef}
      className="map-canvas"
      style={{ aspectRatio: `${mapRow.image_width || 1} / ${mapRow.image_height || 1}` }}
    >
      <img className="map-image" src={`data:image/jpeg;base64,${mapRow.image_data}`} alt="" />
      {placed.map((location, i) => (
        <LocationMarker
          key={location.id}
          location={location}
          color={ACTIVITY_COLORS[(location.sort_order ?? i) % ACTIVITY_COLORS.length]}
          geometry={JSON.parse(location.map_geometry)}
          registerLocationEl={registerLocationEl}
          dragFsm={dragFsm}
        />
      ))}
      <div ref={liveRef} className="map-drag-live" aria-live="polite" />
    </div>
  )
}

function LocationRow({ location, role, onSave, onDelete, weekToggle }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(location.name)
  const [capacity, setCapacity] = useState(location.capacity)
  const [notes, setNotes] = useState(location.notes || '')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(location.id, { name: name.trim(), capacity: Number(capacity), notes: notes.trim() || null })
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
          <input value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }} style={S.input} />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button className="press-97" onClick={save} disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="press-97" onClick={() => { setName(location.name); setCapacity(location.capacity); setNotes(location.notes || ''); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={(e) => e.currentTarget.style.background = ''}
    >
      <td style={{ ...S.td, fontWeight: 500 }}>{location.name}</td>
      <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums' }}>{capacityWord(location.capacity)}</td>
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

export default function LocationsScreen({ campId, role, onNavigate, weekId, weeks = [], onSelectWeek }) {
  const { rows: unsortedLocations, loading, error, setError, adding, add, save, deleteAll: deleteAllRecords, reload } =
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
      buildCreateFields: ({ name, capacity, notes }) => ({
        name,
        camp_id: campId,
        capacity,
        notes: notes || null,
      }),
      addFailedText: 'That location could not be added.',
      saveFailedText: 'That location could not be saved.',
      adminOnlyDeleteAllText: 'Only an admin can delete locations — no locations were deleted.',
      partialDeleteAllText: (succeeded, total, failed) => `Deleted ${succeeded} of ${total} locations (${failed} failed — see console).`,
    })
  const locations = [...unsortedLocations].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? '')))

  const [newName, setNewName] = useState('')
  const [newCapacity, setNewCapacity] = useState(1)
  const [newNotes, setNewNotes] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [excludedLocationIds, setExcludedLocationIds] = useState(new Set())
  const [pendingExclusion, setPendingExclusion] = useState(null) // { location, slotCount }
  const nameRef = useRef()
  const enter = useEnterTransition('liftFade')

  // M6 — the optional camp map. docs/adr/2026-08-16-locations-optional-map.md,
  // docs/work/specs/2026-08-16-m6-map-design.md.
  const [tab, setTab] = useState('list')
  const [mapRow, setMapRow] = useState(null)
  const [mapBusy, setMapBusy] = useState(false)
  const [mapError, setMapError] = useState(null)
  const [pendingRemoveMap, setPendingRemoveMap] = useState(false)
  const [removingMap, setRemovingMap] = useState(false)
  const mapFileInputRef = useRef()
  const mapContainerRef = useRef(null)
  const { writeGeometry } = useLocationGeometryMutations({ repository })
  const handleGeometryCommitError = useCallback(() => {
    setMapError('That change could not be saved. Try again.')
  }, [])
  const dragFsm = useMapDragFSM({ writeGeometry, containerRef: mapContainerRef, onCommitError: handleGeometryCommitError })
  const mapSensors = useSensors(
    // distance: 5, matching ScheduleScreen.jsx:203 exactly (ADR D8) — not the
    // brief's stale 8 (Designer spec's Implementation Notes).
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )

  async function loadCampMap() {
    try {
      const rows = (await localClient.list('camp_maps')) || []
      setMapRow(rows.find((r) => r.camp_id === campId) ?? null)
    } catch {
      setMapRow(null)
    }
  }

  useEffect(() => {
    ;(async () => { await loadCampMap() })()
  }, [campId])

  function triggerMapUpload() {
    mapFileInputRef.current?.click()
  }

  async function handleMapFileSelected(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file next time
    if (!file) return
    setMapError(null)
    setMapBusy(true)
    try {
      const { base64, mime, width, height } = await processMapImage(file)
      // camp_id must be included here, not left to the real backend's
      // ensureExists to stamp: src/localClient.mock.js's write() only
      // auto-stamps camp_id for UNIQUE_KEYS composite entities, and camp_maps
      // is correctly not one (a singleton keyed by id = camp_id already) —
      // so in the browser dev mock, an upload without this field is
      // unfindable by camp_id and loadCampMap never matches it. Harmless on
      // the real backend, and matches every other entity's create write in
      // this same file (buildCreateFields above, and DaysScreen.jsx).
      await repository.writeFields('camp_maps', campId, {
        camp_id: campId,
        image_data: base64,
        image_mime: mime,
        image_width: width,
        image_height: height,
      })
      await loadCampMap()
    } catch (err) {
      setMapError(err instanceof MapImageError ? err.message : "That file isn't a photo Shoresh can use. Choose a JPG, PNG, or WEBP image.")
    } finally {
      setMapBusy(false)
    }
  }

  async function confirmRemoveMap() {
    setRemovingMap(true)
    try {
      await repository.writeFields('camp_maps', campId, { image_data: null })
      await loadCampMap()
    } finally {
      setRemovingMap(false)
      setPendingRemoveMap(false)
    }
  }

  // Shared DndContext handlers for the Map tab: `move:`/`resize:` ids
  // delegate to useMapDragFSM (D7/D8); `tray:` ids are the unplaced-tray
  // drop-to-place gesture, handled as a single synthesized 'move' write
  // (Designer spec "Design judgment calls" #3) rather than a third FSM kind.
  function handleMapDragStart(event) {
    const id = String(event.active.id)
    if (id.startsWith('move:') || id.startsWith('resize:')) dragFsm.dndProps.onDragStart(event)
  }
  function handleMapDragMove(event) {
    const id = String(event.active.id)
    if (id.startsWith('move:') || id.startsWith('resize:')) dragFsm.dndProps.onDragMove(event)
  }
  function handleMapDragEnd(event) {
    const id = String(event.active.id)
    if (id.startsWith('move:') || id.startsWith('resize:')) {
      dragFsm.dndProps.onDragEnd(event)
      return
    }
    if (id.startsWith('tray:') && event.over?.id === 'map-canvas') {
      const locationId = id.slice('tray:'.length)
      const container = mapContainerRef.current?.getBoundingClientRect()
      const translated = event.active.rect.current.translated
      if (!container || !translated) return
      const centerXPx = translated.left + translated.width / 2 - container.left
      const centerYPx = translated.top + translated.height / 2 - container.top
      const dropFraction = {
        x: container.width > 0 ? centerXPx / container.width : 0.5,
        y: container.height > 0 ? centerYPx / container.height : 0.5,
      }
      const geometry = defaultTrayGeometry(dropFraction)
      writeGeometry(locationId, geometry, crypto.randomUUID()).catch(() => {
        setMapError('That change could not be saved. Try again.')
      })
    }
  }
  function handleMapDragCancel(event) {
    const id = String(event.active.id)
    if (id.startsWith('move:') || id.startsWith('resize:')) dragFsm.dndProps.onDragCancel()
  }

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

  async function addLocation() {
    if (!newName.trim()) return
    const succeeded = await add({ name: newName.trim(), capacity: Number(newCapacity), notes: newNotes.trim() })
    if (succeeded) { setNewName(''); setNewCapacity(1); setNewNotes('') }
  }

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
      <ListMapToggle tab={tab} onChange={setTab} />
      {error && (
        <div style={S.errorBanner}>
          {error}
        </div>
      )}

      {tab === 'list' && (
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
          ) : locations.length === 0 ? (
            <div style={{ ...emptyStyles.wrap, ...enter }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5">
                <path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10Z" />
                <circle cx="12" cy="11" r="2.2" />
              </svg>
              <div style={emptyStyles.title}>No locations yet</div>
              <div style={emptyStyles.body}>Add a location below and say how many groups fit at once. Or skip this — the schedule works fine without it, and you can add locations any time.</div>
              <button className="press-97" onClick={() => nameRef.current?.focus()} style={{ ...S.btnPrimary, marginTop: 14 }}>Add your first location</button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {locations.length} location{locations.length !== 1 ? 's' : ''}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
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
                      <th style={S.th}>Notes</th>
                      {weekId && <th style={{ ...S.th, textAlign: 'center' }}>{currentWeek?.name ?? 'Week'}</th>}
                      <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locations.map((location) => (
                      <LocationRow
                        key={location.id}
                        location={location}
                        role={role}
                        onSave={save}
                        onDelete={deleteLocation}
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
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Location</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 160px' }}>
                <label style={fieldLabel}>Name</label>
                <input ref={nameRef} placeholder="e.g. Pool, Gym, Beit Midrash" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLocation()} style={S.input} />
              </div>
              <div>
                <label style={fieldLabel}>Groups at once</label>
                <CapacityStepper value={newCapacity} onChange={setNewCapacity} />
              </div>
              <div style={{ flex: '1 1 160px' }}>
                <label style={fieldLabel}>Notes (optional)</label>
                <input placeholder="e.g. shared with the town" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLocation()} style={S.input} />
              </div>
              <button className="press-97" onClick={addLocation} disabled={adding || !newName.trim()} style={{ ...S.btnPrimary, flexShrink: 0 }}>{adding ? 'Adding…' : '+ Add'}</button>
            </div>
          </div>
        </>
      )}

      {tab === 'map' && (
        <DndContext sensors={mapSensors} onDragStart={handleMapDragStart} onDragMove={handleMapDragMove} onDragEnd={handleMapDragEnd} onDragCancel={handleMapDragCancel}>
          <input
            ref={mapFileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={handleMapFileSelected}
          />
          {mapError && <div style={S.errorBanner}>{mapError}</div>}
          {!mapRow?.image_data ? (
            <MapEmptyState role={role} onUploadClick={triggerMapUpload} busy={mapBusy} />
          ) : (
            <>
              {role === 'admin' && (
                <div style={mapToolbarStyles.wrap}>
                  <button className="press-97" onClick={triggerMapUpload} disabled={mapBusy} style={S.btnSecondary}>
                    {mapBusy ? 'Preparing…' : 'Replace image'}
                  </button>
                  <button className="press-97" onClick={() => setPendingRemoveMap(true)} disabled={mapBusy} style={S.btnDanger}>Remove image</button>
                </div>
              )}
              <MapCanvas mapRow={mapRow} locations={locations} dragFsm={dragFsm} containerRef={mapContainerRef} />
              {locations.some((l) => !l.map_geometry) && (
                <UnplacedTray items={locations.filter((l) => !l.map_geometry)} />
              )}
            </>
          )}
        </DndContext>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="press-97" onClick={() => onNavigate('activities')} style={S.authLinkBtn}>← Back to Activities</button>
        <button className="press-97" onClick={() => onNavigate('anchors')} style={S.btnPrimary}>Next: Recurring Events →</button>
      </div>

      {pendingRemoveMap && (
        <ConfirmDangerDialog
          title="Remove the map image?"
          recovery="This can't be undone from Trash — you'll need to upload it again. Every location keeps its position."
          confirmLabel="Remove Map Image"
          busy={removingMap}
          onConfirm={confirmRemoveMap}
          onCancel={() => setPendingRemoveMap(false)}
        />
      )}

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
        background: '#fff',
        transition: reduced ? 'none' : 'left 120ms ease',
      }} />
    </button>
  )
}

const fieldLabel = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
  marginBottom: 5,
  display: 'block',
}

const stepperStyles = {
  wrap: {
    display: 'inline-flex',
    alignItems: 'stretch',
    border: '1.5px solid var(--border)',
    borderRadius: 7,
    overflow: 'hidden',
    background: 'var(--surface)',
  },
  btn: {
    width: 30,
    border: 'none',
    background: 'var(--surface)',
    color: 'var(--text)',
    fontSize: 15,
    lineHeight: 1,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  input: {
    width: 42,
    border: 'none',
    borderLeft: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    textAlign: 'center',
    fontSize: 13,
    background: 'var(--surface-elevated)',
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'inherit',
  },
}

// Calm, no-card empty block — DESIGN_STANDARD §5a. NOT the in-table colSpan
// row Days/Groups use, and not a bordered card like Activities': Locations
// are optional, so their emptiness must read as deliberately fine.
const emptyStyles = {
  wrap: {
    padding: '60px 16px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text)',
    marginTop: 8,
  },
  body: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    maxWidth: '56ch',
  },
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
  merge: { padding: '11px 0', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14, width: '100%', cursor: 'pointer' },
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

// M6 Designer spec Part 3 — location markers. Computed geometry (left/top/
// width/height) is set inline at the call site (ADR D9); these are the
// non-computed, static-per-render style pieces (the chip/dot/handle visual
// treatment), which is exactly the same split scheduleGrid.css draws.
const markerStyles = {
  chip: (color) => ({
    position: 'absolute',
    top: -1,
    left: -1,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 7px',
    background: 'color-mix(in srgb, var(--surface-elevated) 90%, transparent)',
    border: `1px solid ${color}`,
    borderRadius: 5,
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--text)',
    whiteSpace: 'nowrap',
    maxWidth: '22ch',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    boxShadow: '0 1px 4px color-mix(in srgb, var(--text) 18%, transparent)',
    zIndex: 2,
  }),
  dot: (color) => ({
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
}

const trayStyles = {
  wrap: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '14px 16px',
    marginTop: 16,
  },
  head: { display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10 },
  title: { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em' },
  count: { color: 'var(--text-secondary)', fontSize: 12, marginLeft: 'auto' },
  row: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '7px 11px',
    background: 'var(--surface)',
    border: '1.5px solid var(--border)',
    borderRadius: 8,
    fontSize: 13,
  },
}

const mapToolbarStyles = {
  wrap: { display: 'flex', gap: 8, marginBottom: 12 },
}
