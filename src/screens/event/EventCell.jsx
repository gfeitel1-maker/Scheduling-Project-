// Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-internal-
// subschedule.md §4). Thin wrapper rendered by EventGridEditor around the
// reused, unmodified SlotCell/EmptyCell leaf components — structural mirror
// of SpecialDayCell.jsx with `special_day` renamed to `event` and
// `groupId`/`group_id` renamed to `eventGroupId`/`event_group_id`. Owns the
// per-cell location line as a SIBLING DOM node sharing the same grid
// placement — SlotCell stays pure (no location prop added to it).
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

export default function EventCell({
  slotRow, // { id, activity_id, location_id, event_group_id, time_block_id } | undefined (empty)
  activity, // resolved activity or null; undefined activity_id with a real row -> "removed"
  location, // resolved location or null
  eventGroupId, blockId, eventId,
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
        groupId: eventGroupId,
        dayId: eventId,
        blockId,
        flags: {}, // no UNFILLABLE/OVERLAP/WEEK_CLOSED — events have no engine
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
      {slot ? (
        <SlotCell
          slot={slot}
          activity={displayActivity}
          eligibleActivities={eligibleActivities}
          onPlace={onPlace}
          onCreateNew={onCreateNew}
          ariaColIndex={ariaColIndex}
          cellKey={`${eventGroupId}|${eventId}|${blockId}`}
          blockNames={blockNames}
          column={column}
        />
      ) : (
        <EmptyCell
          groupId={eventGroupId}
          dayId={eventId}
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
