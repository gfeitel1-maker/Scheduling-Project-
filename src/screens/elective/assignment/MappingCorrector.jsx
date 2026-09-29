// T229 -- inline mapping corrector for a preference sheet's inferred column
// mapping. Not a modal; anchored above a sample-rows table of the file's REAL
// header text.
import { S } from '../../../styles/shared'
import { describeMappingReadiness } from '../../../ingest/preferenceSheet.js'

function columnLetter(index) {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function optionLabel(header, index) {
  const text = String(header[index] ?? '').slice(0, 20)
  return `Column ${columnLetter(index)}: "${text}"`
}

function FieldSelect({ id, label, value, header, onChange, flagged, required }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label htmlFor={id} style={S.label}>{label}{required ? ' *' : ''}</label>
      <select
        id={id}
        value={value == null ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        style={{ ...S.input, width: 'auto', ...(flagged ? { borderLeft: '3px solid var(--danger)', paddingLeft: 10 } : {}) }}
      >
        <option value="">Not mapped</option>
        {header.map((_, i) => (
          <option key={i} value={i}>{optionLabel(header, i)}</option>
        ))}
      </select>
    </div>
  )
}

export default function MappingCorrector({ header, sampleRows, mapping, onChange, onConfirm, onChooseDifferentFile }) {
  const rankColumns = mapping?.rankColumns ?? []

  function setRankIndex(rank, index) {
    const next = rankColumns.filter((r) => r.rank !== rank)
    if (index != null) next.push({ rank, index })
    else next.push({ rank, index: null })
    next.sort((a, b) => a.rank - b.rank)
    onChange({ ...mapping, rankColumns: next })
  }

  // M2 — a sheet with no '#1'-style headers (an ordinary camp export column
  // arrangement) inferred zero rank columns, no pickers rendered, and
  // "Confirm Mapping" could never enable: a total dead end. The director adds
  // one here, picks which sheet column it is, and can add more or remove one.
  function addRankColumn() {
    const nextRank = rankColumns.length > 0 ? Math.max(...rankColumns.map((r) => r.rank)) + 1 : 1
    // `unmapped` is NOT patched here. It is derived from the roles, and hand-editing
    // it was the corrector's own copy of the defect T307 fixes downstream: a field
    // that says ranks are mapped because a picker appeared, not because one is.
    onChange({ ...mapping, rankColumns: [...rankColumns, { rank: nextRank, index: null }] })
  }

  function removeRankColumn(rank) {
    onChange({ ...mapping, rankColumns: rankColumns.filter((r) => r.rank !== rank) })
  }

  // T307 — THE GATE IS THE TRANSFORM'S OWN, asked rather than restated
  // (`describeMappingReadiness`). This button used to carry its own copy of "what
  // counts as readable" — `nameIndex != null && rankColumns.length > 0` — and a copy
  // is what drifts: T305 found it refusing planner grids the transform could read,
  // and the same clause would refuse an INVERTED MATRIX, whose ranks live in its
  // cells and which therefore has no rank columns to count.
  const { unmapped: stillUnmapped, collision } = describeMappingReadiness(mapping)

  // An added rank with no column picked is not caught above — the reader drops it, so
  // the mapping stays readable — but it is a half-finished edit and confirming would
  // silently discard it. That is a question for the director, not the transform.
  const rankAwaitingColumn = rankColumns.some((r) => r.index == null)

  const canConfirm = stillUnmapped.length === 0 && !collision && !rankAwaitingColumn

  return (
    <div style={{ marginBottom: 16 }}>
      <FieldSelect
        id="mapping-name" label="Camper name" required
        value={mapping?.nameIndex} header={header}
        onChange={(i) => onChange({ ...mapping, nameIndex: i })}
        flagged={stillUnmapped.includes('name')}
      />
      <FieldSelect
        id="mapping-external-id" label="Camper ID"
        value={mapping?.externalIdIndex} header={header}
        onChange={(i) => onChange({ ...mapping, externalIdIndex: i })}
      />
      <FieldSelect
        id="mapping-division" label="Division"
        value={mapping?.divisionIndex} header={header}
        onChange={(i) => onChange({ ...mapping, divisionIndex: i })}
      />
      {stillUnmapped.includes('ranks') && (
        <div style={S.emptyStateBody}>
          No rank columns were found. Ranks look like #1, #2, #3 in your header — add one below.
        </div>
      )}
      {rankColumns.map((r) => (
        <div key={r.rank} style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <FieldSelect
              id={`mapping-rank-${r.rank}`} label={`Rank #${r.rank}`}
              value={r.index} header={header}
              onChange={(i) => setRankIndex(r.rank, i)}
            />
          </div>
          <button
            type="button" className="press-97"
            onClick={() => removeRankColumn(r.rank)}
            aria-label={`Remove rank #${r.rank}`}
            style={{ ...S.btnUtility, marginBottom: 10 }}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="press-97" onClick={addRankColumn} style={{ ...S.btnUtility, marginBottom: 12 }}>
        + Add Rank Column
      </button>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr>
            {header.map((h, i) => <th key={i} style={S.th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {sampleRows.map((row, i) => (
            <tr key={i}>
              {header.map((_, j) => <td key={j} style={S.td}>{row[j]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>

      {/* A DISABLED BUTTON MUST SAY WHY. M2's whole finding was a director facing a
          control that would not enable and no sentence telling them what to change. */}
      {collision && (
        <div role="alert" style={{ ...S.emptyStateBody, marginTop: 12, color: 'var(--danger)' }}>
          {`Column ${columnLetter(collision.index)} is set as ${collision.roles.join(' and ')}. ` +
            'Each column can only be one of them — change one before confirming.'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button
          className="press-97"
          onClick={onConfirm}
          disabled={!canConfirm}
          style={canConfirm ? S.btnPrimary : { ...S.btnPrimary, ...S.buttonDisabled }}
        >
          Confirm Mapping
        </button>
        {/* M2 — no phase of this flow may be a terminal state a director cannot leave. */}
        <button type="button" className="press-97" onClick={onChooseDifferentFile} style={S.btnUtility}>
          Choose a Different File
        </button>
      </div>
    </div>
  )
}
