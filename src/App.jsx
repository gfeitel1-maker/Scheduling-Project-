import { useEffect, useState } from 'react'
import Shell from './components/layout/Shell'
import AuthScreen from './screens/AuthScreen'
import CampSetup from './screens/CampSetup'
import TiersScreen from './screens/TiersScreen'
import GroupsScreen from './screens/GroupsScreen'
import TimeBlocksScreen from './screens/TimeBlocksScreen'
import ActivitiesScreen from './screens/ActivitiesScreen'
import AnchorsScreen from './screens/AnchorsScreen'
import CohortsScreen from './screens/CohortsScreen'
import DayOverridesScreen from './screens/DayOverridesScreen'
import ScheduleScreen from './screens/ScheduleScreen'
import { useSession } from './hooks/useSession'
import { supabase } from './supabase'
import { ensureCohort } from './utils/ensureCohort'

const SCREENS = {
  setup:        CampSetup,
  cohorts:      CohortsScreen,
  tiers:        TiersScreen,
  groups:       GroupsScreen,
  timeblocks:   TimeBlocksScreen,
  activities:   ActivitiesScreen,
  anchors:      AnchorsScreen,
  dayoverrides: DayOverridesScreen,
  schedule:     ScheduleScreen,
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

// DEV BYPASS — remove before production
const DEV_CAMP_ID = '022d370c-b25a-42e5-9b4c-f521d17dae29'

export default function App() {
  const [screen, setScreen] = useState('setup')

  useEffect(() => {
    seedDays(DEV_CAMP_ID)
    ensureCohort(DEV_CAMP_ID)
  }, [])

  const Screen = SCREENS[screen] || CampSetup

  return (
    <Shell currentScreen={screen} onNavigate={setScreen} campId={DEV_CAMP_ID} onLogout={() => {}}>
      <Screen campId={DEV_CAMP_ID} onNavigate={setScreen} />
    </Shell>
  )
}
