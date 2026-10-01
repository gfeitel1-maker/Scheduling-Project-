// The import preview's one-line summary, in ONE spelling for every per-entity setup
// importer (T315).
//
// It exists because the sentence gained a second clause. Before, each screen inlined
// `{ready} ready, {warn} with warnings (skipped)` — four copies of a short string, which
// is tolerable. Adding "read from tab X" to four copies is not: that clause is the visible
// half of a defect fix, and four spellings of it drift, which is the same argument
// `selectPreferenceSheet` settles one layer down.
//
// WHY THE TAB CLAUSE IS HERE AT ALL. The importers used to read `SheetNames[0]` blindly. A
// director whose table sat on a later tab imported nothing — and on the screens keyed on
// `name`, worse: the camp's `Programs` tab was read and its program imported as a group or
// an activity, a plausible row nobody created. Now the right tab is chosen, and a director
// looking at a preview of rows they did not expect can see WHICH tab produced them instead
// of guessing. Said only when the workbook had more than one tab, because on a single-sheet
// file there was no choice to report.
export default function ImportPreviewSubtitle({ ready = 0, warn = 0, sheetNote = null, mappingIssue = null }) {
  return (
    <>
      {mappingIssue && (
        <div style={{ color: 'var(--danger)', marginBottom: 4 }}>{mappingIssue}</div>
      )}
      {ready} ready{warn > 0 && `, ${warn} with warnings (skipped)`}
      {sheetNote && (
        <>
          {' · '}
          {/* The tab READ is named first, because it is what the rows in front of them came
              from; the others follow so the omission is stated rather than implied. */}
          read from {'“'}{sheetNote.sheet}{'”'}
          {sheetNote.others.length > 0 && (
            <> {'—'} not {sheetNote.others.map((s) => `“${s}”`).join(', ')}</>
          )}
        </>
      )}
    </>
  )
}
