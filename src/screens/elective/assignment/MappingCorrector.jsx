// T229 -- inline mapping corrector for a preference sheet's inferred column
// mapping. Not a modal; anchored above a sample-rows table of the file's REAL
// header text.
import { S } from '../../../styles/shared'

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
  const unmapped = mapping?.unmapped ?? []
  const rankColumns = mapping?.rankColumns ?? []
  const noRanks = rankColumns.length === 0

  function setRankIndex(rank, index) {
    const next = rankColumns.filter((r) => r.rank !== rank)
    if (index != null) next.push({ rank, index })
    else next.push({ rank, index: null })
    next.sort((a, b) => a.rank - b.rank)
    onChange({ ...mapping, rankColumns: next, unmapped: unmapped.filter((u) => u !== 'ranks') })
  }

  // M2 — a sheet with no '#1'-style headers (an ordinary camp export column
  // arrangement) inferred zero rank columns, no pickers rendered, and
  // "Confirm Mapping" could never enable: a total dead end. The director adds
  // one here, picks which sheet column it is, and can add more or remove one.
  function addRankColumn() {
    const nextRank = rankColumns.length > 0 ? Math.max(...rankColumns.map((r) => r.rank)) + 1 : 1
    onChange({
      ...mapping,
      rankColumns: [...rankColumns, { rank: nextRank, index: null }],
      unmapped: unmapped.filter((u) => u !== 'ranks'),
    })
  }

  function removeRankColumn(rank) {
    onChange({ ...mapping, rankColumns: rankColumns.filter((r) => r.rank !== rank) })
  }

  const canConfirm =
    mapping?.nameIndex != null && rankColumns.length > 0 && rankColumns.every((r) => r.index != null)

  return (
    <div style={{ marginBottom: 16 }}>
      <FieldSelect
        id="mapping-name" label="Camper name" required
        value={mapping?.nameIndex} header={header}
        onChange={(i) => onChange({ ...mapping, nameIndex: i })}
        flagged={unmapped.includes('name')}
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
      {noRanks && (
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
