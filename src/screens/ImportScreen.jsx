import { useState, useRef } from 'react'
import { localClient } from '../localClient'
import { useCohorts } from '../hooks/useCohorts'
import { S } from '../styles/shared'
import * as XLSX from 'xlsx'
import { parseTextGrid } from '../ingest/textGrid'
import { workbookToPages, groupNameFromFilename, sharedFilenamePrefix } from '../ingest/sheetGrid'
import { extractEntities, INGESTIBLE_ENTITIES } from '../ingest/extractEntities'
import { inferFixedEvents } from '../ingest/fixedEvents'
import { inferActivityRules } from '../ingest/activityRules'
import { buildPreview, describePreview, normalizeName } from '../ingest/preview'
import { autoAccepts } from '../ingest/confidence'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { assertImportFileSize, assertWorkbookComplexity, unescapeRow } from '../utils/exportSanitize.js'
import { downloadWorkbook, META_SHEET } from '../utils/exportWorkbook.js'
import { workbookToSource } from '../ingest/workbookToSource.js'
import ReconciliationScreen from './ReconciliationScreen.jsx'
import { getReadiness, describeReadiness } from '../engine/readiness.js'
import { useSetupCounts } from '../hooks/useSetupCounts.js'
import { describeOptionalGaps } from './importOutcomeModel.js'

// Read last year's schedule and propose the camp's setup from it.
//
// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
//
// The shape of this screen IS the decision: read → propose → the director
// edits → commit. There is no path that skips the middle two, because
// everything here is inference and a wrong guess written silently into a
// camp's setup is the failure this feature must not have (ADR §1).
//
// So the proposal arrives with every row already checked, and every row
// unchecked-able. Approving is the director's act, not a formality.

const LABEL = {
  cohorts: 'Programs',
  tiers: 'Units',
  groups: 'Groups',
  days_of_operation: 'Days',
  time_blocks: 'Time Blocks',
  locations: 'Places',
  activities: 'Activities',
}

// Identifies a proposed fixed event for tick toggling (spec §4.1).
const fixedEventKey = (fe) => `${fe.name} ${fe.time_block} ${fe.days.join(',')}`

// Maps a rule-state field name (what updateActivityRule patches) to the SOURCE
// field name the commit's `humanEditedFields` speaks (what foldApprovedToRecords /
// buildPlan diff against; buildPlan normalizes these to stored columns via
// dbFieldFor). This is the activity-rule half of the Decision 2 provenance
// mechanism (docs/adr/2026-08-09-activity-rule-hand-edit-provenance.md), mirroring
// how the unit column marks `['unit']`. Eligibility is the only rename (rule state
// calls it `eligible_group_names`, the source record calls it `eligible_groups`);
// meta keys the editor also patches (`_inferred`, `eligibility_known`,
// `_editedFields`) are absent here on purpose, so they never count as a field.
const RULE_FIELD_TO_SOURCE = Object.freeze({
  min_per_week: 'min_per_week',
  max_per_week: 'max_per_week',
  priority: 'priority',
  eligible_group_names: 'eligible_groups',
})

// S1b — cohort-scoped entity_type set the alias path gates cohort_id on. Lives
// in its own module (importAliasScope.js) so a drift-guard test can assert it
// stays equal to the engine's COHORT_SCOPED without this component file having
// to export a non-component value.

// activities.priority is the engine's two-valued contract — 'high'/'low',
// never a third value (ActivitiesScreen.jsx, buildSchedule.js's runRound).
// inferActivityRules already returns exactly one of these two strings, so
// this screen displays and writes the same value throughout; no conversion
// at commit (round 2 review, Fix 1 — an earlier 1/2/3 draft was wrong).
const PRIORITY_LABEL = { high: 'High', low: 'Low' }

// T73/S5b — FIELD_LABEL and fieldLabel now live in src/ingest/fieldLabels.js so
// this screen and ReconciliationLedger share ONE camp-language map (design §7.3).

const sumCounts = (counts) => Object.values(counts ?? {}).reduce((n, c) => n + c, 0)

// An empty selection and "all groups" (null) both write the same thing — no
// restriction (T35 Fix 3) — so they must say the same thing, or unticking
// every chip would silently lie about what gets committed. One formatter so
// the collapsed summary and the expanded editor can't drift apart (round 2
// review).
const formatEligibility = (groupNames) =>
  groupNames == null || groupNames.length === 0 ? 'All groups' : `Groups: ${groupNames.join(', ')}`

export default function ImportScreen({ campId, onNavigate }) {
  // Units and time blocks are scoped to a Program; an import files them under
  // the active one so the setup screens will show them (T33).
  const { activeCohort } = useCohorts(campId)
  // D4 — the post-commit banner's readiness handoff. useSetupCounts already
  // subscribes to op-applied events, so counts refresh after the commit's
  // op-log apply without any extra plumbing here.
  const { counts } = useSetupCounts(campId)
  const [fileNames, setFileNames] = useState([])
  const [preview, setPreview] = useState(null)
  // D2 round 2 — see the comment at its assignment in readFiles.
  const fileGroupUnitsRef = useRef({})
  // Q8 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D5) — same
  // "survives staging" reasoning as fileGroupUnitsRef: normalized(activity
  // name) -> the one place name it was captured next to.
  const fileActivityLocationsRef = useRef({})
  const [chosen, setChosen] = useState({})
  // Proposed recurring fixed events (T34), and which the director has ticked.
  // High-confidence events start ticked; low-confidence start unticked, mirroring
  // the rare-entity treatment. operatingDayCount is only for the "every day" hint.
  const [fixedEvents, setFixedEvents] = useState([])
  const [chosenFixedEvents, setChosenFixedEvents] = useState(new Set())
  const [operatingDayCount, setOperatingDayCount] = useState(0)
  // ADR 2026-08-09 Decision 1 — dualUseNames is a SEED for the activities-list
  // tick-seeding below, not a routing verdict; pinOnlyNames is everything ticked
  // as a fixed event that ISN'T dual-use. Both are display-name sets, used only
  // to default the tick state and render a note — buildPlan never sees them.
  const [dualUseActivityNames, setDualUseActivityNames] = useState(new Set())
  const [pinOnlyActivityNames, setPinOnlyActivityNames] = useState(new Set())
  // ADR 2026-08-09 Decision 2 — the reviewable unit column's per-group state:
  // { [groupName]: unitName } (set) | { [groupName]: { clear: true } } (cleared)
  // | { [groupName]: { editing: true, value } } ("+ New unit…", still typing).
  // Absent for a name is "unset" — leave to the file's own inference.
  const [groupUnitOverrides, setGroupUnitOverrides] = useState({})
  // Inferred (or director-edited) rules per activity name (T35). Plain object,
  // not a Map, so it sits in React state cleanly: name -> { eligible_group_names,
  // min_per_week, max_per_week, priority, _inferred }.
  const [activityRules, setActivityRules] = useState({})
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  // R2'b cutover — `held`/`resolving`/`reconciliation`/`queueAnswers`/
  // `queueOpen`/`rememberNotes` are gone: ReconciliationScreen owns the whole
  // triage/held/commit loop once `ledger` is staged (below).
  // `{ context, fileName, origin }` — the exact commit inputs
  // ReconciliationScreen re-runs as a dry run on every triage action and
  // finally commits. Nothing is written while this is set.
  const [ledger, setLedger] = useState(null)
  // Camp-wide counts of the same entities, unfiltered by Program. Replace
  // (electron/ops/ingest.js's replaceScope) deletes WHERE camp_id = ? with no
  // cohort filter — every Program's rows, not just the active one's — so the
  // confirmation must count camp-wide too, or a multi-Program camp sees a
  // small Program-scoped number while everything is destroyed underneath it.
  const [existingRecordsAll, setExistingRecordsAll] = useState({})
  const [importMode, setImportMode] = useState('add')
  // What Replace destroys that Trash cannot bring back, read in the same
  // pre-confirm pass as the Program-filtered duplicate-check set so the
  // warning can state real numbers.
  // Saved versions survive the delete but their slots name group/activity ids
  // that no longer exist, so restoring one fails; Day Override templates
  // survive as named shells with nothing in them.
  const [snapshotCount, setSnapshotCount] = useState(0)
  const [dayOverrideCount, setDayOverrideCount] = useState(0)
  // Slots placed on EITHER schedule route, camp-wide. replaceScope tears down
  // template_slots and template_overlays for both Manual Build and Generated
  // Schedule (FK ordering forces it), and the director sees the count only
  // in the success banner today — after it has already happened. This reads
  // it pre-confirm instead (Red Hat, T61 round 3).
  const [slotCount, setSlotCount] = useState(0)
  // Fixed Events (anchor_activities) — director-authored content with its own
  // nav screen, deleted by replaceScope step 6 because anchors reference
  // days_of_operation, which step 8 also deletes. Recoverable from Trash,
  // same as slots (T68).
  const [anchorCount, setAnchorCount] = useState(0)

  const REPLACEABLE = INGESTIBLE_ENTITIES.filter((e) => e !== 'cohorts')
  // Camp-wide count — what Replace actually deletes. This drives the
  // confirmation copy the director sees before committing.
  const existingCountAll = REPLACEABLE.reduce((n, e) => n + (existingRecordsAll[e]?.length ?? 0), 0)

  // A camp's schedule can arrive as several files — Camp Mindy exports one
  // spreadsheet per group. They are one camp and must be read as one import,
  // or the same days and activities are proposed four times over and the
  // groups arrive in four separate passes.
  async function readFiles(fileList) {
    setError(null)
    setResult(null)
    setLedger(null)
    setFixedEvents([])
    setChosenFixedEvents(new Set())
    setActivityRules({})
    setGroupUnitOverrides({})
    const files = [...(fileList ?? [])]
    if (files.length === 0) return
    setFileNames(files.map((f) => f.name))

    try {
      // The camp's own name and the year are in every filename, so they say
      // nothing about which group a file is. What differs is the group.
      const prefix = sharedFilenamePrefix(files.map((f) => f.name))
      const pages = []

      for (const file of files) {
        const title = groupNameFromFilename(file.name, prefix)
        if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
          // F4 — fail closed before the bytes reach the parser, then bound the
          // parsed workbook, so a zip-bomb/oversize file imports nothing.
          assertImportFileSize(file.size)
          const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
          assertWorkbookComplexity(wb)
          // S4b — a Shoresh enrichment workbook (carries the hidden metadata
          // sheet) is a round-trip, NOT a raw schedule. It re-enters through the
          // SAME buildPlan→commit pipeline via the id-match tier, not entity
          // inference. Short-circuit the schedule reader entirely.
          if (wb.SheetNames.includes(META_SHEET)) {
            await handleWorkbookReimport(wb, file.name)
            return
          }
          const sheets = wb.SheetNames.map((name) => ({
            name,
            // raw:false so Excel formats each cell the way the sheet displays it.
            // A time typed as a time is stored as a fraction of a day — 9:15am
            // is 0.3854166666666667 — and reading it raw puts that number in
            // the camp as the name of a period.
            // unescapeRow reverses any leading-apostrophe our own export wrote,
            // so an escaped literal round-trips and never re-enters as a formula.
            rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false }).map(unescapeRow),
          }))
          pages.push(...workbookToPages(sheets, title))
        } else {
          pages.push(...parseTextGrid(await file.text()).pages)
        }
      }

      if (pages.length === 0) {
        setPreview(null)
        setError('No schedule could be read out of that. It may be a scan rather than a document with text in it.')
        return
      }

      const proposal = extractEntities({ pages })
      const existing = {}
      const existingAll = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        const rows = await localClient.list(entity).catch(() => [])
        existingAll[entity] = rows
        // Duplicate-detection for the Program-scoped entities is scoped to the
        // active Program, or a re-import into a different Program would skip a
        // unit/time-block that only exists in another one (T33). This is
        // deliberately narrower than existingAll above — see existingCountAll.
        existing[entity] = (entity === 'tiers' || entity === 'time_blocks') && activeCohort
          ? rows.filter((r) => r.cohort_id === activeCohort.id)
          : rows
      }
      setExistingRecordsAll(existingAll)
      setSnapshotCount((await localClient.list('schedule_snapshots').catch(() => [])).length)
      setDayOverrideCount((await localClient.list('day_override_templates').catch(() => [])).length)
      setSlotCount((await localClient.list('template_slots').catch(() => [])).length)
      setAnchorCount((await localClient.list('anchor_activities').catch(() => [])).length)
      setImportMode('add')
      const next = buildPreview(proposal, existing)
      setPreview(next)
      // D2 round 2 — buildCommitInputs() needs this file-inferred groupUnits
      // map even after staging nulls `preview` out (commitInputsWithResolutions
      // calls buildCommitInputs() again live, to pick up post-staging edits).
      // A ref survives that null without re-rendering or needing its own reset
      // bookkeeping — a fresh upload simply overwrites it.
      fileGroupUnitsRef.current = next.groupUnits ?? {}
      fileActivityLocationsRef.current = proposal.activityLocations ?? {}

      // Recurring fixed events implied by the grid (T34). High-confidence ones
      // (holding on every operating day) start ticked; low-confidence ones (a
      // majority but not all) start unticked — the same treatment rare entities
      // get. All are shown; ticking is the director's act.
      const { fixedEvents: inferred, dualUseNames = [] } = inferFixedEvents({ pages }, proposal)
      setFixedEvents(inferred)
      const initialTickedFixedEvents = new Set(inferred.filter((fe) => autoAccepts(fe.confidence)).map(fixedEventKey))
      setChosenFixedEvents(initialTickedFixedEvents)
      setOperatingDayCount(proposal.entities.days_of_operation.length)

      // ADR 2026-08-09 Decision 1 — a ticked fixed-event name that is NOT
      // dual-use defaults OUT of the activities catalog (it is never a free
      // choice in the source file); ticking its row is the one-click override.
      const dualUseSet = new Set(dualUseNames)
      const initialTickedFixedEventNames = new Set(
        inferred.filter((fe) => autoAccepts(fe.confidence)).map((fe) => fe.name)
      )
      const pinOnlySet = new Set([...initialTickedFixedEventNames].filter((n) => !dualUseSet.has(n)))
      setDualUseActivityNames(dualUseSet)
      setPinOnlyActivityNames(pinOnlySet)

      // Everything starts approved except values the file gives no reason to
      // trust — seen once across the camp AND not universal in any one unit,
      // or a name that is two other proposed names welded together — OR a
      // pin-only fixed-event name (Decision 1, above). Nothing is hidden
      // either way; the unticked rows are right there with their note or count.
      const initial = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        const { create, lowConfidence = [] } = next.perEntity[entity]
        const low = new Set(lowConfidence)
        // Q8 (§D5): a location create candidate defaults UNTICKED — the one
        // deviation from every other entity's create-defaults-ticked-unless-
        // low-confidence rule, mirroring the fixed-event pin-only precedent.
        // Nothing is ever minted or bound without the director's explicit tick.
        initial[entity] = entity === 'locations'
          ? new Set()
          : new Set(create.filter((n) => !low.has(n) && !(entity === 'activities' && pinOnlySet.has(n))))
      }
      setChosen(initial)

      // Rule inference (T35) — same "propose, director confirms" shape as the
      // entities and fixed events above.
      const rules = inferActivityRules(
        proposal.entities.activities,
        proposal.activityPages,
        proposal.seenCounts,
        proposal.entities.days_of_operation.length,
        proposal.entities.groups
      )
      setActivityRules(Object.fromEntries(rules))
    } catch (err) {
      setPreview(null)
      setError(describeWriteFailure(err, 'That file could not be read.'))
    }
  }

  // S4b — a Shoresh enrichment workbook re-import. Parse it back into a buildPlan
  // source via the hardened adapter (allowlist, baseline-diff, fail-closed
  // metadata, forced add-mode), then commit through the SAME pipeline as the
  // schedule preview — the two import faces unified (ADR §2). T75 — the workbook
  // no longer bypasses the preview: it stages the SAME reconciliation ledger the
  // schedule path does, the director confirms from it, and only then does the
  // atomic ingestCommit run, surfacing held/T73 exactly as the schedule path does.
  async function handleWorkbookReimport(wb, fileName) {
    const camp = await localClient.getCamp().catch(() => null)
    let source
    try {
      source = workbookToSource(wb, { camp_id: camp?.id ?? null, cohort_id: activeCohort?.id ?? null })
    } catch (err) {
      // A fail-closed reject (missing/edited metadata, camp/cohort mismatch) is a
      // clear user-facing message, not a crash — nothing was imported.
      setPreview(null)
      setError(err?.message ?? 'That worksheet could not be read.')
      return
    }
    if (!activeCohort) {
      setError('Waiting for a Program to load before importing. Try again in a moment.')
      return
    }
    await stageLedger({
      approved: source.approved,
      links: { groups: {} },
      cohort_id: activeCohort?.id ?? null,
      fixedEvents: [],
      activityRules: {},
      mode: 'add',
      // The staleness clock is the workbook's EXPORTED generation (ADR §4), not
      // the current op-seq — a field written after the export is what makes it stale.
      base_generation: source.base_generation,
    }, fileName, 'workbook')
  }

  // S4a — the enrichment-workbook EXPORT. A read-only download: read the camp's
  // current entities and produce a pre-populated xlsx the director can edit and
  // re-import (S4b). Writes nothing to the camp.
  //
  // base_generation is stamped null here: the op-log generation the staleness
  // gate diffs against is not yet surfaced to the renderer, and its consumer is
  // S4b. Sourcing a real value needs a read-only max-op-seq accessor S4b adds.
  const [exporting, setExporting] = useState(false)
  async function downloadWorksheet() {
    setExporting(true)
    setError(null)
    try {
      const camp = await localClient.getCamp().catch(() => null)
      const entities = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        entities[entity] = await localClient.list(entity).catch(() => [])
      }
      // S4b §4 — stamp the REAL op-log generation so a re-import can detect a
      // workbook filled against a stale export (import-over-import staleness).
      const base_generation = await localClient.latestOpSeq().catch(() => 0)
      downloadWorkbook({
        ...entities,
        camp_id: camp?.id ?? null,
        cohort_id: activeCohort?.id ?? null,
        base_generation,
      })
    } catch (err) {
      setError(describeWriteFailure(err, 'The worksheet could not be created.'))
    } finally {
      setExporting(false)
    }
  }

  function toggle(entity, name) {
    setChosen(prev => {
      const set = new Set(prev[entity])
      if (set.has(name)) set.delete(name)
      else set.add(name)
      return { ...prev, [entity]: set }
    })
  }

  function toggleFixedEvent(key) {
    setChosenFixedEvents(prev => {
      const set = new Set(prev)
      if (set.has(key)) set.delete(key)
      else set.add(key)
      return set
    })
  }

  // Editing a field clears `_inferred` for that activity's whole rule, so the
  // styling reflects it is now the director's value rather than a proposal. It
  // ALSO records WHICH fields the director touched (as SOURCE field names) in
  // `_editedFields`, so buildCommitInputs can mark only those source:'human' —
  // protecting the hand-edit from a later re-import (Policy A) while leaving the
  // rule's still-inferred fields freely re-importable (the activity-rule half of
  // Decision 2). Field-level, not rule-level: editing min_per_week must not also
  // freeze an untouched max_per_week.
  function updateActivityRule(name, patch) {
    setActivityRules((prev) => {
      const prevRule = prev[name] ?? {}
      const edited = new Set(prevRule._editedFields ?? [])
      for (const key of Object.keys(patch)) {
        const src = RULE_FIELD_TO_SOURCE[key]
        if (src) edited.add(src)
      }
      return { ...prev, [name]: { ...prevRule, ...patch, _inferred: false, _editedFields: [...edited] } }
    })
  }

  function toggleRuleGroup(name, groupName, allGroups) {
    const current = activityRules[name]?.eligible_group_names
    // null means "all groups" — the chips all show as on, so the first click
    // must start from that full set (every OTHER group stays on) rather than
    // an empty one, or unticking one chip would silently drop every group.
    const set = new Set(current ?? allGroups)
    if (set.has(groupName)) set.delete(groupName)
    else set.add(groupName)
    // The director just told us which groups directly — this is no longer
    // the "couldn't tell from the file" state (T35 Fix 2b), whatever it was
    // before the click.
    updateActivityRule(name, { eligible_group_names: [...set], eligibility_known: true })
  }

  // A single global control, not per-activity — simpler, and a director who
  // wants to start from scratch wants that for every activity, not one at a
  // time (spec §"Preview UI changes").
  function clearInferredRules() {
    setActivityRules({})
  }

  const approvedCount = Object.values(chosen).reduce((n, set) => n + set.size, 0)

  // The exact inputs a commit sends — built once here so a held re-commit (T73)
  // re-sends the SAME inputs plus the director's resolutions (ADR §1).
  function buildCommitInputs() {
    const approved = {}
    for (const entity of INGESTIBLE_ENTITIES) approved[entity] = [...(chosen[entity] ?? [])]
    // ADR 2026-08-09 Decision 2 — three explicit per-group unit review states.
    // Only groups actually being created are considered, so a bunk the
    // director unticked cannot drag a unit (or a clear) in behind it.
    const groupUnits = {}
    const groupClears = {}
    const groupHumanFields = {}
    for (const name of approved.groups ?? []) {
      const override = groupUnitOverrides[name]
      if (override && typeof override === 'object' && override.clear) {
        // 3. Explicitly cleared — routes through record.clears, NOT groupUnits/
        // links.groups (Red Hat Risk 1: a clear is not a value).
        groupClears[name] = ['unit']
        groupHumanFields[name] = ['unit']
      } else if (override && typeof override === 'object' && override.editing) {
        // 2b. "+ New unit…" — a typed name not in either tier list.
        const typed = String(override.value ?? '').trim()
        if (typed) {
          groupUnits[name] = typed
          groupHumanFields[name] = ['unit']
          if (!approved.tiers.some((t) => normalizeName(t) === normalizeName(typed))) {
            approved.tiers.push(typed)
          }
        }
      } else if (typeof override === 'string' && override) {
        // 2a. Set to an existing/proposed tier — the director picked it.
        groupUnits[name] = override
        groupHumanFields[name] = ['unit']
      } else if (fileGroupUnitsRef.current?.[name]) {
        // 1. Unset — leave to the file's own inference, unchanged. Reads the
        // ref (not `preview`, which stageLedger nulls once staged) so this
        // still works when buildCommitInputs() is rebuilt live at commit
        // time (commitInputsWithResolutions, D2 round 2).
        groupUnits[name] = fileGroupUnitsRef.current[name]
      }
    }
    // Only the fixed events the director ticked; unticked ones are not sent.
    const tickedFixedEvents = fixedEvents.filter((fe) => chosenFixedEvents.has(fixedEventKey(fe)))
    // Only rules for activities the director actually approved — an
    // activity they unticked must not carry a rule into commitIngest, same
    // principle as groupUnits above. priority passes through as-is: post-B2
    // (commit 57f75ed) an inferred rule's priority is UNKNOWN (undefined) unless
    // the director set it in the editor, and undefined is resolved to the
    // engine's two-valued contract at generation time, not here.
    const outgoingRules = {}
    // Per approved activity, the SOURCE field names the director hand-edited —
    // marked source:'human' at commit so a later re-import cannot silently
    // overwrite them (Policy A). Only touched fields go in; an untouched,
    // file-inferred rule field stays absent and re-importable. Same mechanism as
    // the unit column above, keyed under `activities` in the SAME humanEditedFields
    // map (docs/adr/2026-08-09-activity-rule-hand-edit-provenance.md).
    const activityHumanFields = {}
    for (const name of approved.activities ?? []) {
      const rule = activityRules[name]
      if (!rule) continue
      outgoingRules[name] = {
        eligible_group_names: rule.eligible_group_names ?? null,
        min_per_week: rule.min_per_week,
        max_per_week: rule.max_per_week,
        priority: rule.priority,
      }
      // Q8 (§D5): gate the paired location on the director's own tick — a
      // captured location that is not ticked is simply omitted, never sent,
      // the same "preserve" semantics buildPlan already gives any absent
      // field. This is what keeps Q8 genuinely propose-only: no location row
      // is ever minted, and no activity is ever bound to one, without it.
      const pairedLocation = fileActivityLocationsRef.current[normalizeName(name)]
      if (pairedLocation && chosen.locations?.has(pairedLocation)) {
        outgoingRules[name].location = pairedLocation
      }
      const edited = Array.isArray(rule._editedFields) ? rule._editedFields : []
      if (edited.length > 0) activityHumanFields[name] = edited
    }
    return {
      approved,
      links: { groups: groupUnits },
      clears: { groups: groupClears },
      humanEditedFields: { groups: groupHumanFields, activities: activityHumanFields },
      cohort_id: activeCohort?.id ?? null,
      fixedEvents: tickedFixedEvents,
      activityRules: outgoingRules,
      mode: importMode === 'replace' ? 'replace' : 'add',
    }
  }

  // R2'b cutover — ReconciliationScreen owns the whole triage/dry-run/commit
  // loop now (ADR Seam 3): it re-issues localClient.ingestReconcile itself on
  // every triage action and calls localClient.ingestCommit for the final
  // apply. This screen's job is reduced to staging the base commit inputs
  // once the director confirms the file preview — no renderer-side buildPlan,
  // no separate held/queue surfaces to keep in sync.
  function stageLedger(inputs, fileName, origin = 'schedule') {
    setPreview(null)
    setLedger({ context: inputs, fileName, origin })
  }

  function commit() {
    // S5b — the tick-preview no longer commits directly; it stages the base
    // commit inputs and hands off to ReconciliationScreen, which owns the
    // whole triage/dry-run/apply loop from here (R2'b cutover).
    stageLedger(buildCommitInputs(), fileNames.join(', '), 'schedule')
  }

  // ReconciliationScreen's onCommitted/onDiscard — tears the staged ledger
  // down to the normal result, or back to the file picker, respectively.
  function handleReconciliationCommitted(outcome) {
    setResult(outcome)
    setLedger(null)
    setFileNames([])
    setFixedEvents([])
    setChosenFixedEvents(new Set())
    setActivityRules({})
    setGroupUnitOverrides({})
  }

  function handleReconciliationDiscard() {
    setLedger(null)
    setFileNames([])
    setFixedEvents([])
    setChosenFixedEvents(new Set())
    setActivityRules({})
    setGroupUnitOverrides({})
  }

  // R2'b cutover — once a report exists (the director has staged an import),
  // ReconciliationScreen becomes the whole surface: one continuous scroll,
  // no upload widget or preview underneath (spec §0). The file-upload/parse
  // antechamber below only renders before that point.
  if (ledger) {
    return (
      <ReconciliationScreen
        baseInputs={ledger.context}
        sourceLabel={ledger.fileName}
        onCommitted={handleReconciliationCommitted}
        onDiscard={handleReconciliationDiscard}
        onNavigate={onNavigate}
      />
    )
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', maxWidth: '62ch' }}>
        Already have last year's schedule? Open it here and Shoresh will read the groups, days,
        periods and activities out of it. Nothing is added until you have looked at the list and
        said so.
      </p>

      {error && <div style={{ ...S.errorBanner, marginBottom: 16 }}>{error}</div>}

      {result && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderLeft: '3px solid var(--success)', borderRadius: 8, padding: '12px 14px',
          marginBottom: 16, fontSize: 13, lineHeight: 1.6,
        }}>
          <strong>
            Imported {result.total} {result.total === 1 ? 'record' : 'records'}
            {result.fixedEvents?.created > 0 && `, including ${result.fixedEvents.created} fixed ${result.fixedEvents.created === 1 ? 'event' : 'events'}`}.
          </strong>{' '}
          They are ordinary records now — edit or delete any of them from the setup screens, and
          anything you delete can be brought back from Trash.
          {result.fixedEvents?.skipped?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {result.fixedEvents.skipped.length} fixed {result.fixedEvents.skipped.length === 1 ? 'event' : 'events'} couldn’t
              be created because their time block or groups weren’t imported — you can add {result.fixedEvents.skipped.length === 1 ? 'it' : 'them'} on the Fixed Events screen.
            </div>
          )}
          {result.fixedEvents?.partial?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              Some fixed events were added for fewer days or groups than proposed, because you didn’t import all of them:{' '}
              {result.fixedEvents.partial.map((p) => `${p.name} (${p.reason})`).join('; ')}. Adjust {result.fixedEvents.partial.length === 1 ? 'it' : 'them'} on the Fixed Events screen.
            </div>
          )}
          {result.fixedEvents?.moved?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {result.fixedEvents.moved.length} fixed {result.fixedEvents.moved.length === 1 ? 'event has' : 'events have'} moved since this file was last imported, so {result.fixedEvents.moved.length === 1 ? 'it was' : 'they were'} left as-is instead of creating a duplicate:{' '}
              {result.fixedEvents.moved.map((m) => `${m.name} (${m.reason})`).join('; ')}.
            </div>
          )}
          {/* What the Replace destroyed, stated rather than implied — an
              import never silently omits (ADR §1), and that cuts both ways. */}
          {result.replaced && (
            <div style={{ marginTop: 8 }}>
              {sumCounts(result.replaced.entities)} old setup {sumCounts(result.replaced.entities) === 1 ? 'record was' : 'records were'} cleared first,
              along with {sumCounts(result.replaced.dependents)} schedule {sumCounts(result.replaced.dependents) === 1 ? 'row' : 'rows'} that used {sumCounts(result.replaced.entities) === 1 ? 'it' : 'them'}.
            </div>
          )}
          {counts != null && (
            <ImportReadinessNote counts={counts} />
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
            <button className="press-97" onClick={() => onNavigate('groups')} style={S.btnSecondary}>Go to Groups</button>
            {counts != null && (
              <button className="press-97" onClick={() => onNavigate('readiness')} style={readinessLinkBtn}>
                See Setup Readiness
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '16px', marginBottom: 20,
      }}>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 8, color: 'var(--text)' }}>
          Choose the file, or all of them
        </label>
        <input
          type="file"
          multiple
          accept=".xlsx,.xlsm,.xls,.txt,.csv,.tsv"
          onChange={e => readFiles(e.target.files)}
          style={{ fontSize: 13 }}
        />
        {fileNames.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', lineHeight: 1.6 }}>
            {fileNames.join(', ')}
          </div>
        )}
        {/* S4a — download a worksheet pre-filled with what the camp already
            knows, to edit and re-import. Read-only; writes nothing. */}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
            Prefer to fill in the details in a spreadsheet? Download a worksheet with everything Shoresh
            already knows, edit it, and open it back here.
          </div>
          <button className="press-97" onClick={downloadWorksheet} disabled={exporting} style={{ ...S.btnSecondary, opacity: exporting ? 0.45 : 1 }}>
            {exporting ? 'Preparing…' : 'Download worksheet'}
          </button>
        </div>
      </div>

      {preview && (
        <>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderLeft: `3px solid var(--${preview.isNoOp ? 'accent' : 'primary'})`,
            borderRadius: 8, padding: '12px 14px', marginBottom: 8, fontSize: 13, lineHeight: 1.6,
          }}>
            {describePreview(preview)}
          </div>

          {/* The orientation was detected, not known. Saying so lets a director
              catch a misread before it becomes their data (ADR §7). */}
          {preview.orientation && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.6 }}>
              {preview.orientation.confident
                ? `Read as one page per ${preview.orientation.pages === 'groups' ? 'group, with the days across the top' : 'day, with the groups across the top'}.`
                : 'Could not tell how this file is laid out, so some of the list below may be wrong. Worth checking closely.'}
            </div>
          )}

          {INGESTIBLE_ENTITIES.map(entity => {
            const { create, skip, lowConfidence = [] } = preview.perEntity[entity]
            if (create.length === 0 && skip.length === 0) return null
            return (
              <div key={entity} style={{ marginBottom: 20 }}>
                <div style={{
                  fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: 'var(--text-secondary)', marginBottom: 8,
                }}>
                  {LABEL[entity]}
                </div>

                {lowConfidence.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
                    {lowConfidence.length} of these appeared only once in the file, so they are more
                    likely to be a misread than something your camp does. They are left unticked —
                    tick any that are real.
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {create.map(name => {
                    const on = chosen[entity]?.has(name)
                    const seen = preview.perEntity[entity].counts?.[name]
                    const isPinOnly = entity === 'activities' && pinOnlyActivityNames.has(name)
                    const isDualUse = entity === 'activities' && dualUseActivityNames.has(name)
                    const isLocationCandidate = entity === 'locations'
                    return (
                      <button
                        key={name}
                        title={seen ? `Found ${seen} ${seen === 1 ? 'time' : 'times'} in the file` : undefined}
                        onClick={() => toggle(entity, name)}
                        style={{
                          fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                          fontFamily: 'inherit',
                          background: on ? 'color-mix(in srgb, var(--success) 12%, var(--surface))' : 'var(--bg)',
                          border: `1px solid ${on ? 'var(--success)' : 'var(--border)'}`,
                          color: on ? 'var(--text)' : 'var(--text-secondary)',
                          textDecoration: on ? 'none' : 'line-through',
                        }}
                      >
                        {on ? '✓ ' : ''}{name}
                        {seen > 1 && (
                          <span style={{ marginLeft: 6, opacity: 0.55, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                            ×{seen}
                          </span>
                        )}
                        {/* ADR 2026-08-09 Decision 1 — the routing default must be
                            visible and reversible before commit, not silent. */}
                        {isPinOnly && (
                          <div style={{ fontSize: 10, marginTop: 2, fontWeight: 400, textDecoration: 'none', opacity: 0.8 }}>
                            Scheduled as a fixed event — not added to the activity catalog.
                          </div>
                        )}
                        {isDualUse && (
                          <div style={{ fontSize: 10, marginTop: 2, fontWeight: 400, textDecoration: 'none', opacity: 0.8 }}>
                            Also appears as a fixed event.
                          </div>
                        )}
                        {/* Q8 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D5) —
                            a place is propose-only: nothing is created and no
                            activity is bound to it until the director ticks it. */}
                        {isLocationCandidate && (
                          <div style={{ fontSize: 10, marginTop: 2, fontWeight: 400, textDecoration: 'none', opacity: 0.8 }}>
                            Seen in this file as a room. Tick to add it as a place and put these activities on it.
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* ADR §5 — a skip is silently partial unless it is named
                    before the confirm, with what it matched. */}
                {skip.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                    Already in your camp, so they will be left alone:{' '}
                    {skip.map(s => s.name).join(', ')}.
                  </div>
                )}

                {/* ADR 2026-08-09 Decision 2 — the reviewable unit column, one
                    per ticked group: unset (file inference), a picked/typed
                    unit, or an explicit clear. Only groups actually being
                    created are shown, same gating as the activity rules below. */}
                {entity === 'groups' && create.some((n) => chosen.groups?.has(n)) && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
                      Which unit each group belongs to. Left as-is uses what the file itself says.
                    </div>
                    {create.filter((n) => chosen.groups?.has(n)).map((name) => {
                      const override = groupUnitOverrides[name]
                      const isClear = !!(override && typeof override === 'object' && override.clear)
                      const isEditing = !!(override && typeof override === 'object' && override.editing)
                      const selectValue = isClear ? '__clear__' : isEditing ? '__new__' : (typeof override === 'string' ? override : '')
                      const tierNames = [...new Set([
                        ...(preview.perEntity.tiers?.create ?? []),
                        ...(existingRecordsAll.tiers ?? [])
                          .filter((t) => !activeCohort || t.cohort_id === activeCohort.id)
                          .map((t) => t.name),
                      ])]
                      return (
                        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
                          <span style={{ minWidth: 140, color: 'var(--text-secondary)' }}>{name}</span>
                          <select
                            value={selectValue}
                            onChange={(e) => {
                              const v = e.target.value
                              setGroupUnitOverrides((prev) => {
                                const next = { ...prev }
                                if (v === '') delete next[name]
                                else if (v === '__clear__') next[name] = { clear: true }
                                else if (v === '__new__') next[name] = { editing: true, value: '' }
                                else next[name] = v
                                return next
                              })
                            }}
                            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                          >
                            <option value="">{preview.groupUnits?.[name] ? `From file: ${preview.groupUnits[name]}` : 'No unit (from file)'}</option>
                            {tierNames.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                            <option value="__new__">+ New unit…</option>
                            <option value="__clear__">No unit</option>
                          </select>
                          {isEditing && (
                            <input
                              autoFocus
                              value={override.value}
                              placeholder="Unit name"
                              onChange={(e) => {
                                const value = e.target.value
                                setGroupUnitOverrides((prev) => ({ ...prev, [name]: { editing: true, value } }))
                              }}
                              style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Inferred scheduling rules (T35) — only for activities the
                    director has ticked, since an unticked activity is not
                    being created and a rule for it would have nothing to
                    attach to. */}
                {entity === 'activities' && create.some((n) => chosen.activities?.has(n)) && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        Guessed how often and for whom, from the file. Edit anything that looks wrong.
                      </div>
                      <button className="press-97" onClick={clearInferredRules} style={{ ...S.btnSecondary, padding: '4px 10px', fontSize: 11 }}>
                        Clear inferred rules
                      </button>
                    </div>
                    {create.filter((n) => chosen.activities?.has(n)).map((name) => (
                      <ActivityRuleRow
                        key={name}
                        name={name}
                        rule={activityRules[name]}
                        allGroups={preview.perEntity.groups?.create ?? []}
                        onChange={(patch) => updateActivityRule(name, patch)}
                        onToggleGroup={(g) => toggleRuleGroup(name, g, preview.perEntity.groups?.create ?? [])}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {/* Fixed Events (T34). Activities pinned to the same period across a
              group's days — Mifkad, Lunch, Swim. Tick-only, like the entity
              sections: an imported fixed event is an ordinary anchor, so its full
              editor already exists on the Fixed Events screen (spec §4.2). */}
          {fixedEvents.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{
                fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                color: 'var(--text-secondary)', marginBottom: 8,
              }}>
                Fixed Events
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
                These activities sat at the same time across a group’s days, so they look fixed rather
                than scheduled fresh each day. Ticked ones are added as fixed events you can edit later.
              </div>
              {fixedEvents.some((fe) => fe.confidence === 'low') && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
                  Some appeared on a majority of a group’s days but not all, so they are left unticked —
                  tick any that really are fixed.
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {fixedEvents.map((fe) => {
                  const key = fixedEventKey(fe)
                  const on = chosenFixedEvents.has(key)
                  const scope = fe.scope.is_all_groups ? 'every group' : fe.scope.groups.join(', ')
                  const daysLabel = operatingDayCount > 0 && fe.days.length >= operatingDayCount
                    ? 'every day'
                    : fe.days.join(', ')
                  return (
                    <button
                      key={key}
                      onClick={() => toggleFixedEvent(key)}
                      style={{
                        fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                        fontFamily: 'inherit', textAlign: 'left',
                        background: on ? 'color-mix(in srgb, var(--success) 12%, var(--surface))' : 'var(--bg)',
                        border: `1px solid ${on ? 'var(--success)' : 'var(--border)'}`,
                        color: on ? 'var(--text)' : 'var(--text-secondary)',
                        textDecoration: on ? 'none' : 'line-through',
                      }}
                    >
                      {on ? '✓ ' : ''}{fe.name}
                      <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>
                        · {fe.time_block} · {scope} · {daysLabel}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Keep-vs-replace. Only asked when the camp already holds setup —
              importing onto an empty camp has nothing to replace. Replace is
              recoverable (Trash), so it is a plain choice, not a scary gate.
              Both counts here are existingCountAll (camp-wide), because
              replaceScope (electron/ops/ingest.js) deletes WHERE camp_id = ?
              with no cohort filter — every Program's setup, not just the
              active one's — and the director must confirm the number that
              actually gets deleted, not the Program-scoped one. */}
          {existingCountAll > 0 && (
            <div style={{
              marginTop: 20, padding: '14px 16px', background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 8,
            }}>
              <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 10 }}>
                Your camp already has <strong>{existingCountAll}</strong> {existingCountAll === 1 ? 'item' : 'items'} set up across the entire camp. What should happen to {existingCountAll === 1 ? 'it' : 'them'}?
              </div>
              {[
                { key: 'add', title: 'Keep them', sub: 'Add what I import alongside what’s already here.' },
                { key: 'replace', title: 'Replace them', sub: `This will replace all Units, Groups, Days, Time Blocks, and Activities across the entire camp — every Program, not just this one. Clears the ${existingCountAll} existing ${existingCountAll === 1 ? 'item' : 'items'} first, then imports.` },
              ].map(opt => {
                const on = importMode === opt.key
                return (
                  <button
                    key={opt.key}
                    onClick={() => setImportMode(opt.key)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                      marginTop: opt.key === 'add' ? 0 : 8, padding: '10px 12px', borderRadius: 7,
                      fontFamily: 'inherit',
                      background: on ? `color-mix(in srgb, var(--primary) 8%, var(--surface))` : 'var(--bg)',
                      border: `1.5px solid ${on ? 'var(--primary)' : 'var(--border)'}`,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {on ? '● ' : '○ '}{opt.title}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, marginLeft: 16 }}>{opt.sub}</div>
                  </button>
                )
              })}

              {/* What Replace destroys beyond the setup records above, said
                  before the confirm rather than discovered weeks later.
                  Split into two sub-blocks (T68): recoverable items — slots,
                  Fixed Events, Day Override templates — share one bordered
                  container in --accent (temporary/recoverable per
                  DESIGN_STANDARD); saved versions get their own --danger
                  container, always last, because they are the one item that
                  is NOT Trash-restorable and must not read as a peer of the
                  others. Rendered as arrays with index-based spacing rather
                  than pairwise marginTop conditionals, which stop being
                  eyeball-verifiable past three items (Code Reviewer, T61). */}
              {importMode === 'replace' && (() => {
                const recoverableWarnings = [
                  { key: 'slots', count: slotCount, render: () => (
                      <>Both your <strong>Manual Build</strong> and <strong>Generated Schedule</strong> will
                      be cleared ({slotCount} {slotCount === 1 ? 'slot' : 'slots'}).</>) },
                  { key: 'anchors', count: anchorCount, render: () => (
                      <>Your <strong>{anchorCount}</strong> Fixed {anchorCount === 1 ? 'Event' : 'Events'} will
                      be cleared. {anchorCount === 1 ? 'It is' : 'They are'} recoverable from Trash.</>) },
                  { key: 'dayOverrides', count: dayOverrideCount, render: () => (
                      <>Your {dayOverrideCount} Day Override {dayOverrideCount === 1 ? 'template keeps its name' : 'templates keep their names'} but
                      {dayOverrideCount === 1 ? ' is' : ' are'} emptied — you will need to fill {dayOverrideCount === 1 ? 'it' : 'them'} in again.</>) },
                ].filter((w) => w.count > 0)

                const irreversibleWarnings = [
                  { key: 'snapshots', count: snapshotCount, render: () => (
                      <>You have <strong>{snapshotCount}</strong> saved schedule {snapshotCount === 1 ? 'version' : 'versions'}.
                      Unlike the items above, {snapshotCount === 1 ? 'this is' : 'these are'} not Trash-restorable —
                      {snapshotCount === 1 ? ' it names' : ' they name'} groups and activities that will no longer exist,
                      so replacing makes {snapshotCount === 1 ? 'it' : 'them'} permanently unrestorable.</>) },
                ].filter((w) => w.count > 0)

                if (recoverableWarnings.length === 0 && irreversibleWarnings.length === 0) return null

                return (
                  <div>
                    {recoverableWarnings.length > 0 && (
                      <div style={{
                        marginTop: 10, padding: '10px 12px', borderRadius: 7,
                        background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
                        border: '1px solid color-mix(in srgb, var(--accent) 40%, var(--border))',
                        fontSize: 12, lineHeight: 1.6, color: 'var(--text)',
                      }}>
                        {recoverableWarnings.map((w, i) => (
                          <div key={w.key} style={{ marginTop: i === 0 ? 0 : 6 }}>{w.render()}</div>
                        ))}
                      </div>
                    )}
                    {irreversibleWarnings.length > 0 && (
                      <div style={{
                        marginTop: recoverableWarnings.length > 0 ? 8 : 10, padding: '10px 12px', borderRadius: 7,
                        background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
                        border: '1px solid color-mix(in srgb, var(--danger) 40%, var(--border))',
                        fontSize: 12, lineHeight: 1.6, color: 'var(--text)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                          <span style={{ fontWeight: 600, color: 'var(--danger)' }}>Cannot be undone</span>
                        </div>
                        {irreversibleWarnings.map((w) => (
                          <div key={w.key} style={{ marginTop: 6 }}>{w.render()}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )}

          {/* Without an active Program, units and time blocks would be filed
              nowhere and vanish from the setup screens (T33); block the commit
              rather than import into limbo. "Main" is auto-created, so this is a
              still-loading guard, not a normal state. */}
          {!activeCohort && (
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-secondary)' }}>
              Waiting for a Program to load before importing…
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 24, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <button className="press-97"
              onClick={commit}
              disabled={approvedCount === 0 || !activeCohort}
              style={{ ...S.btnPrimary, opacity: approvedCount === 0 || !activeCohort ? 0.45 : 1 }}
            >
              {importMode === 'replace' && existingCountAll > 0
                ? `Replace with ${approvedCount} ${approvedCount === 1 ? 'record' : 'records'}`
                : `Add ${approvedCount} ${approvedCount === 1 ? 'record' : 'records'}`}
            </button>
            <button className="press-97" onClick={() => { setPreview(null); setFileNames([]) }} style={S.btnSecondary}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// One activity's inferred (or edited) rule: a compact summary line plus
// inline editing. `rule` is undefined for an activity nothing was inferred
// for (e.g. it never appeared in a `days`-oriented grid, T35 gotcha) — that
// activity gets blank inputs, same as before this work, not a crash.
function ActivityRuleRow({ name, rule, allGroups, onChange, onToggleGroup }) {
  const [expanded, setExpanded] = useState(false)
  const inferred = rule?._inferred !== false && rule != null
  const textColor = inferred ? 'var(--text-secondary)' : 'var(--text)'
  const groupNames = rule?.eligible_group_names ?? null // null = all groups
  // T35 Fix 2b — no page-level signal existed for this activity at all, so
  // "All groups" below would be an absence of evidence dressed as a
  // conclusion. Full-contrast, not muted like other inferred fields: this is
  // a thing worth the director's attention, not a confident default.
  const eligibilityUnknown = rule != null && rule.eligibility_known === false

  const eligibilitySummary = formatEligibility(groupNames)
  const frequencySummary = rule?.min_per_week != null && rule?.max_per_week != null
    ? `${rule.min_per_week}–${rule.max_per_week}×/wk`
    : 'Not set'
  const prioritySummary = PRIORITY_LABEL[rule?.priority ?? 'low']

  const chevron = (
    <svg
      aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      style={{
        flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform var(--motion-base) var(--ease-standard)',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )

  const adjustButton = (
    <button
      type="button"
      onClick={() => setExpanded((e) => !e)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'inherit',
        border: 'none', background: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text) 5%, transparent)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
    >
      Adjust
      {chevron}
    </button>
  )

  // The outer container's own box (border, radius, margin, background) is
  // identical in both states — only the content inside, and therefore the
  // height, changes (spec: "silhouette must not jump"). A reveal keyframe
  // (max-height + opacity) plays on the inner wrapper of whichever content
  // mounts; reduced-motion turns it off via the component-scoped media query.
  const containerStyle = {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
    padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)',
    marginBottom: 6, fontSize: 12, background: 'var(--bg)',
  }
  const revealStyle = {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, width: '100%',
    overflow: 'hidden', animation: 'importRuleReveal var(--motion-base) var(--ease-standard)',
  }
  const revealKeyframes = (
    <style>{`
      @keyframes importRuleReveal { from { max-height: 0; opacity: 0; } to { max-height: 200px; opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .import-rule-reveal { animation: none !important; } }
    `}</style>
  )

  if (!expanded) {
    return (
      <div style={{ ...containerStyle, justifyContent: 'space-between' }}>
        {revealKeyframes}
        <div className="import-rule-reveal" style={{ ...revealStyle, width: 'auto', flex: 1 }}>
          <span style={{ fontWeight: 600, color: 'var(--text)', minWidth: 110 }}>{name}</span>
          <span style={{ fontFamily: 'inherit', fontSize: 12, color: textColor }}>
            {frequencySummary} · {prioritySummary} · {eligibilitySummary}
          </span>
          {eligibilityUnknown && (
            <span style={{ color: 'var(--text)' }}>Worth checking — groups unclear</span>
          )}
        </div>
        {adjustButton}
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      {revealKeyframes}
      <div className="import-rule-reveal" style={revealStyle}>
        <div style={{ display: 'flex', width: '100%', justifyContent: 'flex-end' }}>
          {adjustButton}
        </div>
        <span style={{ fontWeight: 600, color: 'var(--text)', minWidth: 110 }}>{name}</span>

        <input
          type="number" min={1}
          value={rule?.min_per_week ?? ''}
          onChange={(e) => onChange({ min_per_week: Math.max(1, Number(e.target.value) || 1) })}
          style={{ width: 40, padding: '3px 5px', fontSize: 12, borderRadius: 5, border: '1px solid var(--border)', color: textColor, background: 'var(--surface)' }}
        />
        <span style={{ color: 'var(--text-secondary)' }}>–</span>
        <input
          type="number" min={1}
          value={rule?.max_per_week ?? ''}
          onChange={(e) => onChange({ max_per_week: Math.max(1, Number(e.target.value) || 1) })}
          style={{ width: 40, padding: '3px 5px', fontSize: 12, borderRadius: 5, border: '1px solid var(--border)', color: textColor, background: 'var(--surface)' }}
        />
        <span style={{ color: textColor }}>×/wk</span>

        <select
          value={rule?.priority ?? 'low'}
          onChange={(e) => onChange({ priority: e.target.value })}
          style={{ fontSize: 12, padding: '3px 5px', borderRadius: 5, border: '1px solid var(--border)', color: textColor, background: 'var(--surface)', fontFamily: 'inherit' }}
        >
          {['high', 'low'].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>

        {eligibilityUnknown ? (
          <span style={{ color: 'var(--text)' }}>
            Shoresh couldn’t tell from this file’s layout which groups do which activity, so eligibility
            is left open. Worth checking.
          </span>
        ) : (
          <span style={{ color: textColor }}>{formatEligibility(groupNames)}</span>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {allGroups.map((g) => {
            const on = groupNames === null || groupNames.includes(g)
            return (
              <button
                key={g}
                onClick={() => onToggleGroup(g)}
                style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                  background: on ? 'color-mix(in srgb, var(--success) 12%, var(--surface))' : 'var(--surface)',
                  border: `1px solid ${on ? 'var(--success)' : 'var(--border)'}`,
                  color: on ? 'var(--text)' : 'var(--text-secondary)',
                }}
              >
                {g}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// D4 — the honest readiness verdict inside the post-commit success banner.
// Reads getReadiness the same way ReadinessHub.jsx does (Array(counts.x || 0)
// stand-ins, not real rows — only presence/absence matters here), so "Ready
// to build a week." and "which optional areas are still absent" can never
// disagree with the hub. describeReadiness owns the blocking sentence;
// describeOptionalGaps (importOutcomeModel.js) owns the calm optional line.
function ImportReadinessNote({ counts }) {
  const collections = {
    cohorts: Array(counts.cohorts || 0),
    tiers: Array(counts.tiers || 0),
    groups: Array(counts.groups || 0),
    days: Array(counts.days || 0),
    timeBlocks: Array(counts.timeblocks || 0),
    activities: Array(counts.activities || 0),
    anchors: Array(counts.anchors || 0),
    dayOverrides: Array(counts.dayoverrides || 0),
  }
  const readiness = getReadiness(collections)
  const { blocking } = describeReadiness(readiness)
  const optionalNote = describeOptionalGaps(readiness)

  return (
    <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
      <div>{blocking}</div>
      {optionalNote && <div style={{ marginTop: 2 }}>{optionalNote}</div>}
    </div>
  )
}

const readinessLinkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--text-secondary)', fontSize: 13, fontFamily: 'inherit',
  textDecoration: 'underline',
}
