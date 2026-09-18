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
      <button className="press-97" onClick={onSolve} style={S.btnPrimary}>Solve Assignments</button>
    </div>
  )
}
