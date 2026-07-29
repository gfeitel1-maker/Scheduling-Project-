import { S, prefersReducedMotion } from '../../styles/shared'
import { SEVERITY_BAR_COLOR } from './slotCellConstants'

// Popover anchored under the header badges — the single discoverable surface
// for reading several flag/finding reasons at once, replacing the native
// `title` hover as the primary path (a short `title` fallback stays on the
// UNFILLABLE cell icon for accessibility).
// docs/superpowers/specs/2026-07-28-schedule-grid-decolorization-design.md
// §"Reasons surface — Findings & Flags rail"
export default function FindingsRail({ rows, onDismiss, onLocate, onClose, intro, emptyText }) {
  const reduced = prefersReducedMotion()

  return (
    <div
      style={{
        ...S.findingsRailPanel,
        top: '100%',
        left: 0,
        marginTop: 6,
        animation: reduced
          ? 'none'
          : undefined,
        opacity: 1,
      }}
    >
      {intro && (
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{intro.title}</div>
          {intro.sub && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{intro.sub}</div>}
        </div>
      )}
      {rows.length === 0 ? (
        <div style={{ padding: '16px 14px', fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
          {emptyText || 'No issues found.'}
        </div>
      ) : (
        rows.map(row => (
          <div key={row.key} style={S.findingsRailRow(SEVERITY_BAR_COLOR[row.severity])}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', marginTop: 3, flexShrink: 0,
              background: row.severity === 'danger' ? SEVERITY_BAR_COLOR.danger : 'transparent',
              border: row.severity === 'danger' ? 'none' : `1.5px solid ${SEVERITY_BAR_COLOR[row.severity]}`,
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', cursor: onLocate ? 'pointer' : 'default' }}
                onClick={() => onLocate?.(row)}
              >
                {row.reason}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{row.locator}</div>
            </div>
            <button
              onClick={() => onDismiss(row)}
              title="Dismiss"
              style={{
                fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
                background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
                fontFamily: 'inherit', flexShrink: 0,
              }}
            >×</button>
          </div>
        ))
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 10px' }}>
        <button onClick={onClose} style={{ ...S.btnSecondary, padding: '4px 10px', fontSize: 11 }}>Close</button>
      </div>
    </div>
  )
}
