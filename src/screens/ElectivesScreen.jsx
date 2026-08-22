// The dedicated elective sub-schedule screen — Electives Slice 1
// (docs/adr/2026-08-22-nested-schedules-electives-and-events.md §2,
// docs/work/specs/2026-08-22-electives-nested-schedule-slices.md Slice 1).
//
// "The somewhere else that holds the data and is editable." A director
// builds an elective SET (a named period's worth of offerings) and, inside
// it, manages OFFERINGS — member activities, each carrying location/staff/
// eligibility (read from the activity, never duplicated) plus an editable
// capacity (camper_headcount, v39). Reuses the shared setup-CRUD seam
// (setupCrudRepository/useCrudScreen, PR #53 pattern) exactly like every
// other setup screen.
//
// No campers roster, no solver (ADR §2) — this screen only holds and
// displays what the director decides.
import { useState, useRef, useEffect } from 'react'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { S, useEnterTransition, prefersReducedMotion } from '../styles/shared'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'

const repository = createSetupCrudRepository({ localClient })
const setScopeFilter = (row, campId) => row.camp_id === campId
const offeringScopeFilter = (row, electiveSetId) => row.elective_set_id === electiveSetId

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

function ElectiveSetDetail({ set, role, activities, locations, tiers, groups, onBack }) {
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

  const [pickerActivityId, setPickerActivityId] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const offeredActivityIds = new Set(offerings.map((o) => o.activity_id))
  const availableActivities = activities.filter((a) => !offeredActivityIds.has(a.id))

  async function addOffering() {
    if (!pickerActivityId) return
    const succeeded = await add({ activityId: pickerActivityId })
    if (succeeded) setPickerActivityId('')
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

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : offerings.length === 0 ? (
        <div style={emptyStyles.wrap}>
          <div style={emptyStyles.title}>No offerings yet</div>
          <div style={emptyStyles.body}>Add an activity below to make it one of this set's choices.</div>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={pickerActivityId}
            onChange={(e) => setPickerActivityId(e.target.value)}
            style={{ ...S.input, minWidth: 220 }}
            aria-label="Choose an activity to add"
          >
            <option value="">
              {availableActivities.length === 0 ? 'No more activities to add' : 'Choose an activity…'}
            </option>
            {availableActivities.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button
            className="press-97"
            onClick={addOffering}
            disabled={adding || !pickerActivityId}
            style={S.btnPrimary}
          >
            {adding ? 'Adding…' : '+ Add'}
          </button>
        </div>
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
    </div>
  )
}

function ElectiveSetRow({ set, onOpen, onSave, onDelete, role }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(set.name)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(set.id, { name: name.trim() })
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
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            style={S.input}
          />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <button className="press-97" onClick={save} disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="press-97" onClick={() => { setName(set.name); setEditing(false) }} style={{ ...S.btnSecondary, marginLeft: 6 }}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ ...S.td, fontWeight: 500, cursor: 'pointer' }} onClick={() => onOpen(set)}>
        {set.name || '(untitled set)'}
      </td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button className="press-97" onClick={() => onOpen(set)} style={S.btnSecondary}>Manage Offerings</button>
        <button className="press-97" onClick={() => setEditing(true)} style={{ ...S.btnSecondary, marginLeft: 6 }}>Rename</button>
        <button
          onClick={() => onDelete(set)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
        >
          Delete
        </button>
      </td>
    </tr>
  )
}

export default function ElectivesScreen({ campId, role }) {
  const { rows: sets, loading, error, setError, adding, add, save, reload } = useCrudScreen({
    entity: 'elective_sets',
    campId,
    localClient,
    repository,
    scopeFilter: setScopeFilter,
    buildCreateFields: ({ name }) => ({ camp_id: campId, name }),
    addFailedText: 'That elective set could not be added.',
    saveFailedText: 'That elective set could not be saved.',
  })

  const [newName, setNewName] = useState('')
  const [selectedSetId, setSelectedSetId] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [supportData, setSupportData] = useState({ activities: [], locations: [], tiers: [], groups: [] })
  const nameRef = useRef()
  const enter = useEnterTransition('liftFade')

  async function loadSupportData() {
    const [activities, locations, tiers, groups] = await Promise.all([
      localClient.list('activities'),
      localClient.list('locations'),
      localClient.list('tiers'),
      localClient.list('groups'),
    ])
    setSupportData({
      activities: (activities || []).filter((a) => a.camp_id === campId),
      locations: (locations || []).filter((l) => l.camp_id === campId),
      tiers: (tiers || []).filter((t) => t.camp_id === campId),
      groups: (groups || []).filter((g) => g.camp_id === campId),
    })
  }

  // The IIFE wrapper (rather than calling loadSupportData() directly) is
  // required by this repo's react-hooks/set-state-in-effect lint rule — same
  // reason as LocationsScreen.jsx's refreshReviewData mount effect.
  useEffect(() => {
    ;(async () => { await loadSupportData() })()
  }, [campId])

  async function addSet() {
    if (!newName.trim()) return
    const succeeded = await add({ name: newName.trim() })
    if (succeeded) setNewName('')
  }

  async function confirmDeleteSet() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const result = await localClient.deleteElectiveSet({ electiveSetId: pendingDelete.id })
      if (!result || result.error) throw new Error(result?.error ?? 'delete-failed')
      if (selectedSetId === pendingDelete.id) setSelectedSetId(null)
      await reload()
    } catch (err) {
      setError(describeWriteFailure(err, 'That elective set could not be deleted.'))
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  const selectedSet = sets.find((s) => s.id === selectedSetId)

  if (selectedSet) {
    return (
      <ElectiveSetDetail
        set={selectedSet}
        role={role}
        activities={supportData.activities}
        locations={supportData.locations}
        tiers={supportData.tiers}
        groups={supportData.groups}
        onBack={() => setSelectedSetId(null)}
      />
    )
  }

  return (
    <div style={{ maxWidth: 720 }}>
      {error && <div style={S.errorBanner}>{error}</div>}

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : sets.length === 0 ? (
        <div style={{ ...emptyStyles.wrap, ...enter }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M8 10h8M8 14h5" />
          </svg>
          <div style={emptyStyles.title}>No elective sets yet</div>
          <div style={emptyStyles.body}>
            An elective set is a named period's worth of choices — like "Afternoon Chugim". Add one below, then pick
            which activities are offered.
          </div>
          <button className="press-97" onClick={() => nameRef.current?.focus()} style={{ ...S.btnPrimary, marginTop: 14 }}>
            Add your first elective set
          </button>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <th style={S.th}>Name</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sets.map((set) => (
                <ElectiveSetRow
                  key={set.id}
                  set={set}
                  role={role}
                  onOpen={(s) => setSelectedSetId(s.id)}
                  onSave={save}
                  onDelete={setPendingDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Elective Set</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <label style={fieldLabel}>Name</label>
            <input
              ref={nameRef}
              placeholder="e.g. Afternoon Chugim"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addSet()}
              style={S.input}
            />
          </div>
          <button className="press-97" onClick={addSet} disabled={adding || !newName.trim()} style={{ ...S.btnPrimary, flexShrink: 0 }}>
            {adding ? 'Adding…' : '+ Add'}
          </button>
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDangerDialog
          title={`Delete "${pendingDelete.name || 'this elective set'}"?`}
          recovery="Its offerings go with it. Any schedule cell pointing at it falls back to showing nothing scheduled — the same handling as any deleted reference."
          confirmLabel="Delete Elective Set"
          busy={deleting}
          onConfirm={confirmDeleteSet}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
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

// Calm, no-card empty block — DESIGN_STANDARD §5a, same treatment
// LocationsScreen.jsx uses for its own optional-entity empty state.
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
