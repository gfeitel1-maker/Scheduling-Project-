import { useEffect, useRef, useState } from 'react'
import { localClient } from './localClient'
import Shell from './components/layout/Shell'
import ModeSelectScreen from './screens/ModeSelectScreen'
import JoinScreen from './screens/JoinScreen'
import CampBootstrapScreen from './screens/CampBootstrapScreen'
import LoginScreen from './screens/LoginScreen'
import CampScreen from './screens/CampScreen'
import ImportScreen from './screens/ImportScreen'
import ReconciliationScreen from './screens/ReconciliationScreen'
import TiersScreen from './screens/TiersScreen'
import GroupsScreen from './screens/GroupsScreen'
import TimeBlocksScreen from './screens/TimeBlocksScreen'
import ActivitiesScreen from './screens/ActivitiesScreen'
import LocationsScreen from './screens/LocationsScreen'
import AnchorsScreen from './screens/AnchorsScreen'
import ElectivesScreen from './screens/ElectivesScreen'
import DaysScreen from './screens/DaysScreen'
import CohortsScreen from './screens/CohortsScreen'
import SpecialDaysScreen from './screens/SpecialDaysScreen'
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

// Keys mirrored into screenKeys.js (a plain-data sibling file, not this
// component file) so a guard test can assert every readiness/rootMap-node
// `screen` key resolves to a real entry here, without this file exporting a
// non-component value (react-refresh/only-export-components forbids that) —
// see screenDestinationsExist.test.js.
const SCREENS = {
  camp:         CampScreen,
  import:       ImportScreen,
  // Roots as a persistent inspector (docs/adr/2026-08-19-roots-census-and-
  // persistent-inspector.md §(e)) — the first time ReconciliationScreen is
  // reachable outside the ImportScreen takeover. Fixed `mode="inspect"` prop
  // threaded at the render site below, same pattern as
  // SCHEDULE_ROUTE_BY_SCREEN's fixed `route` prop. Also the in-session
  // landing screen (see the 'readiness' redirect below) — Setup Readiness
  // (ReadinessHub) is retired; its verdict now lives on the Roots banner.
  roots:        ReconciliationScreen,
  conflicts:    ConflictsScreen,
  trash:        TrashScreen,
  cohorts:      CohortsScreen,
  tiers:        TiersScreen,
  groups:       GroupsScreen,
  days:         DaysScreen,
  timeblocks:   TimeBlocksScreen,
  activities:   ActivitiesScreen,
  locations:    LocationsScreen,
  anchors:      AnchorsScreen,
  electives:    ElectivesScreen,
  specialdays:  SpecialDaysScreen,
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

// Exported (in addition to the default App below) so App.test.jsx can drive
// it directly with fixed props, bypassing useDeviceMode's async init — the
// same reasoning every screen test already applies to its own component.
export function AppShell({ campId, role, mode, onLogout }) {
  // Roots is the in-session landing (S5, OF-1; plan T3): every director lands
  // on the honest "what does Shoresh know about this camp" home base — now
  // carrying the readiness verdict banner — rather than mid-setup on Units.
  // Every other screen stays reachable from the sidebar.
  const [screen, setScreen] = useState('roots')
  // Roots-as-dashboard plan, Task 4 — the carrier that lifts a finished
  // import's commit outcome across the screen boundary. ImportScreen hands it
  // up (onImported) as it routes to Roots; ReconciliationScreen (inspect mode)
  // reads it to show the post-import banner and start the surviving
  // grace-window undo. Held here, above both screens, so it outlives
  // ImportScreen unmounting. Cleared the moment the director leaves Roots —
  // the least-surprising lifecycle: the post-import moment belongs to the
  // landing, not to every later visit.
  const [justImported, setJustImported] = useState(null)
  // Slice 2 drill-in (docs/work/specs/2026-08-22-electives-nested-schedule-
  // slices.md) — the elective_set_id an elective cell's drill-in button
  // wants Electives to open focused on, carried the same way justImported
  // carries the post-import outcome: lifted above the screen swap, cleared
  // whenever navigation heads anywhere other than 'electives'.
  const [electiveFocusSetId, setElectiveFocusSetId] = useState(null)
  // Every in-session navigation goes through this: it clears the carried
  // import outcome the moment the director leaves Roots, so the post-import
  // banner belongs to the landing, not to every later visit. Clearing at the
  // navigation edge (rather than in an effect keyed on `screen`) keeps the
  // transition in one synchronous update, no cascading re-render.
  const navigate = (next, opts) => {
    // 'readiness' redirects to 'roots' at render (resolvedScreen below), so
    // treat it as 'roots' here too — otherwise a nav to 'readiness' would
    // clear the post-import banner while visually staying on Roots.
    const target = next === 'readiness' ? 'roots' : next
    if (target !== 'roots') setJustImported(null)
    if (target !== 'electives') setElectiveFocusSetId(null)
    if (opts?.electiveSetId) setElectiveFocusSetId(opts.electiveSetId)
    setScreen(next)
  }
  // Single instance of the pending-conflicts source for this whole shell —
  // both the Sidebar badge count and ConflictsScreen's list read from it, so
  // they can never disagree.
  const pendingConflicts = usePendingConflicts()

  // docs/adr/2026-08-15-locations-concurrent-create-collision.md (D3/D4):
  // this is the offline-queue case's only path to the renderer — flushQueue
  // runs with no live caller waiting on any one queued write, so without
  // this subscription a director who created a place while offline would
  // never learn the create was silently rejected once the queue flushed.
  // Owner decision (addendum, remediation round): the original ADR scoped UI
  // out of this fix and called a real notice "future polish" — the owner has
  // since decided offline rejection must be VISIBLE, not console-only, so
  // this now shows a minimal, dismissible banner reusing the shared
  // S.errorBanner visual language already used for error surfaces across the
  // app, rather than inventing a new toast framework.
  // Single scalar, not a queue: a second rejection while one is already
  // showing replaces it rather than stacking. Accepted as adequate for this
  // minimal notice (T12) — a real queue is out of scope here.
  const [opRejectedNotice, setOpRejectedNotice] = useState(null)
  useEffect(() => {
    const unsub = localClient.onOpRejected?.((msg) => {
      setOpRejectedNotice(
        msg.existing?.name
          ? `A location named "${msg.existing.name}" already exists and wasn't created.`
          : 'A change could not be saved because it conflicts with existing data.'
      )
    })
    return () => unsub?.()
  }, [])

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

  // Setup Readiness (ReadinessHub) is retired (plan T3) — its verdict now
  // lives on the Roots banner. A stale 'readiness' deep-link or nav target
  // (e.g. a saved link from before this change) redirects to Roots rather
  // than rendering nothing, same as if the director had landed there fresh.
  const resolvedScreen = screen === 'readiness' ? 'roots' : screen
  const Screen = SCREENS[resolvedScreen] || TiersScreen
  const scheduleRoute = SCHEDULE_ROUTE_BY_SCREEN[resolvedScreen]
  const isWeekScreen = resolvedScreen === 'activities' || resolvedScreen === 'groups' || resolvedScreen === 'locations'
  const screenProps = resolvedScreen === 'conflicts'
    ? { campId, role, onNavigate: navigate, pendingConflicts }
    : {
        campId, role, deviceMode: mode, onNavigate: navigate,
        ...(scheduleRoute ? { initialRoute: scheduleRoute } : {}),
        ...(isWeekScreen ? weekProps : {}),
        // Roots as persistent inspector — fixed prop per route key, same
        // pattern as scheduleRoute above (docs/adr/2026-08-19-roots-census-
        // and-persistent-inspector.md §(e)). Task 4 also threads the carried
        // import outcome so Roots can show its post-import banner + undo.
        ...(resolvedScreen === 'roots' ? { mode: 'inspect', justImported } : {}),
        // Task 4 — ImportScreen hands a finished import's outcome up here.
        ...(resolvedScreen === 'import' ? { onImported: setJustImported } : {}),
        // Slice 2 — the set id a schedule cell's drill-in wants focused.
        ...(resolvedScreen === 'electives' ? { initialElectiveSetId: electiveFocusSetId } : {}),
      }

  return (
    <>
      {opRejectedNotice && (
        <div style={opRejectedNoticeStyles.wrap} role="alert">
          <span>{opRejectedNotice}</span>
          <button
            type="button"
            onClick={() => setOpRejectedNotice(null)}
            aria-label="Dismiss"
            style={opRejectedNoticeStyles.dismissBtn}
          >×</button>
        </div>
      )}
      <Shell
        currentScreen={resolvedScreen}
        onNavigate={navigate}
        campId={campId}
        role={role}
        onLogout={onLogout}
        sidebarBadges={{ conflicts: pendingConflicts.conflicts.length }}
      >
        <Screen {...screenProps} />
      </Shell>
    </>
  )
}

// A fixed, top-of-viewport placement (rather than inline in the scrolling
// screen content) so the notice is visible regardless of which screen the
// director is on when the offline queue flushes — reuses S.errorBanner's
// visual language (color/border/radius/type) with layout overrides for the
// fixed-position toast placement, and mirrors the existing dismiss-button
// pattern from src/components/schedule/ErrorBanner.jsx.
const opRejectedNoticeStyles = {
  wrap: {
    ...S.errorBanner,
    position: 'fixed',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    // Below S.overlay's zIndex 1000 (src/styles/shared.js), not above it: an
    // open modal's own title/close controls must win where the two overlap,
    // never be covered by this banner (T12, Red Hat LOW).
    zIndex: 900,
    maxWidth: 480,
    width: 'calc(100% - 32px)',
    marginBottom: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    boxShadow: '0 2px 12px color-mix(in srgb, var(--text) 12%, transparent)',
  },
  dismissBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'inherit',
    fontSize: 16,
    lineHeight: 1,
    flexShrink: 0,
  },
}

export default function App() {
  const device = useDeviceMode()

  // Deploy smoke-test heartbeat: proof React actually mounted and a renderer→
  // main IPC round-trip works. Main writes the smoke marker only when the deploy
  // set SHORESH_SMOKE_NONCE; every other run is a harmless no-op round-trip.
  // Placed before any conditional return so it obeys the Rules of Hooks and
  // fires on mount regardless of phase. Routed through localClient so browser
  // dev hits the mock's no-op (never a bare window.shoresh access).
  useEffect(() => {
    localClient.reportSmokeReady()
  }, [])

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
    return <LoginScreen campName={device.camp?.name} onSubmit={device.login} notice={device.sessionEndedReason} />
  }

  return <AppShell campId={device.camp?.id} role={device.role} mode={device.mode} onLogout={device.logout} />
}
