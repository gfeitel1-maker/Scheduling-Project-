const TITLES = {
  setup:        'Camp Setup',
  cohorts:      'Programs',
  tiers:        'Units',
  groups:       'Groups',
  days:         'Days of Operation',
  timeblocks:   'Time Blocks',
  activities:   'Activities',
  anchors:      'Anchors',
  dayoverrides: 'Day Overrides',
  schedule:     'Schedule',
}

export default function TopBar({ screen, onLogout }) {
  return (
    <header style={{
      height: 52, minHeight: 52, background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px',
    }}>
      <h1 style={{
        fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18,
        letterSpacing: '-0.2px', color: 'var(--text)',
      }}>
        {TITLES[screen] || 'Shoresh'}
      </h1>
      {onLogout && (
        <button onClick={onLogout} style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 6,
          padding: '5px 12px', fontSize: 12, color: 'var(--text-secondary)',
          cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
        }}>
          Log out
        </button>
      )}
    </header>
  )
}
