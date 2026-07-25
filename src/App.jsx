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
import ConflictsScreen from './screens/ConflictsScreen'
import { useDeviceMode } from './hooks/useDeviceMode'
import { usePendingConflicts } from './hooks/usePendingConflicts'
import { ensureCohort } from './utils/ensureCohort'
import { seedDays } from './utils/seedDays'
import { S } from './styles/shared'

const SCREENS = {
  setup:        CampSetup,
  conflicts:    ConflictsScreen,
  cohorts:      CohortsScreen,
  tiers:        TiersScreen,
  groups:       GroupsScreen,
  timeblocks:   TimeBlocksScreen,
  activities:   ActivitiesScreen,
  anchors:      AnchorsScreen,
  dayoverrides: DayOverridesScreen,
  schedule:     ScheduleScreen,
}

function AppShell({ campId, role, onLogout }) {
  const [screen, setScreen] = useState('setup')
  // Single instance of the pending-conflicts source for this whole shell —
  // both the Sidebar badge count and ConflictsScreen's list read from it, so
  // they can never disagree.
  const pendingConflicts = usePendingConflicts()

  useEffect(() => {
    seedDays(campId)
    ensureCohort(campId)
  }, [campId])

  const Screen = SCREENS[screen] || CampSetup
  const screenProps = screen === 'conflicts'
    ? { campId, role, onNavigate: setScreen, pendingConflicts }
    : { campId, role, onNavigate: setScreen }

  return (
    <Shell
      currentScreen={screen}
      onNavigate={setScreen}
      campId={campId}
      onLogout={onLogout}
      sidebarBadges={{ conflicts: pendingConflicts.conflicts.length }}
    >
      <Screen {...screenProps} />
    </Shell>
  )
}

export default function App() {
  const device = useDeviceMode()

  if (device.phase === 'loading') return null

  if (device.phase === 'error') {
    return (
      <div style={S.authPage}>
        <div style={S.authCard}>
          <div style={S.authLogoBlock}>
            <div style={S.authLogo}>Shoresh</div>
          </div>
          <div style={S.authTitle}>Something went wrong</div>
          <div style={S.authSubtitle}>
            {device.error || 'An unexpected error occurred while starting the app.'}
          </div>
          <button
            style={S.authBtnPrimary}
            onClick={() => {
              if (device.retry) device.retry()
              else window.location.reload()
            }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

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

  return <AppShell campId={device.camp?.id} role={device.role} onLogout={device.logout} />
}
