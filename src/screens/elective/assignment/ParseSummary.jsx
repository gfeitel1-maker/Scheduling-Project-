// T229 -- clean parse summary, or the blocking refusal card, for a parsed
// preference sheet. Never both: a same-name collision or a contradictory-rank
// sheet means the Solve button is ABSENT, not disabled (design spec).
import { S, useEnterTransition } from '../../../styles/shared'
import { A } from './assignmentStyles'

// WRONG, not merely unresolved: something the file states contradicts itself, or a
// camper's choices were split or dropped. Everything else is advisory — the import
// read what it could and is saying what it left. `--danger` is reserved for the
// first set so it keeps meaning something; the rest get `--accent`, the caution hue.
const WRONG_KINDS = new Set([
  'DROPPED_DUPLICATE_RANK',
  'RANK_KIND_DISAGREEMENT',
  'FORKED_IDENTITY',
  'NO_CAMPER_NAMES',
  'NO_READABLE_CHOICES',
])
const severityColor = (kind) => (WRONG_KINDS.has(kind) ? 'var(--danger)' : 'var(--accent)')

// REPORTED AT SOLVE TIME INSTEAD, and better there. `AssignmentPanel` re-reports
// unmatched divisions aggregated per division VALUE with a `suggestDivisionMatch`
// proposal ("did you mean …?"); the parse-time item is per camper and suggests
// nothing. Rendering both means the director meets the vague one first. The item is
// still produced and still in the residue ledger — only this panel skips it.
const SOLVE_TIME_KINDS = new Set(['UNMATCHED_DIVISION'])

function Stat({ value, label }) {
  return (
    <div>
      <div style={A.statValue}>{value}</div>
      <div style={S.sectionCount}>{label}</div>
    </div>
  )
}

export default function ParseSummary({ parsed, contradictoryRanks = false, onSolve, onChooseDifferentFile }) {
  const enter = useEnterTransition('slideFade')
  const sameName = parsed?.sameNameCampers ?? []
  const refused = sameName.length > 0 || contradictoryRanks

  if (refused) {
    return (
      <div style={{ ...A.refusalCard, ...enter }}>
        <div style={A.refusalTitle}>This sheet can&apos;t be assigned yet</div>
        {sameName.length > 0 ? (
          <>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              {sameName.length} camper name(s) appear on more than one row with no camper id to tell them apart:
            </div>
            <ul style={{ margin: '0 0 10px', paddingLeft: 20, fontSize: 13 }}>
              {sameName.map((c) => (
                <li key={c.display_name}>{c.display_name} — rows {c.rowNumbers.join(', ')}</li>
              ))}
            </ul>
            <div style={{ fontSize: 13, marginBottom: 12 }}>
              Fix the sheet — add a camper ID to tell them apart, or correct the duplicate — then import it again.
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            A camper holds the same preference rank more than once — the sheet can&apos;t be read unambiguously.
          </div>
        )}
        <button className="press-97" onClick={onChooseDifferentFile} style={S.btnSecondary}>
          Choose a Different File
        </button>
      </div>
    )
  }

  const campers = parsed?.campers?.length ?? 0
  const choices = parsed?.choices?.length ?? 0
  const preferences = parsed?.preferences?.length ?? 0
  const skippedRows = parsed?.skippedRows ?? []
  // THE LOUD HALF (ADR section 3.4), which had never been rendered anywhere in the
  // product. The whole design rests on the director being told what we could not
  // resolve; until this, they were told nothing — every residue item the ETL
  // produced was computed and then dropped on the floor by the UI.
  //
  // Deliberately in the SAME disclosure idiom as `skippedRows` above rather than a
  // banner: banners are the "SaaS nonsense" the standing rule rejects, and state
  // that needs surfacing belongs in the vocabulary a director already reads.
  //
  // Rendered as a SEVERITY-RAILED ROW WITH PARTS, like every other attention item in
  // the app — the solver's findings two steps later in this same workflow
  // (`AssignmentPreview`) and the attention surface (`RootsHomeScreen`). It was prose
  // in a bare div, which made one concept read two ways two clicks apart.
  //
  // A 100-camper sheet naming one missing activity is ONE finding, not a hundred, and
  // that now holds: the producer splits each item into a shared `why` and a
  // distinguishing `head` (`src/ingest/preferenceSheet.js`), so the group prints the
  // fact once and the hundred rows contribute a hundred tokens on one line.
  const residue = (parsed?.residue ?? []).filter((r) => !SOLVE_TIME_KINDS.has(r.kind))
  // Grouped on the SHARED FACT, not on the kind. Grouping by kind alone did not
  // collapse anything: the old items were each a complete self-contained sentence,
  // so forty rows naming one unknown activity produced forty near-identical
  // paragraphs and the grouping only demoted the duplicates to bullets. Two items
  // with the same `why` are literally the same finding, so the group states it once
  // and the items contribute only their distinguishing `head`.
  const groupsByKey = new Map()
  for (const item of residue) {
    // An item from a producer that has not been split yet carries only `message`.
    // It becomes a statement with no token rather than the same string printed
    // twice, so a partial conversion reads as terse, not as duplicated.
    const why = item.why ?? item.message
    const key = `${item.kind}::${why}`
    if (!groupsByKey.has(key)) groupsByKey.set(key, { key, kind: item.kind, why, heads: [] })
    if (item.head) groupsByKey.get(key).heads.push(item.head)
  }
  const residueGroups = [...groupsByKey.values()]

  return (
    <div style={enter}>
      <div style={{ display: 'flex', gap: 28, marginBottom: 14 }}>
        <Stat value={campers} label="Campers" />
        <Stat value={choices} label="Choices" />
        <Stat value={preferences} label="Preferences" />
      </div>
      {skippedRows.length > 0 && (
        <details style={A.disclosure}>
          <summary style={A.disclosureSummary}>{skippedRows.length} row(s) skipped</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {skippedRows.map((r, i) => (
              <li key={i}>Row {r.rowNumber} — {r.reason}</li>
            ))}
          </ul>
        </details>
      )}
      {residueGroups.length > 0 && (
        <details style={A.disclosure}>
          <summary style={A.residueSummary}>
            {residue.length} thing(s) this import could not resolve
          </summary>
          <div style={{ marginTop: 6 }}>
            {residueGroups.map((group) => (
              <div key={group.key} style={S.findingsRailRow(severityColor(group.kind))}>
                <div>
                  <div style={A.residueWhy}>{group.why}</div>
                  {group.heads.length > 0 && (
                    <div style={A.residueHeads}>{group.heads.join(' \u00b7 ')}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      <button className="press-97" onClick={onSolve} style={S.btnPrimary}>Solve Assignments</button>
    </div>
  )
}
