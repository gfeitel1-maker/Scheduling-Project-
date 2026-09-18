// T229 -- style constants local to the assignment panel, layered on top of
// src/styles/shared.js's S. No CSS modules (component styles are inline React
// objects, per DESIGN_STANDARD/CLAUDE.md).
export const A = {
  refusalCard: {
    background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
    border: '1px solid color-mix(in srgb, var(--danger) 35%, var(--border))',
    borderRadius: 6,
    padding: '16px 18px',
  },
  refusalTitle: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 15,
    color: 'var(--danger)',
    marginBottom: 8,
  },
  statValue: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 20,
    color: 'var(--text)',
  },
  busyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text-secondary)',
    fontSize: 13,
    fontFamily: 'monospace',
  },
}
