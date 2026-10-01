// The elective SET builder — offerings management, extracted from
// ElectivesScreen.jsx (docs/work/specs/2026-08-23-electives-gap.md Part b)
// so it can be reused verbatim from two entry points: Roots's
// ElectivesScreen (pre-extraction behavior, now reached via a link) and the
// new Schedule-side ScheduleElectivesScreen. Same file-organization
// convention as SpecialDayGridEditor/EventGridEditor's own subfolders.
import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { localClient } from '../../localClient'
import { createSetupCrudRepository } from '../../data/setupCrudRepository'
import { useCrudScreen } from '../../hooks/useCrudScreen'
import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { S, prefersReducedMotion } from '../../styles/shared'
import ConfirmDangerDialog from '../../components/ConfirmDangerDialog'
import ActivityPicker from '../../components/ActivityPicker'
import { ChevronIcon } from '../../components/icons/index.jsx'
import { parseTextGrid } from '../../ingest/textGrid'
import { workbookToPages } from '../../ingest/sheetGrid'
import { parseGridSchedule } from '../../ingest/parseGridSchedule'
import { populateElectiveSet } from '../../ingest/electiveSetPopulate'
import { markElectivePermissionTier } from '../../ingest/electivePermissionTier'
import { filterFreeChoiceActivities } from '../../engine/freeChoiceActivities'
import { clearElectivePermissionOnRemoval } from '../../ingest/electivePermissionClear'
import { createActivity } from '../schedule/createActivityHelper'
import { assertImportFileSize, readWorkbookSafely, unescapeRow } from '../../utils/exportSanitize.js'
import { useLatestTimeout } from '../../hooks/useLatestTimeout'
import AssignmentPanel from './assignment/AssignmentPanel.jsx'
import BundleEditor from './BundleEditor.jsx'
import { deriveBundlePickerCells } from './assignment/deriveBundlePickerCells.js'

const repository = createSetupCrudRepository({ localClient })
// createActivityHelper.js's createActivity (and populateElectiveSet, which
// calls it for import-minted rows) both need a `writeActivityFields(id,
// fields)` method — setupCrudRepository only exposes the generic
// `writeFields(entity, id, fields)`. Mirrors the same one-line repoShim
// EventGridEditor.jsx/SpecialDayGridEditor.jsx each build for the same
// reason, so manual-create (this file) and import-create
// (populateElectiveSet) mint activities through the identical write path.
const activityRepo = { ...repository, writeActivityFields: (id, fields) => repository.writeFields('activities', id, fields) }
const offeringScopeFilter = (row, electiveSetId) => row.elective_set_id === electiveSetId

const IMPORT_LABELS = {
  importAction: 'Import from a file',
  noGridFound: 'No schedule could be read out of that. It may be a scan rather than a document with text in it.',
}

// Defense-in-depth: malformed JSON in an eligible_*_ids column must not crash
// this screen — same posture as ActivitiesScreen.jsx's parseIdList.
function parseIdList(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// "Staff" has no model on `activities` anywhere in this codebase today (no
// column, no join table) — surfacing it here would mean inventing a new
// model, which the brief explicitly forbids ("do not duplicate those
// models"). Location and eligibility are real activity fields; staff is
// left out of this render rather than fabricated.
function eligibilitySummary(activity, tiers, groups) {
  const tierIds = parseIdList(activity?.eligible_tier_ids)
  const groupIds = parseIdList(activity?.eligible_group_ids)
  if (groupIds.length > 0) {
    const names = groupIds.map((id) => groups.find((g) => g.id === id)?.name).filter(Boolean)
    return names.length ? names.join(', ') : `${groupIds.length} group(s)`
  }
  if (tierIds.length > 0) {
    const names = tierIds.map((id) => tiers.find((t) => t.id === id)?.name).filter(Boolean)
    return names.length ? names.join(', ') : `${tierIds.length} division(s)`
  }
  return 'Everyone'
}

function OfferingRow({
  offering, activity, locations, tiers, groups, onSaveCapacity, onSaveMinimum, onDelete, role,
  // T301 slice 2 — linked-elective bundles for this offering's activity.
  days, timeBlocks, occurrenceCells, bundles, bundlePeriods, bundleTiers,
  onToggleBundlePeriod, onSetBundleScopeMode, onToggleBundleTier, onSaveBundleName, onDeleteBundle,
}) {
  // v66 (T194): capacity is a two-part value — capacity_mode is the AUTHORITY,
  // and capacity_limit is ignored entirely when the mode is 'unlimited'. This
  // control's behaviour is unchanged from v39 IN ONE RESPECT ONLY — empty box =
  // no cap, a number = that cap — and that is as far as the claim goes. Under
  // D3's new semantics, commitCapacity's `parseInt(trimmed, 10) || 0` coercion
  // means typing 'abc' now silently CLOSES the offering (limited, 0) where
  // under v39 it was merely an ambiguous zero. D3's "unlimited vs closed must
  // be unmistakable" authoring redesign is NOT this slice — it is recorded as a
  // T197/T199 requirement — and this is only the repoint needed to keep the
  // existing control working now that camper_headcount is retired from the
  // write path.
  const [capacityText, setCapacityText] = useState(
    offering.capacity_mode === 'limited' && offering.capacity_limit != null
      ? String(offering.capacity_limit)
      : ''
  )
  const [saving, setSaving] = useState(false)
  // Brief green flash confirming a successful capacity save — silent-save left
  // directors unsure it persisted (Slice 1 Tester). Single-shot, self-clears;
  // reuses the confirm-feedback pattern from the Roots-as-hub Slice E.
  const [savedFlash, setSavedFlash] = useState(false)
  const { start: startSavedFlash } = useLatestTimeout()
  // T265 — the minimum headcount to run, its own two-part value beside the
  // capacity. `min_mode` is the AUTHORITY: a leftover `min_to_run` under mode
  // 'none' shows as EMPTY, so a director never sees a minimum the engine is
  // ignoring. Same read shape as the capacity control directly above.
  const [minText, setMinText] = useState(
    offering.min_mode === 'required' && offering.min_to_run != null
      ? String(offering.min_to_run)
      : ''
  )
  const [minSaving, setMinSaving] = useState(false)
  const [minSavedFlash, setMinSavedFlash] = useState(false)
  const { start: startMinSavedFlash } = useLatestTimeout()
  const location = locations.find((l) => l.id === activity?.location_id)

  async function commitCapacity() {
    const trimmed = capacityText.trim()
    const value = trimmed === '' ? null : Math.max(0, parseInt(trimmed, 10) || 0)
    const current =
      offering.capacity_mode === 'limited' && offering.capacity_limit != null
        ? offering.capacity_limit
        : null
    if (value === current) return
    setSaving(true)
    try {
      await onSaveCapacity(offering.id, value)
      setSavedFlash(true)
      startSavedFlash(() => setSavedFlash(false), 700)
    } catch {
      // onSaveCapacity already surfaced the error via the screen's error banner.
    } finally {
      setSaving(false)
    }
  }

  // NOTHING IS COERCED HERE. The capacity control above turns a blank into
  // `parseInt(...) || 0`, which is how a blank capacity became a CLOSED offering
  // — the live defect T265's two-part shape exists to avoid reproducing. So a
  // blank clears the minimum (mode 'none'), and a 0 is REFUSED with a reason
  // rather than silently becoming "no minimum" or "needs 0".
  async function commitMinimum() {
    const trimmed = minText.trim()
    const current =
      offering.min_mode === 'required' && offering.min_to_run != null
        ? offering.min_to_run
        : null
    if (trimmed === '0') {
      // Owner ruling 2026-09-25: the min could be 1, cannot be 0.
      onSaveMinimum(offering.id, current, 'A minimum to run has to be at least 1.')
      setMinText(current == null ? '' : String(current))
      return
    }
    const value = trimmed === '' ? null : parseInt(trimmed, 10)
    if (value === current) return
    setMinSaving(true)
    try {
      await onSaveMinimum(offering.id, value)
      setMinSavedFlash(true)
      startMinSavedFlash(() => setMinSavedFlash(false), 700)
    } catch {
      // onSaveMinimum already surfaced the error via the screen's error banner.
    } finally {
      setMinSaving(false)
    }
  }

  // T301 slice 2 — linked-elective bundles for THIS offering's activity,
  // assembled from the three flat tables ElectiveSetDetail loaded (one
  // pass, not memoized per row: bundle counts per activity are small, and
  // this mirrors the existing per-row `activities.find(...)` lookups above).
  const activityBundles = (bundles ?? [])
    .filter((b) => b.activity_id === offering.activity_id)
    .map((b) => ({
      id: b.id,
      elective_set_id: b.elective_set_id,
      activity_id: b.activity_id,
      name: b.name,
      scope_mode: b.scope_mode,
      periods: (bundlePeriods ?? [])
        .filter((p) => p.bundle_id === b.id)
        .map((p) => ({ day_id: p.day_id, time_block_id: p.time_block_id })),
      tierIds: (bundleTiers ?? []).filter((t) => t.bundle_id === b.id).map((t) => t.tier_id),
    }))
  const [bundlesExpanded, setBundlesExpanded] = useState(false)
  const [draftActive, setDraftActive] = useState(false)
  const hasSchedule = (occurrenceCells ?? []).length > 0
  const reducedBundles = prefersReducedMotion()

  // A draft has no id — the FIRST period click is what mints the real
  // elective_bundles row (see ElectiveSetDetail's onToggleBundlePeriod). Once
  // that happens this editor instance's `bundle` prop stops being the draft
  // (the next reload's `activityBundles` includes the new row instead), so
  // the draft placeholder itself is retired here.
  async function handleBundleTogglePeriod(bundle, cell, isSelected) {
    const wasDraft = bundle.id == null
    await onToggleBundlePeriod(activity, bundle, cell, isSelected)
    if (wasDraft) setDraftActive(false)
  }

  const draftBundle = {
    id: null, elective_set_id: offering.elective_set_id, activity_id: offering.activity_id,
    name: '', scope_mode: 'all', periods: [], tierIds: [],
  }
  const bundleEditorProps = {
    activity, tiers, days, timeBlocks, occurrenceCells, role,
    onSetScopeMode: onSetBundleScopeMode, onToggleTier: onToggleBundleTier,
    onSaveName: onSaveBundleName, onDelete: onDeleteBundle,
    onTogglePeriod: handleBundleTogglePeriod,
  }

  return (
    <>
    <tr style={{ borderBottom: activityBundles.length === 0 && !draftActive ? '1px solid var(--border)' : 'none' }}>
      <td style={{ ...S.td, fontWeight: 500 }}>
        {activity?.name ?? '(deleted activity)'}{' '}
        {activityBundles.length === 0 ? (
          <button
            type="button"
            className="press-97"
            onClick={() => { setBundlesExpanded(true); setDraftActive(true) }}
            disabled={!hasSchedule}
            title={!hasSchedule ? 'Place this set on a schedule first — bundles are built from its placed periods.' : undefined}
            style={{
              fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
              border: 'none', background: 'none', padding: 0, marginLeft: 8, fontFamily: 'inherit',
              cursor: hasSchedule ? 'pointer' : 'not-allowed', opacity: hasSchedule ? 1 : 0.5,
            }}
          >
            + Add bundle
          </button>
        ) : (
          <button
            type="button"
            className="press-97"
            onClick={() => setBundlesExpanded((v) => !v)}
            aria-expanded={bundlesExpanded}
            aria-controls={`bundles-${offering.id}`}
            style={{
              fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
              border: 'none', background: 'none', padding: 0, marginLeft: 8, fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
            }}
          >
            {activityBundles.length} bundle{activityBundles.length === 1 ? '' : 's'}
            <ChevronIcon expanded={bundlesExpanded} />
          </button>
        )}
      </td>
      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 12 }}>{location?.name ?? '—'}</td>
      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 12 }}>
        {activity ? eligibilitySummary(activity, tiers, groups) : '—'}
      </td>
      <td style={S.td}>
        <input
          type="text"
          inputMode="numeric"
          placeholder="No cap"
          value={capacityText}
          disabled={saving}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '' || /^\d+$/.test(raw)) setCapacityText(raw)
          }}
          onBlur={commitCapacity}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          data-saved={savedFlash ? '' : undefined}
          style={{
            ...S.input,
            width: 90,
            boxShadow: savedFlash ? '0 0 0 2px var(--secondary)' : undefined,
            transition: prefersReducedMotion() ? 'none' : 'box-shadow var(--motion-base) var(--ease-out)',
          }}
          aria-label={`Capacity for ${activity?.name ?? 'offering'}`}
        />
      </td>
      <td style={S.td}>
        <input
          type="text"
          inputMode="numeric"
          placeholder="No minimum"
          value={minText}
          disabled={minSaving}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '' || /^\d+$/.test(raw)) setMinText(raw)
          }}
          onBlur={commitMinimum}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          data-saved={minSavedFlash ? '' : undefined}
          style={{
            ...S.input,
            width: 110,
            boxShadow: minSavedFlash ? '0 0 0 2px var(--secondary)' : undefined,
            transition: prefersReducedMotion() ? 'none' : 'box-shadow var(--motion-base) var(--ease-out)',
          }}
          aria-label={`Minimum to run ${activity?.name ?? 'offering'}`}
        />
      </td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button
          onClick={() => onDelete(offering)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnRowDanger, ...S.buttonDisabled } : S.btnRowDanger}
        >
          Remove
        </button>
      </td>
    </tr>
    <tr>
      <td colSpan={6} style={{ padding: 0, border: activityBundles.length > 0 || draftActive ? '1px solid var(--border)' : 'none', borderTop: 'none' }}>
        <div
          id={`bundles-${offering.id}`}
          style={{
            overflow: 'hidden',
            maxHeight: bundlesExpanded ? 4000 : 0,
            opacity: bundlesExpanded ? 1 : 0,
            transition: reducedBundles ? 'none' : 'max-height var(--motion-base) var(--ease-out), opacity var(--motion-base) var(--ease-out)',
          }}
        >
          <div style={{ padding: '10px 14px 14px', background: 'var(--bg)' }}>
            {activityBundles.map((b) => (
              <BundleEditor
                key={b.id}
                bundle={b}
                isDraft={false}
                siblingBundles={activityBundles.filter((x) => x.id !== b.id)}
                {...bundleEditorProps}
              />
            ))}
            {draftActive && (
              <BundleEditor bundle={draftBundle} isDraft={true} siblingBundles={activityBundles} {...bundleEditorProps} />
            )}
            {activityBundles.length > 0 && !draftActive && (
              <button type="button" className="press-97" onClick={() => setDraftActive(true)} style={{ ...S.btnUtility, fontSize: 12, padding: '6px 0' }}>
                + Add another bundle
              </button>
            )}
          </div>
        </div>
      </td>
    </tr>
    </>
  )
}

export default function ElectiveSetDetail({
  set, role, activities, locations, tiers, groups, refreshActivities, onBack, onNavigate,
  days = [], timeBlocks = [], templateSlots = [], scheduleTemplates = [], scheduleWeeks = [],
  campers = [],
}) {
  const { rows: offerings, loading, error, setError, adding, add, reload } = useCrudScreen({
    entity: 'elective_set_activities',
    campId: set.id,
    localClient,
    repository,
    scopeFilter: offeringScopeFilter,
    buildCreateFields: ({ activityId }) => ({
      elective_set_id: set.id,
      activity_id: activityId,
    }),
    addFailedText: 'That offering could not be added.',
    saveFailedText: 'That capacity could not be saved.',
  })

  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [importing, setImporting] = useState(false)
  // T195 — offerings that were in this set but not on the sheet just imported,
  // so the director is told rather than left to notice a stale offering.
  // Report-only; nothing is deleted. Holds `{ setId, offerings }` (the raw rows,
  // not just names, so an offering whose activity was deleted from the catalog —
  // name null — is still surfaced rather than silently dropped). It is TAGGED
  // with the set it belongs to and the render gates on `setId === set.id`, so a
  // notice never carries over when this component is reused without a key across
  // a set switch (Red Hat) — avoiding a reset-in-effect.
  const [vanishedNotice, setVanishedNotice] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const fileInputRef = useRef(null)

  // T301 slice 2 — this set's authored bundles. Three flat tables, loaded
  // plainly (not via useCrudScreen, which is shaped around ONE entity with
  // its own error state; bundle writes route through THIS screen's existing
  // `error` banner instead, the same way saveCapacity/saveMinimum already
  // do). elective_bundle_periods/elective_bundle_tiers carry no
  // elective_set_id of their own (ADR D1 — parent-scoped by bundle_id only),
  // so they are loaded campwide and filtered here by this set's own bundle
  // ids, mirroring offeringScopeFilter's own list-then-filter shape.
  const [bundles, setBundles] = useState([])
  // Board item 9b — every bundle NAME in the camp, unfiltered by set. A bundle's
  // director-given name is a label a camper's sheet may rank (ADR D4), so it
  // belongs in the label catalogue AssignmentPanel builds — and camp-wide,
  // because that is what the CLI door reads. Scoping this one to `set.id` while
  // the CLI reads camp-wide would make a bundle resolve through one door and not
  // the other, which is the drift buildPreferenceCatalog exists to prevent.
  const [allBundleNames, setAllBundleNames] = useState([])
  const [bundlePeriods, setBundlePeriods] = useState([])
  const [bundleTiers, setBundleTiers] = useState([])
  const [pendingDeleteBundle, setPendingDeleteBundle] = useState(null)
  const [deletingBundle, setDeletingBundle] = useState(false)

  const reloadBundles = useCallback(async () => {
    const [allBundles, allPeriods, allTiers] = await Promise.all([
      localClient.list('elective_bundles'),
      localClient.list('elective_bundle_periods'),
      localClient.list('elective_bundle_tiers'),
    ])
    setAllBundleNames((allBundles || []).map((b) => b.name).filter(Boolean))
    const setBundlesRows = (allBundles || []).filter((b) => b.elective_set_id === set.id)
    const bundleIds = new Set(setBundlesRows.map((b) => b.id))
    setBundles(setBundlesRows)
    setBundlePeriods((allPeriods || []).filter((p) => bundleIds.has(p.bundle_id)))
    setBundleTiers((allTiers || []).filter((t) => bundleIds.has(t.bundle_id)))
  }, [set.id])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reloadBundles()
  }, [reloadBundles])

  // The picker grid's cells — the union of both candidate routes' placed
  // periods for this set (CLAUDE.md: neither route is canonical). Recomputed
  // only when the inputs that could change it change, since it is read by
  // EVERY bundle editor on this screen and a whole-camp slot scan is a real
  // cost at up to 480 cells (mirrors AssignmentPanel.jsx's own H2 memo).
  const occurrenceCells = useMemo(
    () => deriveBundlePickerCells({ templateSlots, scheduleTemplates, groups, days, timeBlocks, electiveSetId: set.id }),
    [templateSlots, scheduleTemplates, groups, days, timeBlocks, set.id]
  )

  // Deletes every elective_bundle_periods/elective_bundle_tiers row for the
  // given bundle ids, then the elective_bundles rows themselves — the shared
  // cleanup both a single bundle delete and an offering/clear-offerings
  // removal need (ADR's own note: both paths leave orphans with no FK
  // cascade). Silent no-op for an empty list, matching this file's own
  // `if (bundleIdsToRemove.length === 0) return` posture elsewhere.
  async function deleteBundleRows(bundleIds) {
    if (bundleIds.length === 0) return
    const idSet = new Set(bundleIds)
    const periodIds = bundlePeriods.filter((p) => idSet.has(p.bundle_id)).map((p) => p.id)
    const tierIds = bundleTiers.filter((t) => idSet.has(t.bundle_id)).map((t) => t.id)
    // The two child tables are independent of each other — only the parent
    // bundle row needs to go last.
    await Promise.all([
      repository.deleteAllRecords('elective_bundle_periods', periodIds),
      repository.deleteAllRecords('elective_bundle_tiers', tierIds),
    ])
    await repository.deleteAllRecords('elective_bundles', bundleIds)
  }

  // D7 — the proposed name for a bundle's first period. Computed ONCE, here,
  // at the moment a draft's first cell is picked (the only caller of the
  // bundle.id == null branch below); never recomputed after, because the
  // name is then the director's to edit.
  function proposeBundleName(forActivity, cell) {
    const existing = bundles.filter((b) => b.activity_id === forActivity.id)
    if (existing.length === 0) return forActivity.name
    const day = days.find((d) => d.id === cell.day_id)
    const block = timeBlocks.find((b) => b.id === cell.time_block_id)
    const dayLabel = day?.label ?? day?.name ?? cell.day_id
    const blockName = block?.name ?? cell.time_block_id
    return `${forActivity.name} — ${dayLabel}, ${blockName}`
  }

  async function onToggleBundlePeriod(forActivity, bundle, cell, isSelected) {
    try {
      if (bundle.id == null) {
        // A draft has no row yet — the first period click mints both the
        // bundle and its first period in one gesture.
        const newBundleId = crypto.randomUUID()
        await repository.createRecord('elective_bundles', newBundleId, {
          elective_set_id: set.id,
          activity_id: forActivity.id,
          name: proposeBundleName(forActivity, cell),
          scope_mode: 'all',
        })
        await repository.createRecord('elective_bundle_periods', crypto.randomUUID(), {
          bundle_id: newBundleId, day_id: cell.day_id, time_block_id: cell.time_block_id,
        })
      } else if (isSelected) {
        const toRemove = bundlePeriods
          .filter((p) => p.bundle_id === bundle.id && p.day_id === cell.day_id && p.time_block_id === cell.time_block_id)
          .map((p) => p.id)
        await repository.deleteAllRecords('elective_bundle_periods', toRemove)
      } else {
        await repository.createRecord('elective_bundle_periods', crypto.randomUUID(), {
          bundle_id: bundle.id, day_id: cell.day_id, time_block_id: cell.time_block_id,
        })
      }
      await reloadBundles()
    } catch (err) {
      setError(describeWriteFailure(err, 'That period could not be saved.'))
      throw err
    }
  }

  // 'all' leaves any pre-existing elective_bundle_tiers rows alone — they are
  // inert under 'all' (ADR D2), and preserving them means a director toggling
  // between Only/All while deciding does not lose their picks.
  async function onSetBundleScopeMode(bundle, mode) {
    try {
      await repository.writeFields('elective_bundles', bundle.id, { scope_mode: mode })
      await reloadBundles()
    } catch (err) {
      setError(describeWriteFailure(err, "That bundle's scope could not be saved."))
      throw err
    }
  }

  async function onToggleBundleTier(bundle, tierId, isSelected) {
    try {
      if (isSelected) {
        const toRemove = bundleTiers.filter((t) => t.bundle_id === bundle.id && t.tier_id === tierId).map((t) => t.id)
        await repository.deleteAllRecords('elective_bundle_tiers', toRemove)
      } else {
        await repository.createRecord('elective_bundle_tiers', crypto.randomUUID(), { bundle_id: bundle.id, tier_id: tierId })
      }
      await reloadBundles()
    } catch (err) {
      setError(describeWriteFailure(err, 'That division could not be saved.'))
      throw err
    }
  }

  async function onSaveBundleName(bundle, name) {
    try {
      await repository.writeFields('elective_bundles', bundle.id, { name })
      await reloadBundles()
    } catch (err) {
      setError(describeWriteFailure(err, "That bundle's name could not be saved."))
      throw err
    }
  }

  async function confirmDeleteBundle() {
    if (!pendingDeleteBundle) return
    setDeletingBundle(true)
    try {
      await deleteBundleRows([pendingDeleteBundle.id])
      await reloadBundles()
    } catch (err) {
      setError(describeWriteFailure(err, 'That bundle could not be deleted.'))
    } finally {
      setDeletingBundle(false)
      setPendingDeleteBundle(null)
    }
  }

  const offeredActivityIds = new Set(offerings.map((o) => o.activity_id))
  // T266 (site 5 of 7) — an elective offering is a free choice a camper picks, so
  // a name ingest pass 1/2 already claimed is not offerable. Applied alongside
  // the existing already-offered-here filter, not folded into it.
  const availableActivities = filterFreeChoiceActivities(activities)
    .filter((a) => !offeredActivityIds.has(a.id))

  async function addExistingOffering(activityId) {
    await add({ activityId })
    const currentStatus = activities.find((a) => a.id === activityId)?.recurrence_truth_status
    await markElectivePermissionTier(activityRepo, activityId, currentStatus)
  }

  // Part (a) — mints a new activity through the SAME path
  // populateElectiveSet already uses for import-minted activities
  // (createActivityHelper.js's createActivity), so manual-create and
  // import-create activities are indistinguishable rows. Name only — no
  // location/eligibility at creation time, those are Activities-screen
  // concerns (spec's "what a newly-created activity gets").
  // Returns the created activity, which the residue-resolution path in
  // AssignmentPanel re-parses against immediately: `refreshActivities` updates the
  // prop for the NEXT render, and a re-parse that waited for it would read the old
  // catalog and resolve nothing. The inline-add caller ignores the return value.
  async function createAndAddOffering(name) {
    const { activityId, activity } = await createActivity({ name, campId: set.camp_id, activities }, activityRepo)
    await add({ activityId })
    await markElectivePermissionTier(activityRepo, activityId, activity.recurrence_truth_status)
    await refreshActivities()
    return activity
  }

  // File -> parse -> populate wiring (ADR §8, mirrors EventGridEditor.jsx's
  // runImport). Reuses the same file->grid extraction and size/complexity
  // guards ImportScreen.jsx uses — this import stays renderer-side, scoped
  // to this one elective set, never touching ReconciliationScreen/
  // buildPlan.js/the campwide ingest pipeline. Both the xlsx AND the .txt
  // branch are size-guarded (a gap Security caught in the events consumer).
  async function runImport(file) {
    if (!file) return
    setError(null)
    setVanishedNotice(null)
    setImporting(true)
    try {
      let pages
      if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
        const wb = readWorkbookSafely(await file.arrayBuffer(), { type: 'array', byteLength: file.size })
        const sheets = wb.SheetNames.map((name) => ({
          name,
          rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false }).map(unescapeRow),
        }))
        pages = workbookToPages(sheets, file.name)
      } else {
        assertImportFileSize(file.size)
        pages = parseTextGrid(await file.text()).pages
      }

      if (!pages || pages.length === 0) {
        setError(IMPORT_LABELS.noGridFound)
        return
      }

      const parsed = parseGridSchedule(pages)
      const result = await populateElectiveSet(parsed, {
        electiveSetId: set.id, campId: set.camp_id, repo: activityRepo, existingActivities: activities, existingOfferings: offerings,
      })

      if (!result.ok) {
        setError(result.reason)
        return
      }
      // Refresh BOTH offerings (this set) and the activities catalog (shared
      // across every set) — reload() alone leaves existingActivities stale
      // for the next import, in this set on retry or in a different set
      // opened later in the same session, letting createActivity's dedup
      // miss activities this import just wrote and mint duplicates (Red Hat
      // HIGH). Mirrors EventGridEditor.jsx's runImport, which reloads
      // everything via one load() call — split here because offerings and
      // the activities catalog live in different state owners (this
      // component vs. the parent).
      await Promise.all([reload(), refreshActivities()])
      // T195 — tell the director which previously-imported offerings are not on
      // the sheet they just imported. Report-only: those rows are left exactly
      // as they were (never deleted or demoted on import). Keep the rows as-is
      // (including any with a null name — an offering whose activity was deleted
      // from the catalog, which is exactly the case this marker must not hide):
      // the render supplies a fallback label.
      const vanished = result.vanishedOfferings ?? []
      setVanishedNotice(vanished.length > 0 ? { setId: set.id, offerings: vanished } : null)
    } catch (err) {
      // A mid-import failure can leave partial writes (populateElectiveSet has
      // no rollback). Reload FIRST so the UI reflects what actually landed
      // instead of showing a stale empty list, which would let the director
      // retry and re-mint duplicate catalog activities for names that
      // already succeeded — mirrors EventGridEditor.jsx's runImport. Same
      // reasoning as the success path above: both offerings AND activities
      // must refresh, not just offerings.
      await Promise.all([reload(), refreshActivities()])
      setError(describeWriteFailure(err, 'Could not import that schedule.'))
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function saveCapacity(offeringId, value) {
    try {
      // Written as two fields; applyProjection applies ONE field per op, and
      // the DB CHECKs are per-column precisely so either arrival order is
      // legal on every device (see schema.sql's comment).
      await repository.writeFields('elective_set_activities', offeringId, {
        capacity_mode: value == null ? 'unlimited' : 'limited',
        capacity_limit: value,
      })
      await reload()
    } catch (err) {
      setError(describeWriteFailure(err, 'That capacity could not be saved.'))
      throw err
    }
  }

  // T265 — the minimum, written as the two-part (min_mode, min_to_run) pair for
  // the same reason the capacity is: applyProjection applies ONE field per op, and
  // the DB CHECKs are per-column precisely so either arrival order is legal on
  // every device.
  //
  // `refusal` is the 0 case, caught before any write: reported through the SAME
  // error surface as a failed write, because to a director "that did not save" is
  // one situation whatever the cause.
  async function saveMinimum(offeringId, value, refusal) {
    if (refusal) {
      setError(refusal)
      return
    }
    try {
      await repository.writeFields('elective_set_activities', offeringId, {
        min_mode: value == null ? 'none' : 'required',
        min_to_run: value,
      })
      await reload()
    } catch (err) {
      setError(describeWriteFailure(err, 'That minimum could not be saved.'))
      throw err
    }
  }

  // Closes the dead-end the refuse-on-nonempty import message ("...already
  // has offerings. Clear it first...") otherwise points at with no control
  // to act on (Tester MEDIUM). Deletes every elective_set_activities row for
  // this set via the same per-row delete path Remove already uses; the
  // elective_sets row itself is untouched. Mirrors EventGridEditor.jsx's
  // clearSchedule.
  async function clearOfferings() {
    setClearing(true)
    try {
      const ids = offerings.map((o) => o.id)
      // Fetched once, before the delete, so the clear-on-removal math below
      // subtracts removedIds from a consistent pre-delete snapshot rather
      // than re-listing after the write (read-after-write race).
      const allMemberships = await localClient.list('elective_set_activities')
      const { succeeded } = await repository.deleteAllRecords('elective_set_activities', ids)
      if (succeeded !== ids.length) throw new Error('clear-offerings-partial-failure')
      const distinctActivityIds = [...new Set(offerings.map((o) => o.activity_id))]
      for (const activityId of distinctActivityIds) {
        const currentStatus = activities.find((a) => a.id === activityId)?.recurrence_truth_status
        await clearElectivePermissionOnRemoval({
          repo: activityRepo, allMemberships, removedMembershipIds: ids, activityId, currentStatus,
        })
      }
      // T301 slice 2 — a bundle has no FK cascade (ADR D1): removing the
      // offering it belongs to must take its periods/tiers/bundle row with
      // it, or they orphan silently.
      const distinctActivityIdSet = new Set(distinctActivityIds)
      await deleteBundleRows(bundles.filter((b) => distinctActivityIdSet.has(b.activity_id)).map((b) => b.id))
      await Promise.all([reload(), reloadBundles()])
    } catch (err) {
      setError(describeWriteFailure(err, "Could not clear this set's offerings."))
    } finally {
      setClearing(false)
      setConfirmClear(false)
    }
  }

  async function confirmDeleteOffering() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      // Fetched before the delete for the same read-after-write reason as
      // clearOfferings above.
      const allMemberships = await localClient.list('elective_set_activities')
      const { succeeded } = await repository.deleteAllRecords('elective_set_activities', [pendingDelete.id])
      if (succeeded !== 1) throw new Error('delete failed')
      const currentStatus = activities.find((a) => a.id === pendingDelete.activity_id)?.recurrence_truth_status
      await clearElectivePermissionOnRemoval({
        repo: activityRepo,
        allMemberships,
        removedMembershipIds: [pendingDelete.id],
        activityId: pendingDelete.activity_id,
        currentStatus,
      })
      // T301 slice 2 — same orphan-cleanup obligation as clearOfferings above.
      await deleteBundleRows(bundles.filter((b) => b.activity_id === pendingDelete.activity_id).map((b) => b.id))
      await Promise.all([reload(), reloadBundles()])
    } catch (err) {
      setError(describeWriteFailure(err, 'That offering could not be removed.'))
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <button className="press-97" onClick={onBack} style={S.backBar}>← Back to Elective Sets</button>

      <div style={{ marginTop: 12, marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 20 }}>{set.name || '(untitled set)'}</div>
      </div>

      {error && <div style={S.errorBanner}>{error}</div>}

      {vanishedNotice && vanishedNotice.setId === set.id && (() => {
        // An offering whose activity was deleted from the catalog has no name;
        // label it rather than drop it, so a clean re-import that silently
        // orphaned it is still reported (Red Hat).
        const labels = vanishedNotice.offerings.map((v) => (v.name ? `“${v.name}”` : 'an offering whose activity is no longer in your catalog'))
        return (
          <div style={S.cautionBanner}>
            {labels.length === 1
              ? `${labels[0]} is in this set but not on the sheet you just imported. It was left as it is — nothing was removed.`
              : `${labels.length} offerings are in this set but not on the sheet you just imported — left as they are, nothing removed: ${labels.join(', ')}.`}
          </div>
        )
      })()}

      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xlsm,.xls,.txt"
        style={{ display: 'none' }}
        onChange={(e) => runImport(e.target.files?.[0])}
      />

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : offerings.length === 0 ? (
        <div style={emptyStyles.wrap}>
          <div style={emptyStyles.title}>No offerings yet</div>
          <button
            className="press-97"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            style={{ ...S.btnSecondary, marginTop: 10 }}
          >
            {importing ? 'Importing…' : IMPORT_LABELS.importAction}
          </button>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 14px 0' }}>
            <button className="press-97" onClick={() => setConfirmClear(true)} style={S.btnDanger}>Clear offerings</button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <th style={S.th}>Activity</th>
                <th style={S.th}>Location</th>
                <th style={S.th}>Who can go</th>
                <th style={S.th}>Capacity</th>
                <th style={S.th}>Minimum to run</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {offerings.map((offering) => (
                <OfferingRow
                  key={offering.id}
                  offering={offering}
                  activity={activities.find((a) => a.id === offering.activity_id)}
                  locations={locations}
                  tiers={tiers}
                  groups={groups}
                  role={role}
                  onSaveCapacity={saveCapacity}
                  onSaveMinimum={saveMinimum}
                  onDelete={setPendingDelete}
                  days={days}
                  timeBlocks={timeBlocks}
                  occurrenceCells={occurrenceCells}
                  bundles={bundles}
                  bundlePeriods={bundlePeriods}
                  bundleTiers={bundleTiers}
                  onToggleBundlePeriod={onToggleBundlePeriod}
                  onSetBundleScopeMode={onSetBundleScopeMode}
                  onToggleBundleTier={onToggleBundleTier}
                  onSaveBundleName={onSaveBundleName}
                  onDeleteBundle={setPendingDeleteBundle}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Offering</div>
        <ActivityPicker
          activities={availableActivities}
          catalogHasAny={activities.length > 0}
          disabled={adding}
          onSelect={addExistingOffering}
          onCreate={createAndAddOffering}
        />
      </div>

      {pendingDelete && (
        <ConfirmDangerDialog
          title={`Remove ${activities.find((a) => a.id === pendingDelete.activity_id)?.name ?? 'this offering'}?`}
          recovery="It stops being one of this set's choices. The activity itself is untouched."
          confirmLabel="Remove Offering"
          busy={deleting}
          onConfirm={confirmDeleteOffering}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {confirmClear && (
        <ConfirmDangerDialog
          title="Clear all offerings from this set?"
          recovery="This can't be undone."
          confirmLabel="Clear Offerings"
          busy={clearing}
          onConfirm={clearOfferings}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      {pendingDeleteBundle && (
        <ConfirmDangerDialog
          title={`Delete "${pendingDeleteBundle.name || 'this bundle'}"?`}
          recovery="Its periods and division scope go with it, and this can't be undone."
          confirmLabel="Delete Bundle"
          busy={deletingBundle}
          onConfirm={confirmDeleteBundle}
          onCancel={() => setPendingDeleteBundle(null)}
        />
      )}

      <AssignmentPanel
        electiveSetId={set.id}
        campId={set.camp_id}
        setActivities={offerings}
        activities={activities}
        groups={groups}
        tiers={tiers}
        campers={campers}
        days={days}
        timeBlocks={timeBlocks}
        templateSlots={templateSlots}
        scheduleTemplates={scheduleTemplates}
        scheduleWeeks={scheduleWeeks}
        role={role}
        onAddActivity={createAndAddOffering}
        onError={setError}
        onNavigate={onNavigate}
        bundles={bundles}
        bundlePeriods={bundlePeriods}
        bundleTiers={bundleTiers}
        catalogBundleNames={allBundleNames}
      />
    </div>
  )
}

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
}
