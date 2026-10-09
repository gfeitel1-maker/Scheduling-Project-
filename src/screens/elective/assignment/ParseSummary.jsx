// T229 -- clean parse summary, or the blocking refusal card, for a parsed
// preference sheet. Never both: a same-name collision or a contradictory-rank
// sheet means the Solve button is ABSENT, not disabled (design spec).
import { useEffect, useMemo, useRef, useState } from 'react'
import { S, useEnterTransition } from '../../../styles/shared'
import { foldTokens, residueIsDecision, residueRailColor } from '../../../ingest/residueKinds'
import { proposeActivityMatch, RESOLUTION } from '../../../ingest/labelResolutions'
import { A } from './assignmentStyles'

// REPORTED AT SOLVE TIME INSTEAD, and better there. `AssignmentPanel` re-reports
// unmatched divisions aggregated per division VALUE with a `suggestDivisionMatch`
// proposal ("did you mean …?"); the parse-time item is per camper and suggests
// nothing. Rendering both means the director meets the vague one first. The item is
// still produced and still in the residue ledger — only this panel skips it.
const SOLVE_TIME_KINDS = new Set(['UNMATCHED_DIVISION'])

// THE COUNT NAMES WHAT THERE IS TO DO, not how many cells produced it.
//
// It read "43 thing(s) this import could not resolve" over three statements — an
// instance count above a decision body, which told a director they had 43 problems
// when they had one thing to settle and two notes. That undoes the collapse it sits
// on top of. The instance counts still exist; they are the tokens inside each
// statement, where they describe a blast radius rather than a workload.
function residueSummaryLabel(decisionCount, ackCount, settledCount) {
  const parts = []
  if (decisionCount > 0) parts.push(`${decisionCount} thing${decisionCount === 1 ? '' : 's'} to decide`)
  if (ackCount > 0) parts.push(`${ackCount} thing${ackCount === 1 ? '' : 's'} noted`)
  // T298 — LAST, because it is the only one of the three that is already done, and
  // a count of finished work must not lead a summary whose job is to say what is
  // outstanding. It is here at all so that a disclosure holding nothing BUT settled
  // rows still has a summary; without it the last resolution on a sheet collapses
  // the label to an empty string.
  if (settledCount > 0) parts.push(`${settledCount} settled`)
  return parts.join(' \u00b7 ')
}

// THE ONE ACTION SLICE 1 IMPLEMENTS, and the reason it is the one: an unresolved
// label is the only residue kind where the director can settle the question and the
// settlement changes what gets imported. Adding the activity makes the camp have it,
// so the sheet's preferences for it become readable on the re-parse.
//
// "Ignore it for this import" is deliberately NOT a control: it is already what
// happens, so a button for it would be inert, and the standing rule forbids that.
//
// T298 ADDS THE TWO SLICE 1 LEFT OUT, for the reason slice 1 itself gave \u2014 they
// needed a picker and a proposal rule, and half of either rendered as a disabled
// affordance would have looked finished while doing nothing.
//
//   MAP TO AN EXISTING ACTIVITY, on every label-bearing decision row. Offered only
//   when the camp HAS activities to map to: with an empty catalog every option in
//   the picker would be inert, which is the one case where the standing rule means
//   the affordance is ABSENT rather than empty.
//
//   READ A PACKED CELL AS ITS PARTS, on `AMBIGUOUS_PACKED_CELL` only, where the
//   producer supplies the parts. All three readings of such a cell are now live,
//   which is what earned that kind its promotion to a decision.
//
// A PROPOSAL IS PRESELECTED, NEVER APPLIED. `proposeActivityMatch` may preselect an
// option and the row says in words why it did; nothing is written until the director
// presses the button beside it.
function ResidueRow({ group, onAddActivity, onMapToActivity, onSplitPacked, activityNames, resolutions, busyLabel }) {
  const { invariant, variable } = foldTokens(group.heads)
  const label = group.label ?? null
  const isDecision = residueIsDecision(group.kind) && Boolean(label)
  const settled = label != null ? resolutions[label] : null
  const busy = busyLabel != null && busyLabel === label

  const canAdd = Boolean(onAddActivity) && isDecision
  // The picker needs somewhere to map TO. Zero activities means every option is
  // inert, so the affordance is absent rather than empty.
  const canMap = Boolean(onMapToActivity) && isDecision && activityNames.length > 0
  const packedParts = group.kind === 'AMBIGUOUS_PACKED_CELL' ? (group.parts ?? []) : []
  const canSplit = Boolean(onSplitPacked) && isDecision && packedParts.length >= 2

  const proposal = useMemo(
    () => (canMap ? proposeActivityMatch(label, activityNames) : null),
    [canMap, label, activityNames]
  )
  const [picked, setPicked] = useState('')
  // The proposal is the picker\u2019s initial value; `picked` takes over the moment the
  // director touches the control. Derived rather than copied into state, so a
  // re-parse that changes the proposal is not shadowed by a stale stored value.
  const selected = picked || proposal?.name || ''

  return (
    <div style={S.findingsRailRow(residueRailColor(group.kind))}>
      <div style={{ flex: 1 }}>
        <div style={A.residueWhy}>{group.why}</div>
        {variable.length > 0 && (
          <div style={A.residueHeads}>
            {/* The invariant segment, factored out of every token and stated once. */}
            {invariant ? `${invariant} \u2014 ${variable.join(', ')}` : variable.join(' \u00b7 ')}
          </div>
        )}
        {!settled && (canSplit || canAdd) && (
          <div style={A.residueActions}>
            {canSplit && (
              <button
                type="button"
                className="press-97"
                disabled={busy}
                onClick={() => onSplitPacked(label, packedParts)}
                style={A.residueAction}
                data-testid="residue-split"
              >
                {busy ? 'Reading\u2026' : `Read as ${packedParts.length} separate choices`}
              </button>
            )}
            {canAdd && (
              <button
                type="button"
                className="press-97"
                disabled={busy}
                onClick={() => onAddActivity(label)}
                style={A.residueAction}
                data-testid="residue-add"
              >
                {busy ? `Adding \u201c${label}\u201d\u2026` : `Add \u201c${label}\u201d`}
              </button>
            )}
          </div>
        )}
        {!settled && canMap && (
          <div style={A.residuePicker}>
            <select
              value={selected}
              disabled={busy}
              onChange={(e) => setPicked(e.target.value)}
              style={A.residueSelect}
              aria-label={`Map \u201c${label}\u201d to activity`}
              data-testid="residue-map-select"
            >
              <option value="">{'Map to activity\u2026'}</option>
              {activityNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <button
              type="button"
              className="press-97"
              disabled={busy || !selected}
              onClick={() => onMapToActivity(label, selected)}
              style={A.residueAction}
              data-testid="residue-map"
            >
              Map
            </button>
            {proposal && selected === proposal.name && (
              <span style={A.residueProposal} data-testid="residue-proposal">
                {proposal.rule === 'connector'
                  ? 'Same name, punctuated differently'
                  : 'Same name, different word form'}
              </span>
            )}
          </div>
        )}
        {settled && <div style={A.residueResolved}>{settledText(settled)}</div>}
      </div>
    </div>
  )
}

// WHAT THE ROW SAYS ONCE IT IS SETTLED. Bare fact, and it names the thing that
// changed rather than congratulating anyone for changing it.
function settledText(settled) {
  if (settled.action === RESOLUTION.MAP_TO_EXISTING) return `Read as \u201c${settled.activityName}\u201d`
  if (settled.action === RESOLUTION.SPLIT_PACKED) return 'Read as separate choices'
  return 'Added as an activity'
}

function Stat({ value, label }) {
  return (
    <div>
      <div style={A.statValue}>{value}</div>
      <div style={S.sectionCount}>{label}</div>
    </div>
  )
}

export default function ParseSummary({
  parsed,
  contradictoryRanks = false,
  onSolve,
  onChooseDifferentFile,
  // THE THREE IMPLEMENTED RESOLUTIONS. Each is absent by default (the CLI's and
  // the tests' case), and an absent handler means the action is NOT RENDERED
  // rather than rendered dead — the standing rule, held at the prop boundary so a
  // caller that cannot perform an action cannot accidentally display it.
  onAddActivity,
  onMapToActivity,
  onSplitPacked,
  // The camp's activity names, which are both the picker's options and what the
  // proposal rule compares against. Empty means no mapping affordance at all.
  activityNames = [],
  // What this director has already settled on THIS parse, keyed by label:
  // `{ [label]: { action, activityName } }` from `resolutionMap`.
  resolutions = {},
  busyLabel = null,
}) {
  const enter = useEnterTransition('slideFade')
  const sameName = parsed?.sameNameCampers ?? []
  const refused = sameName.length > 0 || contradictoryRanks
  // T250 A5 — the aria-live announcement elsewhere already SAYS the sheet
  // cannot be assigned; this moves focus to where that message is written, so
  // a screen-reader director lands on it rather than merely hearing it once.
  const refusalRef = useRef(null)
  useEffect(() => {
    if (refused) refusalRef.current?.focus()
  }, [refused])

  if (refused) {
    return (
      <div ref={refusalRef} role="alert" tabIndex={-1} style={{ ...A.refusalCard, ...enter }}>
        <div style={A.refusalTitle}>This sheet can&apos;t be assigned yet</div>
        {sameName.length > 0 ? (
          <>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              {sameName.length} camper name(s) appear on more than one row with no camper id to tell them apart:
            </div>
            <ul style={{ margin: '0 0 10px', paddingLeft: 20, fontSize: 13 }}>
              {sameName.map((c) => (
                // The DIVISIONS are the disambiguation evidence — "those are two
                // different kids" (ADR 2026-09-27 §12.2a). The CLI's refusal already
                // names them; show them here too when the sheet carried a division
                // column, so the director can act without re-opening the file. Only
                // when present: a sheet with no division column leaves them null.
                <li key={c.display_name}>
                  {c.display_name} — rows {c.rowNumbers.join(', ')}
                  {(c.divisionLabels ?? []).some(Boolean)
                    ? ` (${c.divisionLabels.map((d) => d || '—').join(', ')})`
                    : ''}
                </li>
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
    // `label` rides on the group because the ACTION is about the label, not about
    // any one cell that named it — forty rows naming "Quidditch" are one activity
    // to add. It is only ever read for a decision kind, where the producer always
    // carries it, and `ResidueRow` requires it before offering anything.
    if (!groupsByKey.has(key)) {
      // `parts` rides the group for the same reason `label` does: the packed
      // reading is about the CELL VALUE, and every item sharing this group's `why`
      // shares the cell value that produced it, so the parts are a property of the
      // group rather than of any one row that named it.
      groupsByKey.set(key, { key, kind: item.kind, why, label: item.label ?? null, parts: item.parts ?? null, heads: [] })
    }
    if (item.head) groupsByKey.get(key).heads.push(item.head)
  }
  const residueGroups = [...groupsByKey.values()]
  const decisions = residueGroups.filter((g) => residueIsDecision(g.kind))
  const acknowledgments = residueGroups.filter((g) => !residueIsDecision(g.kind))

  // A SETTLED DECISION LEAVES THE RESIDUE LIST ENTIRELY, which is correct and, on
  // its own, silent: resolving re-parses, the label stops being residue, and the row
  // the director just acted on simply disappears. Only the counts move, and a
  // director watching the row they pressed is not watching the counts.
  //
  // So a settled resolution keeps its own row, stating what the file now reads as.
  // On the NEUTRAL hairline and outside the "to decide" count — it is a statement
  // about what was done, not a thing still to do.
  const stillResidue = new Set(residueGroups.map((g) => g.label).filter(Boolean))
  const settledRows = Object.entries(resolutions)
    .filter(([label]) => !stillResidue.has(label))
    .map(([label, settled]) => ({ label, settled }))

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
      {(residueGroups.length > 0 || settledRows.length > 0) && (
        <details style={A.disclosure}>
          <summary style={decisions.length > 0 ? A.residueSummaryDecide : A.residueSummary}>
            {residueSummaryLabel(decisions.length, acknowledgments.length, settledRows.length)}
          </summary>
          <div style={{ marginTop: 6 }}>
            {/* DECISIONS FIRST, unconditionally. The one row that asks something of
                the director must not sit below two that do not. */}
            {settledRows.map(({ label, settled }) => (
              <div key={`settled:${label}`} style={S.findingsRailRow('var(--border)')} data-testid="residue-settled">
                <div style={{ flex: 1 }}>
                  <div style={A.residueWhy}>{`\u201c${label}\u201d`}</div>
                  <div style={A.residueResolved}>{settledText(settled)}</div>
                </div>
              </div>
            ))}
            {[...decisions, ...acknowledgments].map((group) => (
              <ResidueRow
                key={group.key}
                group={group}
                onAddActivity={onAddActivity}
                onMapToActivity={onMapToActivity}
                onSplitPacked={onSplitPacked}
                activityNames={activityNames}
                resolutions={resolutions}
                busyLabel={busyLabel}
              />
            ))}
          </div>
        </details>
      )}
      <button className="press-97" onClick={onSolve} style={S.btnPrimary}>Solve Assignments</button>
    </div>
  )
}
