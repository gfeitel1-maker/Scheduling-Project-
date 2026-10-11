// One definition of the flag, shared by "What Shoresh has learned" and the import review cards
// (docs/work/specs/2026-10-11-what-shoresh-has-learned-view.md 0.2). A flag is a small inline
// marker on the row it describes, never a banner. The `color-mix` recipes are the ones
// S.cautionBanner / S.errorBanner use, scaled down to a pill.
const TONE = {
  neutral: { ink: 'var(--text-secondary)', fill: 'color-mix(in srgb, var(--text) 6%, var(--surface))', line: 'color-mix(in srgb, var(--text-secondary) 35%, var(--border))' },
  caution: { ink: 'color-mix(in srgb, var(--accent) 65%, var(--text))', fill: 'color-mix(in srgb, var(--accent) 10%, var(--surface))', line: 'color-mix(in srgb, var(--accent) 35%, var(--border))' },
  success: { ink: 'color-mix(in srgb, var(--success) 70%, var(--text))', fill: 'color-mix(in srgb, var(--success) 10%, var(--surface))', line: 'color-mix(in srgb, var(--success) 35%, var(--border))' },
  primary: { ink: 'var(--primary)', fill: 'color-mix(in srgb, var(--primary) 10%, var(--surface))', line: 'color-mix(in srgb, var(--primary) 35%, var(--border))' },
  danger: { ink: 'var(--danger)', fill: 'color-mix(in srgb, var(--danger) 10%, var(--surface))', line: 'color-mix(in srgb, var(--danger) 35%, var(--border))' },
}

export function flagStyle(tone = 'neutral') {
  const t = TONE[tone] ?? TONE.neutral
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 999,
    fontSize: 11, fontWeight: 600, lineHeight: '16px', fontFamily: 'var(--font-sans)',
    color: t.ink, background: t.fill, border: `1px solid ${t.line}`,
    animation: 'importHeldIn var(--motion-fast) var(--ease-out)',
  }
}

export const meta = { fontSize: 12, color: 'var(--text-secondary)' }
