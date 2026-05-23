import { useState, useEffect } from 'react'
import Shell from './components/layout/Shell'
import LandingScreen from './components/entry/LandingScreen'
import CampSetup from './screens/CampSetup'
import TiersScreen from './screens/TiersScreen'
import GroupsScreen from './screens/GroupsScreen'
import TimeBlocksScreen from './screens/TimeBlocksScreen'
import ActivitiesScreen from './screens/ActivitiesScreen'
import AnchorsScreen from './screens/AnchorsScreen'
import ScheduleScreen from './screens/ScheduleScreen'
import { supabase } from './supabase'

const SCREENS = {
  setup: CampSetup,
  tiers: TiersScreen,
  groups: GroupsScreen,
  timeblocks: TimeBlocksScreen,
  activities: ActivitiesScreen,
  anchors: AnchorsScreen,
  schedule: ScheduleScreen,
}

const MON_FRI = [
  { label: 'Monday',    day_of_week: 1, sort_order: 1 },
  { label: 'Tuesday',   day_of_week: 2, sort_order: 2 },
  { label: 'Wednesday', day_of_week: 3, sort_order: 3 },
  { label: 'Thursday',  day_of_week: 4, sort_order: 4 },
  { label: 'Friday',    day_of_week: 5, sort_order: 5 },
]

async function seedDays(campId) {
  const { count } = await supabase
    .from('days_of_operation')
    .select('id', { count: 'exact', head: true })
    .eq('camp_id', campId)
  if (count === 0) {
    await supabase.from('days_of_operation').insert(
      MON_FRI.map(d => ({ ...d, camp_id: campId }))
    )
  }
}

function getUrlCampId() {
  return new URLSearchParams(window.location.search).get('camp')
}

function setUrlCampId(campId) {
  const url = new URL(window.location.href)
  url.searchParams.set('camp', campId)
  window.history.replaceState({}, '', url.toString())
}

export default function App() {
  // URL param wins over localStorage
  const urlCampId = getUrlCampId()
  const storedCampId = localStorage.getItem('campId')
  const initialCampId = urlCampId || storedCampId || null

  const [campId, setCampId] = useState(initialCampId)
  const [screen, setScreen] = useState('setup')

  useEffect(() => {
    if (campId) {
      localStorage.setItem('campId', campId)
      setUrlCampId(campId)
      seedDays(campId)
    }
  }, [campId])

  function handleEnter(id) {
    setCampId(id)
  }

  if (!campId) {
    return <LandingScreen onEnter={handleEnter} />
  }

  const Screen = SCREENS[screen] || CampSetup

  return (
    <Shell currentScreen={screen} onNavigate={setScreen} campId={campId}>
      <Screen campId={campId} onNavigate={setScreen} />
    </Shell>
  )
}
