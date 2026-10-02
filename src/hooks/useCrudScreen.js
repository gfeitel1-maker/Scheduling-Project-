// The React orchestration layer for the five setup-CRUD screens. ADR
// 2026-08-12-setup-crud-shared-persistence-seam.md.
//
// Owns: load/loading/error state, the add/save/deleteAll/importRows
// orchestration every screen hand-wrote. Built on top of
// setupCrudRepository (the IO layer) and localClient.list (reads).
//
// Does NOT own: delete-confirmation UI (screen calls localClient.previewDelete
// / renders its own modal, then calls reload() itself), row-shape validation,
// XLSX parsing, or table rendering. Error copy strings are supplied by the
// screen so each entity keeps its own wording.
import { useState, useEffect } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { commitSetupImportBatch } from '../ingest/setupImportCommit.js'

export function useCrudScreen({
  entity,
  campId,
  localClient,
  repository,
  scopeFilter,
  buildCreateFields,
  addFailedText,
  saveFailedText,
  adminOnlyDeleteAllText,
  partialDeleteAllText,
  deleteAllFailedText = 'Those records could not be deleted.',
}) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await localClient.list(entity)
      setRows((data || []).filter((row) => scopeFilter(row, campId)))
    } catch {
      setError("Couldn't load your camp setup — check your connection and refresh.")
    }
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [entity, campId])

  // Mints an id, writes buildCreateFields(formState) in order (name-first is
  // the caller's field ordering, not baked in here), best-effort cleanup on
  // failure via repository.createRecord. Returns true on success so the
  // screen can clear its own form state; false leaves it in place.
  async function add(formState) {
    setAdding(true)
    try {
      const id = crypto.randomUUID()
      const fields = buildCreateFields(formState)
      await repository.createRecord(entity, id, fields)
      await load()
      return true
    } catch (err) {
      setError(describeWriteFailure(err, addFailedText))
      return false
    } finally {
      setAdding(false)
    }
  }

  // Rethrows on failure — callers (e.g. a row's inline edit) catch it to stay
  // in edit mode, matching today's saveGroup/saveTier/saveDay.
  async function save(id, fields) {
    try {
      await repository.writeFields(entity, id, fields)
      await load()
    } catch (err) {
      setError(describeWriteFailure(err, saveFailedText))
      throw err
    }
  }

  // Re-fetches fresh rows via localClient.list immediately before building
  // the id list — NOT the hook's own `rows` state — so a row another device
  // synced in between page-load and this call is not silently skipped.
  async function deleteAll() {
    try {
      const freshRows = await localClient.list(entity)
      const ids = (freshRows || []).filter((row) => scopeFilter(row, campId)).map((row) => row.id)
      const { succeeded, failed, failedDueToRole } = await repository.deleteAllRecords(entity, ids)
      await load()
      if (failed > 0) {
        setError(
          failedDueToRole
            ? adminOnlyDeleteAllText
            : partialDeleteAllText
              ? partialDeleteAllText(succeeded, ids.length, failed)
              : `Deleted ${succeeded} of ${ids.length} (${failed} failed — see console).`
        )
      }
      return { succeeded, failed, failedDueToRole }
    } catch (err) {
      setError(describeWriteFailure(err, deleteAllFailedText))
    }
  }

  // Resolves warned/duplicate/create/update exactly as before, then commits the
  // confirmed create/update set ATOMICALLY in one call via the shared
  // commitSetupImportBatch (board q-atomic-import-primitive, part 2 — the
  // door-swap): the whole import is all-or-none and a failure names the row,
  // replacing the old per-row writeFields/createRecord hard-stop loop.
  //
  // Resolution is unchanged (#701): skip `warning` rows; against rows seen so
  // far (starting from current state, growing as each row is queued — so two
  // duplicate rows in the SAME batch resolve against each other too), either
  // `duplicateCheck` (legacy true/false match always SKIPS) or `findExisting`
  // + `buildChangedFields` (board q-export-columns-do-not-round-trip, B3:
  // create-or-update, only the fields that differ). The writes themselves no
  // longer happen here — they are collected into `batch` and applied atomically.
  async function importRows(parsedRows, { mapRow, duplicateCheck, findExisting, buildChangedFields, rowLabel = (row) => row.name ?? row.label ?? '' }) {
    let unchanged = 0
    let skipped = 0
    let createdSoFar = 0
    const seenRows = [...rows]
    const batch = []
    for (const [index, row] of parsedRows.entries()) {
      if (row.warning) {
        skipped++
        continue
      }
      const existing = findExisting ? findExisting(seenRows, row) : null
      if (existing) {
        const changedFields = buildChangedFields(existing, row)
        if (!changedFields || Object.keys(changedFields).length === 0) {
          unchanged++
          continue
        }
        batch.push({ action: 'update', entity, entity_id: existing.id, fields: changedFields, name: rowLabel(row), __row: index + 1 })
        // Red Hat HIGH (carried forward): refresh seenRows with the value this
        // batch will apply, replacing (never mutating — `existing` may be a
        // shared React-state object) the stale entry, so a LATER row sharing this
        // key diffs against what the earlier row writes.
        const at = seenRows.indexOf(existing)
        if (at !== -1) seenRows[at] = { ...existing, ...changedFields }
        continue
      }
      if (!findExisting && duplicateCheck(seenRows, row)) {
        skipped++
        continue
      }
      const id = crypto.randomUUID()
      const fields = mapRow(row, createdSoFar)
      createdSoFar++
      batch.push({ action: 'create', entity, entity_id: id, fields, name: rowLabel(row), __row: index + 1 })
      seenRows.push({ id, ...fields })
    }
    const { added, updated, stoppedAt } = await commitSetupImportBatch(repository, { batch, totalCount: parsedRows.length })
    await load()
    return { added, updated, unchanged, skipped, stoppedAt }
  }

  return { rows, loading, error, setError, adding, add, save, deleteAll, importRows, reload: load }
}
