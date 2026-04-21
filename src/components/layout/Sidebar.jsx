const NAV = [
  { key: 'setup',      label: 'Camp Setup' },
  { key: 'tiers',      label: 'Tiers' },
  { key: 'groups',     label: 'Groups' },
  { key: 'timeblocks', label: 'Time Blocks' },
  { key: 'activities', label: 'Activities' },
  { key: 'anchors',    label: 'Anchors' },
  { key: 'schedule',   label: 'Schedule', divider: true },
]

export default function Sidebar({ current, onNavigate }) {
  return (
    <aside style={{
      width: 200, minWidth: 200, background: 'var(--surface)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', height: '100%',
    }}>
      <div style={{
        padding: '20px 20px 16px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 22,
          color: 'var(--primary)', letterSpacing: '-0.3px',
        }}>Shoresh</div>
        <div style={{
          fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
          marginTop: 2,
        }}>Camp Achva</div>
      </div>

      <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>
        {NAV.map(item => (
          <div key={item.key}>
            {item.divider && (
              <div style={{
                height: 1, background: 'var(--border)', margin: '8px 16px',
              }} />
            )}
            <button
              onClick={() => onNavigate(item.key)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 20px', border: 'none', background: 'none',
                fontSize: 13, fontWeight: current === item.key ? 600 : 400,
                color: current === item.key ? 'var(--primary)' : 'var(--text)',
                borderLeft: current === item.key
                  ? '3px solid var(--primary)'
                  : '3px solid transparent',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => {
                if (current !== item.key) e.currentTarget.style.background = 'var(--bg)'
              }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
            >
              {item.label}
            </button>
          </div>
        ))}
      </nav>

      <div style={{
        padding: '12px 20px', borderTop: '1px solid var(--border)',
        fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
      }}>
        v0.1.0
      </div>
    </aside>
  )
}
