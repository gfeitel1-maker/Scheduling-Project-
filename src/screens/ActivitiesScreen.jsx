import React, { useState, useEffect, useRef } from 'react'
import { describeWriteFailure, deleteRefusalMessage } from '../utils/writeErrorMessage'
import { whitespaceInsensitiveName } from '../ingest/preview'
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet, unescapeRow } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { S, prefersReducedMotion, useEnterTransition } from '../styles/shared'
import DeleteRecordDialog from '../components/DeleteRecordDialog'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import ImportModal from '../components/setup/ImportModal'
import SetupScreenShell from '../components/setup/SetupScreenShell'
import WeekContextBar from '../components/schedule/WeekContextBar'
import ExclusionConfirmDialog from '../components/schedule/ExclusionConfirmDialog'
import { createScheduleRepository } from '../data/scheduleRepository'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { LocationPicker } from '../components/LocationPicker'
import { CapacityStepper } from '../components/CapacityStepper'
import { resolveLocationCandidateId } from '../../electron/ops/locationId.js'
import { CONFIDENCE_COPY, plainEvidenceSentence } from '../components/reconciliation/reconciliationCards.jsx'
import { deriveActivityProvenance, hasAnyEvidence, worstTier } from '../utils/ruleProvenance.js'
import uiClipboard from '../assets/brand/icons/ui-clipboard.png'
import { DOW, parseIdList, makeSerializeFieldValue } from './setup/setupHelpers'
import { createLocationRecord, updateLocationCapacityRecord } from '../lib/locationDedup'

// operations.value only accepts strings/null (better-sqlite3 throws on a raw
// boolean/array) — every write must pre-serialize through these before
// hitting localClient.write. Reads go through normalizeActivity below.
const BOOL_FIELDS = new Set(['is_outdoor', 'same_tier_only'])
const ARRAY_FIELDS = new Set(['eligible_tier_ids', 'eligible_group_ids'])
const serializeFieldValue = makeSerializeFieldValue(BOOL_FIELDS, ARRAY_FIELDS)

function normalizeActivity(row) {
  return {
    ...row,
    is_outdoor: row.is_outdoor === 1 || row.is_outdoor === true,
    same_tier_only: row.same_tier_only === 1 || row.same_tier_only === true,
    max_groups_per_slot: row.max_groups_per_slot ?? 1,
    min_per_week: row.min_per_week ?? 0,
    max_per_week: row.max_per_week ?? 5,
    span_blocks: row.span_blocks ?? 1,
    priority: row.priority || 'low',
    eligible_tier_ids: parseIdList(row.eligible_tier_ids),
    eligible_group_ids: parseIdList(row.eligible_group_ids),
  }
}

// Slice D (docs/adr/2026-08-22-roots-as-hub-setup-ia.md §7): the row-level
// provenance dot + popover for the 3 owner-locked inferred-rule fields
// (min/max-per-week, eligible groups, location). Renders nothing when the
// activity has no import_evidence at all — hand-created activities stay
// quiet, per the ADR's "not framed as what Shoresh learned".
const TIER_LABEL = { confirmed: 'Confirmed', observed: 'Observed', inferred: 'Inferred' }
// Contrast guard (spec's "Contrast guard"): --accent (#B8833A) on --surface
// (#FCFBF8) at 11px text measures ~3.2:1, under the 4.5:1 AA floor for small
// text. The tier TEXT label always renders in --text; only the dot itself
// carries the tier hue (ADR §8's "colors are unchanged" + WCAG 1.4.1 — the
// dot is never the only signal, the label always accompanies it).
const TIER_DOT_COLOR = { confirmed: 'var(--secondary)', observed: 'var(--primary)', inferred: 'var(--accent)' }

// Slice E, Target 4 (WCAG 1.4.1) — tier must be distinguishable by dot SHAPE,
// not hue alone: confirmed = filled solid, observed = ring (no fill),
// inferred = outlined-fill (a filled dot plus a --surface gap ring, so it
// reads distinct from confirmed's plain fill at 6px). Color is unchanged;
// this only adds shape on top of it.
function tierShapeStyle(tier) {
  if (tier === 'observed') {
    return { background: 'transparent', border: `1.5px solid ${TIER_DOT_COLOR.observed}`, boxShadow: 'none' }
  }
  if (tier === 'inferred') {
    return { background: TIER_DOT_COLOR.inferred, border: 'none', boxShadow: `0 0 0 1.5px var(--surface), 0 0 0 2.5px ${TIER_DOT_COLOR.inferred}` }
  }
  return { background: TIER_DOT_COLOR.confirmed, border: 'none', boxShadow: 'none' }
}

function useProvenancePopover(open, onClose) {
  const popRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const firstFocusable = popRef.current?.querySelector('button:not([disabled])')
    firstFocusable?.focus()

    function onKeyDown(e) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      const focusables = popRef.current?.querySelectorAll('button:not([disabled])')
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    function onPointerDown(e) {
      if (popRef.current && !popRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open, onClose])
  return popRef
}

function ProvenancePopoverRow({ row, onConfirm, onChange }) {
  const disclosureText = row.evidence
    ? [
        row.evidence.confidence ? `From this file — ${CONFIDENCE_COPY[row.evidence.confidence] ?? row.evidence.confidence}.` : null,
        plainEvidenceSentence(row.evidence.support),
      ].filter(Boolean).join(' ')
    : null
  return (
    <div style={dotStyles.row}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...dotStyles.rowDot, ...tierShapeStyle(row.tier) }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{row.label}</span>
        <span style={dotStyles.tierLabel}>{TIER_LABEL[row.tier]}</span>
      </div>
      {disclosureText && <div style={dotStyles.rowSentence}>{disclosureText}</div>}
      <div style={dotStyles.rowActions}>
        {row.tier === 'confirmed' ? (
          <span style={dotStyles.confirmedLabel}>Confirmed</span>
        ) : (
          <button type="button" className="press-97" onClick={onConfirm} style={dotStyles.confirmBtn}>Confirm</button>
        )}
        <button type="button" className="press-97" onClick={onChange} style={dotStyles.changeBtn}>Change</button>
      </div>
    </div>
  )
}

// Mounted only while the popover is open — its own mount effect (never a
// setState branch keyed off a prop toggling to false, which React flags as a
// cascading-render effect) is what gives the fade + 4px slide-down its "from"
// frame, same pattern as useEnterTransition (src/styles/shared.js).
function ProvenancePopover({ activity, rows, popRef, onConfirmField, onChange }) {
  const reduced = prefersReducedMotion()
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const motion = reduced
    ? { opacity: entered ? 1 : 0, transition: 'opacity var(--motion-fast) var(--ease-out)' }
    : { opacity: entered ? 1 : 0, transform: entered ? 'none' : 'translateY(-4px)', transition: 'opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)' }

  return (
    <div ref={popRef} role="dialog" aria-label={`Provenance for ${activity.name}`} tabIndex={-1} style={{ ...dotStyles.popover, ...motion }}>
      {rows.map(row => (
        <ProvenancePopoverRow
          key={row.key}
          row={row}
          onConfirm={() => onConfirmField(activity, row)}
          onChange={() => onChange(activity)}
        />
      ))}
    </div>
  )
}

function RuleProvenanceDot({ activity, evidenceByField, fieldSources, onConfirmField, onChange }) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const btnRef = useRef(null)
  const close = () => { setOpen(false); btnRef.current?.focus() }
  const popRef = useProvenancePopover(open, close)
  const reduced = prefersReducedMotion()

  if (!hasAnyEvidence(evidenceByField)) return null

  const rows = deriveActivityProvenance(fieldSources, evidenceByField)
  const worst = worstTier(rows.map(r => r.tier))
  const needsReview = rows.filter(r => r.tier !== 'confirmed').length
  const ariaLabel = needsReview > 0
    ? `Provenance: ${worst}, ${needsReview} of 3 fields need review`
    : 'Provenance: all confirmed'
  const shape = tierShapeStyle(worst)

  return (
    <span style={{ position: 'relative', display: 'inline-block', marginLeft: 6 }} onClick={e => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          ...dotStyles.dot,
          ...shape,
          boxShadow: hovered ? '0 0 0 3px color-mix(in srgb, var(--text) 10%, transparent)' : shape.boxShadow,
          transition: reduced ? 'none' : 'background-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)',
        }}
      />
      {open && (
        <ProvenancePopover
          activity={activity}
          rows={rows}
          popRef={popRef}
          onConfirmField={onConfirmField}
          onChange={(a) => { close(); onChange(a) }}
        />
      )}
    </span>
  )
}

function ActivityModal({ activity, tiers, groups, activities, locations, onSave, onClose, onCreateLocation, onUpdateLocationCapacity }) {
  const isNew = !activity?.id
  const [name, setName] = useState(activity?.name || '')
  const [locationId, setLocationId] = useState(activity?.location_id ?? null)
  const [isOutdoor, setIsOutdoor] = useState(activity?.is_outdoor || false)
  const [maxGroups, setMaxGroups] = useState(activity?.max_groups_per_slot ?? 1)
  const [minWeek, setMinWeek] = useState(activity?.min_per_week ?? 0)
  const [maxWeek, setMaxWeek] = useState(activity?.max_per_week ?? 5)
  const [sameTier, setSameTier] = useState(activity?.same_tier_only || false)
  const [priority, setPriority] = useState(activity?.priority || 'low')
  const [eligTiers, setEligTiers] = useState(activity?.eligible_tier_ids || [])
  const [groupOverride, setGroupOverride] = useState((activity?.eligible_group_ids || []).length > 0)
  const [eligGroups, setEligGroups] = useState(activity?.eligible_group_ids || [])
  const [preferDay, setPreferDay] = useState(activity?.prefer_before_day != null)
  const [preferDayVal, setPreferDayVal] = useState(activity?.prefer_before_day ?? 5)
  const [preferMin, setPreferMin] = useState(activity?.prefer_before_day_min ?? 2)
  const [weatherAlt, setWeatherAlt] = useState(activity?.weather_alternative_id || '')
  const [notes, setNotes] = useState(activity?.notes || '')
  const [spanBlocks, setSpanBlocks] = useState(activity?.span_blocks ?? 1)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  // Default expanded if an existing activity already has data in a hidden
  // field, so nothing becomes unreachable on edit; a new activity opens collapsed.
  const [showMore, setShowMore] = useState(groupOverride || preferDay || !!weatherAlt || notes.trim().length > 0)

  function toggleTier(id) { setEligTiers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]) }
  function toggleGroup(id) { setEligGroups(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]) }

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    setSaveError(null)
    // C5: a location_id left dangling (set, but the place it pointed at is
    // gone — deleted, cross-device race, stale import) is never persisted
    // silently on save. The picker surfaces the warning; if the director
    // saves without re-picking, this clears it rather than writing a
    // reference to a place that no longer exists.
    const resolvedLocationId = locationId && locations.some(l => l.id === locationId) ? locationId : null
    const record = {
      name: name.trim(), location_id: resolvedLocationId, is_outdoor: isOutdoor,
      max_groups_per_slot: Number(maxGroups), min_per_week: Number(minWeek), max_per_week: Number(maxWeek), span_blocks: Number(spanBlocks),
      same_tier_only: sameTier, priority,
      eligible_tier_ids: eligTiers, eligible_group_ids: groupOverride ? eligGroups : [],
      prefer_before_day: preferDay ? Number(preferDayVal) : null,
      prefer_before_day_min: preferDay ? Number(preferMin) : null,
      weather_alternative_id: weatherAlt || null,
      notes: notes.trim() || null,
    }
    try {
      // onSave must re-throw on failure — that's what keeps saveError
      // (rather than a silent modal close) visible to the user.
      await onSave(activity?.id || null, record)
    } catch (err) {
      setSaveError(describeWriteFailure(err, 'Your changes could not be saved.'))
      setSaving(false)
      return
    }
    setSaving(false)
  }

  const otherActivities = activities.filter(a => a.id !== activity?.id)

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 1000, padding: '24px 16px', overflowY: 'auto' }}>
      <div style={{ background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, width: 600, maxWidth: '100%' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, marginBottom: 20 }}>
          {isNew ? 'Add Activity' : `Edit: ${activity.name}`}
        </div>

        <div style={grid2}>
          <Field label="Name">
            <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={S.input} placeholder="Activity name" />
          </Field>
          <Field label="Location (optional)">
            <LocationPicker value={locationId} locations={locations} onChange={setLocationId} onCreate={onCreateLocation} onUpdateCapacity={onUpdateLocationCapacity} />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
          <label style={checkLabel}><input type="checkbox" checked={isOutdoor} onChange={e => setIsOutdoor(e.target.checked)} style={{ marginRight: 6 }} />Outdoor activity</label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={checkLabel}>
            <input type="checkbox" checked={maxGroups > 1} onChange={e => {
              if (e.target.checked) { setMaxGroups(prev => Math.max(2, Number(prev))); }
              else { setMaxGroups(1); setSameTier(false); }
            }} style={{ marginRight: 6 }} />
            Allow multiple groups at this activity at the same time
          </label>
          {maxGroups > 1 && (
            <div style={{ paddingLeft: 22, marginTop: 10, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <Field label="Max groups at once">
                <CapacityStepper value={maxGroups} onChange={setMaxGroups} min={2} ariaLabel="Max groups at once" />
              </Field>
              <div style={{ paddingTop: 22 }}>
                <label style={checkLabel}>
                  <input type="checkbox" checked={sameTier} onChange={e => setSameTier(e.target.checked)} style={{ marginRight: 6 }} />
                  Groups must be from the same age division
                </label>
              </div>
            </div>
          )}
        </div>

        <div style={grid3}>
          <Field label="Min per week">
            <CapacityStepper value={minWeek} onChange={setMinWeek} min={0} ariaLabel="Minimum per week" />
          </Field>
          <Field label="Max per week">
            <CapacityStepper value={maxWeek} onChange={setMaxWeek} min={0} ariaLabel="Maximum per week" />
          </Field>
          <Field label="Blocks per session">
            <CapacityStepper value={spanBlocks} onChange={setSpanBlocks} min={1} ariaLabel="Blocks per session" />
          </Field>
        </div>

        <Field label="Scheduling Priority">
          <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', width: 'fit-content' }}>
            {['high','low'].map(p => (
              <button key={p} onClick={() => setPriority(p)} style={S.chip('var(--primary)', priority === p, { borderRadius: 0, border: 'none', padding: '7px 20px' })}>{p.charAt(0).toUpperCase() + p.slice(1)}</button>
            ))}
          </div>
        </Field>

        <Field label="Eligible Age Divisions (leave all unchecked = eligible for all)">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
            {tiers.length === 0 ? <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No age divisions set up yet</span> : tiers.map(t => (
              <label key={t.id} style={checkLabel}>
                <input type="checkbox" checked={eligTiers.includes(t.id)} onChange={() => toggleTier(t.id)} style={{ marginRight: 5 }} />{t.name}
              </label>
            ))}
          </div>
        </Field>

        <button
          type="button"
          onClick={() => setShowMore(v => !v)}
          className="press-97"
          style={{ ...S.btnSecondary, marginBottom: 16, fontSize: 12 }}
        >
          {showMore ? 'Hide more options ▲' : 'More options ▼'}
        </button>

        <div style={{
          maxHeight: showMore ? 2000 : 0,
          opacity: showMore ? 1 : 0,
          overflow: 'hidden',
          transition: prefersReducedMotion() ? 'none' : 'max-height 200ms ease-out, opacity 160ms ease-out',
        }}>
          <label style={{ ...checkLabel, display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
            <input type="checkbox" checked={groupOverride} onChange={e => setGroupOverride(e.target.checked)} />
            Override by specific groups
          </label>
          {groupOverride && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingLeft: 8, marginBottom: 16 }}>
              {groups.map(g => (
                <label key={g.id} style={checkLabel}>
                  <input type="checkbox" checked={eligGroups.includes(g.id)} onChange={() => toggleGroup(g.id)} style={{ marginRight: 5 }} />{g.name}
                </label>
              ))}
            </div>
          )}

          <label style={{ ...checkLabel, display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
            <input type="checkbox" checked={preferDay} onChange={e => setPreferDay(e.target.checked)} />
            Distribute early in the week
          </label>
          {preferDay && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', paddingLeft: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>At least</span>
              <input type="number" min={1} value={preferMin} onChange={e => setPreferMin(e.target.value)} style={{ ...S.input, width: 60 }} />
              <span style={{ fontSize: 13 }}>times before</span>
              <select value={preferDayVal} onChange={e => setPreferDayVal(e.target.value)} style={{ ...S.input, width: 130 }}>
                {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
          )}

          <Field label="Weather alternative (shown when weather mode is on)">
            <select value={weatherAlt} onChange={e => setWeatherAlt(e.target.value)} style={S.input}>
              <option value="">— None —</option>
              {otherActivities.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>

          <Field label="Notes">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...S.input, resize: 'vertical' }} />
          </Field>
        </div>

        {saveError && (
          <div style={S.errorBanner}>
            {saveError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="press-97" onClick={onClose} style={S.btnSecondary}>Cancel</button>
          <button className="press-97" onClick={save} disabled={saving || !name.trim()} style={S.btnPrimary}>{saving ? 'Saving…' : isNew ? 'Add Activity' : 'Save Changes'}</button>
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

const repo = createScheduleRepository({ localClient })
// Repository-only migration (not the full useCrudScreen hook): load() fetches
// activities, tiers, AND groups in parallel plus a separate weekId-driven
// exclusions effect, which is outside the hook's single-entity load model.
// See docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md.
const repository = createSetupCrudRepository({ localClient })

export default function ActivitiesScreen({ campId, role, onNavigate, weekId, weeks = [], onSelectWeek }) {
  const emptyEnter = useEnterTransition('liftFade')
  const [activities, setActivities] = useState([])
  const [tiers, setTiers] = useState([])
  const [groups, setGroups] = useState([])
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null) // null | { activity } — activity=null means new
  const [importStep, setImportStep] = useState(null)
  const [importRows, setImportRows] = useState([])
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [excludedActivityIds, setExcludedActivityIds] = useState(new Set())
  const [pendingExclusion, setPendingExclusion] = useState(null) // { activity, slotCount }
  const [quickName, setQuickName] = useState('')
  const [quickAdding, setQuickAdding] = useState(false)
  // Slice D: { evidence: importEvidenceRow[], fieldSources: { [activityId]: { [opField]: source|null } } }
  const [provenance, setProvenance] = useState({ evidence: [], fieldSources: {} })
  // Slice E, Target 3 — a single-shot row settle highlight after a
  // provenance field is confirmed; self-clears after 700ms.
  const [justConfirmed, setJustConfirmed] = useState(null) // null | { activityId, field }
  // Row hover is declarative (single hovered-row id) so it shares the one
  // `background` slot with justConfirmed instead of imperatively mutating it —
  // a just-confirmed row stays highlighted even while hovered (Slice E review
  // fix: the old imperative onMouseEnter/Leave silently cancelled the settle).
  const [hoveredRow, setHoveredRow] = useState(null)
  const fileRef = useRef()

  useEffect(() => { load() }, [campId])
  useEffect(() => { loadExclusions() }, [weekId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [aData, tData, gData, lData, provenanceData] = await Promise.all([
        localClient.list('activities'),
        localClient.list('tiers'),
        localClient.list('groups'),
        localClient.list('locations'),
        localClient.listImportEvidence(),
      ])
      setProvenance(provenanceData || { evidence: [], fieldSources: {} })
      const list = (aData || [])
        .filter(a => a.camp_id === campId)
        .map(normalizeActivity)
        .sort((a, b) =>
          (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) ||
          String(a.name ?? '').localeCompare(String(b.name ?? ''))
        )
      setActivities(list)
      setTiers((tData || []).filter(t => t.camp_id === campId))
      setGroups((gData || []).filter(g => g.camp_id === campId))
      setLocations((lData || []).filter(l => l.camp_id === campId))
    } catch {
      setError("Couldn't load your camp setup — check your connection and refresh.")
    } finally {
      setLoading(false)
    }
  }

  async function loadExclusions() {
    if (!weekId) { setExcludedActivityIds(new Set()); return }
    try {
      const { activityExclusions } = await repo.loadWeekExclusions(weekId)
      setExcludedActivityIds(new Set(activityExclusions.map(e => e.activity_id)))
    } catch {
      setExcludedActivityIds(new Set())
    }
  }

  async function handleToggleExclusion(activity, currentlyExcluded) {
    if (!weekId) return
    if (currentlyExcluded) {
      // Turning ON — no confirmation needed
      await repo.toggleActivityExclusion(weekId, activity.id, false)
      setExcludedActivityIds(prev => { const next = new Set(prev); next.delete(activity.id); return next })
      return
    }
    // Turning OFF — count placed slots first
    const allSlots = await localClient.list('template_slots') || []
    const templates = await localClient.list('schedule_templates') || []
    const weekTemplateIds = new Set(templates.filter(t => t.week_id === weekId).map(t => t.id))
    const slotCount = allSlots.filter(s => weekTemplateIds.has(s.template_id) && s.activity_id === activity.id).length
    if (slotCount === 0) {
      await repo.toggleActivityExclusion(weekId, activity.id, true)
      setExcludedActivityIds(prev => new Set([...prev, activity.id]))
    } else {
      setPendingExclusion({ activity, slotCount })
    }
  }

  async function confirmExclusion() {
    if (!pendingExclusion || !weekId) return
    const { activity } = pendingExclusion
    await repo.toggleActivityExclusion(weekId, activity.id, true)
    setExcludedActivityIds(prev => new Set([...prev, activity.id]))
    setPendingExclusion(null)
  }

  // Boolean/array fields are serialized here since operations.value only
  // accepts strings/null — the repository writes whatever value it's given.
  function serializeFields(fields) {
    return Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, serializeFieldValue(field, value)]))
  }

  // Thin wrapper, not a reimplementation: curries the entity name and composes
  // Activities-only serialization before delegating to the shared repository.
  async function writeFields(id, fields) {
    await repository.writeFields('activities', id, serializeFields(fields))
  }

  // Called by ActivityModal. Re-throws on failure so the modal's own
  // saveError state stays visible instead of silently closing.
  async function saveActivity(id, fields) {
    const { name, ...rest } = fields
    const trimmedName = String(name ?? '').trim()
    if (!id && activities.some(a => whitespaceInsensitiveName(a.name) === whitespaceInsensitiveName(trimmedName))) {
      const err = new Error('An activity with this name already exists')
      setError('An activity with this name already exists — choose a different name.')
      throw err
    }
    try {
      if (id) {
        // `name` written first — a UNIQUE(camp_id, name) collision on the
        // `name` write fails atomically before any other field commits.
        await writeFields(id, { name: trimmedName, ...rest })
      } else {
        const newId = crypto.randomUUID()
        await repository.createRecord('activities', newId, serializeFields({ name: trimmedName, camp_id: campId, ...rest }))
      }
      await load()
      setModal(null)
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? 'An activity with this name already exists — choose a different name.'
          : describeWriteFailure(err, 'That activity could not be saved.')
      )
      throw err
    }
  }

  // Contextual create from the LocationPicker's "create new" row (design spec
  // Part 2) — the director never leaves the activity modal. Capacity defaults
  // to 1, notes null, matching the Locations screen's own Add Place default.
  // Case-insensitive dedupe (matching the picker's own case-insensitive
  // create-row gate, ~line 143) guards a picker session that raced the
  // Locations screen (or another device) creating the same name in between.
  // Kept case-insensitive on purpose — see confirmImport for the full
  // rationale (a case-sensitive resolve would mint unreviewable capacity-
  // fragmenting duplicates the M3c gate never sees).
  //
  // NOT aligned to T81/deriveLocationId (Red Hat, T81 round 2): this is an
  // INTERACTIVE, renameable create — the director can rename this row via
  // LocationsScreen immediately after creating it — exactly the shape
  // docs/adr/2026-08-15-locations-concurrent-create-collision.md option (d)
  // rejects deterministic ids for: create "Pool" (id location:{camp}:Pool),
  // rename to "Swimming Pool" (id unchanged), a later create of a location
  // literally named "Pool" would re-derive the same id and silently
  // overwrite the renamed row's fields. M4's ingest path accepts this
  // tradeoff only for a batch commit with its own review gate; the picker's
  // inline-create has no such gate, so it stays random-UUID/case-insensitive,
  // as the ADR decided. T81's scope is the CSV-template importer only.
  async function createLocation(name) {
    const result = await createLocationRecord({ repository, campId, name, existing: locations })
    if (!result) return null
    if (result.created) setLocations(prev => [...prev, result.location])
    return result.location.id
  }

  // C2: the in-place capacity stepper LocationPicker shows for a place it
  // just created this session — a normal write through the same repository
  // path as the Locations screen's own capacity edit, so the change is
  // indistinguishable from one made there.
  async function updateLocationCapacity(locationId, capacity) {
    await updateLocationCapacityRecord({ repository, locationId, capacity })
    setLocations(prev => prev.map(l => l.id === locationId ? { ...l, capacity } : l))
  }

  // Deleting a record a schedule uses: count first, confirm with the count
  // shown, then clear and delete in one Host-side transaction.
  // docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
  async function deleteActivity(id) {
    setError(null)
    let preview
    try {
      preview = await localClient.previewDelete('activities', id)
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? "You don't have permission to do this."
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

  // Ported to the same writeFields-based pattern as addActivity/confirmImport
  // rather than a special-cased raw insert.
  async function duplicateActivity(a) {
    // "Copy of X" is a deterministic, guessable collision target — a
    // director duplicating the same activity twice hits this every time,
    // so it needs the same pre-check + UNIQUE-aware error copy as
    // saveActivity's create path, not just a generic connection-error
    // fallback (Red Hat finding, Sub-plan C Task 5 round 1).
    let copyName = `Copy of ${a.name}`
    if (activities.some(x => whitespaceInsensitiveName(x.name) === whitespaceInsensitiveName(copyName))) {
      setError(`An activity named "${copyName}" already exists — rename it before duplicating again.`)
      return
    }
    const newId = crypto.randomUUID()
    try {
      await repository.createRecord('activities', newId, serializeFields({
        name: copyName,
        camp_id: campId,
        location_id: a.location_id,
        is_outdoor: a.is_outdoor,
        max_groups_per_slot: a.max_groups_per_slot,
        min_per_week: a.min_per_week,
        max_per_week: a.max_per_week,
        span_blocks: a.span_blocks,
        same_tier_only: a.same_tier_only,
        priority: a.priority,
        eligible_tier_ids: a.eligible_tier_ids,
        eligible_group_ids: a.eligible_group_ids,
        prefer_before_day: a.prefer_before_day,
        prefer_before_day_min: a.prefer_before_day_min,
        weather_alternative_id: a.weather_alternative_id,
        notes: a.notes,
      }))
      await load()
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? `An activity named "${copyName}" already exists — rename it before duplicating again.`
          : describeWriteFailure(err, 'That activity could not be duplicated.')
      )
    }
  }

  // Name-only quick-add — mirrors saveActivity's create path but skips the
  // modal, filling every other field with normalizeActivity's own fallbacks
  // so a quick-added row is indistinguishable from one created via the modal.
  async function addActivityQuick() {
    const trimmedName = quickName.trim()
    if (!trimmedName) return
    if (activities.some(a => whitespaceInsensitiveName(a.name) === whitespaceInsensitiveName(trimmedName))) {
      setError('An activity with this name already exists — choose a different name.')
      return
    }
    setQuickAdding(true)
    const newId = crypto.randomUUID()
    try {
      await repository.createRecord('activities', newId, serializeFields({
        name: trimmedName,
        camp_id: campId,
        location_id: null,
        is_outdoor: false,
        max_groups_per_slot: 1,
        min_per_week: 0,
        max_per_week: 5,
        span_blocks: 1,
        same_tier_only: false,
        priority: 'low',
        eligible_tier_ids: [],
        eligible_group_ids: [],
        prefer_before_day: null,
        prefer_before_day_min: null,
        weather_alternative_id: null,
        notes: null,
      }))
      setQuickName('')
      await load()
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? 'An activity with this name already exists — choose a different name.'
          : describeWriteFailure(err, 'That activity could not be added.')
      )
    } finally {
      setQuickAdding(false)
    }
  }

  function deleteAll() {
    setPendingDeleteAll(true)
  }

  async function confirmDeleteAll() {
    setDeletingAll(true)
    try {
      // Re-fetch immediately before building the id list rather than using the
      // closed-over `activities` state — if another device synced in new
      // activities between page-load and this click, the stale in-memory
      // snapshot would silently skip them with no indication anything was missed.
      const freshActivities = await localClient.list('activities')
      const ids = (freshActivities || []).filter(a => a.camp_id === campId).map(a => a.id)
      const { succeeded, failed, failedDueToRole } = await repository.deleteAllRecords('activities', ids)
      await load()
      if (failed > 0) {
        setError(
          failedDueToRole
            ? 'Only an admin can delete activities — no activities were deleted.'
            : `Deleted ${succeeded} of ${ids.length} activities — please try again for the rest.`
        )
      }
    } catch (err) {
      setError(describeWriteFailure(err, 'Those activities could not be deleted.'))
    } finally {
      setDeletingAll(false)
      setPendingDeleteAll(false)
    }
  }

  function downloadTemplate() {
    const ws = aoaToSanitizedSheet([
      ['name','location','is_outdoor','max_groups_per_slot','min_per_week','max_per_week','same_tier_only','priority','eligible_tiers','prefer_before_day','prefer_before_day_min','weather_alternative','notes'],
      ['Water Play','Pool Deck','TRUE',2,1,3,'FALSE','high','Yeladim,Tzofim','Friday',2,'',''],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Activities')
    XLSX.writeFile(wb, 'activities_template.xlsx')
  }

  function onFileChange(e) {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }).map(unescapeRow)
      const tierMap = Object.fromEntries(tiers.map(t => [t.name.toLowerCase(), t.id]))
      const actMap = Object.fromEntries(activities.map(a => [a.name.toLowerCase(), a.id]))
      const dowMap = Object.fromEntries(DOW.map((d, i) => [d.toLowerCase(), i]))
      // Existing places keyed the SAME (exact, case-SENSITIVE, trim-only) way
      // confirmImport resolves them (T81, matching deriveLocationId's own
      // normalization contract) — so the preview agrees with the actual
      // create: "pool" against an existing "Pool" now shows "new place", not
      // a silent/annotated fold, because it genuinely mints a second row.
      const locNameByExact = new Map(locations.map(l => [String(l.name ?? '').trim(), String(l.name ?? '').trim()]))

      const parsed = rows.map(r => {
        const name = String(r.name || '').trim()
        let warning = null
        if (!name) warning = 'Missing name'

        const eligTierRaw = String(r.eligible_tiers || '').trim().toLowerCase()
        const eligTierNames = eligTierRaw === 'all' || eligTierRaw === ''
          ? []
          : eligTierRaw.split(',').map(s => s.trim()).filter(Boolean)
        const eligible_tier_ids = eligTierNames.map(n => tierMap[n]).filter(Boolean)
        if (eligTierNames.length && eligible_tier_ids.length < eligTierNames.length) {
          const missing = eligTierNames.filter(n => !tierMap[n])
          warning = warning || `Age Division(s) not found: ${missing.join(', ')}`
        }

        const weatherName = String(r.weather_alternative || '').trim()
        const weather_alternative_id = weatherName ? actMap[weatherName.toLowerCase()] || null : null
        if (weatherName && !weather_alternative_id) warning = warning || `Weather alt "${weatherName}" not found`

        const preferDayStr = String(r.prefer_before_day || '').trim()
        const prefer_before_day = preferDayStr ? (dowMap[preferDayStr.toLowerCase()] ?? null) : null

        const locationName = String(r.location || '').trim() || null
        // 'reuse' → an existing place, exact-name match (matchedLocationName
        // is always identical to locationName when set — case variants no
        // longer fold, T81); 'new' → confirmImport will mint it via
        // deriveLocationId. Camp places only — a name new to the camp but
        // repeated within this same import still reads 'new'.
        const matchedLocationName = locationName ? (locNameByExact.get(locationName) ?? null) : null
        const locationResolution = locationName ? (matchedLocationName ? 'reuse' : 'new') : null

        return {
          name,
          location: locationName,
          locationResolution,
          matchedLocationName,
          is_outdoor: String(r.is_outdoor || '').toUpperCase() === 'TRUE',
          max_groups_per_slot: Number(r.max_groups_per_slot) || 1,
          min_per_week: Number(r.min_per_week) || 0,
          max_per_week: Number(r.max_per_week) || 5,
          same_tier_only: String(r.same_tier_only || '').toUpperCase() === 'TRUE',
          priority: ['high','low'].includes(String(r.priority).toLowerCase()) ? String(r.priority).toLowerCase() : 'low',
          eligible_tier_ids,
          eligible_group_ids: [],
          prefer_before_day,
          prefer_before_day_min: r.prefer_before_day_min !== '' ? Number(r.prefer_before_day_min) : null,
          weather_alternative_id,
          notes: String(r.notes || '').trim() || null,
          warning,
        }
      })
      setImportRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    try {
      // Defense-in-depth: a stray malformed row here must not throw and
      // wedge the modal on "Importing…" forever.
      const existingNames = new Set(activities.map(a => whitespaceInsensitiveName(a.name)))
      // D5 UI freeze, extended to this sheet-driven path (the sheet's
      // `location` column is a free-text place NAME, same resolution as
      // eligible_tiers/weather_alternative above): resolve it to a
      // `locations` row, creating one on first sight, so every activity this
      // screen writes gets location_id — never the free-text column. Seeded
      // from the camp's existing places and grown as new names are seen, so
      // two rows naming the same new place in one import share one location.
      // This is ActivitiesScreen's own template importer, NOT the
      // electron/ops/ingest.js / src/ingest/* legacy-spreadsheet ingest path
      // (M4 territory) — but T81 aligns its create POLICY to that path's:
      //
      // Resolve by EXACT trimmed name first (reuse ANY existing row —
      // migration/picker/ingest-created), mint only when absent, via
      // deriveLocationId(campId, trimmedName) rather than crypto.randomUUID().
      // Case-SENSITIVE on purpose (matches deriveLocationId's own
      // normalization contract and the v32 UNIQUE(camp_id, name) key) — an
      // imported "pool" against an existing "Pool" now mints a second,
      // genuinely distinct row instead of silently folding onto it, exactly
      // like M3c treats every other case-variant pair (a mergeable near-
      // duplicate the M3c gate can heal, not a silent create-time fold). This
      // supersedes the prior case-insensitive/randomUUID policy (Red Hat,
      // 2026-08-16), which traded away cross-device id determinism — the same
      // template imported on two paired devices minted two different
      // `locations.id`s for one place — to dodge a capacity-fragmentation
      // concern that resolve-by-exact-name-first + M3c's existing merge gate
      // already covers on every other locations surface. Deterministic ids
      // were rejected for a *renameable, interactive* create in
      // docs/adr/2026-08-15-locations-concurrent-create-collision.md option
      // (d) — that hazard (a later create colliding with an earlier row's
      // post-create rename) applies equally to M4's own ingest create path,
      // already shipped and accepted; T81 extends the same, already-accepted
      // tradeoff to this second call site rather than introducing a new one.
      const locationIdByName = new Map(locations.map(l => [String(l.name ?? '').trim(), l.id]))
      let added = 0, skipped = 0
      for (const row of importRows) {
        if (!row.name || row.warning) { skipped++; continue }
        const lower = whitespaceInsensitiveName(row.name)
        if (existingNames.has(lower)) { skipped++; continue }

        let locationId = null
        if (row.location) {
          const trimmedLoc = String(row.location).trim()
          locationId = locationIdByName.get(trimmedLoc) ?? null
          if (!locationId) {
            try {
              // T101 (docs/work/tickets/T101-locations-deterministic-id-rename-recollide.md):
              // deriveLocationId's base id may already belong to a RENAMED
              // row (the row keeps its id, only its name changed) — minting
              // there directly would silently overwrite the renamed row's
              // name. resolveLocationCandidateId is the same disambiguation
              // ingest.js's create paths use; `locations` (loaded from db,
              // reflecting any rename) is its existing-rows input.
              const newLocId = resolveLocationCandidateId(campId, trimmedLoc, locations).id
              await repository.createRecord('locations', newLocId, { name: trimmedLoc, camp_id: campId, capacity: 1, notes: null })
              locationId = newLocId
              locationIdByName.set(trimmedLoc, newLocId)
            } catch {
              locationId = null // best-effort: the activity still imports, just without a place
            }
          }
        }

        const newId = crypto.randomUUID()
        try {
          // `name` first — same collision-fails-atomically reasoning as saveActivity.
          await repository.createRecord('activities', newId, serializeFields({
            name: row.name,
            camp_id: campId,
            location_id: locationId,
            is_outdoor: row.is_outdoor,
            max_groups_per_slot: row.max_groups_per_slot,
            min_per_week: row.min_per_week,
            max_per_week: row.max_per_week,
            same_tier_only: row.same_tier_only,
            priority: row.priority,
            eligible_tier_ids: row.eligible_tier_ids,
            eligible_group_ids: row.eligible_group_ids,
            prefer_before_day: row.prefer_before_day,
            prefer_before_day_min: row.prefer_before_day_min,
            weather_alternative_id: row.weather_alternative_id,
            notes: row.notes,
          }))
        } catch {
          skipped++
          continue
        }
        added++
        existingNames.add(lower)
      }
      setImportResult({ added, skipped })
      setImportStep('done')
    } catch (err) {
      setError(describeWriteFailure(err, 'That import could not be completed.'))
      setImportStep(null); setImportRows([])
    } finally {
      setImporting(false); await load()
    }
  }

  // Slice D: group the batched evidence rows by activity id -> evidence field.
  const evidenceByActivity = {}
  for (const row of provenance.evidence || []) {
    if (!evidenceByActivity[row.entity_id]) evidenceByActivity[row.entity_id] = {}
    evidenceByActivity[row.entity_id][row.field] = row
  }

  // Silent re-write of the SAME current value through the existing write
  // path (source defaults to null = human/confirmed, see appendOp) — no new
  // write primitive. min_per_week's row confirms BOTH min_per_week AND
  // max_per_week since they're one logical field (one evidence record).
  async function confirmProvenanceField(activity, row) {
    const fields = Object.fromEntries(row.opFields.map(f => [f, activity[f]]))
    try {
      await writeFields(activity.id, fields)
      await load()
      setJustConfirmed({ activityId: activity.id, field: row.key })
      setTimeout(() => setJustConfirmed(null), 700)
    } catch (err) {
      setError(describeWriteFailure(err, 'That could not be confirmed.'))
    }
  }

  const highPriority = activities.filter(a => a.priority === 'high')
  const lowPriority = activities.filter(a => a.priority === 'low')
  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)
  const actMap = Object.fromEntries(activities.map(a => [a.id, a.name]))
  const locMap = Object.fromEntries(locations.map(l => [l.id, l.name]))

  const currentWeek = weeks.find(w => w.id === weekId)

  return (
    <div style={{ maxWidth: 820 }}>
      {weeks.length > 0 && (
        <WeekContextBar
          weekId={weekId}
          weeks={weeks}
          onSelectWeek={onSelectWeek}
          exclusionCount={excludedActivityIds.size}
          totalCount={activities.length}
          entityLabel="activities"
        />
      )}
      <SetupScreenShell
        countLabel={`${activities.length} activit${activities.length !== 1 ? 'ies' : 'y'}`}
        role={role}
        actions={{ onDownloadTemplate: downloadTemplate, onImport: () => fileRef.current.click(), onDeleteAll: deleteAll }}
        fileInputRef={fileRef}
        onFileChange={onFileChange}
        maxWidth={820}
        nextLabel="Next: Recurring Events →"
        onNext={() => onNavigate('anchors')}
        error={error}
      >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="press-97" onClick={() => setModal({ activity: null })} style={S.btnPrimary}>+ Add Activity</button>
      </div>

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : activities.length === 0 ? (
        // padding 40px 24px intentional — wider horizontal padding than other empty states
        <div style={{ ...S.emptyState, padding: '40px 24px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
          <div style={emptyEnter}>
            <img src={uiClipboard} alt="" style={S.emptyStateIcon} />
            <div style={S.emptyStateTitle}>No activities yet</div>
            <div style={S.emptyStateBody}>Add your first activity or import from Excel.</div>
          </div>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Location</th>
                <th style={S.th}>Outdoor</th>
                <th style={S.th}>Co-schedule</th>
                <th style={S.th}>Min–Max/Wk</th>
                <th style={S.th}>Alt</th>
                {weekId && <th style={{ ...S.th, textAlign: 'center' }}>{currentWeek?.name ?? 'Week'}</th>}
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {[{ label: 'High Priority', rows: highPriority }, { label: 'Low Priority', rows: lowPriority }].map(({ label, rows }) => {
                if (!rows.length) return null
                return (
                  <React.Fragment key={label}>
                    <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1px solid var(--border)' }}>
                      <td colSpan={weekId ? 8 : 7} style={{ padding: '6px 14px', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</td>
                    </tr>
                    {rows.map(a => (
                      <tr key={a.id} style={{
                          borderBottom: '1px solid var(--border)',
                          cursor: 'pointer',
                          // justConfirmed wins over hover so the settle survives a hover.
                          background: justConfirmed?.activityId === a.id
                            ? 'color-mix(in srgb, var(--secondary) 10%, transparent)'
                            : hoveredRow === a.id ? 'var(--bg)' : 'transparent',
                          // Transition only the confirm settle; hover stays instant.
                          transition: (justConfirmed?.activityId === a.id && !prefersReducedMotion())
                            ? 'background-color var(--motion-settle) var(--ease-out)' : 'none',
                        }}
                        onClick={() => setModal({ activity: a })}
                        onMouseEnter={() => setHoveredRow(a.id)}
                        onMouseLeave={() => setHoveredRow(null)}
                        onFocus={() => setHoveredRow(a.id)}
                        onBlur={() => setHoveredRow(null)}
                      >
                        <td style={{ ...S.td, fontWeight: 500 }}>
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`Edit ${a.name}`}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModal({ activity: a }) } }}
                            style={{ cursor: 'pointer' }}
                          >{a.name}</span>
                          <RuleProvenanceDot
                            activity={a}
                            evidenceByField={evidenceByActivity[a.id] || {}}
                            fieldSources={provenance.fieldSources?.[a.id] || {}}
                            onConfirmField={confirmProvenanceField}
                            onChange={(activity) => setModal({ activity })}
                          />
                        </td>
                        <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 12 }}>{a.location_id ? locMap[a.location_id] || '—' : '—'}</td>
                        <td style={{ ...S.td, fontSize: 12 }}>{a.is_outdoor ? '🌤' : '—'}</td>
                        <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
                          {a.max_groups_per_slot > 1 ? `Up to ${a.max_groups_per_slot}${a.same_tier_only ? ' (same age division)' : ''}` : '—'}
                        </td>
                        <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{a.min_per_week}–{a.max_per_week}</td>
                        <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>{a.weather_alternative_id ? actMap[a.weather_alternative_id] || '—' : '—'}</td>
                        {weekId && (
                          <td style={{ ...S.td, textAlign: 'center' }}>
                            <WeekToggle
                              on={!excludedActivityIds.has(a.id)}
                              label={excludedActivityIds.has(a.id)
                                ? `Off in ${currentWeek?.name ?? 'this week'}`
                                : `Runs in ${currentWeek?.name ?? 'this week'}`}
                              onToggle={() => handleToggleExclusion(a, excludedActivityIds.has(a.id))}
                            />
                          </td>
                        )}
                        <td style={{ ...S.td, textAlign: 'right', borderLeft: weekId ? '1px solid var(--border)' : undefined }}>
                          <button className="press-97" onClick={e => { e.stopPropagation(); duplicateActivity(a) }} style={S.btnSecondary}>Duplicate</button>
                          <button
                            onClick={e => { e.stopPropagation(); deleteActivity(a.id) }}
                            disabled={role !== 'admin'}
                            title={role !== 'admin' ? 'Admin only' : undefined}
                            style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
                          >Delete</button>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginTop: 16 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Add Activity
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            placeholder="Activity name (e.g. Archery)"
            value={quickName}
            onChange={e => setQuickName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addActivityQuick()}
            style={{ ...S.input, flex: 1 }}
          />
          <button className="press-97" onClick={addActivityQuick} disabled={quickAdding || !quickName.trim()} style={S.btnPrimary}>
            {quickAdding ? 'Adding…' : '+ Add'}
          </button>
        </div>
      </div>

      </SetupScreenShell>

      {modal && (
        <ActivityModal
          activity={modal.activity}
          tiers={tiers}
          groups={groups}
          activities={activities}
          locations={locations}
          onSave={saveActivity}
          onClose={() => setModal(null)}
          onCreateLocation={createLocation}
          onUpdateLocationCapacity={updateLocationCapacity}
        />
      )}

      <ImportModal
        step={importStep}
        title={importStep === 'done' ? 'Import Complete' : 'Import Preview'}
        width={620}
        columns={[{ key: 'name', label: 'Name' }, { key: 'location', label: 'Location' }, { key: 'priority', label: 'Priority' }, { key: 'status', label: 'Status' }]}
        rows={importRows}
        readyCount={readyRows.length}
        warnCount={warnRows.length}
        result={importResult}
        importing={importing}
        onConfirm={confirmImport}
        onCancel={() => { setImportStep(null); setImportRows([]) }}
        previewSubtitle={<>{readyRows.length} ready{warnRows.length > 0 && `, ${warnRows.length} with warnings (skipped)`}</>}
        renderCell={(r, c) => {
          if (c.key === 'name') return r.name || '—'
          if (c.key === 'location') return (
            <>
              {r.location || '—'}
              {r.locationResolution === 'new' && (
                <span style={importAnnotation.newPlace}>+ new location</span>
              )}
            </>
          )
          if (c.key === 'priority') return r.priority
          if (c.key === 'status') return <span style={r.warning ? S.importWarnText : { color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</span>
        }}
      />

      {pendingDelete && (
        <DeleteRecordDialog
          preview={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onDeleted={() => { setPendingDelete(null); load() }}
        />
      )}
      {pendingDeleteAll && (
        <ConfirmDangerDialog
          title="Delete all activities?"
          recovery="They can be restored from Trash."
          confirmLabel="Delete All Activities"
          busy={deletingAll}
          onConfirm={confirmDeleteAll}
          onCancel={() => setPendingDeleteAll(false)}
        />
      )}
      {pendingExclusion && (
        <ExclusionConfirmDialog
          entityName={pendingExclusion.activity.name}
          weekName={currentWeek?.name ?? 'this week'}
          slotCount={pendingExclusion.slotCount}
          onCancel={() => setPendingExclusion(null)}
          onConfirm={confirmExclusion}
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
      onClick={e => { e.stopPropagation(); onToggle() }}
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

const grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }
const grid3 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 16px' }
const checkLabel = { fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }

// Import-preview per-row location annotations: make new-vs-reused resolution
// visible before commit (a case-variant fold is shown, not silent).
const importAnnotationBase = { marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 10, whiteSpace: 'nowrap' }
const importAnnotation = {
  newPlace: { ...importAnnotationBase, color: 'var(--secondary)' },
  reuse: { ...importAnnotationBase, color: 'var(--text-secondary)' },
}

// Slice D — row-level provenance dot + popover (spec docs/work/specs/
// 2026-08-22-roots-as-hub-setup-ia-slices.md, Slice D).
const dotStyles = {
  dot: {
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: '50%',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    verticalAlign: 'middle',
  },
  popover: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    zIndex: 40,
    minWidth: 260,
    padding: 12,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
  },
  row: {
    padding: '8px 0',
    borderBottom: '1px solid var(--border)',
  },
  rowDot: {
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  tierLabel: {
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-secondary)',
  },
  rowSentence: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginTop: 4,
  },
  rowActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 6,
  },
  confirmedLabel: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  confirmBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--primary)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  changeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
}
