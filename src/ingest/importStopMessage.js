// One spelling of the hard-stop sentence every setup-import door shows when an
// UNEXPECTED row failure stops the loop (board q-export-columns-do-not-round-trip,
// honest-atomicity-half). NEVER call this "atomic" — it is a hard-stop-and-report,
// not a rollback; the rows already written before the failure stay written.
export function formatImportStopMessage({ importedCount, totalCount, rowNumber, rowName, reason }) {
  return `Imported ${importedCount} of ${totalCount} rows; row ${rowNumber} ('${rowName}') failed: ${reason}. No further rows were written.`
}
