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
import { formatImportStopMessage } from '../ingest/importStopMessage.js'

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

  // Skips warned rows. Against rows seen so far (starting from current state,
  // growing as each row is added — so two duplicate rows in the SAME import
  // batch resolve against each other too), either `duplicateCheck` (legacy:
  // a true/false match always SKIPS, the original behavior) or `findExisting`
  // (board q-export-columns-do-not-round-trip, B3: returns the matched existing
  // row, or none) decides what a duplicate name means. With `findExisting`,
  // `buildChangedFields(existing, row)` returns the fields that differ (an
  // UPDATE, via writeFields) or a falsy value (UNCHANGED, no write) — the
  // same create/update/unchanged split every hand-rolled setup screen's
  // confirmImport now does, via src/ingest/resolveRowAction.js. Uses the
  // same create-with-cleanup path as add() for a genuinely new row.
  async function importRows(parsedRows, { mapRow, duplicateCheck, findExisting, buildChangedFields, rowLabel = (row) => row.name ?? row.label ?? '' }) {
    let added = 0
    let updated = 0
    let unchanged = 0
    let skipped = 0
    let stoppedAt = null
    const seenRows = [...rows]
    const totalCount = parsedRows.length
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
        try {
          await repository.writeFields(entity, existing.id, changedFields)
          updated++
          // Red Hat HIGH: refresh seenRows with the applied value, replacing (never
          // mutating — `existing` may be a shared React-state object) the stale entry,
          // so a LATER row sharing this key diffs against what was actually written.
          const index = seenRows.indexOf(existing)
          if (index !== -1) seenRows[index] = { ...existing, ...changedFields }
        } catch (err) {
          // Hard stop, not a rollback: an UNEXPECTED failure stops the loop immediately
          // (board q-export-columns-do-not-round-trip, honest-atomicity-half).
          stoppedAt = formatImportStopMessage({
            importedCount: added + updated, totalCount, rowNumber: index + 1,
            rowName: rowLabel(row), reason: err?.message || 'an unexpected error',
          })
          break
        }
        continue
      }
      if (!findExisting && duplicateCheck(seenRows, row)) {
        skipped++
        continue
      }
      try {
        const id = crypto.randomUUID()
        const fields = mapRow(row, added)
        await repository.createRecord(entity, id, fields)
        added++
        seenRows.push({ id, ...fields })
      } catch (err) {
        stoppedAt = formatImportStopMessage({
          importedCount: added + updated, totalCount, rowNumber: index + 1,
          rowName: rowLabel(row), reason: err?.message || 'an unexpected error',
        })
        break
      }
    }
    await load()
    return { added, updated, unchanged, skipped, stoppedAt }
  }

  return { rows, loading, error, setError, adding, add, save, deleteAll, importRows, reload: load }
}
