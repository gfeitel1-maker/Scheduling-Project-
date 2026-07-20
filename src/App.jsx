import { useEffect, useState } from 'react'
import Shell from './components/layout/Shell'
import ModeSelectScreen from './screens/ModeSelectScreen'
import JoinScreen from './screens/JoinScreen'
import CampBootstrapScreen from './screens/CampBootstrapScreen'
import LoginScreen from './screens/LoginScreen'
import CampSetup from './screens/CampSetup'
import TiersScreen from './screens/TiersScreen'
import GroupsScreen from './screens/GroupsScreen'
import TimeBlocksScreen from './screens/TimeBlocksScreen'
import ActivitiesScreen from './screens/ActivitiesScreen'
import AnchorsScreen from './screens/AnchorsScreen'
import CohortsScreen from './screens/CohortsScreen'
import DayOverridesScreen from './screens/DayOverridesScreen'
import ScheduleScreen from './screens/ScheduleScreen'
import { useDeviceMode } from './hooks/useDeviceMode'
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

function AppShell({ campId, onLogout }) {
  const [screen, setScreen] = useState('setup')

  useEffect(() => {
    seedDays(campId)
    ensureCohort(campId)
  }, [campId])

  const Screen = SCREENS[screen] || CampSetup

  return (
    <Shell currentScreen={screen} onNavigate={setScreen} campId={campId} onLogout={onLogout}>
      <Screen campId={campId} onNavigate={setScreen} />
    </Shell>
  )
}

export default function App() {
  const device = useDeviceMode()

  if (device.phase === 'loading') return null

  if (device.phase === 'mode-select') {
    return <ModeSelectScreen onChooseHost={device.chooseHost} onChooseJoin={device.chooseJoin} />
  }

  if (device.phase === 'bootstrap') {
    return <CampBootstrapScreen onBack={device.backToModeSelect} onSubmit={device.bootstrapCamp} />
  }

  if (device.phase === 'join') {
    return <JoinScreen onBack={device.backToModeSelect} onSelectHost={device.selectJoinHost} />
  }

  if (device.phase === 'login') {
    return <LoginScreen campName={device.camp?.name} onSubmit={device.login} />
  }

  return <AppShell campId={device.camp?.id} onLogout={device.logout} />
}
