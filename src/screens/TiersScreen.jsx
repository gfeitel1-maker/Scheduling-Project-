import { useState, useEffect, useRef, useMemo } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet, readEntitySheet } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import DuplicateNameDot from '../components/setup/DuplicateNameDot'
import { duplicateSiblingsByIdFor } from './duplicateSiblings.js'
import { S, useEnterTransition } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import ImportModal from '../components/setup/ImportModal'
import ImportPreviewSubtitle from '../components/setup/ImportPreviewSubtitle.jsx'
import SetupScreenShell from '../components/setup/SetupScreenShell'
import InlineAddRow from '../components/setup/InlineAddRow'
import { ENTITY_FIELD_CATALOGS, inferEntityMapping, applyEntityMapping, describeMappingIssue } from '../ingest/entityColumnMapping.js'
import { resolveRowAction } from '../ingest/resolveRowAction.js'
import { resolveRowCohort, describeCohortNote } from '../ingest/resolveRowCohort.js'
import { commitSetupImportBatch } from '../ingest/setupImportCommit.js'

const TIERS_CATALOG = ENTITY_FIELD_CATALOGS.tiers

// Tiers' load is cohort-scoped (camp_id AND cohort_id), fetches groups
// alongside tiers for groupCounts, and guards against a stale response
// overwriting the UI when the user switches cohorts mid-load — none of
// which fits useCrudScreen's single-entity/single-scopeFilter load model
// without growing its config surface (loadDeps, compound scope, a race
// guard) for this one consumer. Per the migration plan's own guidance, that
// stays screen-local; only the write/create/delete-all primitives — the
// actual duplicated code the ADR measured — are shared via
// setupCrudRepository. See docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md.
const repository = createSetupCrudRepository({ localClient })

// Edit-mode Save/Cancel (and Delete, where present) must sit on one line —
// never wrap/stack — at the screen's normal width.
const rowActionsFlex = { display: 'flex', flexWrap: 'nowrap', gap: 6, justifyContent: 'flex-end' }

function TierRow({ tier, groupCount, role, onSave, onDelete, duplicateSiblings }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tier.name)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(tier.id, { name: name.trim() })
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
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            style={S.input}
          />
        </td>
        <td style={S.td}>{groupCount}</td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <div style={rowActionsFlex}>
            <button className="press-97" onClick={save} disabled={saving} style={{ ...S.btnPrimary, whiteSpace: 'nowrap' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="press-97" onClick={() => { setName(tier.name); setEditing(false) }} style={{ ...S.btnSecondary, whiteSpace: 'nowrap' }}>
              Cancel
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
      onClick={() => setEditing(true)}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
      onFocus={e => e.currentTarget.style.background = 'var(--bg)'}
      onBlur={e => e.currentTarget.style.background = ''}
    >
      <td style={S.td}>
        <span
          role="button"
          tabIndex={0}
          aria-label={`Edit ${tier.name}`}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true) } }}
          style={{ cursor: 'pointer' }}
        >{tier.name}</span>
        {duplicateSiblings?.length > 0 && <DuplicateNameDot row={tier} siblings={duplicateSiblings} entityLabel="tier" />}
      </td>
      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{groupCount}</td>
      <td style={{ ...S.td, textAlign: 'right' }}>
        <button onClick={e => { e.stopPropagation(); onDelete(tier.id) }}
          style={groupCount > 0 || role !== 'admin' ? { ...S.btnRowDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnRowDanger, marginLeft: 6 }}
          disabled={groupCount > 0 || role !== 'admin'}
          title={groupCount > 0 ? 'Remove groups from this age division first' : role !== 'admin' ? 'Admin only' : ''}
        >Delete</button>
      </td>
    </tr>
  )
}

export default function TiersScreen({ campId, role, onNavigate }) {
  const emptyEnter = useEnterTransition('liftFade')
  const [tiers, setTiers] = useState([])
  const duplicateTierSiblings = useMemo(() => duplicateSiblingsByIdFor(tiers), [tiers])
  const [groupCounts, setGroupCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [importStep, setImportStep] = useState(null) // null | 'preview' | 'done'
  const [importRows, setImportRows] = useState([])
  const [importMapping, setImportMapping] = useState(null)
  const [importCohortNote, setImportCohortNote] = useState(null)
  // T315 — which tab these rows came from, when there was more than one to choose
  // between. Null on a single-sheet file: no choice, so nothing to report.
  const [importSheetNote, setImportSheetNote] = useState(null)
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null) // tier being confirmed for delete
  const [deleting, setDeleting] = useState(false)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const deleteInFlight = useRef(false)
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
      const [tierData, groupData] = await Promise.all([
        localClient.list('tiers'),
        localClient.list('groups'),
      ])
      // If a newer load() started (e.g. the user switched cohorts) while
      // this request was in flight, this response is stale — applying it
      // would overwrite the UI with the wrong cohort's age divisions
      // (last-resolver-wins race). Bail out without touching state.
      if (requestId !== loadRequestRef.current) return
      const list = (tierData || [])
        .filter(t => t.camp_id === campId && t.cohort_id === cohortIdAtStart)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? '')))
      setTiers(list)
      const counts = {}
      for (const g of (groupData || []).filter(g => g.camp_id === campId)) {
        counts[g.tier_id] = (counts[g.tier_id] || 0) + 1
      }
      setGroupCounts(counts)
    } catch {
      if (requestId !== loadRequestRef.current) return
      setError("Couldn't load your camp setup — check your connection and refresh.")
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }

  async function addTier(values) {
    const trimmedName = String(values.name ?? '').trim()
    if (!trimmedName || !activeCohort) return false
    // Case/whitespace-normalized existing-name check, matching
    // confirmImport's dedupe — without this, the plain "+ Add" button had
    // zero dedupe check while import did.
    if (tiers.some(t => String(t.name ?? '').trim().toLowerCase() === trimmedName.toLowerCase())) {
      setError('An age division with this name already exists — choose a different name.')
      return false
    }
    setAdding(true)
    try {
      const id = crypto.randomUUID()
      // No natural key to derive order from — append after the highest
      // existing sort_order. Directors add age divisions in the order they
      // want them displayed; there is no manual reorder surface.
      const sortVal = tiers.reduce((max, t) => Math.max(max, t.sort_order ?? 0), 0) + 1
      // `name` written FIRST — ensureExists creates the row as part of
      // applying whichever field write lands first, so a UNIQUE(camp_id,
      // cohort_id, name) collision on the `name` write fails atomically
      // before the row ever exists, rather than leaving a
      // camp_id/cohort_id-only orphan behind. createRecord does the
      // write-then-cleanup-on-failure dance.
      await repository.createRecord('tiers', id, {
        name: trimmedName,
        camp_id: campId,
        cohort_id: activeCohort.id,
        sort_order: sortVal,
      })
      await load()
      return true
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? 'An age division with this name already exists — choose a different name.'
          : describeWriteFailure(err, 'That age division could not be added.')
      )
      return false
    } finally {
      setAdding(false)
    }
  }

  async function saveTier(id, fields) {
    try {
      await repository.writeFields('tiers', id, fields)
      await load()
    } catch (err) {
      setError(describeWriteFailure(err, 'That age division could not be saved.'))
      throw err
    }
  }

  function deleteTier(id) {
    const tier = tiers.find(t => t.id === id)
    if (!tier) return
    setPendingDelete(tier)
  }

  async function confirmTierDelete() {
    if (!pendingDelete || deleteInFlight.current) return
    deleteInFlight.current = true
    setDeleting(true)
    try {
      const token = localStorage.getItem('shoresh-token')
      const result = await localClient.deleteEntity(token, 'tiers', pendingDelete.id)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
      setPendingDelete(null)
      await load()
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can delete age divisions.'
          : describeWriteFailure(err, 'That age division could not be deleted.')
      )
      setPendingDelete(null)
    } finally {
      setDeleting(false)
      deleteInFlight.current = false
    }
  }

  function deleteAll() {
    if (!activeCohort) {
      setError('No program selected — add a program before deleting age divisions.')
      return
    }
    setPendingDeleteAll(true)
  }

  async function confirmDeleteAll() {
    setDeletingAll(true)
    try {
      // Re-fetch immediately before building the id list rather than using the
      // closed-over `tiers` state — if another device synced in new age divisions
      // between page-load and this click, the stale in-memory snapshot would
      // silently skip them with no indication anything was missed.
      const freshTiers = await localClient.list('tiers')
      const ids = (freshTiers || [])
        .filter(t => t.camp_id === campId && t.cohort_id === activeCohort.id)
        .map(t => t.id)
      const { succeeded, failed, failedDueToRole } = await repository.deleteAllRecords('tiers', ids)
      await load()
      if (failed > 0) {
        setError(
          failedDueToRole
            ? 'Only an admin can delete age divisions — no age divisions were deleted.'
            : `Deleted ${succeeded} of ${ids.length} age divisions — please try again for the rest.`
        )
      }
    } catch (err) {
      setError(describeWriteFailure(err, 'Those age divisions could not be deleted.'))
    } finally {
      setDeletingAll(false)
      setPendingDeleteAll(false)
    }
  }

  function downloadTemplate() {
    const ws = aoaToSanitizedSheet([
      ['name', 'sort_order'],
      ['Yeladim', 1],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Age Divisions')
    XLSX.writeFile(wb, 'age_divisions_template.xlsx')
  }

  function onFileChange(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      try {
      // T315 — the tab that holds THIS entity, not blindly the first. This screen keys on
      // `name`, and the app's own export puts a `Programs` tab first, so before this a
      // director importing their own exported workbook got the camp's PROGRAM imported as a
      // row of this entity: a succeeding import with wrong data in it, not a refusal.
      const { sheet: importedSheet, rows, otherSheets } = readEntitySheet(ev.target.result, {
        type: 'array', byteLength: file.size, sheetName: 'Age Divisions', requiredColumns: ['name'],
      })
      const header = Object.keys(rows[0] ?? {})
      const mapping = inferEntityMapping(header, TIERS_CATALOG)
      const mappedRows = applyEntityMapping(rows, mapping, TIERS_CATALOG)
      setImportMapping(mapping)
      const parsed = mappedRows.map(r => {
        const name = String(r.name || '').trim()
        const sort_order = r.sort_order !== '' ? Number(r.sort_order) : null
        let warning = null
        if (!name) warning = 'Missing name'
        else if (sort_order !== null && !(Number.isInteger(sort_order) && sort_order >= 0)) warning = 'sort_order must be a whole number 0 or greater'
        return { name, sort_order, cohortName: r.cohort_name, warning }
      })
      setImportRows(parsed)
      // One disclosure line, not a per-row warning: the FIRST row with something to say
      // (a resolved mismatch OR an unmatched cohort name — Red Hat MEDIUM-HIGH, these are
      // two different problems with distinct wording via describeCohortNote) is enough to
      // tell the director (B3 cohort fix b) — the import proceeds either way, never blocked.
      const firstNote = parsed.map(r => describeCohortNote(resolveRowCohort(r.cohortName, cohorts, activeCohort), activeCohort)).find(Boolean)
      setImportCohortNote(firstNote ?? null)
      setImportSheetNote(otherSheets.length > 0 ? { sheet: importedSheet, others: otherSheets } : null)
      setImportStep('preview')
      } catch (err) {
        setError(describeWriteFailure(err, 'That import file could not be read.'))
      }
    }
    reader.readAsArrayBuffer(file)
    e.target.value = ''
  }

  async function confirmImport() {
    if (!activeCohort) return
    setImporting(true)
    try {
      // Defense-in-depth: a row with a null/undefined name should never
      // reach this point (import parsing and load() both normalize name
      // to a string), but a stray malformed row here must not throw and
      // wedge the modal on "Importing…" forever — coerce rather than crash.
      const existingByKey = new Map(tiers.map(t => [String(t.name ?? '').toLowerCase(), t]))
      // Code Reviewer HIGH+MEDIUM: only diff fields the sheet actually named — cohort_name's
      // column maps to cohort_id, sort_order to itself. A column absent (e.g. no cohort_name
      // on this sheet) must never overwrite the existing row with the active-cohort fallback.
      const ROLE_TO_DB_KEY = { cohort_name: 'cohort_id', sort_order: 'sort_order' }
      const providedKeys = new Set(Object.keys(importMapping?.roles ?? {}).map(k => ROLE_TO_DB_KEY[k] ?? k))
      let unchanged = 0, skipped = 0, createdSoFar = 0
      const totalCount = importRows.length
      // Resolve into a confirmed create/update set, then commit it atomically
      // (board q-atomic-import-primitive, part 2): all-or-none, a failure names the row.
      const batch = []
      for (const [index, row] of importRows.entries()) {
        if (!row.name || row.warning) { skipped++; continue }
        const sortVal = row.sort_order !== null ? row.sort_order : (tiers.length + createdSoFar + 1)
        const { cohortId } = resolveRowCohort(row.cohortName, cohorts, activeCohort)
        const candidateFields = { sort_order: sortVal, cohort_id: cohortId }
        const key = String(row.name).toLowerCase()
        const resolution = resolveRowAction(row.name, candidateFields, existingByKey, providedKeys)
        if (resolution.action === 'unchanged') { unchanged++; continue }
        if (resolution.action === 'update') {
          batch.push({ action: 'update', entity: 'tiers', entity_id: resolution.existing.id, fields: resolution.changedFields, name: row.name, __row: index + 1 })
          // Red Hat HIGH: refresh the baseline with the value this batch will write for a later same-key row.
          existingByKey.set(key, { ...resolution.existing, ...resolution.changedFields })
          continue
        }
        const id = crypto.randomUUID()
        // `name` first — collision-guarded field leads (primitive enforces it too).
        batch.push({ action: 'create', entity: 'tiers', entity_id: id, fields: {
          name: row.name,
          camp_id: campId,
          cohort_id: cohortId,
          sort_order: sortVal,
        }, name: row.name, __row: index + 1 })
        createdSoFar++
        existingByKey.set(key, { id, name: row.name, sort_order: sortVal, cohort_id: cohortId })
      }
      const { added, updated, stoppedAt } = await commitSetupImportBatch(repository, { batch, totalCount })
      setImportResult({ added, updated, unchanged, skipped, stoppedAt })
      setImportStep('done')
    } catch (err) {
      setError(describeWriteFailure(err, 'That import could not be completed.'))
      setImportStep(null); setImportRows([])
    } finally {
      setImporting(false); await load()
    }
  }

  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)

  return (
    <>
    <SetupScreenShell
      countLabel={`${tiers.length} age division${tiers.length !== 1 ? 's' : ''}`}
      role={role}
      actions={{ onDownloadTemplate: downloadTemplate, onImport: () => fileRef.current.click(), onDeleteAll: deleteAll, deleteAllDisabled: !activeCohort }}
      fileInputRef={fileRef}
      onFileChange={onFileChange}
      maxWidth={700}
      nextLabel="Next: Groups →"
      onNext={() => onNavigate('groups')}
      error={error}
      cohortPicker={<CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />}
    >
      {/* Table */}
      {showLoading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : !activeCohort ? (
        <div style={{ ...S.emptyState, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 16 }}>
          <div style={S.emptyStateTitle}>No programs yet</div>
          <div style={S.emptyStateBody}>Add a Program before adding Age Divisions.</div>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Groups</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tiers.length === 0 ? (
                <tr><td colSpan={3} style={S.emptyState}>
                  <div style={emptyEnter}>
                    <div style={S.emptyStateTitle}>No age divisions yet</div>
                    <div style={S.emptyStateBody}>Add your first age division below or import from Excel.</div>
                  </div>
                </td></tr>
              ) : tiers.map(tier => (
                <TierRow
                  key={tier.id}
                  tier={tier}
                  groupCount={groupCounts[tier.id] || 0}
                  role={role}
                  onSave={saveTier}
                  onDelete={deleteTier}
                  duplicateSiblings={duplicateTierSiblings.get(tier.id)}
                />
              ))}
              {/* The always-present blank "type here to add" row — lives as
                  the last row of the age divisions table (Excel-like inline
                  add). Aligns Name under Name; a blank trailing cell holds
                  the Groups column so "+ Add" sits under Actions. */}
              <InlineAddRow
                fields={[
                  { key: 'name', type: 'text', placeholder: 'Age division name (e.g. Yeladim)', required: true },
                ]}
                onAdd={addTier}
                adding={adding}
                disabled={!activeCohort}
                trailingCells={<td style={S.td} />}
              />
            </tbody>
          </table>
        </div>
      )}
      </SetupScreenShell>

      <ImportModal
        step={importStep}
        title={importStep === 'done' ? 'Import Complete' : 'Import Preview'}
        width={520}
        columns={[{ key: 'name', label: 'Name' }, { key: 'status', label: 'Status' }]}
        rows={importRows}
        readyCount={readyRows.length}
        warnCount={warnRows.length}
        previewSubtitle={<>
          <ImportPreviewSubtitle ready={readyRows.length} warn={warnRows.length} sheetNote={importSheetNote} mappingIssue={describeMappingIssue(importMapping)} />
          {importCohortNote && <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>{importCohortNote}</div>}
        </>}
        confirmDisabled={!!importMapping && (importMapping.unmapped.length > 0 || importMapping.collision.length > 0)}
        result={importResult}
        doneExtra={(importResult?.stoppedAt || importCohortNote) && (
          <div style={{ marginTop: 8 }}>
            {importCohortNote && <div style={{ color: 'var(--text-secondary)' }}>{importCohortNote}</div>}
            {importResult?.stoppedAt && <div style={S.importWarnText}>{importResult.stoppedAt}</div>}
          </div>
        )}
        importing={importing}
        onConfirm={confirmImport}
        onCancel={() => { setImportStep(null); setImportRows([]); setImportMapping(null); setImportCohortNote(null) }}
        confirmLabel={`Import ${readyRows.length} age division${readyRows.length !== 1 ? 's' : ''}`}
        doneSkippedSuffix=" (invalid)"
        renderCell={(r, c) => {
          if (c.key === 'name') return r.name || <span style={{ color: 'var(--accent)' }}>—</span>
        }}
      />

      {pendingDelete && (
        <ConfirmDangerDialog
          title={`Delete "${pendingDelete.name}"?`}
          body={
            groupCounts[pendingDelete.id]
              ? `This age division still has ${groupCounts[pendingDelete.id]} group${groupCounts[pendingDelete.id] === 1 ? '' : 's'} assigned to it. Removing it will leave ${groupCounts[pendingDelete.id] === 1 ? 'that group' : 'those groups'} without an age division.`
              : 'This age division has no groups, so nothing in your schedules is affected.'
          }
          recovery={`"${pendingDelete.name}" goes to Trash, and you can put it back from there.`}
          confirmLabel="Delete Age Division"
          busy={deleting}
          onConfirm={confirmTierDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingDeleteAll && (
        <ConfirmDangerDialog
          title="Delete all age divisions?"
          recovery="They can be restored from Trash."
          confirmLabel="Delete All Age Divisions"
          busy={deletingAll}
          onConfirm={confirmDeleteAll}
          onCancel={() => setPendingDeleteAll(false)}
        />
      )}
    </>
  )
}
