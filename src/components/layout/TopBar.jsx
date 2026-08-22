import { CHILD_SCREEN, DOMAIN_SCREEN } from '../reconciliation/rootMapNav'

// Must match the sidebar's labels exactly (src/components/layout/navSections.js).
// A screen missing here falls back to "Shoresh", which tells the director
// nothing about where they are — `camp`, `devices` and both schedule routes
// were all doing that.
const TITLES = {
  import:       'Import last year',
  cohorts:      'Programs',
  tiers:        'Age Divisions',
  groups:       'Groups',
  days:         'Days',
  timeblocks:   'Time Blocks',
  activities:   'Activities',
  anchors:      'Fixed Events',
  electives:    'Electives',
  schedule:              'Schedule',
  'schedule:generated':  'Generated Schedule',
  'schedule:manual':     'Manual Build',
  camp:         'Camp',
  conflicts:    'Conflicts',
  trash:        'Trash',
  devices:      'LAN & Devices',
}

// The setup/editable screens Roots deep-links into (rootMapNav's
// CHILD_SCREEN + DOMAIN_SCREEN target values). Reused, not duplicated, so
// the "← Roots" return loop can't drift from the forward "Manage {Area} →"
// navigation it pairs with. Schedule routes are excluded — they're their
// own destination, not a setup-detail you return from.
const SETUP_SCREENS = new Set(
  [...Object.values(CHILD_SCREEN), ...Object.values(DOMAIN_SCREEN)]
    .filter((screen) => screen && !screen.startsWith('schedule'))
)

export default function TopBar({ screen, onNavigate, onLogout }) {
  const showRootsLink = screen !== 'roots' && SETUP_SCREENS.has(screen)

  return (
    <header style={{
      height: 52, minHeight: 52, background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {showRootsLink && (
          <button onClick={() => onNavigate('roots')} style={{
            background: 'none', border: 'none', padding: 0,
            fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer',
            fontFamily: 'inherit', fontWeight: 500,
          }}>
            ← Roots
          </button>
        )}
        <h1 style={{
          fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18,
          letterSpacing: '-0.2px', color: 'var(--text)',
        }}>
          {TITLES[screen] || 'Shoresh'}
        </h1>
      </div>
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
