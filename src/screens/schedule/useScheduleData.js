import { useState, useEffect, useRef, useCallback } from 'react'
import { computeFindings } from '../../engine/buildSchedule'
import { normalizeActivityEligibility } from '../../utils/normalizeActivityEligibility'
import { isRestorable } from '../snapshotRestore'
import { deriveScheduleTemplateId } from '../../../electron/ops/scheduleTemplateId'

// Which row IS this camp's candidate for this route? Ask the database by
// (camp_id, kind) — do not assume the derived id is the one on disk.
// See ScheduleScreen's original comment (git history) for the full rationale;
// unchanged on the move — `kind` is the route authority (ADR Decision §1),
// resolution is by (week_id, kind).
function templateRowFor(templates, weekId, kind) {
  // A row with no kind at all is 'generated': that is the column default and
  // what migration v23 backfilled, so a row that predates the column (or
  // arrives from a peer that has not projected kind yet) must not read as
  // belonging to no route.
  return (templates || []).find(t => t.week_id === weekId && (t.kind || 'generated') === kind)
}

function resolveTemplateId(templates, weekId, kind) {
  const row = templateRowFor(templates, weekId, kind)
  return row ? row.id : deriveScheduleTemplateId(weekId, kind)
}

// Pure — no setState, no closures over hook state. `ctx` unused today (the
// count needs nothing beyond the slot list itself) but kept as a parameter for
// symmetry with recalcFindings and so a future stat that needs more data
// doesn't change the call signature.
export function recalcStats(slotList) {
  return {
    open: slotList.filter(s => s.is_anchor === false).length,
    filled: slotList.filter(s => s.is_anchor === false && s.activity_id).length,
  }
}

// Pure — no setState. `ctx` is exactly what computeFindings needs beyond the
// slot list: the setup lists it cross-references.
export function recalcFindings(slotList, ctx) {
  return computeFindings({ slots: slotList, groups: ctx.groups, activities: ctx.activities, days: ctx.days })
}

const EMPTY_SETUP_LISTS = { groups: [], days: [], timeBlocks: [], activities: [], anchors: [], tiers: [], cohorts: [] }
const EMPTY_EXCLUSIONS = { activityExclusions: [], groupExclusions: [] }
const EMPTY_TEMPLATE_DATA = {
  existingTemplates: {}, templateIdByRoute: {},
  slotsByRoute: {}, overlaysByRoute: {}, snapshotsByRoute: {}, statsByRoute: {}, findingsByRoute: {},
}

// Owns the load: setup catalog, weeks + weekId resolution, week exclusions,
// template data (slots/overlays/snapshots/stats/findings per route). Four
// concerns, one lifecycle — see docs/work/specs/architecture-restructure-
// proposal.md §"C1". Route data flows OUT only; this hook never imports or
// touches useRouteState, and designates neither route as canonical.
export function useScheduleData({ campId, weekId: preferredWeekId, repo, routes }) {
  const [setupLists, setSetupLists] = useState(EMPTY_SETUP_LISTS)
  const [weeks, setWeeks] = useState([])
  const [weekId, setWeekId] = useState(null)
  const [weekDeletedBanner, setWeekDeletedBanner] = useState(null)
  const [exclusions, setExclusions] = useState(EMPTY_EXCLUSIONS)
  const [templateData, setTemplateDataState] = useState(EMPTY_TEMPLATE_DATA)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [templateError, setTemplateError] = useState(null)

  // Load-generation guard (C1-R1): loadAll is called from mount AND
  // unconditionally on every foreign op-applied event, so a Host absorbing a
  // sync burst can have several loads in flight at once. Without this, an
  // older load's setters can land after a newer load's and stamp stale data
  // over fresh. Every setter block below bails before firing if a newer load
  // has started in the meantime.
  const generationRef = useRef(0)
  // Which weekId the last COMPLETED load actually resolved to. The mount/
  // reload effect below re-fires whenever `preferredWeekId` changes, and the
  // screen feeds its own state back in as `preferredWeekId` once a load
  // resolves (so a later reload — e.g. from onOpApplied — starts from where
  // the director actually is, not from null). That feedback is an ECHO of a
  // resolution this hook already performed, not a new instruction, so it
  // must not trigger a second, redundant load — one that would race the
  // first for no reason (C1-R2 idempotency).
  const lastResolvedWeekIdRef = useRef(undefined)

  const load = async () => {
    const gen = ++generationRef.current
    setLoading(true)
    setLoadError(null)
    setTemplateError(null)
    let g, a, d
    try {
      // Cohorts are not used to build a week, only to answer "is setup done"
      // from the same source the sidebar and Camp Setup use. Without it this
      // screen would report a Programs gap the setup screen does not — the
      // exact disagreement getSetupGaps exists to end.
      const {
        groups: gd, days_of_operation: td, time_blocks: bd, activities: ad,
        anchor_activities: ancd, tiers: tierd, cohorts: cohd,
      } = await repo.loadSetupLists()
      if (gen !== generationRef.current) return
      g = [...(gd || [])].filter(x => x.camp_id === campId).sort((x, y) => x.name.localeCompare(y.name))
      const b = [...(bd || [])].filter(x => x.camp_id === campId).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      a = (ad || []).filter(x => x.camp_id === campId).map(normalizeActivityEligibility)
      const anc = (ancd || []).filter(x => x.camp_id === campId)
      const t = [...(tierd || [])].filter(x => x.camp_id === campId).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      const sortedTd = [...(td || [])].filter(x => x.camp_id === campId).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      d = sortedTd.filter((x, i, arr) => arr.findIndex(y => y.day_of_week === x.day_of_week) === i)
      const tierOrderMap = new Map(t.map(tier => [tier.id, tier.sort_order ?? 0]))
      const sortedG = [...g].sort((x, y) => {
        const ox = tierOrderMap.get(x.tier_id) ?? 999
        const oy = tierOrderMap.get(y.tier_id) ?? 999
        return ox !== oy ? ox - oy : x.name.localeCompare(y.name)
      })
      const coh = (cohd || []).filter(x => x.camp_id === campId)
      if (gen !== generationRef.current) return
      setSetupLists({ groups: sortedG, days: d, timeBlocks: b, activities: a, anchors: anc, tiers: t, cohorts: coh })
    } catch {
      if (gen !== generationRef.current) return
      setLoadError('Failed to load schedule data — check your connection and refresh')
      setLoading(false)
      return
    }
    let liveWeekId = preferredWeekId
    try {
      const weekRows = await repo.loadWeeks()
      if (gen !== generationRef.current) return
      // `weeks` holds every one of this camp's weeks, archived included — the
      // switcher needs archived ones too, to offer Unarchive. Only ACTIVE
      // weeks are eligible for `weekId` (a director cannot land on an
      // archived week by default or via reload).
      const campWeeks = (weekRows || [])
        // A blank name is a placeholder a device holds transiently mid-sync
        // (projections.ensureExists inserts schedule_weeks with name='' when a
        // field arrives before the name op) — never show it in the switcher or
        // let weekId land on it; it resolves to a real name once sync catches up.
        .filter(w => w.camp_id === campId && String(w.name ?? '').trim() !== '')
        .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0) || x.name.localeCompare(y.name))
      let camp = campWeeks.filter(w => String(w.is_archived) !== '1')
      // Lazy creation, same precedent as ensureTemplateRow: a camp is never
      // shown with zero weeks to choose from. This only fires for a camp that
      // predates schedule_weeks entirely and somehow reached this screen before
      // migration v27 ran (the ordinary path is the v27 migration creating
      // "Week 1" for every existing camp up front) — not a normal first-run.
      if (campWeeks.length === 0) {
        const wid = `schedule-week:${campId}:1`
        await repo.createWeek(wid, { campId, name: 'Week 1', sortOrder: 0 })
        if (gen !== generationRef.current) return
        camp = [{ id: wid, camp_id: campId, name: 'Week 1', sort_order: 0, is_archived: 0 }]
        setWeeks(camp)
      } else {
        setWeeks(campWeeks)
      }
      // Keep the current week if it is still in the list (a mid-switch reload
      // must not bounce the director back to the first one), otherwise fall to
      // the first active week. Computed synchronously from the current weekId
      // so `liveWeekId` is set for the route load BELOW — a functional setState
      // updater runs asynchronously (React batches it), which would leave
      // liveWeekId null on first load and skip the whole route load.
      if (preferredWeekId && !camp.some(w => w.id === preferredWeekId)) {
        // S3-6: The current week has disappeared — deleted on another device.
        const deletedWeek = campWeeks.find(w => w.id === preferredWeekId) ?? weeks.find(w => w.id === preferredWeekId)
        const name = deletedWeek?.name ?? 'This week'
        setWeekDeletedBanner(`${name} was deleted on another device.`)
      }
      liveWeekId = preferredWeekId && camp.some(w => w.id === preferredWeekId) ? preferredWeekId : (camp[0]?.id ?? null)
      if (gen !== generationRef.current) return
      lastResolvedWeekIdRef.current = { campId, weekId: liveWeekId }
      setWeekId(liveWeekId)
    } catch {
      if (gen !== generationRef.current) return
      setLoadError('Failed to load schedule data — check your connection and refresh')
      setLoading(false)
      return
    }
    if (!liveWeekId) { if (gen === generationRef.current) setLoading(false); return }
    try {
      const { activityExclusions: ae, groupExclusions: ge } = await repo.loadWeekExclusions(liveWeekId)
      if (gen !== generationRef.current) return
      setExclusions({ activityExclusions: ae || [], groupExclusions: ge || [] })
    } catch {
      if (gen !== generationRef.current) return
      setExclusions(EMPTY_EXCLUSIONS)
    }
    // Both routes are refreshed on every load. loadAll() re-runs on every
    // applied op, and a load that only refreshed the route on screen would
    // leave the other one showing whatever it held before the op arrived.
    try {
      const { templates, slots: allSlots, overlays: overlayData, snapshots: snapData } =
        await repo.loadTemplateData()
      if (gen !== generationRef.current) return

      const exists = {}
      const nextTids = {}
      const nextSlots = {}
      const nextOverlays = {}
      const nextSnaps = {}
      const nextStats = {}
      const nextFindings = {}

      for (const r of routes) {
        // Resolution is by (week_id, kind), never by week_id alone: a week now
        // has one row per route, and first-match-wins would silently elect one
        // of them as "the" schedule. It is NOT by derived id either — see
        // resolveTemplateId.
        const tid = resolveTemplateId(templates, liveWeekId, r)
        nextTids[r] = tid
        exists[r] = Boolean(templateRowFor(templates, liveWeekId, r))
        // Gated on the parent row existing: a route with no schedule_templates
        // row has not been started, whatever orphan child rows may be lying
        // around.
        const saved = exists[r] ? allSlots.filter(x => x.template_id === tid) : []
        nextSlots[r] = saved
        nextOverlays[r] = (overlayData || []).filter(o => o.template_id === tid)
        nextStats[r] = recalcStats(saved)
        nextFindings[r] = recalcFindings(saved, { groups: g, activities: a, days: d })
        nextSnaps[r] = (snapData || [])
          .filter(x => x.template_id === tid)
          .sort((x, y) => new Date(y.created_at) - new Date(x.created_at))
          // `restorable` is carried so the Versions list and the restore action
          // agree — offering a version restore will refuse is the T8 defect.
          // The payload travels with the row so the Versions list can say,
          // truthfully and at render time, which version is the week on screen.
          .map(x => ({
            id: x.id, template_id: x.template_id, name: x.name,
            is_auto: x.is_auto, created_at: x.created_at,
            slots: x.slots, overlays: x.overlays,
            restorable: isRestorable(x),
          }))
      }

      if (gen !== generationRef.current) return
      setTemplateDataState({
        existingTemplates: exists,
        templateIdByRoute: nextTids,
        slotsByRoute: nextSlots,
        overlaysByRoute: nextOverlays,
        snapshotsByRoute: nextSnaps,
        statsByRoute: nextStats,
        findingsByRoute: nextFindings,
      })
    } catch {
      if (gen === generationRef.current) setTemplateError('Failed to load saved schedule — check your connection and refresh')
    }
    if (gen === generationRef.current) setLoading(false)
  }

  // Load-on-mount / on-week-change: load() sets state from its own async body,
  // which is the canonical data-fetch-on-mount pattern the set-state-in-effect
  // rule allows an exception for. Skips when `preferredWeekId` only just
  // caught up to what the last load already resolved — see
  // lastResolvedWeekIdRef above.
  useEffect(() => {
    const last = lastResolvedWeekIdRef.current
    if (last && last.campId === campId && last.weekId === preferredWeekId) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campId, preferredWeekId])

  const setActivities = useCallback(
    (updater) => setSetupLists(prev => ({ ...prev, activities: typeof updater === 'function' ? updater(prev.activities) : updater })),
    []
  )

  return {
    setupLists, setActivities,
    weeks, setWeeks,
    weekId,
    weekDeletedBanner, setWeekDeletedBanner,
    exclusions,
    templateData,
    loading, loadError, templateError,
    reload: load,
  }
}
