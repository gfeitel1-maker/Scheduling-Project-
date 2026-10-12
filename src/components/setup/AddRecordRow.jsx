import { S } from '../../styles/shared'

// The add control for a setup table whose records need a form (Activities, Fixed and Recurring
// Events): the table's last row, where InlineAddRow sits on the screens whose records are simple, with
// the same row styling and the same "+ Add" button. So every setup screen adds from the same place
// (consistency audit 2026-10-12, C3). The label never wraps.
export default function AddRecordRow({ label, onClick, colSpan, disabled = false }) {
  return (
    <tr style={{ borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
      <td colSpan={colSpan} style={S.td}>
        <button
          type="button"
          className="press-97"
          onClick={onClick}
          disabled={disabled}
          style={{ ...S.btnSecondary, whiteSpace: 'nowrap', ...(disabled ? S.buttonDisabled : {}) }}
        >+ {label}</button>
      </td>
    </tr>
  )
}
