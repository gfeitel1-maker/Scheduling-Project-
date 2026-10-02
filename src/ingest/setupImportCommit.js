// The shared commit step every setup-import door now calls after it has resolved
// its preview rows into a confirmed, ordered create/update batch (board
// q-atomic-import-primitive, part 2 — the door-swap). It hands the batch to the
// atomic primitive (electron/ops/importSetupRows.js, via
// repository.importRows → the shoresh:import-setup-rows IPC) so the whole import
// is all-or-none: on any row's failure nothing is written and the director's
// setup is byte-identical to before; on success the primitive's own
// created/updated counts are returned.
//
// Each door still owns resolution — which rows are create vs update vs unchanged
// vs skipped, and what fields each carries (#701's create-or-update and
// only-fields-the-file-carried behaviour). This helper owns only the write +
// the failure wording, so all seven doors stay identical on the part that must
// not drift.
//
// Batch item shape: { action: 'create' | 'update', entity, entity_id, fields,
// name, __row }. `__row` is the row's 1-based position in the director's FILE
// (not its index in the batch, which skips unchanged/warned rows) so a failure
// names the row the director sees. It is stripped before the IPC.
import { formatImportStopMessage } from './importStopMessage.js'

export async function commitSetupImportBatch(repository, { batch, totalCount }) {
  // Nothing to write (every row was unchanged or skipped): no IPC, no failure,
  // and — crucially — no empty atomic frame.
  if (!batch || batch.length === 0) {
    return { added: 0, updated: 0, stoppedAt: null }
  }

  const result = await repository.importRows(batch)

  if (!result || result.ok === false) {
    // The primitive numbers the failed row by its position in the batch it
    // received, which is this same `batch` order — so batch[number - 1] is the
    // item that failed, and its __row is the file row to name.
    const failed = result?.failedRow
    const item = failed && Number.isInteger(failed.number) ? batch[failed.number - 1] : null
    return {
      added: 0,
      updated: 0,
      stoppedAt: formatImportStopMessage({
        totalCount,
        rowNumber: item?.__row ?? failed?.number ?? 0,
        rowName: failed?.name ?? item?.name ?? '',
        reason: result?.reason ?? 'an unexpected error',
      }),
    }
  }

  return { added: result.created, updated: result.updated, stoppedAt: null }
}
