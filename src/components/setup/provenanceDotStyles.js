// Styles for ProvenanceDot, in their own module so the component file exports
// only a component (react-refresh/only-export-components).
export const provenanceDotStyles = {
  dot: { display: 'inline-block', width: 6, height: 6, borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', verticalAlign: 'middle' },
  popover: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40, minWidth: 240, padding: 12,
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
  },
  rowDot: { display: 'inline-block', width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },
  tierLabel: { fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' },
  rowSentence: { fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.5 },
  rowActions: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 },
  confirmBtn: { background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit' },
}
