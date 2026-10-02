// One spelling of the failure sentence every setup-import door shows when a row
// cannot be saved. Since the door-swap (board q-atomic-import-primitive, part 2)
// the import is ATOMIC: a single row's failure rolls the WHOLE import back
// through electron/ops/importSetupRows.js's one runAtomic frame, so nothing is
// written and the director's existing setup is byte-identical to before.
//
// _Prior: this was deliberately an honest HARD-STOP, not a rollback — "the rows
// already written before the failure stay written", worded "Imported N of M …
// No further rows were written." That is no longer true: the atomic primitive
// rolls everything back, so the copy now says nothing was imported._
export function formatImportStopMessage({ totalCount, rowNumber, rowName, reason }) {
  return `Nothing was imported — row ${rowNumber} of ${totalCount} ('${rowName}') couldn't be saved: ${reason}. Your existing setup was left exactly as it was.`
}
