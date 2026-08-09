import { useEffect, useRef, useState } from 'react'
import { localClient } from './localClient'
import Shell from './components/layout/Shell'
import ModeSelectScreen from './screens/ModeSelectScreen'
import JoinScreen from './screens/JoinScreen'
import CampBootstrapScreen from './screens/CampBootstrapScreen'
import LoginScreen from './screens/LoginScreen'
import CampScreen from './screens/CampScreen'
import ImportScreen from './screens/ImportScreen'
import ReadinessHub from './screens/ReadinessHub'
import TiersScreen from './screens/TiersScreen'
import GroupsScreen from './screens/GroupsScreen'
import TimeBlocksScreen from './screens/TimeBlocksScreen'
import ActivitiesScreen from './screens/ActivitiesScreen'
import AnchorsScreen from './screens/AnchorsScreen'
import DaysScreen from './screens/DaysScreen'
import CohortsScreen from './screens/CohortsScreen'
import DayOverridesScreen from './screens/DayOverridesScreen'
import ScheduleScreen from './screens/ScheduleScreen'
import ConflictsScreen from './screens/ConflictsScreen'
import TrashScreen from './screens/TrashScreen'
import DeviceManagerScreen from './screens/DeviceManagerScreen'
import PairingPendingScreen from './screens/PairingPendingScreen'
import { useDeviceMode } from './hooks/useDeviceMode'
import { usePendingConflicts } from './hooks/usePendingConflicts'
import { ensureCohort } from './utils/ensureCohort'
import { seedDays } from './utils/seedDays'
import { S } from './styles/shared'

const SCREENS = {
  readiness:    ReadinessHub,
  camp:         CampScreen,
  import:       ImportScreen,
  conflicts:    ConflictsScreen,
  trash:        TrashScreen,
  cohorts:      CohortsScreen,
  tiers:        TiersScreen,
  groups:       GroupsScreen,
  days:         DaysScreen,
  timeblocks:   TimeBlocksScreen,
  activities:   ActivitiesScreen,
  anchors:      AnchorsScreen,
  dayoverrides: DayOverridesScreen,
  // Two routes to a week, two sidebar destinations, one screen. Neither is the
  // camp's "real" schedule — the director makes that call, never the app
  // (docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md). 'schedule' is
  // a neutral entry point kept for the setup flow's "Next: Schedule" links; it
  // designates nothing — it lands on the first-run choice screen while neither
  // route has been started, and asks which week to open once both exist.
  schedule:               ScheduleScreen,
  'schedule:manual':      ScheduleScreen,
  'schedule:generated':   ScheduleScreen,
  devices:      DeviceManagerScreen,
}

// Which schedule route a sidebar destination stands for. Absent for the
// neutral 'schedule' entry, which forces nothing: with both weeks started the
// screen asks the director which one to open rather than defaulting to either.
const SCHEDULE_ROUTE_BY_SCREEN = {
  'schedule:manual': 'manual',
  'schedule:generated': 'generated',
}

function AppShell({ campId, role, onLogout }) {
  // The Setup Readiness hub is the in-session landing (S5, OF-1): every director
  // lands on the honest "can this camp build a week yet" home base rather than
  // mid-setup on Units. Every other screen stays reachable from the sidebar.
  const [screen, setScreen] = useState('readiness')
  // Single instance of the pending-conflicts source for this whole shell —
  // both the Sidebar badge count and ConflictsScreen's list read from it, so
  // they can never disagree.
  const pendingConflicts = usePendingConflicts()

  // Shared week state threaded into Activities and Groups screens so the
  // director stays on the same week as they navigate between setup screens
  // (S2-6). ScheduleScreen manages its own week state independently.
  const [weeks, setWeeks] = useState([])
  const [weekId, setWeekId] = useState(null)
  useEffect(() => {
    if (!campId) return
    localClient.list('schedule_weeks').then(rows => {
      const active = (rows || [])
        .filter(w => w.camp_id === campId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      setWeeks(active)
      if (!weekId || !active.some(w => w.id === weekId)) {
        const first = active.find(w => String(w.is_archived) !== '1')
        setWeekId(first?.id ?? null)
      }
    }).catch(() => {})
  }, [campId])

  // Run the one-time camp bootstrap (default weekdays + "Main" program) once
  // per camp. The ref guard neutralizes React StrictMode's dev-mode
  // double-invocation of this effect: seedDays/ensureCohort each read-then-write
  // and are not safe against two concurrent invocations (days_of_operation has
  // no UNIQUE constraint, so a double-invoke would seed Mon–Fri twice → 10
  // days). Without this guard the duplication is only masked in production
  // builds, where StrictMode does not double-invoke.
  const seededForCamp = useRef(null)
  useEffect(() => {
    if (!campId || seededForCamp.current === campId) return
    seededForCamp.current = campId
    seedDays(campId)
    ensureCohort(campId)
  }, [campId])

  const weekProps = { weekId, weeks, onSelectWeek: setWeekId }

  const Screen = SCREENS[screen] || TiersScreen
  const scheduleRoute = SCHEDULE_ROUTE_BY_SCREEN[screen]
  const isWeekScreen = screen === 'activities' || screen === 'groups'
  const screenProps = screen === 'conflicts'
    ? { campId, role, onNavigate: setScreen, pendingConflicts }
    : {
        campId, role, onNavigate: setScreen,
        ...(scheduleRoute ? { initialRoute: scheduleRoute } : {}),
        ...(isWeekScreen ? weekProps : {}),
      }

  return (
    <Shell
      currentScreen={screen}
      onNavigate={setScreen}
      campId={campId}
      role={role}
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

  if (device.phase === 'pairing_pending') {
    return <PairingPendingScreen denied={false} onBack={device.backToModeSelect} />
  }

  if (device.phase === 'pairing_denied') {
    return <PairingPendingScreen denied onBack={device.backToModeSelect} />
  }

  if (device.phase === 'login') {
    return <LoginScreen campName={device.camp?.name} onSubmit={device.login} />
  }

  return <AppShell campId={device.camp?.id} role={device.role} onLogout={device.logout} />
}
