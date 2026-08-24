// The elective SET builder — offerings management, extracted from
// ElectivesScreen.jsx (docs/work/specs/2026-08-23-electives-gap.md Part b)
// so it can be reused verbatim from two entry points: Roots's
// ElectivesScreen (pre-extraction behavior, now reached via a link) and the
// new Schedule-side ScheduleElectivesScreen. Same file-organization
// convention as SpecialDayGridEditor/EventGridEditor's own subfolders.
import { useState, useRef } from 'react'
import * as XLSX from 'xlsx'
import { localClient } from '../../localClient'
import { createSetupCrudRepository } from '../../data/setupCrudRepository'
import { useCrudScreen } from '../../hooks/useCrudScreen'
import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { S, prefersReducedMotion } from '../../styles/shared'
import ConfirmDangerDialog from '../../components/ConfirmDangerDialog'
import ActivityPicker from '../../components/ActivityPicker'
import { parseTextGrid } from '../../ingest/textGrid'
import { workbookToPages } from '../../ingest/sheetGrid'
import { parseGridSchedule } from '../../ingest/parseGridSchedule'
import { populateElectiveSet } from '../../ingest/electiveSetPopulate'
import { createActivity } from '../schedule/createActivityHelper'
import { assertImportFileSize, assertWorkbookComplexity, unescapeRow } from '../../utils/exportSanitize.js'

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
  importAction: 'or import this set’s offerings from a file',
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

function OfferingRow({ offering, activity, locations, tiers, groups, onSaveCapacity, onDelete, role }) {
  const [capacityText, setCapacityText] = useState(
    offering.camper_headcount == null ? '' : String(offering.camper_headcount)
  )
  const [saving, setSaving] = useState(false)
  // Brief green flash confirming a successful capacity save — silent-save left
  // directors unsure it persisted (Slice 1 Tester). Single-shot, self-clears;
  // reuses the confirm-feedback pattern from the Roots-as-hub Slice E.
  const [savedFlash, setSavedFlash] = useState(false)
  const location = locations.find((l) => l.id === activity?.location_id)

  async function commitCapacity() {
    const trimmed = capacityText.trim()
    const value = trimmed === '' ? null : Math.max(0, parseInt(trimmed, 10) || 0)
    if (value === (offering.camper_headcount ?? null)) return
    setSaving(true)
    try {
      await onSaveCapacity(offering.id, value)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 700)
    } catch {
      // onSaveCapacity already surfaced the error via the screen's error banner.
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ ...S.td, fontWeight: 500 }}>{activity?.name ?? '(deleted activity)'}</td>
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
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button
          onClick={() => onDelete(offering)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
        >
          Remove
        </button>
      </td>
    </tr>
  )
}

export default function ElectiveSetDetail({ set, role, activities, locations, tiers, groups, refreshActivities, onBack }) {
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
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const fileInputRef = useRef(null)

  const offeredActivityIds = new Set(offerings.map((o) => o.activity_id))
  const availableActivities = activities.filter((a) => !offeredActivityIds.has(a.id))

  async function addExistingOffering(activityId) {
    await add({ activityId })
  }

  // Part (a) — mints a new activity through the SAME path
  // populateElectiveSet already uses for import-minted activities
  // (createActivityHelper.js's createActivity), so manual-create and
  // import-create activities are indistinguishable rows. Name only — no
  // location/eligibility at creation time, those are Activities-screen
  // concerns (spec's "what a newly-created activity gets").
  async function createAndAddOffering(name) {
    const { activityId } = await createActivity({ name, campId: set.camp_id, activities }, activityRepo)
    await add({ activityId })
    await refreshActivities()
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
    setImporting(true)
    try {
      let pages
      if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
        assertImportFileSize(file.size)
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
        assertWorkbookComplexity(wb)
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
      await repository.writeFields('elective_set_activities', offeringId, { camper_headcount: value })
      await reload()
    } catch (err) {
      setError(describeWriteFailure(err, 'That capacity could not be saved.'))
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
      const { succeeded } = await repository.deleteAllRecords('elective_set_activities', ids)
      if (succeeded !== ids.length) throw new Error('clear-offerings-partial-failure')
      await reload()
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
      const { succeeded } = await repository.deleteAllRecords('elective_set_activities', [pendingDelete.id])
      if (succeeded !== 1) throw new Error('delete failed')
      await reload()
    } catch (err) {
      setError(describeWriteFailure(err, 'That offering could not be removed.'))
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <button className="press-97" onClick={onBack} style={S.authLinkBtn}>← Back to Elective Sets</button>

      <div style={{ marginTop: 12, marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 20 }}>{set.name || '(untitled set)'}</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          Offerings a group sees when they're in this elective period — the "Electives" cell on the campwide schedule
          stays opaque; this is the detail behind it.
        </div>
      </div>

      {error && <div style={S.errorBanner}>{error}</div>}

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
          <div style={emptyStyles.body}>Add an activity below to make it one of this set's choices.</div>
          <button
            className="press-97"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            style={{ ...S.btnSecondary, fontStyle: 'italic', marginTop: 10 }}
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
                  onDelete={setPendingDelete}
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
  body: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    maxWidth: '56ch',
  },
}
