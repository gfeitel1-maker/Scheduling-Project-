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
import AnchorsScreen from './screens/AnchorsScreen'
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
import PreferenceImportScreen from './screens/PreferenceImportScreen'
import SeedScreen from './screens/SeedScreen'
import { useDeviceMode } from './hooks/useDeviceMode'
import { usePendingConflicts } from './hooks/usePendingConflicts'
import { ensureCohort } from './utils/ensureCohort'
import { seedDays } from './utils/seedDays'
import { describeWriteFailure } from './utils/writeErrorMessage'
import { S, useEnterTransition, prefersReducedMotion } from './styles/shared'

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
  // distinct-screen.md §2) — route-level split, not a `mode` fork. Census
  // tiles / RootMap / RootMapPanel stay scoped to ReconciliationScreen's
  // `mode="import"` reconcile-a-file flow (reached via the bottom "Import
  // last year" action below), never inlined here. Also the in-session
  // landing screen (see the 'readiness' redirect below) — Setup Readiness
  // (ReadinessHub) is retired; there is no verdict banner on this screen.
  roots:        RootsHomeScreen,
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
  // Fixed vs Recurring un-conflation (docs/adr/2026-08-28-fixed-vs-recurring-
  // events.md §7) — both nav keys point at the same AnchorsScreen, filtered
  // by the fixed `kind` prop below (same pattern as SCHEDULE_ROUTE_BY_SCREEN's
  // fixed `route` prop), not two screens.
  fixedevents:  AnchorsScreen,
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
  // T195 — admin-only preference import (docs/work/tickets/T195-preference-
  // import-service.md). Fixture data only pending the owner's dated
  // acceptance of real camper data — see the screen's own notice.
  preferenceimport: PreferenceImportScreen,
}

// Which schedule route a sidebar destination stands for. Absent for the
// neutral 'schedule' entry, which forces nothing: with both weeks started the
// screen asks the director which one to open rather than defaulting to either.
const SCHEDULE_ROUTE_BY_SCREEN = {
  'schedule:manual': 'manual',
  'schedule:generated': 'generated',
}

// Fixed vs Recurring events (docs/adr/2026-08-28-fixed-vs-recurring-events.md
// §7) — one AnchorsScreen, filtered by a fixed `kind` prop per nav key, same
// pattern as SCHEDULE_ROUTE_BY_SCREEN above.
const ANCHOR_KIND_BY_SCREEN = {
  fixedevents: 'fixed',
  anchors: 'recurring',
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
  // Single scalar, not a queue: a second rejection while one is already
  // showing replaces it rather than stacking. Accepted as adequate for this
  // minimal notice (T12) — a real queue is out of scope here.
  //
  // T204: the value is an OBJECT (`{ message }`), never a bare string, and
  // every arrival allocates a fresh one. §5c's dismiss now fades out over
  // --motion-fast, which opens a ~140ms window in which a NEW notice can
  // arrive while the old one is still fading; the banner cancels its pending
  // unmount when this identity changes, so the new notice is never swallowed
  // by the outgoing one's timer. String state could not distinguish "the same
  // message arrived again" from "no new notice", which is exactly the case
  // that window makes reachable (two identical queue rejections in a row).
  const [opRejectedNotice, setOpRejectedNotice] = useState(null)
  // T201: only a bootstrap-failure notice gets a retry affordance — the
  // offline-queue rejection below has nothing meaningful to re-run, so this
  // stays null for that source and is only ever set alongside a bootstrap
  // notice (see runBootstrap).
  const [noticeRetry, setNoticeRetry] = useState(null)
  useEffect(() => {
    const unsub = localClient.onOpRejected?.((msg) => {
      setOpRejectedNotice({
        message: msg.existing?.name
          ? `A location named "${msg.existing.name}" already exists and wasn't created.`
          : 'A change could not be saved because it conflicts with existing data.',
      })
      setNoticeRetry(null)
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
  // that source fires alone, asynchronously, one event at a time — it was
  // never part of the race this collapses, so last-writer-wins is still
  // sound for it (T200's "open design question"). KNOWN, NARROWED limit
  // (T12/T200/T201): the bootstrap pair no longer races itself, but an
  // unrelated onOpRejected notice can still arrive mid-bootstrap-retry and
  // replace this notice (and its retry affordance) under the same
  // single-scalar last-writer-wins rule — fixing that means the notice
  // queue T12 explicitly ruled out of scope.
  async function runBootstrap(id, { isRetry = false } = {}) {
    if (bootstrapInFlight.current) {
      seededForCamp.current = null
      // Round 3, HIGH: a director clicking Try again while the mount-time
      // attempt is still hung used to no-op silently, leaving the notice as
      // it was (misleading, since nothing is actually happening on their
      // behalf). Say so plainly, and keep the retry affordance so they can
      // try again once the stuck run frees up.
      if (isRetry) {
        setOpRejectedNotice({ message: 'The previous attempt has not finished yet, so this was not retried. If nothing changes, restart the app.' })
        setNoticeRetry(() => () => runBootstrap(id, { isRetry: true }))
      }
      return
    }
    bootstrapInFlight.current = true
    if (isRetry) setBootstrapBusy(true)
    dismissedRef.current = false

    const state = { days: 'pending', cohort: 'pending' }
    const recompose = () => {
      if (dismissedRef.current) return
      const daysReason = state.days === 'pending' || state.days === 'ok' ? null : state.days
      const cohortReason = state.cohort === 'pending' || state.cohort === 'ok' ? null : state.cohort
      const notice = composeBootstrapNotice(daysReason, cohortReason)
      if (notice) {
        setOpRejectedNotice({ message: notice })
        // T201: re-running both is safe — seedDays and ensureCohort are each
        // idempotent check-then-repair, not one-shot inserts (see seedDays.js's
        // header comment) — so "Try again" can simply call this again.
        setNoticeRetry(() => () => runBootstrap(id, { isRetry: true }))
      } else if (state.days !== 'pending' && state.cohort !== 'pending') {
        setOpRejectedNotice(null)
        setNoticeRetry(null)
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
  const isWeekScreen = resolvedScreen === 'activities' || resolvedScreen === 'groups' || resolvedScreen === 'locations'
  const screenProps = resolvedScreen === 'conflicts'
    ? { campId, role, onNavigate: navigate, pendingConflicts }
    : {
        campId, role, deviceMode: mode, onNavigate: navigate,
        ...(scheduleRoute ? { initialRoute: scheduleRoute } : {}),
        ...(isWeekScreen ? weekProps : {}),
        // Slice 2 — the set id a schedule cell's drill-in (or Roots's "Open"
        // row action) wants the Schedule-side Electives builder focused on.
        ...(resolvedScreen === 'schedule:electives' ? { initialElectiveSetId: electiveFocusSetId } : {}),
        ...(resolvedScreen === 'specialevents' ? { initialFocus: specialEventsFocus } : {}),
        ...(resolvedScreen === 'schedule:special' ? { initialSelection: specialScheduleFocus } : {}),
        ...(ANCHOR_KIND_BY_SCREEN[resolvedScreen] ? { kind: ANCHOR_KIND_BY_SCREEN[resolvedScreen] } : {}),
      }

  return (
    <>
      {opRejectedNotice && (
        <OpRejectedNoticeBanner
          notice={opRejectedNotice}
          retry={noticeRetry}
          busy={bootstrapBusy}
          onDismiss={() => {
            // Round 3, MEDIUM: mark the current runBootstrap invocation (if
            // any) as dismissed so a still-pending settle can't reopen the
            // notice the director just closed.
            dismissedRef.current = true
            setOpRejectedNotice(null)
            setNoticeRetry(null)
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
function OpRejectedNoticeBanner({ notice, retry, busy, onDismiss }) {
  const enter = useEnterTransition('slideFade')
  // WHICH notice is fading, not a bare boolean: a NEW notice arriving mid-fade
  // must cancel the pending unmount rather than be swallowed by the outgoing
  // notice's timer. Keying on the notice object's identity (see the state
  // declaration in AppShell) means two identical messages in a row are still
  // two arrivals, and makes `dismissing` a pure derivation — no effect
  // resetting state on a prop change (which cascades renders).
  const [dismissingNotice, setDismissingNotice] = useState(null)
  const dismissing = dismissingNotice === notice

  const currentNoticeRef = useRef(notice)
  useEffect(() => { currentNoticeRef.current = notice })
  const dismissTimeoutRef = useRef(null)
  useEffect(() => () => clearTimeout(dismissTimeoutRef.current), [])

  const handleDismiss = () => {
    if (prefersReducedMotion()) {
      onDismiss()
      return
    }
    const dismissed = notice
    setDismissingNotice(dismissed)
    dismissTimeoutRef.current = setTimeout(() => {
      // Only unmount if this is still the notice on screen; a newer one that
      // arrived during the fade is a live notice and must survive.
      if (currentNoticeRef.current !== dismissed) return
      onDismiss()
    }, 140)
  }

  return (
    <div
      style={{
        ...opRejectedNoticeStyles.wrap,
        ...enter,
        ...(dismissing ? opRejectedNoticeStyles.dismissing : {}),
      }}
      role="alert"
    >
      {/* §5c: outline alert icon, 16px, var(--danger), before the message. */}
      <div style={opRejectedNoticeStyles.message}>
        <WarningTriangleIcon size={16} color="var(--danger)" />
        <span>{notice.message}</span>
      </div>
      <div style={opRejectedNoticeStyles.actions}>
        {retry && (
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
            onClick={() => retry()}
            style={opRejectedNoticeStyles.retryBtn}
          >{busy ? 'Retrying…' : 'Try again'}</button>
        )}
        <button
          type="button"
          onClick={handleDismiss}
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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    boxShadow: '0 2px 12px color-mix(in srgb, var(--text) 12%, transparent)',
  },
  // §5c dismiss motion: fade only, --motion-fast. Spread last so it wins over
  // the enter transition's opacity/transition. pointerEvents off so a banner
  // on its way out cannot be clicked again mid-fade.
  dismissing: {
    opacity: 0,
    transition: 'opacity var(--motion-fast) var(--ease-out)',
    pointerEvents: 'none',
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
