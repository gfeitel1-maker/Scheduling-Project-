// T229 -- clean parse summary, or the blocking refusal card, for a parsed
// preference sheet. Never both: a same-name collision or a contradictory-rank
// sheet means the Solve button is ABSENT, not disabled (design spec).
import { S, useEnterTransition } from '../../../styles/shared'
import { A } from './assignmentStyles'

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
  // that needs surfacing belongs in the vocabulary a director already reads. Grouped
  // by kind because one unresolved label per row would otherwise bury the one
  // sentence that matters — a 100-camper sheet naming one missing activity is ONE
  // finding, not a hundred.
  const residue = parsed?.residue ?? []
  const residueByKind = []
  for (const item of residue) {
    const existing = residueByKind.find((g) => g.kind === item.kind)
    if (existing) existing.items.push(item)
    else residueByKind.push({ kind: item.kind, items: [item] })
  }

  return (
    <div style={enter}>
      <div style={{ display: 'flex', gap: 28, marginBottom: 14 }}>
        <Stat value={campers} label="Campers" />
        <Stat value={choices} label="Choices" />
        <Stat value={preferences} label="Preferences" />
      </div>
      {skippedRows.length > 0 && (
        <details style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 12 }}>
          <summary>{skippedRows.length} row(s) skipped</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {skippedRows.map((r, i) => (
              <li key={i}>Row {r.rowNumber} — {r.reason}</li>
            ))}
          </ul>
        </details>
      )}
      {residueByKind.length > 0 && (
        <details style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 12 }}>
          <summary>
            {residue.length} thing(s) this import could not resolve
          </summary>
          <div style={{ marginTop: 6 }}>
            {residueByKind.map((group) => (
              <div key={group.kind} style={{ marginBottom: 8 }}>
                {/* The first item's sentence carries the explanation; the rest are
                    listed as the specific cases it covers, so the reader gets one
                    statement plus its instances rather than the same paragraph N
                    times. */}
                <div style={{ marginBottom: 2 }}>{group.items[0].message}</div>
                {group.items.length > 1 && (
                  <ul style={{ margin: '2px 0 0', paddingLeft: 20 }}>
                    {group.items.slice(1).map((item, i) => (
                      <li key={i}>{item.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      <button className="press-97" onClick={onSolve} style={S.btnPrimary}>Solve Assignments</button>
    </div>
  )
}
