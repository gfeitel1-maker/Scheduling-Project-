import { useEffect, useRef, useState } from 'react'
import { localClient } from './localClient'
import Shell from './components/layout/Shell'
import { CloseIcon, WarningTriangleIcon } from './components/icons'
import ModeSelectScreen from './screens/ModeSelectScreen'
import JoinByCodeScreen from './screens/JoinByCodeScreen'
import CampBootstrapScreen from './screens/CampBootstrapScreen'
import LoginScreen from './screens/LoginScreen'
import CampScreen from './screens/CampScreen'
import ImportScreen from './screens/ImportScreen'
import ReconciliationScreen from './screens/ReconciliationScreen'
import RootsHomeScreen from './screens/RootsHomeScreen'
import TiersScreen from './screens/TiersScreen'
import GroupsScreen from './screens/GroupsScreen'
import TimeBlocksScreen from './screens/TimeBlocksScreen'
import ActivitiesScreen from './screens/ActivitiesScreen'
import LocationsScreen from './screens/LocationsScreen'
import FixedEventsScreen from './screens/FixedEventsScreen'
import ElectivesScreen from './screens/ElectivesScreen'
import SpecialEventsScreen from './screens/SpecialEventsScreen'
import DaysScreen from './screens/DaysScreen'
import CohortsScreen from './screens/CohortsScreen'
import SpecialSchedulesScreen from './screens/SpecialSchedulesScreen'
import ScheduleElectivesScreen from './screens/ScheduleElectivesScreen'
import ScheduleScreen from './screens/ScheduleScreen'
import ConflictsScreen from './screens/ConflictsScreen'
import TrashScreen from './screens/TrashScreen'
import DeviceManagerScreen from './screens/DeviceManagerScreen'
import HostHandoffConfirm from './components/HostHandoffConfirm'
import SeedScreen from './screens/SeedScreen'
import AboutScreen from './screens/AboutScreen'
import { PairAgainScreen } from './screens/JoinByCodeScreen'
import { useDeviceMode } from './hooks/useDeviceMode'
import BootRecoveryScreen from './screens/BootRecoveryScreen'
import { usePendingConflicts } from './hooks/usePendingConflicts'
import { ensureCohort } from './utils/ensureCohort'
import { seedDays } from './utils/seedDays'
import { describeWriteFailure } from './utils/writeErrorMessage'
import { S, useEnterTransition, prefersReducedMotion } from './styles/shared'
import { enqueue, upsertById, removeById } from './notices/noticeQueue'

// Keys mirrored into screenKeys.js (a plain-data sibling file, not this
// component file) so a guard test can assert every readiness/rootMap-node
// `screen` key resolves to a real entry here, without this file exporting a
// non-component value (react-refresh/only-export-components forbids that) —
// see screenDestinationsExist.test.js.
const SCREENS = {
  camp:         CampScreen,
  import:       ImportScreen,
  // Stage-aware landing (docs/adr/2026-08-28-stage-aware-nav-landing.md
  // Decision 1) — the first-run landing for a camp with no setup data yet.
  // Never reachable once campHasSetupData() is true.
  seed:         SeedScreen,
  // Roots home is a distinct screen (docs/adr/2026-08-28-roots-home-is-a-
  // distinct-screen.md §2) — route-level split, not an `entry` fork. Census
  // tiles / RootMap / RootMapPanel stay scoped to ReconciliationScreen's
  // `entry="import"` reconcile-a-file flow (reached via the bottom "Import
  // last year" action below), never inlined here. Also the in-session
  // landing screen (see the 'readiness' redirect below) — Setup Readiness
  // (ReadinessHub) is retired; there is no verdict banner on this screen.
  roots:        RootsHomeScreen,
  // T237 — the second, fileless door into ReconciliationScreen: open
  // decisions worked through without an import (entry="openDecisions"
  // below skips the mount-time dry run and triage tray entirely; see
  // ReconciliationScreen.jsx). Reached from a Roots attention row/overflow
  // chip whose sourceKind is 'reconciliation'.
  reconciliation: ReconciliationScreen,
  conflicts:    ConflictsScreen,
  trash:        TrashScreen,
  cohorts:      CohortsScreen,
  tiers:        TiersScreen,
  groups:       GroupsScreen,
  days:         DaysScreen,
  timeblocks:   TimeBlocksScreen,
  activities:   ActivitiesScreen,
  locations:    LocationsScreen,
  recurringevents:      FixedEventsScreen,
  // Fixed vs Recurring un-conflation (docs/adr/2026-08-28-fixed-vs-recurring-
  // events.md §7) — both nav keys point at the same FixedEventsScreen, filtered
  // by the fixed `kind` prop below (same pattern as SCHEDULE_ROUTE_BY_SCREEN's
  // fixed `route` prop), not two screens.
  fixedevents:  FixedEventsScreen,
  electives:    ElectivesScreen,
  // Special Events unification (docs/adr/2026-08-29-unify-special-events-
  // screen.md) — one create/manage hub replacing the separate Events and
  // Special Days screens; the Plants build surface below is unchanged.
  specialevents: SpecialEventsScreen,
  // Two routes to a week, two sidebar destinations, one screen. Neither is the
  // camp's "real" schedule — the director makes that call, never the app
  // (docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md). 'schedule' is
  // a neutral entry point kept for the setup flow's "Next: Schedule" links; it
  // designates nothing — it lands on the first-run choice screen while neither
  // route has been started, and asks which week to open once both exist.
  schedule:               ScheduleScreen,
  'schedule:manual':      ScheduleScreen,
  'schedule:generated':   ScheduleScreen,
  // The Schedule-side build entry (docs/work/specs/2026-08-23-schedule-
  // build-ia.md) — a picker, not a route, so it is deliberately absent from
  // SCHEDULE_ROUTE_BY_SCREEN below.
  'schedule:special':     SpecialSchedulesScreen,
  // docs/work/specs/2026-08-23-electives-gap.md — a separate Schedule-side
  // picker for elective sets, sibling to schedule:special, not merged into
  // it. Also absent from SCHEDULE_ROUTE_BY_SCREEN — a picker, not a route.
  'schedule:electives':   ScheduleElectivesScreen,
  // Day Map (B1, read-only) — docs/adr/2026-08-24-run-the-day-on-the-map.md
  // Decision 2. Route toggle is IN-screen (unpersisted default 'generated'),
  // deliberately absent from SCHEDULE_ROUTE_BY_SCREEN below: the ADR rejected
  // a fixed-route sidebar destination for this screen as the same
  // "remembered schedule" anti-pattern the plural-candidate-schedules ADR
  // forbids.
  devices:      DeviceManagerScreen,
  // About & Legal — reached from the sidebar footer, not a nav stage. A
  // view-only surface (about note, version, user agreement, license,
  // third-party attributions); see src/screens/AboutScreen.jsx.
  about:        AboutScreen,
  // Footer-only: the can't-reach-the-camp flag's action.
  pairAgain:    PairAgainScreen,
}

// Which schedule route a sidebar destination stands for. Absent for the
// neutral 'schedule' entry, which forces nothing: with both weeks started the
// screen asks the director which one to open rather than defaulting to either.
const SCHEDULE_ROUTE_BY_SCREEN = {
  'schedule:manual': 'manual',
  'schedule:generated': 'generated',
}

// Fixed vs Recurring events (docs/adr/2026-08-28-fixed-vs-recurring-events.md
// §7) — one FixedEventsScreen, filtered by a fixed `kind` prop per nav key, same
// pattern as SCHEDULE_ROUTE_BY_SCREEN above.
const EVENT_KIND_BY_SCREEN = {
  fixedevents: 'fixed',
  recurringevents: 'recurring',
}

// T200 round 2 — the two bootstrap-failure sentences used to repeat their
// cause verbatim when both writers failed for the same reason ("weekdays...
// <cause>. cohort... <cause>."). `describeWriteFailure` isn't touched (it's
// shared by every other write-failure caller in the app); instead this pulls
// the cause half out by calling it with an empty subject, so the two causes
// can be compared and — when identical — folded into one sentence naming
// both subjects.
const BOOTSTRAP_DAYS_SUBJECT = "This camp's default weekdays could not be set up."
const BOOTSTRAP_COHORT_SUBJECT = "This camp's default cohort could not be set up."
function composeBootstrapNotice(daysReason, cohortReason) {
  if (daysReason && cohortReason) {
    const daysCause = describeWriteFailure(daysReason, '').trim()
    const cohortCause = describeWriteFailure(cohortReason, '').trim()
    if (daysCause === cohortCause) {
      return `This camp's default weekdays and default cohort could not be set up. ${daysCause}`
    }
    return `${describeWriteFailure(daysReason, BOOTSTRAP_DAYS_SUBJECT)} ${describeWriteFailure(cohortReason, BOOTSTRAP_COHORT_SUBJECT)}`
  }
  if (daysReason) return describeWriteFailure(daysReason, BOOTSTRAP_DAYS_SUBJECT)
  if (cohortReason) return describeWriteFailure(cohortReason, BOOTSTRAP_COHORT_SUBJECT)
  return null
}

// Exported (in addition to the default App below) so App.test.jsx can drive
// it directly with fixed props, bypassing useDeviceMode's async init — the
// same reasoning every screen test already applies to its own component.
export function AppShell({ campId, role, mode, onLogout, campIsEmpty }) {
  // Stage-aware landing (docs/adr/2026-08-28-stage-aware-nav-landing.md
  // Decision 1): an empty camp lands on the "Seed your camp" screen; every
  // other camp lands on Roots (S5, OF-1; plan T3) — the honest "what does
  // Shoresh know about this camp" home base, carrying the readiness verdict
  // banner. `campIsEmpty` is resolved by useDeviceMode before AppShell ever
  // mounts (the pre-paint 'loading' gate in App() below), so this initializer
  // reads it synchronously rather than recomputing it in-tree. Every other
  // screen stays reachable from the sidebar.
  const [screen, setScreen] = useState(() => campIsEmpty ? 'seed' : 'roots')
  // Slice 2 drill-in (docs/work/specs/2026-08-22-electives-nested-schedule-
  // slices.md), redirected by docs/work/specs/2026-08-23-electives-gap.md —
  // the elective_set_id an elective cell's drill-in button, or the "Open"
  // row action on Roots's Electives list, wants the Schedule-side Electives
  // builder to open focused on. Lifted above the screen swap, cleared
  // whenever navigation heads anywhere other than 'schedule:electives'.
  const [electiveFocusSetId, setElectiveFocusSetId] = useState(null)
  // Special Events unification — the { type: 'event'|'day', id } an event
  // cell's drill-in button (or a Roots link) wants SpecialEventsScreen to
  // open focused on, carried the same way electiveFocusSetId carries the
  // elective drill-in target. Replaces the old eventFocusId scalar.
  const [specialEventsFocus, setSpecialEventsFocus] = useState(null)
  const [newActivityName, setNewActivityName] = useState(null)
  // Schedule-side build entry (docs/work/specs/2026-08-23-schedule-build-ia.md,
  // "the seam, precisely") — SpecialDaysScreen's "Open" row action and
  // EventScreen's "Build this event's schedule" link both navigate here with
  // a pre-selection, carried the same way electiveFocusSetId/eventFocusId
  // carry their own drill-in targets. `{ type: 'day'|'event', id }`.
  const [specialScheduleFocus, setSpecialScheduleFocus] = useState(null)
  // Every in-session navigation goes through this: it clears any carried
  // drill-in focus once the director leaves the screen it targets. Clearing
  // at the navigation edge (rather than in an effect keyed on `screen`)
  // keeps the transition in one synchronous update, no cascading re-render.
  const navigate = (next, opts) => {
    // 'readiness' redirects to 'roots' at render (resolvedScreen below), so
    // treat it as 'roots' here too.
    const target = next === 'readiness' ? 'roots' : next
    if (target !== 'schedule:electives') setElectiveFocusSetId(null)
    if (opts?.electiveSetId) setElectiveFocusSetId(opts.electiveSetId)
    setNewActivityName(target === 'activities' ? opts?.addActivityName ?? null : null)
    if (target !== 'specialevents') setSpecialEventsFocus(null)
    if (opts?.eventId) setSpecialEventsFocus({ type: 'event', id: opts.eventId })
    if (target !== 'schedule:special') setSpecialScheduleFocus(null)
    if (opts?.specialDayId) setSpecialScheduleFocus({ type: 'day', id: opts.specialDayId })
    if (opts?.buildEventId) setSpecialScheduleFocus({ type: 'event', id: opts.buildEventId })
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
  //
  // T200 board follow-up (owner ruling 2026-09-29 "yes to t200"): a bootstrap-
  // failure notice and an offline-queue rejection used to share one scalar,
  // so a second arrival overwrote the first and lost its retry affordance.
  // `notices` is now an ordered FIFO (src/notices/noticeQueue.js's pure ops),
  // each entry `{ id, message, retry: fn|null, source: 'bootstrap' |
  // 'opRejected' }` — `retry` lives on the entry itself, not in separate
  // shell state, so an unrelated notice ahead of or behind a bootstrap entry
  // can never strip its retry. Only the head renders (see OpRejectedNoticeBanner).
  //
  // T204 (carried into the queue): every arrival gets a fresh id, never a
  // reused one, so two identical messages in a row are still two entries —
  // string/object identity alone could not tell "the same message arrived
  // again" apart from "nothing new", which is exactly what a repeated
  // offline rejection makes reachable.
  const [notices, setNotices] = useState([])
  const noticeIdSeq = useRef(0)
  const nextNoticeId = (prefix) => `${prefix}-${++noticeIdSeq.current}`
  useEffect(() => {
    const unsub = localClient.onOpRejected?.((msg) => {
      setNotices((q) => enqueue(q, {
        id: nextNoticeId('opRejected'),
        message: msg.existing?.name
          ? `A location named "${msg.existing.name}" already exists and wasn't created.`
          : 'A change could not be saved because it conflicts with existing data.',
        retry: null,
        source: 'opRejected',
      }))
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
  // Round 3, verified against Red Hat's round-2 claim that an app restart
  // would NOT retry a hung bootstrap because seededForCamp.current would
  // still equal campId: this is wrong. seededForCamp is a useRef scoped to
  // THIS AppShell function-component instance (declared inside AppShell,
  // line ~146 below) — a real app restart, or any AppShell unmount/remount,
  // creates a fresh instance with a fresh ref initialised to null, so the
  // mount effect's `seededForCamp.current === campId` guard is false and
  // runBootstrap runs again. A restart IS a genuine recovery path for an
  // unbounded IPC hang (see the T201/T200 "Known limits accepted" note).
  const seededForCamp = useRef(null)
  // T201: a second ref, separate from seededForCamp, so a manual retry click
  // can't overlap with another retry (or with the mount-time run) — one
  // in-flight bootstrap at a time. seededForCamp itself is never cleared on
  // a genuine failure: that ref's only job is neutralizing StrictMode's
  // double-invoke (see the comment above), and clearing it on failure would
  // let a second concurrent seedDays run through the *effect* path,
  // double-seeding days_of_operation (T201's trap). Retry re-runs through
  // this function instead, which the in-flight ref already serialises.
  //
  // Round 2, Red Hat MEDIUM: seededForCamp.current is set (in the mount
  // effect below) *before* this in-flight check runs, so a campId change
  // mid-flight used to mark the new camp "seeded" even when its run never
  // actually happened — permanently starving it. When this function
  // early-returns because another run is in flight, it clears
  // seededForCamp.current so the mount effect can try again once the lock
  // frees up. This is defensive, not load-bearing today: AppShell only
  // mounts once device.phase === 'session', and this app is single-camp-
  // per-device (every `camps` lookup is `SELECT ... FROM camps LIMIT 1`), so
  // campId does not actually change under a live AppShell instance today.
  const bootstrapInFlight = useRef(false)
  // Round 3, HIGH: bootstrapBusy means "a director-initiated retry is in
  // progress" — NOT "a bootstrap run of any kind is in progress". It is set
  // only on the retry-click path (isRetry below), never on the mount-time
  // run, so a hung mount attempt does not render the retry control as a
  // permanently-disabled "Retrying…" the director never triggered.
  // bootstrapInFlight (the ref) stays the concurrency guard for BOTH the
  // mount run and retries; this never gates logic, only what the button
  // shows.
  const [bootstrapBusy, setBootstrapBusy] = useState(false)
  // Round 3, MEDIUM: reset at the start of each runBootstrap invocation, so
  // a dismiss sticks for THAT invocation's remaining recompose() calls but a
  // brand new retry always starts undismissed.
  const dismissedRef = useRef(false)
  // T200 board follow-up: the id of THE bootstrap queue entry, assigned once
  // (lazily, on the first invocation past the in-flight guard below) and
  // then reused by every later retry of this same bootstrap — a retry is a
  // new runBootstrap call, but it is still the same notice's story, so it
  // must keep updating (and, on a clean resolve, removing) the one entry
  // rather than orphaning it and minting a new one at the back. The
  // "previous attempt has not finished yet" branch (bootstrapInFlight
  // already true) reads this ref rather than minting its own id, for the
  // same reason.
  const bootstrapNoticeIdRef = useRef(null)

  // T200: both writers dispatched together, but round 2 (Red Hat HIGH) moved
  // away from awaiting Promise.allSettled as the notice trigger — a hang on
  // one write (dead IPC, crashed handler) must not suppress a failure that
  // is already known on the other. Each write gets its own success/failure
  // handler that records into `state` and recomposes the notice from
  // whatever has failed *so far*; composeBootstrapNotice keeps days-then-
  // cohort ordering stable no matter which settles first. allSettled is
  // still used, but only to know when to release bootstrapInFlight/
  // bootstrapBusy — a hang no longer blocks the notice.
  //
  // The offline-queue notice (onOpRejected, above) is untouched by this:
  // that source fires alone, asynchronously, one event at a time. T200
  // board follow-up: it previously shared one scalar with the bootstrap
  // notice, so an unrelated arrival could overwrite the bootstrap notice
  // (and its retry) under last-writer-wins. Both sources now write into the
  // same FIFO `notices` queue instead of a shared scalar, so neither can
  // clobber the other — see `notices` above.
  async function runBootstrap(id, { isRetry = false } = {}) {
    if (bootstrapInFlight.current) {
      seededForCamp.current = null
      // Round 3, HIGH: a director clicking Try again while the mount-time
      // attempt is still hung used to no-op silently, leaving the notice as
      // it was (misleading, since nothing is actually happening on their
      // behalf). Say so plainly, and keep the retry affordance so they can
      // try again once the stuck run frees up.
      if (isRetry) {
        const inFlightId = bootstrapNoticeIdRef.current
        setNotices((q) => upsertById(q, inFlightId, {
          message: 'The previous attempt has not finished yet, so this was not retried. If nothing changes, restart the app.',
          retry: () => runBootstrap(id, { isRetry: true }),
          source: 'bootstrap',
        }))
      }
      return
    }
    bootstrapInFlight.current = true
    if (isRetry) setBootstrapBusy(true)
    dismissedRef.current = false
    // Stable across retries of this same bootstrap, not regenerated per
    // invocation: a retry re-runs this function (a new call), but it is
    // still THE bootstrap notice's story, so it must keep updating (and,
    // on a clean resolve, removing) the SAME queue entry rather than
    // orphaning the old one and minting a new one at the back.
    if (!bootstrapNoticeIdRef.current) bootstrapNoticeIdRef.current = nextNoticeId('bootstrap')
    const myId = bootstrapNoticeIdRef.current

    const state = { days: 'pending', cohort: 'pending' }
    const recompose = () => {
      if (dismissedRef.current) return
      const daysReason = state.days === 'pending' || state.days === 'ok' ? null : state.days
      const cohortReason = state.cohort === 'pending' || state.cohort === 'ok' ? null : state.cohort
      const notice = composeBootstrapNotice(daysReason, cohortReason)
      if (notice) {
        // T201: re-running both is safe — seedDays and ensureCohort are each
        // idempotent check-then-repair, not one-shot inserts (see seedDays.js's
        // header comment) — so "Try again" can simply call this again.
        setNotices((q) => upsertById(q, myId, {
          message: notice,
          retry: () => runBootstrap(id, { isRetry: true }),
          source: 'bootstrap',
        }))
      } else if (state.days !== 'pending' && state.cohort !== 'pending') {
        // T200 board follow-up: removes only THIS invocation's own entry,
        // wherever it sits in the queue — not the head, not the whole queue.
        setNotices((q) => removeById(q, myId))
        // Round 2, Finding 3: null the ref so a genuinely new bootstrap
        // story (a later campId, or a later retry after this one already
        // cleared) mints a fresh id instead of silently reusing this
        // resolved invocation's — otherwise the id comparison at the
        // dismiss site below can never go false for a bootstrap head and
        // becomes a no-op restatement of `source === 'bootstrap'`. Guarded
        // on identity because a retry started after this recompose was
        // scheduled but before it ran may have already minted its own id.
        if (bootstrapNoticeIdRef.current === myId) bootstrapNoticeIdRef.current = null
      }
    }

    const daysDone = seedDays(id).then(
      () => { state.days = 'ok'; recompose() },
      (err) => { state.days = err; recompose() }
    )
    const cohortDone = ensureCohort(id).then(
      () => { state.cohort = 'ok'; recompose() },
      (err) => { state.cohort = err; recompose() }
    )

    await Promise.allSettled([daysDone, cohortDone])
    bootstrapInFlight.current = false
    if (isRetry) setBootstrapBusy(false)
  }

  // runBootstrap is a plain function re-created every render, closing only
  // over stable refs and stable useState setters; listing it would rerun
  // this effect every render. campId is the real, intentional guard (see
  // the seededForCamp comment above).
  useEffect(() => {
    if (!campId || seededForCamp.current === campId) return
    seededForCamp.current = campId
    runBootstrap(campId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campId])

  const weekProps = { weekId, weeks, onSelectWeek: setWeekId }

  // Setup Readiness (ReadinessHub) is retired (plan T3) — its verdict now
  // lives on the Roots banner. A stale 'readiness' deep-link or nav target
  // (e.g. a saved link from before this change) redirects to Roots rather
  // than rendering nothing, same as if the director had landed there fresh.
  const resolvedScreen = screen === 'readiness' ? 'roots' : screen
  const Screen = SCREENS[resolvedScreen] || TiersScreen
  const scheduleRoute = SCHEDULE_ROUTE_BY_SCREEN[resolvedScreen]
  const isWeekScreen = resolvedScreen === 'activities' || resolvedScreen === 'groups' || resolvedScreen === 'locations' || resolvedScreen === 'electives'
  const screenProps = resolvedScreen === 'conflicts'
    ? { campId, role, onNavigate: navigate, pendingConflicts }
    : {
        campId, role, deviceMode: mode, onNavigate: navigate,
        ...(scheduleRoute ? { initialRoute: scheduleRoute } : {}),
        ...(isWeekScreen ? weekProps : {}),
        // Slice 2 — the set id a schedule cell's drill-in (or Roots's "Open"
        // row action) wants the Schedule-side Electives builder focused on.
        ...(resolvedScreen === 'schedule:electives' ? { initialElectiveSetId: electiveFocusSetId } : {}),
        ...(resolvedScreen === 'activities' && newActivityName ? { initialNewName: newActivityName } : {}),
        ...(resolvedScreen === 'specialevents' ? { initialFocus: specialEventsFocus } : {}),
        ...(resolvedScreen === 'schedule:special' ? { initialSelection: specialScheduleFocus } : {}),
        ...(EVENT_KIND_BY_SCREEN[resolvedScreen] ? { kind: EVENT_KIND_BY_SCREEN[resolvedScreen] } : {}),
        ...(resolvedScreen === 'reconciliation' ? { entry: 'openDecisions' } : {}),
      }

  const headNotice = notices[0] ?? null

  return (
    <>
      {headNotice && (
        <OpRejectedNoticeBanner
          headNotice={headNotice}
          queueCount={notices.length - 1}
          // Round 3, HIGH / T200 board follow-up (h): bootstrapBusy only
          // ever means something for the bootstrap entry — gating it here
          // (rather than trusting the `retry &&` check alone) means a
          // non-bootstrap head can never render a "Retrying…" state.
          busy={headNotice.source === 'bootstrap' && bootstrapBusy}
          onDismiss={() => {
            // Round 2, Finding 1 (HIGH, Red Hat CONFIRMED): removal here
            // must be keyed to the id of the notice that was ACTUALLY
            // dismissed — captured at click time, below — never "whatever
            // is at index 0 now". This fires after a 140ms fade, and in
            // that window a different writer (a clean bootstrap resolve)
            // can remove the dismissed entry by id already, advancing the
            // head to an unrelated notice the director never dismissed. A
            // positional removal here would then destroy that unrelated
            // notice instead; an id-keyed removal is a harmless no-op when
            // its entry is already gone.
            const dismissedNoticeId = headNotice.id
            // Round 3, MEDIUM / T200 board follow-up (f): mark the current
            // runBootstrap invocation dismissed ONLY when the notice being
            // dismissed IS that invocation's own bootstrap entry — so a
            // still-pending settle can't reopen the notice the director just
            // closed, but dismissing an unrelated offline-queue notice can
            // never suppress a later bootstrap recompose.
            if (headNotice.source === 'bootstrap' && headNotice.id === bootstrapNoticeIdRef.current) {
              dismissedRef.current = true
              // Round 2, Finding 3: null the ref so a later bootstrap story
              // mints a fresh id rather than reusing this dismissed one.
              bootstrapNoticeIdRef.current = null
            }
            setNotices((q) => removeById(q, dismissedNoticeId))
          }}
        />
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
      <HostHandoffConfirm />
    </>
  )
}

// Round 3, Tester MEDIUM (DESIGN_STANDARD §5c): a separate component so its
// own mount gives useEnterTransition a fresh instance each time the notice
// (re)appears — AppShell itself never unmounts, so calling the hook inline
// in AppShell's body would only ever animate once. Mirrors
// src/components/schedule/ErrorBanner.jsx's use of the same 'slideFade'
// variant.
//
// T204: dismiss now fades out over --motion-fast before unmounting, as §5c
// requires ("On dismiss/resolve, fade out --motion-fast"), and degrades to an
// immediate unmount under prefers-reduced-motion (§8). The earlier
// synchronous dismiss was justified here by the shape of the existing
// "dismiss removes the banner" test; per GOVERNANCE_INDEX §11.3 the standard
// governs and the test moved instead (human gate opened for T204). The fade
// mirrors ErrorBanner's dismiss exactly rather than inventing a second
// mechanism.
// T200 board follow-up: `notices` is now a FIFO queue (see AppShell), and
// this banner only ever shows the HEAD. The outer `wrap` (role="alert",
// fixed frame) stays mounted across a dismiss-then-advance so the surface
// never blinks to empty while another notice is waiting — only the inner
// content (icon + message + actions, below) is keyed on the head notice's
// id, which is what gives useEnterTransition a fresh mount to animate when
// the FIFO advances to the next notice. AppShell unmounts the whole banner
// only once the queue is fully empty.
function OpRejectedNoticeBanner({ headNotice, queueCount, busy, onDismiss }) {
  // WHICH notice id is fading, not a bare boolean — mirrors the previous
  // identity-keyed `dismissing` derivation, now keyed on id instead of
  // object identity since entries are queue items, not fresh objects per
  // arrival of the SAME head.
  const [dismissingId, setDismissingId] = useState(null)
  const dismissing = dismissingId === headNotice.id

  const dismissTimeoutRef = useRef(null)
  useEffect(() => () => clearTimeout(dismissTimeoutRef.current), [])

  const handleDismiss = () => {
    if (prefersReducedMotion()) {
      onDismiss()
      return
    }
    // Round 2, Finding 2 (MEDIUM, two reviewers): a second dismiss
    // activation on the same head (keyboard Enter/Space isn't blocked by
    // the dismissing style's pointer-events:none the way a mouse click is,
    // and jsdom honours neither) used to arm a second timer without
    // clearing the first, so both fired. Clearing any pending timer before
    // arming a new one collapses a double activation into a single fade.
    clearTimeout(dismissTimeoutRef.current)
    const dismissingThisId = headNotice.id
    setDismissingId(dismissingThisId)
    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null
      // Round 4 board ruling on Red Hat's residual-loss repro (CONFIRMED):
      // the staleness re-check this used to do here (comparing `current` to
      // `dismissingThisId` inside the setDismissingId updater) was provably
      // dead — the clearTimeout above already guarantees this callback only
      // ever runs for the one timer currently armed — and it was also
      // unsound, since it called the onDismiss side effect from inside a
      // setState updater, which React (StrictMode double-invokes updaters
      // precisely to catch this) requires to be pure. Dropped, per Code
      // Reviewer's finding; cancelDismiss below is what actually prevents a
      // stale fire now.
      setDismissingId(null)
      onDismiss()
    }, 140)
  }

  // Round 4 board ruling, Item 1 (Red Hat CONFIRMED): a retry activated
  // inside the 140ms dismiss fade — reachable by keyboard even though
  // `opRejectedNoticeStyles.dismissing` sets pointerEvents:'none' to block a
  // second mouse click — must cancel THIS notice's own pending dismiss
  // before the retry's upsert can land. Bootstrap retries reuse their entry
  // id, so without this the stale timer above later removes the fresh,
  // never-read retry failure by that same id. Called synchronously, before
  // `notice.retry()`, so the cancel can never race the upsert.
  const cancelPendingDismiss = () => {
    clearTimeout(dismissTimeoutRef.current)
    dismissTimeoutRef.current = null
    setDismissingId(null)
  }

  return (
    <div
      style={{
        ...opRejectedNoticeStyles.wrap,
        ...(dismissing ? opRejectedNoticeStyles.dismissing : {}),
      }}
      role="alert"
    >
      <OpRejectedNoticeContent
        key={headNotice.id}
        notice={headNotice}
        queueCount={queueCount}
        busy={busy}
        onDismiss={handleDismiss}
        onRetry={cancelPendingDismiss}
      />
    </div>
  )
}

// Split out so `key={headNotice.id}` on the parent forces a fresh mount —
// and therefore a fresh useEnterTransition run — each time the FIFO
// advances to a new head, without re-mounting the fixed outer frame.
function OpRejectedNoticeContent({ notice, queueCount, busy, onDismiss, onRetry }) {
  const enter = useEnterTransition('slideFade')
  return (
    <div style={{ ...opRejectedNoticeStyles.content, ...enter }}>
      {/* §5c: outline alert icon, 16px, var(--danger), before the message. */}
      <div style={opRejectedNoticeStyles.message}>
        <WarningTriangleIcon size={16} color="var(--danger)" />
        <span>{notice.message}</span>
      </div>
      <div style={opRejectedNoticeStyles.actions}>
        {notice.retry && (
          // Round 2, Tester HIGH: the notice stays mounted through the
          // retry (no clear-then-vanish) — the button swaps to a
          // disabled "Retrying…" label so the director can tell a
          // re-presented failure from a new one, without a spinner
          // (DESIGN_STANDARD §5b: a label swap is enough for a
          // sub-second local write).
          <button
            type="button"
            disabled={busy}
            aria-disabled={busy}
            onClick={() => { onRetry(); notice.retry() }}
            style={opRejectedNoticeStyles.retryBtn}
          >{busy ? 'Retrying…' : 'Try again'}</button>
        )}
        {queueCount > 0 && (
          // Designer spec: informational only, never out-ranks the retry
          // action for first read — outside the accessible live-region
          // content (role="alert" on the outer wrap is aria-atomic, so an
          // unhidden queue-depth change would re-announce the whole alert
          // for information the director can't act on).
          <span aria-hidden="true" style={opRejectedNoticeStyles.queueCount}>{queueCount} more</span>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={opRejectedNoticeStyles.dismissBtn}
        ><CloseIcon /></button>
      </div>
    </div>
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
    // Centered with auto margins between two insets, NOT `left: 50%` +
    // translateX(-50%) (T204): useEnterTransition owns `transform` for the
    // slide, and spreading it over this wrap clobbered the centering shift —
    // the banner rendered with its left edge at the viewport midpoint. Auto
    // margins leave `transform` free for motion alone.
    left: 16,
    right: 16,
    marginLeft: 'auto',
    marginRight: 'auto',
    // Below S.overlay's zIndex 1000 (src/styles/shared.js), not above it: an
    // open modal's own title/close controls must win where the two overlap,
    // never be covered by this banner (T12, Red Hat LOW).
    zIndex: 900,
    maxWidth: 480,
    width: 'auto',
    marginBottom: 0,
    boxShadow: '0 2px 12px color-mix(in srgb, var(--text) 12%, transparent)',
  },
  // §5c dismiss motion: fade only, --motion-fast. pointerEvents off so a
  // banner on its way out cannot be clicked again mid-fade. Applied to the
  // outer `wrap` (not `content`) so it fades the whole frame when this is
  // the LAST notice — the frame then unmounts once AppShell's queue empties.
  // When another notice is waiting, the frame is never unmounted; only
  // `content` re-keys to the next notice (see OpRejectedNoticeBanner).
  dismissing: {
    opacity: 0,
    transition: 'opacity var(--motion-fast) var(--ease-out)',
    pointerEvents: 'none',
  },
  // The per-notice animated piece: layout that used to live on `wrap`
  // directly, now on its own element so `wrap` can stay mounted (and
  // visually static) across a FIFO advance while only this re-keys and
  // plays a fresh §5c enter.
  content: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    width: '100%',
  },
  message: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
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
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  // T201 retry affordance — quiet, text-weight, not a filled CTA, so it
  // reads as part of the banner rather than competing with it. Round 2,
  // Tester MEDIUM: DESIGN_STANDARD §5c ("Error — recoverable inline") calls
  // for a link-button in var(--primary), not inherited text color — this
  // banner's text color is var(--danger) (S.errorBanner), which made the
  // control read as more error text rather than an action.
  retryBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--primary)',
    fontSize: 13,
    fontWeight: 600,
    textDecoration: 'underline',
    padding: 0,
  },
  // Designer spec: plain inline text, not a pill — no background, no
  // border-radius, no padding beyond the row's existing `gap: 12`. Neither
  // var(--danger) nor var(--primary): those two colors are already
  // load-bearing here for "this is the error" / "this is the action", and
  // the count must not compete with either for first read.
  queueCount: {
    fontSize: 13,
    fontWeight: 400,
    color: 'var(--text-secondary)',
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

  if (device.phase === 'error' && device.bootFailure) {
    return <BootRecoveryScreen failure={device.bootFailure} />
  }

  if (device.phase === 'error') {
    return (
      <div style={S.authPage}>
        <div style={S.authCard}>
          <div style={S.authLogoBlock}>
            <div style={S.authLogo}>Shoresh</div>
          </div>
          <div style={S.authTitle}>Couldn’t start</div>
          {device.error && <div style={S.authSubtitle}>{device.error}</div>}
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
    // Stage 6c: joining is the camp code the director reads off their own Host
    // (docs/adr/2026-09-08-libp2p-join-flow.md). The address picker it replaced
    // belonged to the WebSocket transport — it asked which machine to connect
    // to, a question that has no meaning once every device holds the whole
    // camp document.
    return <JoinByCodeScreen onBack={device.backToModeSelect} onJoined={device.retry} />
  }

  if (device.phase === 'login') {
    return <LoginScreen campName={device.camp?.name} onSubmit={device.login} notice={device.sessionEndedReason} />
  }

  return (
    <AppShell
      campId={device.camp?.id}
      role={device.role}
      mode={device.mode}
      onLogout={device.logout}
      campIsEmpty={device.campIsEmpty}
    />
  )
}
