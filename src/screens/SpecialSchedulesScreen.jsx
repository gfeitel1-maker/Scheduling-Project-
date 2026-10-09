// docs/work/specs/2026-08-23-schedule-build-ia.md — the Schedule-side build
// entry for special days and events. A picker, not a route: it lists every
// authored special day and event (same two categories, same order as Roots's
// "Special Schedule" heading, navSections.js:80-97) and opens the EXISTING
// SpecialDayGridEditor / EventGridEditor components unchanged when a card is
// clicked. No independent schedule state — no slots/overlays/stats route
// slice, per the spec's "why this doesn't read as a third route" §2.
import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import SchedulePickerList, { Crossfade } from '../components/schedule/SchedulePickerList'
import SpecialDayGridEditor from './specialDay/SpecialDayGridEditor'
import EventGridEditor from './event/EventGridEditor'

const LABELS = {
  specialDaysHeading: 'Special Days',
  eventsHeading: 'Events',
  // Must match the `deletedElsewhere` copy in the two grid editors this screen
  // opens — SpecialDayGridEditor.jsx and EventGridEditor.jsx — so a live delete
  // on another device reads the same whether you are on the picker or already
  // inside the editor. (This used to point at SpecialDaysScreen, which the
  // Special Events unification deleted; the sibling copy moved to the editors.)
  dayDeletedElsewhere: 'This special day was deleted.',
  eventDeletedElsewhere: 'This event was deleted.',
}

export default function SpecialSchedulesScreen({ campId, onNavigate, initialSelection = null }) {
  const [specialDays, setSpecialDays] = useState([])
  const [sdTimeBlocks, setSdTimeBlocks] = useState([])
  const [sdSlots, setSdSlots] = useState([])
  const [groups, setGroups] = useState([])
  const [events, setEvents] = useState([])
  const [eventTimeBlocks, setEventTimeBlocks] = useState([])
  const [eventGroups, setEventGroups] = useState([])
  const [eventSlots, setEventSlots] = useState([])
  const [templateSlots, setTemplateSlots] = useState([])
  const [days, setDays] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(initialSelection)
  const [toast, setToast] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [
        specialDaysData, sdBlocksData, sdSlotsData, groupsData,
        eventsData, eventBlocksData, eventGroupsData, eventSlotsData,
        templateSlotsData, daysData,
      ] = await Promise.all([
        localClient.list('special_days'),
        localClient.list('special_day_time_blocks'),
        localClient.list('special_day_slots'),
        localClient.list('groups'),
        localClient.list('events'),
        localClient.list('event_time_blocks'),
        localClient.list('event_groups'),
        localClient.list('event_slots'),
        localClient.list('template_slots'),
        localClient.list('days_of_operation'),
      ])
      setSpecialDays((specialDaysData || []).filter((d) => d.camp_id === campId))
      setSdTimeBlocks(sdBlocksData || [])
      setSdSlots(sdSlotsData || [])
      setGroups((groupsData || []).filter((g) => g.camp_id === campId))
      setEvents((eventsData || []).filter((e) => e.camp_id === campId))
      setEventTimeBlocks(eventBlocksData || [])
      setEventGroups(eventGroupsData || [])
      setEventSlots(eventSlotsData || [])
      setTemplateSlots((templateSlotsData || []).filter((s) => s.event_id))
      setDays((daysData || []).filter((d) => d.camp_id === campId))
    } catch {
      setError("Couldn't load camp setup.")
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [campId])

  useEffect(() => {
    if (initialSelection) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(initialSelection)
    }
  }, [initialSelection])

  if (selected?.type === 'day') {
    return (
      <Crossfade>
        <SpecialDayGridEditor
          campId={campId}
          specialDayId={selected.id}
          onBack={() => { setSelected(null); load() }}
          onDeletedElsewhere={() => {
            setSelected(null)
            setToast(LABELS.dayDeletedElsewhere)
            load()
          }}
        />
      </Crossfade>
    )
  }
  if (selected?.type === 'event') {
    return (
      <Crossfade>
        <EventGridEditor
          campId={campId}
          eventId={selected.id}
          onBack={() => { setSelected(null); load() }}
          onDeletedElsewhere={() => {
            setSelected(null)
            setToast(LABELS.eventDeletedElsewhere)
            load()
          }}
        />
      </Crossfade>
    )
  }

  if (loading) return <div style={S.stateLoading}>Loading…</div>

  const sortByName = (rows) => [...rows].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))

  return (
    <SchedulePickerList
      notice={toast}
      error={error}
      emptyAction="Go to Special Events"
      onEmptyAction={() => onNavigate?.('specialevents')}
      sections={[
        {
          key: 'days',
          heading: LABELS.specialDaysHeading,
          rows: sortByName(specialDays).map((d) => {
            const blocks = sdTimeBlocks.filter((b) => b.special_day_id === d.id)
            const filled = sdSlots.filter((s) => s.special_day_id === d.id && s.activity_id).length
            return {
              key: d.id,
              name: d.name,
              meta: `${filled}/${groups.length * blocks.length}`,
              onClick: () => setSelected({ type: 'day', id: d.id }),
            }
          }),
        },
        {
          key: 'events',
          heading: LABELS.eventsHeading,
          rows: sortByName(events).map((ev) => {
            const evGroups = eventGroups.filter((g) => g.event_id === ev.id)
            const evBlocks = eventTimeBlocks.filter((b) => b.event_id === ev.id)
            const filled = eventSlots.filter((s) => s.event_id === ev.id && s.activity_id).length
            const placement = templateSlots.find((s) => s.event_id === ev.id)
            const dayLabel = placement ? days.find((d) => d.id === placement.day_id)?.label : null
            return {
              key: ev.id,
              name: ev.name,
              sublabel: dayLabel ? `Placed ${dayLabel}` : null,
              meta: `${filled}/${evGroups.length * evBlocks.length}`,
              onClick: () => setSelected({ type: 'event', id: ev.id }),
            }
          }),
        },
      ]}
    />
  )
}
