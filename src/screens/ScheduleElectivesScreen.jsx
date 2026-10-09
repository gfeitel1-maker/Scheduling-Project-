// docs/work/specs/2026-08-23-electives-gap.md Part (b) — the Schedule-side
// build entry for Electives, a SEPARATE row from "Special Schedules"
// (electives are core recurring structure, not an exception category — see
// the spec's "key IA decision"). A picker, not a route: lists every
// authored elective set (data, not nav structure) and opens the existing
// ElectiveSetDetail builder unmodified when a card is clicked. Mirrors
// SpecialSchedulesScreen's shape (single category here instead of two).
import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import SchedulePickerList, { Crossfade } from '../components/schedule/SchedulePickerList'
import ElectiveSetDetail from './elective/ElectiveSetDetail'

const LABELS = {
  heading: 'Elective Sets',
}

export default function ScheduleElectivesScreen({ campId, role, onNavigate, initialElectiveSetId = null }) {
  const [sets, setSets] = useState([])
  const [offerings, setOfferings] = useState([])
  const [activities, setActivities] = useState([])
  const [locations, setLocations] = useState([])
  const [tiers, setTiers] = useState([])
  const [groups, setGroups] = useState([])
  const [campers, setCampers] = useState([])
  const [days, setDays] = useState([])
  const [timeBlocks, setTimeBlocks] = useState([])
  const [templateSlots, setTemplateSlots] = useState([])
  const [scheduleTemplates, setScheduleTemplates] = useState([])
  const [scheduleWeeks, setScheduleWeeks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(initialElectiveSetId)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [
        setsData, offeringsData, activitiesData, locationsData, tiersData, groupsData,
        daysData, timeBlocksData, templateSlotsData, scheduleTemplatesData, scheduleWeeksData,
        campersData,
      ] = await Promise.all([
        localClient.list('elective_sets'),
        localClient.list('elective_set_activities'),
        localClient.list('activities'),
        localClient.list('locations'),
        localClient.list('tiers'),
        localClient.list('groups'),
        localClient.list('days_of_operation'),
        localClient.list('time_blocks'),
        localClient.list('template_slots'),
        localClient.list('schedule_templates'),
        localClient.list('schedule_weeks'),
        localClient.list('campers'),
      ])
      setSets((setsData || []).filter((s) => s.camp_id === campId))
      setOfferings(offeringsData || [])
      setActivities((activitiesData || []).filter((a) => a.camp_id === campId))
      setLocations((locationsData || []).filter((l) => l.camp_id === campId))
      setTiers((tiersData || []).filter((t) => t.camp_id === campId))
      setGroups((groupsData || []).filter((g) => g.camp_id === campId))
      setDays((daysData || []).filter((d) => d.camp_id === campId))
      setTimeBlocks((timeBlocksData || []).filter((t) => t.camp_id === campId))
      setTemplateSlots(templateSlotsData || [])
      setScheduleTemplates((scheduleTemplatesData || []).filter((t) => t.camp_id === campId))
      setScheduleWeeks(scheduleWeeksData || [])
      setCampers((campersData || []).filter((c) => c.camp_id === campId))
    } catch {
      setError("Couldn't load camp setup.")
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [campId])

  useEffect(() => {
    if (initialElectiveSetId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedId(initialElectiveSetId)
    }
  }, [initialElectiveSetId])

  const selectedSet = sets.find((s) => s.id === selectedId)

  if (selectedSet) {
    return (
      <Crossfade>
        <ElectiveSetDetail
          set={selectedSet}
          role={role}
          activities={activities}
          locations={locations}
          tiers={tiers}
          groups={groups}
          campers={campers}
          days={days}
          timeBlocks={timeBlocks}
          templateSlots={templateSlots}
          scheduleTemplates={scheduleTemplates}
          scheduleWeeks={scheduleWeeks}
          refreshActivities={load}
          onBack={() => { setSelectedId(null); load() }}
          onNavigate={onNavigate}
        />
      </Crossfade>
    )
  }

  if (loading) return <div style={S.stateLoading}>Loading…</div>

  const sortedSets = [...sets].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))

  return (
    <SchedulePickerList
      error={error}
      emptyAction="Go to Electives"
      onEmptyAction={() => onNavigate?.('electives')}
      sections={[{
        key: 'sets',
        heading: LABELS.heading,
        rows: sortedSets.map((set) => {
          const count = offerings.filter((o) => o.elective_set_id === set.id).length
          return {
            key: set.id,
            name: set.name || '(untitled set)',
            meta: `${count} offering${count === 1 ? '' : 's'}`,
            onClick: () => setSelectedId(set.id),
          }
        }),
      }]}
    />
  )
}
