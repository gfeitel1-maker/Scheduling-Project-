// T106 (docs/work/specs/2026-08-21-special-day-author-ui-designer-spec.md §2).
// Thin wrapper rendered by SpecialDayGridEditor around the reused, unmodified
// SlotCell/EmptyCell leaf components. Owns the per-cell location line as a
// SIBLING DOM node sharing the same grid placement — SlotCell stays pure per
// the Governor decision (no location prop added to it).
import { useState } from 'react'
import SlotCell from '../../components/schedule/SlotCell'
import EmptyCell from '../../components/schedule/EmptyCell'

function LocationPinIcon() {
  return (
    <svg viewBox="0 0 10 12" width={10} height={10} fill="none" style={{ display: 'block' }}>
      <path
        d="M5 11 C5 11 8.5 7.2 8.5 4.5 C8.5 2.29 6.71 0.5 5 0.5 C3.29 0.5 1.5 2.29 1.5 4.5 C1.5 7.2 5 11 5 11 Z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
      />
      <circle cx="5" cy="4.5" r="1.3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export default function SpecialDayCell({
  slotRow, // { id, activity_id, location_id, group_id, time_block_id } | undefined (empty)
  activity, // resolved activity or null; undefined activity_id with a real row -> "removed"
  location, // resolved location or null
  groupId, blockId, specialDayId,
  gridRow, gridColumn, ariaColIndex, blockNames, column,
  eligibleActivities,
  locations = [],
  onPlace, onCreateNew,
  onLocationChange,
}) {
  const [editingLocation, setEditingLocation] = useState(false)
  const hasActivity = Boolean(slotRow?.activity_id)
  const activityRemoved = hasActivity && !activity
  const hasLocation = Boolean(slotRow?.location_id)
  const locationRemoved = hasLocation && !location

  const slot = slotRow
    ? {
        type: 'activity',
        groupId,
        dayId: specialDayId,
        blockId,
        flags: {}, // no UNFILLABLE/OVERLAP/WEEK_CLOSED — special days have no engine
        elective_set_id: null, // no electives in this slice
      }
    : null

  const displayActivity = activityRemoved
    ? { id: slotRow.activity_id, name: 'Activity (removed)' }
    : activity

  return (
    <div
      className="cell-shell"
      data-has-activity={hasActivity ? '' : undefined}
      data-has-location={hasLocation ? '' : undefined}
      style={{ position: 'relative', gridRow, gridColumn }}
    >
      {/* SlotCell/EmptyCell keep their own gridRow/gridColumn prop surface
          (undefined here) — this wrapper carries the real placement (see
          `style` above), which is sufficient since the wrapper occupies
          exactly the grid cell's box and the leaf simply fills it. */}
      {slot ? (
        <SlotCell
          slot={slot}
          activity={displayActivity}
          eligibleActivities={eligibleActivities}
          onPlace={onPlace}
          onCreateNew={onCreateNew}
          ariaColIndex={ariaColIndex}
          cellKey={`${groupId}|${specialDayId}|${blockId}`}
          blockNames={blockNames}
          column={column}
        />
      ) : (
        <EmptyCell
          groupId={groupId}
          dayId={specialDayId}
          blockId={blockId}
          ariaColIndex={ariaColIndex}
          blockNames={blockNames}
          column={column}
          eligibleActivities={eligibleActivities}
          onPlace={onPlace}
          onCreateNew={onCreateNew}
        />
      )}

      {hasActivity && hasLocation && !editingLocation && (
        <div
          className="cell-location"
          onClick={(e) => { e.stopPropagation(); setEditingLocation(true) }}
        >
          <span className="cell-location-icon"><LocationPinIcon /></span>
          {locationRemoved ? 'Location (removed)' : location.name}
        </div>
      )}

      {hasActivity && !hasLocation && !editingLocation && (
        <button
          type="button"
          className="cell-location-add"
          onClick={(e) => { e.stopPropagation(); setEditingLocation(true) }}
        >
          + location
        </button>
      )}

      {hasActivity && editingLocation && (
        <div
          className="cell-inline-editor"
          style={{ position: 'absolute', inset: 4, zIndex: 3, display: 'flex', alignItems: 'center' }}
          onClick={(e) => e.stopPropagation()}
        >
          <select
            autoFocus
            defaultValue={slotRow.location_id || ''}
            style={{ width: '100%', fontSize: 11 }}
            onChange={(e) => {
              setEditingLocation(false)
              onLocationChange?.(slotRow, e.target.value || null)
            }}
            onBlur={() => setEditingLocation(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditingLocation(false) }}
          >
            <option value="">— No location —</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.name}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
