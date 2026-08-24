// Day Map (B1) — one cluster marker per located location, showing the groups
// present there. docs/adr/2026-08-24-run-the-day-on-the-map.md Decision 3/4.
//
// Presentational only (props in, no writes) — B3 makes this a drag target
// later without a rewrite (ADR Decision 6). Reuses LocationMarker's
// fraction->pixel geometry math (percentage-of-container inline positioning,
// src/screens/LocationsScreen.jsx:336-340) and the `.map-location` class from
// locationMap.css for the backdrop/box chrome; the jam ring/badge colors are
// computed per-cluster so they stay inline (ADR D9 / CLAUDE.md boundary).
import { useEnterTransition } from '../../styles/shared'

const VISIBLE_CHIPS = 3

export default function GroupMarker({ location, geometry, groups, capacity, isJam, groupNameById, onExpand, expanded }) {
  const enter = useEnterTransition('liftFade')
  const visible = groups.slice(0, VISIBLE_CHIPS)
  const overflow = groups.length - visible.length

  return (
    <div
      className="map-location"
      style={{
        left: `${geometry.x * 100}%`,
        top: `${geometry.y * 100}%`,
        width: `${geometry.w * 100}%`,
        height: `${geometry.h * 100}%`,
        border: isJam ? '1px solid var(--danger)' : '1px solid var(--border)',
        background: isJam
          ? 'color-mix(in srgb, var(--danger) 8%, var(--surface))'
          : 'color-mix(in srgb, var(--primary) 6%, var(--surface))',
        cursor: 'pointer',
        ...enter,
      }}
      role="button"
      tabIndex={0}
      aria-label={`${location.name}: ${groups.length} of ${capacity}${isJam ? ', over capacity' : ''}`}
      onClick={() => onExpand?.(location.id)}
    >
      <div style={markerStyles.chipRow}>
        <span style={markerStyles.locationName}>{location.name}</span>
        {isJam && (
          <span style={markerStyles.jamBadge}>{groups.length}/{capacity}</span>
        )}
      </div>
      {(expanded ? groups : visible).map((g, i) => (
        <span key={g.groupId ?? `i${i}`} style={markerStyles.groupChip}>{groupNameById?.(g.groupId) ?? g.groupId}</span>
      ))}
      {!expanded && overflow > 0 && (
        <span style={markerStyles.overflowChip}>+{overflow}</span>
      )}
    </div>
  )
}

const markerStyles = {
  chipRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    position: 'absolute',
    top: -1,
    left: -1,
  },
  locationName: {
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--text)',
    background: 'color-mix(in srgb, var(--surface-elevated) 90%, transparent)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    padding: '2px 6px',
    whiteSpace: 'nowrap',
  },
  jamBadge: {
    fontSize: 11,
    fontWeight: 700,
    fontFamily: 'var(--font-mono)',
    color: 'var(--danger)',
    background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
    border: '1px solid var(--danger)',
    borderRadius: 5,
    padding: '2px 6px',
  },
  groupChip: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text)',
    background: 'var(--surface-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: '1px 5px',
    marginTop: 2,
    marginRight: 3,
  },
  overflowChip: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    padding: '1px 4px',
  },
}
