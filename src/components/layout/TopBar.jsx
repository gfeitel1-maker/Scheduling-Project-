const TITLES = {
  setup:      'Camp Setup',
  tiers:      'Tiers',
  groups:     'Groups',
  days:       'Days of Operation',
  timeblocks: 'Time Blocks',
  activities: 'Activities',
  anchors:    'Anchors',
  schedule:   'Schedule',
}

export default function TopBar({ screen }) {
  return (
    <header style={{
      height: 52, minHeight: 52, background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', padding: '0 24px',
    }}>
      <h1 style={{
        fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18,
        letterSpacing: '-0.2px', color: 'var(--text)',
      }}>
        {TITLES[screen] || 'Shoresh'}
      </h1>
    </header>
  )
}
