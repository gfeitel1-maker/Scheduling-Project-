// The Schedule-side picker shared by Special Schedules and Elective Schedules
// (design inventory 2026-10-08, D2 row 2): the two screens are the same kind of
// page, so they render through one frame — same width, headings, rows,
// empty state and crossfade — and only supply their own rows.
import { useEffect, useState } from 'react'
import { S } from '../../styles/shared'

// 150ms opacity-only crossfade, dropped to 0ms under prefers-reduced-motion.
function useCrossfade() {
  const reduced = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return {
    opacity: entered ? 1 : 0,
    transition: `opacity ${reduced ? '0ms' : '150ms'} var(--ease-out)`,
  }
}

export function Crossfade({ style, children }) {
  const crossfade = useCrossfade()
  return <div style={{ ...style, ...crossfade }}>{children}</div>
}

function Row({ name, sublabel, meta, onClick }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      className="press-97"
      style={styles.row}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface)')}
    >
      <div style={styles.name}>{name}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {sublabel && <div style={styles.sublabel}>{sublabel}</div>}
        <div style={styles.meta}>{meta}</div>
      </div>
    </div>
  )
}

// sections: [{ key, heading, rows: [{ key, name, sublabel?, meta, onClick }] }]
export default function SchedulePickerList({ sections, emptyAction, onEmptyAction, notice, error }) {
  const visible = sections.filter((s) => s.rows.length > 0)
  return (
    <Crossfade style={{ maxWidth: 760 }}>
      {notice && <div style={{ ...S.errorBanner, background: 'var(--surface)', marginBottom: 16 }}>{notice}</div>}
      {error && <div style={S.errorBanner}>{error}</div>}
      {visible.length === 0 ? (
        <div style={S.emptyState}>
          <div style={S.emptyStateTitle}>None yet</div>
          <button className="press-97" onClick={onEmptyAction} style={{ ...S.btnSecondary, marginTop: 10 }}>
            {emptyAction}
          </button>
        </div>
      ) : visible.map((section) => (
        <div key={section.key} style={{ marginBottom: 24 }}>
          <div style={styles.heading}>{section.heading}</div>
          <div style={styles.list}>
            {section.rows.map(({ key, ...row }) => <Row key={key} {...row} />)}
          </div>
        </div>
      ))}
    </Crossfade>
  )
}

const styles = {
  heading: {
    fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13,
    color: 'var(--text-secondary)', textTransform: 'uppercase',
    letterSpacing: '0.05em', marginBottom: 10,
  },
  list: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 12, overflow: 'hidden',
  },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px', borderBottom: '1px solid var(--border)',
    cursor: 'pointer', background: 'var(--surface)',
  },
  name: { fontSize: 14, fontWeight: 500 },
  sublabel: { fontSize: 12, color: 'var(--text-secondary)' },
  meta: { fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' },
}
