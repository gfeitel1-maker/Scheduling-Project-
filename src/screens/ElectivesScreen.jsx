// The dedicated elective sub-schedule screen — Electives Slice 1
// (docs/adr/2026-08-22-nested-schedules-electives-and-events.md §2,
// docs/work/specs/2026-08-22-electives-nested-schedule-slices.md Slice 1).
//
// "The somewhere else that holds the data and is editable." A director
// builds an elective SET (a named period's worth of offerings) and, inside
// it, manages OFFERINGS — member activities, each carrying location/staff/
// eligibility (read from the activity, never duplicated) plus an editable
// capacity (capacity_mode/capacity_limit, v66 — camper_headcount, its v39
// predecessor, is retired from the write path). Reuses the shared setup-CRUD seam
// (setupCrudRepository/useCrudScreen, PR #53 pattern) exactly like every
// other setup screen.
//
// No campers roster, no solver (ADR §2) — this screen only holds and
// displays what the director decides.
import { useState, useMemo } from 'react'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { useCrudScreen } from '../hooks/useCrudScreen'
import { whitespaceInsensitiveName } from '../ingest/preview'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { S } from '../styles/shared'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import SetupScreenShell from '../components/setup/SetupScreenShell'
import InlineAddRow from '../components/setup/InlineAddRow'
import DuplicateNameDot from '../components/setup/DuplicateNameDot'
import { duplicateSiblingsByIdFor } from './duplicateSiblings.js'

const repository = createSetupCrudRepository({ localClient })
const setScopeFilter = (row, campId) => row.camp_id === campId

function ElectiveSetRow({ set, onBuild, onSave, onDelete, role, duplicateSiblings }) {
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
      <td style={{ ...S.td, fontWeight: 500 }}>
        {set.name || '(untitled set)'}
        {duplicateSiblings?.length > 0 && <DuplicateNameDot row={set} siblings={duplicateSiblings} entityLabel="elective set" />}
      </td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button className="press-97" onClick={() => onBuild(set)} style={S.btnSecondary} title="Build this set's offerings from Electives under Schedule">Open</button>
        <button className="press-97" onClick={() => setEditing(true)} style={{ ...S.btnSecondary, marginLeft: 6 }}>Rename</button>
        <button
          onClick={() => onDelete(set)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnRowDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnRowDanger, marginLeft: 6 }}
        >
          Delete
        </button>
      </td>
    </tr>
  )
}

export default function ElectivesScreen({ campId, role, onNavigate, weekId, weeks = [] }) {
  const { rows: sets, loading, error, setError, adding, add, save, reload } = useCrudScreen({
    entity: 'elective_sets',
    campId,
    localClient,
    repository,
    scopeFilter: setScopeFilter,
    // name FIRST — elective_sets is UNIQUE_FIRST_FIELD-registered (UNIQUE(camp_id,
    // name)); the unique field must write first so a collision is detectable and
    // no orphaned blank-name row can be materialized. See setupCrudRepository.
    buildCreateFields: ({ name }) => ({ name, camp_id: campId }),
    addFailedText: 'That elective set could not be added.',
    saveFailedText: 'That elective set could not be saved.',
  })
  const duplicateSetSiblings = useMemo(() => duplicateSiblingsByIdFor(sets), [sets])

  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmingPurge, setConfirmingPurge] = useState(false)
  const [purging, setPurging] = useState(false)
  const [purgeResult, setPurgeResult] = useState(null)
  const [scopeChoice, setScopeChoice] = useState(null)
  const currentWeek = weeks.find((w) => w.id === weekId)
  const scope = (scopeChoice ?? (currentWeek ? 'week' : 'season')) === 'week' && currentWeek ? 'week' : 'season'
  const scopeName = scope === 'week' ? currentWeek.name : 'the whole season'

  async function addSet(values) {
    const name = String(values.name ?? '').trim()
    if (!name) return false
    // Whitespace/case-insensitive so "Chugim"/"Chugim " don't split into two
    // elective sets (same regression as activities, secondary entity).
    if (sets.some((s) => whitespaceInsensitiveName(s.name) === whitespaceInsensitiveName(name))) {
      setError('An elective set with this name already exists — choose a different name.')
      return false
    }
    return await add({ name })
  }

  async function confirmDeleteSet() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const result = await localClient.deleteElectiveSet({ electiveSetId: pendingDelete.id })
      if (!result || result.error) throw new Error(result?.error ?? 'delete-failed')
      await reload()
    } catch (err) {
      setError(describeWriteFailure(err, 'That elective set could not be deleted.'))
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  async function confirmPurgeSeason() {
    setPurging(true)
    setPurgeResult(null)
    try {
      const result = await localClient.purgeElectiveSeason(scope === 'week' ? { scope, weekId } : { scope })
      if (!result?.ok) throw new Error(result?.error ?? 'purge-failed')
      setPurgeResult({ count: result.runsDeleted ?? 0, scopeName })
    } catch (err) {
      setError(describeWriteFailure(err, 'The elective choices could not be cleared.'))
    } finally {
      setPurging(false)
      setConfirmingPurge(false)
    }
  }

  return (
    <SetupScreenShell
      countLabel={`${sets.length} elective set${sets.length !== 1 ? 's' : ''}`}
      error={error}
    >

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
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
              {sets.length === 0 ? (
                <tr><td colSpan={2} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>No elective sets yet</div>
                  <div style={S.emptyStateBody}>Type a name below to add your first one.</div>
                </td></tr>
              ) : sets.map((set) => (
                <ElectiveSetRow
                  key={set.id}
                  set={set}
                  role={role}
                  onBuild={(s) => onNavigate?.('schedule:electives', { electiveSetId: s.id })}
                  onSave={save}
                  onDelete={setPendingDelete}
                  duplicateSiblings={duplicateSetSiblings.get(set.id)}
                />
              ))}
              {/* The always-present blank "type here to add" row — lives as
                  the last row of the elective sets table (Excel-like inline
                  add). */}
              <InlineAddRow
                fields={[
                  { key: 'name', type: 'text', placeholder: 'e.g. Afternoon Chugim', required: true },
                ]}
                onAdd={addSet}
                adding={adding}
              />
            </tbody>
          </table>
        </div>
      )}

      <div style={{ textAlign: 'right', marginBottom: 16 }}>
        <div role="radiogroup" aria-label="Clear scope" style={{ marginBottom: 8, fontSize: 13 }}>
          <label style={{ marginRight: 16, opacity: currentWeek ? 1 : 0.5 }}>
            <input
              type="radio" name="purge-scope" checked={scope === 'week'} disabled={!currentWeek}
              onChange={() => setScopeChoice('week')}
            />{' '}
            {`This week (${currentWeek ? currentWeek.name : 'no week selected'})`}
          </label>
          <label>
            <input type="radio" name="purge-scope" checked={scope === 'season'} onChange={() => setScopeChoice('season')} />{' '}
            The whole season
          </label>
        </div>
        <button
          onClick={() => setConfirmingPurge(true)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : `Clear every elective choice, assignment and run for ${scopeName}`}
          style={role !== 'admin' ? { ...S.btnRowDanger, ...S.buttonDisabled } : S.btnRowDanger}
        >
          {scope === 'week' ? 'Clear this week\u2019s elective choices' : 'Clear season\u2019s elective choices'}
        </button>
      </div>

      {purgeResult !== null && (
        <div role="status" style={{ ...S.emptyStateBody, textAlign: 'right', marginBottom: 16 }}>
          {purgeResult.count === 0
            ? `No elective runs to clear for ${purgeResult.scopeName} \u2014 nothing was changed.`
            : `Cleared ${purgeResult.count} elective ${purgeResult.count === 1 ? 'run' : 'runs'} for ${purgeResult.scopeName} and their choices and assignments.`}
        </div>
      )}

      {confirmingPurge && (
        <ConfirmDangerDialog
          title={scope === 'week' ? `Clear elective choices for ${scopeName}?` : 'Clear all elective choices for the season?'}
          body={`This permanently removes ${scope === 'week' ? `only the elective runs for ${scopeName}` : 'every elective run for the whole season'}, with all camper choices and assignments in them, from this device and from every device this camp syncs with. A device that is offline will catch up when it reconnects. If another device is actively editing a run at that exact moment, it can reappear there, unnamed — clearing again finishes the job. It does not erase them from this app’s own change history, and nothing here can reach a copy already exported or taken off this computer.`}
          recovery={`Kept: your elective sets and their offerings, campers, groups, tiers, activities, and schedules${scope === 'week' ? ', and the elective runs of other weeks' : ''}.`}
          confirmLabel={scope === 'week' ? 'Clear Week' : 'Clear Season'}
          busy={purging}
          onConfirm={confirmPurgeSeason}
          onCancel={() => setConfirmingPurge(false)}
        />
      )}

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
    </SetupScreenShell>
  )
}
