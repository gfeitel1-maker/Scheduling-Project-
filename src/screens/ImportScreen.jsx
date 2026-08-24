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
import { normalizeName } from '../ingest/preview'
import { autoAccepts } from '../ingest/confidence'
import { emitTwoRowSplit, DEFAULT_SPLIT_SUFFIX } from '../ingest/twoRowSplit'
import { createSetupCrudRepository } from '../data/setupCrudRepository'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { assertImportFileSize, assertWorkbookComplexity, unescapeRow } from '../utils/exportSanitize.js'
import { downloadWorkbook, META_SHEET } from '../utils/exportWorkbook.js'
import { workbookToSource } from '../ingest/workbookToSource.js'
import ReconciliationScreen from './ReconciliationScreen.jsx'
import { fetchFirstImportCollections, isFirstImport as computeIsFirstImport } from '../ingest/firstImportSignal.js'

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
  tiers: 'Age Divisions',
  groups: 'Groups',
  days_of_operation: 'Days',
  time_blocks: 'Time Blocks',
  locations: 'Locations',
  activities: 'Activities',
}

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


// An empty selection and "all groups" (null) both write the same thing — no
// restriction (T35 Fix 3) — so they must say the same thing, or unticking
// every chip would silently lie about what gets committed. One formatter so
// the collapsed summary and the expanded editor can't drift apart (round 2
// review).
const formatEligibility = (groupNames) =>
  groupNames == null || groupNames.length === 0 ? 'All groups' : `Groups: ${groupNames.join(', ')}`

// Slice 2b (docs/work/specs/2026-08-23-two-rows-slice2-affordance.md) —
// twoRowSplit.js's createActivity call needs a `writeActivityFields(id,
// fields)` method; setupCrudRepository only exposes the generic
// `writeFields(entity, id, fields)`. Same one-line shim ElectiveSetDetail.jsx/
// EventGridEditor.jsx/SpecialDayGridEditor.jsx each build for the same reason,
// so a split-minted activity writes through the identical generic renderer
// path every setup screen uses (this is also what keeps a split durably
// human-confirmed with no separate provenance stamp — see twoRowSplit.js).
const splitRepository = createSetupCrudRepository({ localClient })
const splitActivityRepo = {
  ...splitRepository,
  writeActivityFields: (id, fields) => splitRepository.writeFields('activities', id, fields),
}

// Pure pre-check mirroring emitTwoRowSplit's own guards (same normalizeName),
// so the UI can disable Split / swap to the collision three-way BEFORE ever
// calling emitTwoRowSplit — the spec forbids calling it speculatively per
// keystroke. Checked against both the file's own proposed activity names and
// the camp's existing activities, since either could already hold the
// suffixed name.
function computeSplitPreview(name, suffix, proposalActivityNames, existingActivities) {
  const newName = `${name}${suffix}`
  if (normalizeName(newName) === normalizeName(name)) {
    return { degenerate: true, collision: false, newName }
  }
  const collidesExisting = (existingActivities ?? []).some((a) => normalizeName(a.name) === normalizeName(newName))
  const collidesProposal = (proposalActivityNames ?? []).some((n) => normalizeName(n) === normalizeName(newName))
  return { degenerate: false, collision: collidesExisting || collidesProposal, newName }
}

export default function ImportScreen({ campId, onNavigate, onImported, deviceMode }) {
  // Units and time blocks are scoped to a Program; an import files them under
  // the active one so the setup screens will show them (T33).
  const { activeCohort } = useCohorts(campId)
  const [fileNames, setFileNames] = useState([])
  // ADR 2026-08-17-onescreen-reconciliation-merge.md §2 — replaces the old
  // `preview` (buildPreview's create/skip/lowConfidence shape, now deleted).
  // `proposal` is extractEntities' own output: every name the file offered,
  // deduped, with no existing-camp filtering (that is buildPlan's job at
  // dry-run/commit time, via ReconciliationScreen).
  const [proposal, setProposal] = useState(null)
  // D2 round 2 — see the comment at its assignment in readFiles.
  const fileGroupUnitsRef = useRef({})
  // Q8 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D5) — same
  // "survives staging" reasoning as fileGroupUnitsRef: normalized(activity
  // name) -> the one place name it was captured next to.
  const fileActivityLocationsRef = useRef({})
  // Proposed recurring recurring events (T34). Every inferred recurring event is sent
  // unconditionally at commit (sub-slice 4, §3/A1) — there is no local tick
  // to gate it. A low-confidence one that the director hasn't reconciled is
  // held back downstream by reconciliationResolutions.js's fixed-event
  // hold-back, keyed on ReconciliationScreen, not here.
  // operatingDayCount is only for the "every day" hint.
  const [fixedEvents, setFixedEvents] = useState([])
  const [operatingDayCount, setOperatingDayCount] = useState(0)
  // ADR 2026-08-09 Decision 1 / A3 (Red Hat, 2026-08-17-onescreen-
  // reconciliation-merge.md) — pinOnlyActivityNames is every auto-accepted
  // (high-confidence) fixed-event name that ISN'T also a free activity
  // choice (dual-use). It travels to buildPlan (buildCommitInputs, below) as
  // the guard that forces tier:'low' on that name, so it can never silently
  // mint into the catalog.
  const [pinOnlyActivityNames, setPinOnlyActivityNames] = useState(new Set())
  // Slice 2b — dualUseNames lifted out of the throwaway destructure in
  // readFiles (was computed only to seed pinOnlySet, then discarded). Filtered
  // against declined_two_row_splits on every readFiles() pass so a director's
  // earlier "Not now" is honored on the next re-import, not just this session
  // (spec "Decline-memory"). Drives the split-suggestion disclosure rendered
  // inline on the Recurring Events chip below.
  const [dualUseNames, setDualUseNames] = useState(new Set())
  // Per dual-use name: { expanded, accepted, suffix, outcome: 'idle'|'collision',
  // confirmedName, errorMessage }. `accepted` true collapses the disclosure to
  // the quiet confirmation line for the rest of this session.
  const [splitDecisions, setSplitDecisions] = useState({})
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
  // that no longer exist, so restoring one fails.
  //
  // T108 Phase 2 review round 2 (MED/HIGH #4) — dayOverrideCount/
  // day_override_templates removed: that table is retired product concept
  // (overrides are now `day_overrides` rows, authored in place on the
  // schedule grid, not a standalone CRUD screen with "templates" to refill).
  const [snapshotCount, setSnapshotCount] = useState(0)
  // Slots placed on EITHER schedule route, camp-wide. replaceScope tears down
  // template_slots and template_overlays for both Manual Build and Generated
  // Schedule (FK ordering forces it), and the director sees the count only
  // in the success banner today — after it has already happened. This reads
  // it pre-confirm instead (Red Hat, T61 round 3).
  const [slotCount, setSlotCount] = useState(0)
  // Recurring Events (anchor_activities) — director-authored content with its own
  // nav screen, deleted by replaceScope step 6 because anchors reference
  // days_of_operation, which step 8 also deletes. Recoverable from Trash,
  // same as slots (T68).
  const [anchorCount, setAnchorCount] = useState(0)
  // T36 — sheets that had content but the detector could not turn into a page
  // (workbookToPages' `.residual`), alongside proposal.residual.cells (content
  // inside a recognised page that never became an entity). Read-only
  // transparency, never a gate on commit.
  const [residualSheets, setResidualSheets] = useState([])

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
    setLedger(null)
    setProposal(null)
    setFixedEvents([])
    setActivityRules({})
    setGroupUnitOverrides({})
    setResidualSheets([])
    setDualUseNames(new Set())
    setSplitDecisions({})
    const files = [...(fileList ?? [])]
    if (files.length === 0) return
    setFileNames(files.map((f) => f.name))

    try {
      // The camp's own name and the year are in every filename, so they say
      // nothing about which group a file is. What differs is the group.
      const prefix = sharedFilenamePrefix(files.map((f) => f.name))
      const pages = []
      const fileResidualSheets = []

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
          const sheets = wb.SheetNames.map((name) => {
            const ws = wb.Sheets[name]
            const ref = ws['!ref']
            // Pin the read window to the absolute origin (row 0, col A) so each
            // row's array index equals its absolute worksheet row, and each
            // cell's index its absolute column — the coordinate space `!merges`
            // uses (which is ALWAYS absolute, independent of the sheet's used
            // range). Without this, a sheet whose data starts below/right of A1
            // (a title/logo banner row) desyncs merge anchors from row indices
            // and the span is silently dropped (Red Hat, Slice A). For an
            // A1-origin sheet this range equals the default, so it is a no-op.
            // blankrows:true then keeps the leading/interior blanks as array
            // entries preserving that alignment — sheetToPage drops blank/
            // footnote rows itself, so nothing downstream regresses
            // (docs/adr/2026-08-24-merged-cell-multiblock-ingest.md addendum).
            const range = ref ? { s: { r: 0, c: 0 }, e: XLSX.utils.decode_range(ref).e } : undefined
            return {
              name,
              // raw:false so Excel formats each cell the way the sheet displays
              // it. A time typed as a time is stored as a fraction of a day —
              // 9:15am is 0.3854166666666667 — and reading it raw puts that
              // number in the camp as the name of a period. unescapeRow reverses
              // any leading-apostrophe our own export wrote, so an escaped
              // literal round-trips and never re-enters as a formula.
              rows: XLSX.utils
                .sheet_to_json(ws, { header: 1, blankrows: true, defval: '', raw: false, ...(range && { range }) })
                .map(unescapeRow),
              merges: ws['!merges'] ?? [],
            }
          })
          const sheetPages = workbookToPages(sheets, title)
          pages.push(...sheetPages)
          for (const r of sheetPages.residual ?? []) fileResidualSheets.push({ file: file.name, ...r })
        } else {
          // F4 — same size guard as the xlsx branch: fail closed before the
          // whole text file is read unbounded into a JS string.
          assertImportFileSize(file.size)
          pages.push(...parseTextGrid(await file.text()).pages)
        }
      }
      setResidualSheets(fileResidualSheets)

      if (pages.length === 0) {
        setProposal(null)
        setError('No schedule could be read out of that. It may be a scan rather than a document with text in it.')
        return
      }

      const proposal = extractEntities({ pages })
      const existingAll = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        existingAll[entity] = await localClient.list(entity).catch(() => [])
      }
      setExistingRecordsAll(existingAll)
      setSnapshotCount((await localClient.list('schedule_snapshots').catch(() => [])).length)
      setSlotCount((await localClient.list('template_slots').catch(() => [])).length)
      setAnchorCount((await localClient.list('anchor_activities').catch(() => [])).length)
      setImportMode('add')
      // ADR 2026-08-17-onescreen-reconciliation-merge.md §2 — no more local
      // create/skip/lowConfidence computation (buildPreview deleted): every
      // name the file offers is a candidate, existing-camp matching and
      // create-confidence both now live downstream in buildPlan, surfaced as
      // real decisions on ReconciliationScreen.
      setProposal(proposal)
      // D2 round 2 — buildCommitInputs() needs this file-inferred groupUnits
      // map even after staging nulls `proposal` out (commitInputsWithResolutions
      // calls buildCommitInputs() again live, to pick up post-staging edits).
      // A ref survives that null without re-rendering or needing its own reset
      // bookkeeping — a fresh upload simply overwrites it.
      fileGroupUnitsRef.current = proposal.groupUnits ?? {}
      fileActivityLocationsRef.current = proposal.activityLocations ?? {}

      // Recurring recurring events implied by the grid (T34). Every inferred event
      // is shown and ships unconditionally at commit (sub-slice 4) — a
      // low-confidence one the director hasn't reconciled is held back
      // downstream (ReconciliationScreen), not here.
      // Bug B (recurring-event detection slice 0): a camp whose periods are
      // named "Period 1"/"Lunch" rather than printed times only gets detected
      // once its own already-configured time_blocks names are known — thread
      // the existing rows in so isBlockLabel can recognize them.
      const knownTimeBlockNames = (existingAll.time_blocks ?? []).map((t) => t.name)
      const { fixedEvents: inferred, dualUseNames: dualUseNamesRaw = [] } = inferFixedEvents({ pages }, proposal, { knownTimeBlockNames })
      setFixedEvents(inferred)
      setOperatingDayCount(proposal.entities.days_of_operation.length)

      // ADR 2026-08-09 Decision 1 / A3 (Red Hat) — an auto-accepted
      // (high-confidence) fixed-event name that is NOT dual-use is never a
      // free activity-catalog choice. This set travels to buildPlan as
      // `pinOnlyActivityNames` (buildCommitInputs, below), which forces
      // tier:'low' on that name so it can never silently mint.
      const dualUseSet = new Set(dualUseNamesRaw)
      const initialTickedFixedEventNames = new Set(
        inferred.filter((fe) => autoAccepts(fe.confidence)).map((fe) => fe.name)
      )
      const pinOnlySet = new Set([...initialTickedFixedEventNames].filter((n) => !dualUseSet.has(n)))
      setPinOnlyActivityNames(pinOnlySet)

      // Slice 2b — filter dualUseSet through decline-memory before it ever
      // reaches render, so a declined name never shows the link, let alone
      // calls emitTwoRowSplit (spec "Decline-memory"). `?.().catch` guards
      // against older localClient test mocks that predate Slice 2a and don't
      // implement listDeclinedSplitNames.
      const declinedRaw = (await localClient.listDeclinedSplitNames?.().catch(() => [])) ?? []
      const declined = new Set(declinedRaw)
      setDualUseNames(new Set([...dualUseSet].filter((n) => !declined.has(normalizeName(n)))))

      // Rule inference (T35) — same "propose, director confirms" shape as the
      // entities and recurring events above.
      //
      // The Asserted-classification exclusion set is NOT pinOnlySet — pinOnlySet
      // is high-confidence-only (it feeds a separate mechanism, the tier:'low'
      // pin above) and would wrongly let a low-confidence fixed event also get
      // an Obligation rule. ADR §4.1 defines the Asserted denylist as every
      // inferFixedEvents name regardless of confidence (high OR low — a
      // low-confidence Asserted guess is still an Asserted-shaped hypothesis,
      // not a demotion to Obligation), minus dual-use names — a dual-use
      // activity legitimately keeps BOTH classifications (ADR OQ1: two rows
      // sharing a name). (docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md
      // §4.1/§6 step 3.)
      const assertedNonDualUseNames = new Set(inferred.map((fe) => fe.name).filter((n) => !dualUseSet.has(n)))
      const rules = inferActivityRules(
        proposal.entities.activities,
        proposal.activityPages,
        proposal.seenCounts,
        proposal.entities.days_of_operation.length,
        proposal.entities.groups,
        assertedNonDualUseNames
      )
      setActivityRules(Object.fromEntries(rules))
    } catch (err) {
      setProposal(null)
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
      setProposal(null)
      setError(err?.message ?? 'That worksheet could not be read.')
      return
    }
    if (!activeCohort) {
      setError('Waiting for a Program to load before importing. Try again in a moment.')
      return
    }
    const workbookFactCount = INGESTIBLE_ENTITIES.reduce((n, e) => n + (source.approved[e]?.length ?? 0), 0)
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
    }, fileName, 'workbook', workbookFactCount)
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

  // Slice 2b — the two-rows split suggestion. Defaults mirrored here (not in
  // useState) so a name with no prior interaction still reads correctly.
  function updateSplitDecision(name, patch) {
    setSplitDecisions((prev) => ({
      ...prev,
      [name]: { expanded: false, accepted: false, suffix: DEFAULT_SPLIT_SUFFIX, outcome: 'idle', ...prev[name], ...patch },
    }))
  }

  // "Not now" and collision-"Cancel" both decline the same way (spec: declining
  // is a normal path, not destructive). This is only ever reachable once the
  // director has opened the disclosure — the collapsed link itself has no
  // decline affordance — so a stray click never records a decline (spec
  // "DECLINE-REVOCATION": there is no unrecord path, so decline must stay a
  // deliberate, expanded-state-only action).
  async function declineSplit(name) {
    setDualUseNames((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
    try {
      await localClient.recordDeclinedSplit(name)
    } catch {
      // Best-effort local bookkeeping — a failed write here only risks the
      // suggestion reappearing on the next import; it must not block or
      // error the director's decline click itself.
    }
  }

  // HIGH #1 (Red Hat, Slice 2b round 2) — Split must NOT write during review:
  // the screen's own contract ("Nothing is added until you have looked at the
  // list and said so") forbids minting an activities row before the import is
  // committed, or a discarded import leaves an orphaned split row behind.
  // confirmSplit therefore only STAGES the decision (splitDecisions[name].
  // accepted); the actual emitTwoRowSplit call happens once, at the single
  // import-commit seam (applyStagedSplits, called from
  // handleReconciliationCommitted). The client precheck (computeSplitPreview,
  // same normalizeName emitTwoRowSplit itself uses) still decides
  // degenerate/collision/clean here — a collision found at review time still
  // routes to the three-way reuse/rename/cancel immediately; only the actual
  // write is deferred.
  function confirmSplit(name, existingActivity) {
    const suffix = splitDecisions[name]?.suffix ?? DEFAULT_SPLIT_SUFFIX
    const preview = computeSplitPreview(name, suffix, proposal?.entities.activities, existingRecordsAll.activities)
    if (preview.degenerate) return // defense in depth — Split is disabled client-side in this state
    if (preview.collision) {
      updateSplitDecision(name, { outcome: 'collision', errorMessage: null })
      return
    }
    updateSplitDecision(name, {
      accepted: true,
      kind: 'split',
      existingActivityId: existingActivity.id,
      suffix,
      confirmedName: `${name}${suffix}`,
      outcome: 'idle',
      errorMessage: null,
    })
  }

  // Collision "Reuse it" — stages the pin (existing row confirmed pinned,
  // mirrors emitTwoRowSplit's own step 1) for the same commit-time apply as
  // confirmSplit, rather than writing immediately (HIGH #1).
  function reuseCollision(name, existingActivity) {
    const suffix = splitDecisions[name]?.suffix ?? DEFAULT_SPLIT_SUFFIX
    updateSplitDecision(name, {
      accepted: true,
      kind: 'reuse',
      existingActivityId: existingActivity.id,
      suffix,
      confirmedName: `${name}${suffix}`,
      outcome: 'idle',
      errorMessage: null,
    })
  }

  // Applies every staged split/reuse decision at the single import-commit
  // seam (handleReconciliationCommitted), once the import itself has already
  // landed. Re-fetches the current activities list rather than reusing
  // existingRecordsAll (a stale readFiles() snapshot) for two reasons: (1) by
  // this point the import's own proposed activities are committed real rows,
  // so emitTwoRowSplit's Guard 2 collision check now naturally sees them too
  // — no separate proposal-name parameter needed (LOW/MED #3); (2) any
  // concurrent-device write since readFiles() is reflected. A failure on one
  // decision is reported, not thrown — the import already committed, so one
  // bad split must not look like the whole import failed.
  async function applyStagedSplits() {
    const accepted = Object.entries(splitDecisions).filter(([, d]) => d.accepted)
    if (accepted.length === 0) return []
    // A SYSTEMIC re-fetch failure (not an empty list) leaves every accepted
    // split unapplied — report all of them rather than silently dropping the
    // lot, and don't conflate it with a per-item "activity vanished" miss
    // (Red Hat HIGH A). We must NOT .catch(()=>[]) here: an empty array is
    // indistinguishable from a failed read and would silently skip everything.
    let currentActivities
    try {
      currentActivities = await localClient.list('activities')
    } catch (err) {
      const failures = accepted.map(([name]) => ({
        name,
        message: describeWriteFailure(err, `The split for "${name}" couldn't be applied — your activity list couldn't be read. Nothing was split; try again from the Activities screen.`),
      }))
      console.error('Two-row split apply failures (activity re-fetch failed):', failures)
      return failures
    }
    const failures = []
    for (const [name, decision] of accepted) {
      const existingActivity = currentActivities.find((a) => a.id === decision.existingActivityId)
      if (!existingActivity) {
        // The pinned activity vanished between staging and commit (edited,
        // removed, or synced away). Report it — don't silently skip (Red Hat).
        failures.push({ name, message: `The split for "${name}" couldn't be applied — that activity is no longer in your setup.` })
        continue
      }
      try {
        if (decision.kind === 'reuse') {
          if (existingActivity.recurrence_truth_status !== 'asserted') {
            await splitActivityRepo.writeFields('activities', existingActivity.id, { recurrence_truth_status: 'asserted' })
          }
        } else {
          const result = await emitTwoRowSplit({
            repo: splitActivityRepo,
            existingActivity,
            existingActivities: currentActivities,
            suffix: decision.suffix,
          })
          if (result.outcome !== 'split') {
            failures.push({ name, message: `"${name}" could not be split into two activities — that name is already in use.` })
          }
        }
      } catch (err) {
        failures.push({ name, message: describeWriteFailure(err, `The split for "${name}" could not be saved.`) })
      }
    }
    if (failures.length > 0) {
      // Not silently dropped: logged for the director/support to find, without
      // blocking or reversing an import that already committed successfully.
      console.error('Two-row split apply failures:', failures)
    }
    return failures
  }

  // ADR 2026-08-17-onescreen-reconciliation-merge.md §2 — every name the file
  // offered, unconditionally (proposal.entities is already deduped, per
  // entity, by extractEntities). Nothing is ticked here anymore; a low-
  // confidence create or a genuine ambiguity now becomes a real decision on
  // ReconciliationScreen instead of being silently unticked upstream.
  const approvedCount = proposal
    ? INGESTIBLE_ENTITIES.reduce((n, e) => n + (proposal.entities[e]?.length ?? 0), 0)
    : 0

  // The exact inputs a commit sends — built once here so a held re-commit (T73)
  // re-sends the SAME inputs plus the director's resolutions (ADR §1).
  function buildCommitInputs() {
    const approved = {}
    for (const entity of INGESTIBLE_ENTITIES) approved[entity] = [...(proposal?.entities[entity] ?? [])]
    // ADR 2026-08-09 Decision 2 — three explicit per-group unit review states.
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
    // Every inferred recurring event ships unconditionally (sub-slice 4, §3/A1)
    // — the hold-back for an unresolved one lives on ReconciliationScreen
    // (reconciliationResolutions.js's fixed-event hold-back), not here.
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
      // Q8 (§D5) folded into buildPlan (ADR 2026-08-17-onescreen-reconciliation-
      // merge.md §2): the paired location is now sent unconditionally — it is
      // no longer gated on a local tick. What keeps Q8 genuinely propose-only
      // is buildPlan's own create-confidence rule (createConfidenceTier):
      // every location create is tier:'low' regardless of frequency, so it
      // always requires an explicit director resolution on
      // ReconciliationScreen before it is minted or bound to.
      const pairedLocation = fileActivityLocationsRef.current[normalizeName(name)]
      if (pairedLocation) {
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
      fixedEvents,
      activityRules: outgoingRules,
      mode: importMode === 'replace' ? 'replace' : 'add',
      // §1 — real create confidence input, and A3's pin-only carry-over.
      seenCounts: proposal?.seenCounts ?? null,
      pinOnlyActivityNames: [...pinOnlyActivityNames],
      // Slice 3a — plain data extractEntities already computed, carried
      // through unchanged to buildPlan's buildElectiveCandidates.
      electiveHeaderFindings: proposal?.electiveHeaderFindings ?? [],
      activityPeriods: proposal?.activityPeriods ?? {},
    }
  }

  // R2'b cutover — ReconciliationScreen owns the whole triage/dry-run/commit
  // loop now (ADR Seam 3): it re-issues localClient.ingestReconcile itself on
  // every triage action and calls localClient.ingestCommit for the final
  // apply. This screen's job is reduced to staging the base commit inputs
  // once the director confirms the file preview — no renderer-side buildPlan,
  // no separate held/queue surfaces to keep in sync.
  // Roots reconstruction moment (docs/adr/2026-08-18-roots-reconstruction-
  // moment-gating.md, Gates 2/3) — factCount and isFirstImport are computed
  // once here, before ReconciliationScreen ever mounts, so its gate
  // predicate never has to recompute after the first paint. isFirstImport
  // reuses the same seven-collection readiness read fetchReadiness() already
  // performs, factored into firstImportSignal.js so neither screen
  // duplicates the localClient.list calls.
  async function stageLedger(inputs, fileName, origin = 'schedule', factCount = 0) {
    setProposal(null)
    const firstImport = computeIsFirstImport(await fetchFirstImportCollections())
    setLedger({ context: inputs, fileName, origin, factCount, isFirstImport: firstImport })
  }

  function commit() {
    // S5b — the antechamber no longer commits directly; it stages the base
    // commit inputs and hands off to ReconciliationScreen, which owns the
    // whole triage/dry-run/apply loop from here (R2'b cutover).
    // Not awaited deliberately: nothing after this line in commit() depends
    // on stageLedger having resolved. setProposal(null) runs synchronously
    // before stageLedger's internal await; setLedger lands once
    // fetchFirstImportCollections resolves, with no caller here waiting on it.
    stageLedger(buildCommitInputs(), fileNames.join(', '), 'schedule', approvedCount)
  }

  // ReconciliationScreen's onCommitted/onDiscard. Task 4 (Roots-as-dashboard
  // plan) — a finished import no longer rests on a local receipt here. It
  // tears the staged ledger down, hands the commit outcome UP to App (which
  // carries it across the screen boundary as `justImported`), and routes the
  // director to Roots, where the post-import banner and the surviving
  // grace-window undo now live. The undo's invertibleOps/createdEntityIds
  // ride along on `outcome`, exactly as they did before.
  //
  // HIGH #1 — this is the single seam where a staged two-row split is
  // actually applied: the import has just committed, so writing the split
  // rows here can no longer strand an orphan if the director had instead
  // discarded (applyStagedSplits only ever runs from this path, never from
  // handleReconciliationDiscard). Awaited before navigating away so a split
  // failure is captured while this component is still mounted.
  async function handleReconciliationCommitted(outcome) {
    const splitFailures = await applyStagedSplits()
    setLedger(null)
    setFileNames([])
    setFixedEvents([])
    setActivityRules({})
    setGroupUnitOverrides({})
    setSplitDecisions({})
    onImported?.(splitFailures.length > 0 ? { ...outcome, splitFailures } : outcome)
    onNavigate('roots')
  }

  // Nothing was written for a staged split (HIGH #1) — discarding the import
  // is just dropping splitDecisions state, same as every other piece of
  // review-time state below.
  function handleReconciliationDiscard() {
    setLedger(null)
    setFileNames([])
    setFixedEvents([])
    setActivityRules({})
    setGroupUnitOverrides({})
    setSplitDecisions({})
  }

  // R2'b cutover — once a report exists (the director has staged an import),
  // ReconciliationScreen becomes the whole surface: one continuous scroll,
  // no upload widget or preview underneath (spec §0). The file-upload/parse
  // antechamber below only renders before that point.
  if (ledger) {
    return (
      <ReconciliationScreen
        campId={campId}
        baseInputs={ledger.context}
        sourceLabel={ledger.fileName}
        onCommitted={handleReconciliationCommitted}
        onDiscard={handleReconciliationDiscard}
        onNavigate={onNavigate}
        factCount={ledger.factCount}
        isFirstImport={ledger.isFirstImport}
      />
    )
  }

  // T93 — import is host-only, enforced at the IPC layer (electron/main.js:
  // "Import can only be run on the main computer."). Without this early
  // signal a Client-mode director could upload, parse, edit the whole
  // proposal, and stage the reconciliation ledger only to fail at the final
  // commit. This is UI guidance only — the IPC-layer check stays exactly as
  // it is, the real security boundary.
  if (deviceMode === 'client') {
    return (
      <div style={{ maxWidth: 760 }}>
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '16px', fontSize: 13, lineHeight: 1.6, color: 'var(--text)',
        }}>
          Import runs on the main computer. Open this camp on the main computer to import last
          year's schedule.
        </div>
      </div>
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

      {proposal && (
        <>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderLeft: '3px solid var(--primary)',
            borderRadius: 8, padding: '12px 14px', marginBottom: 8, fontSize: 13, lineHeight: 1.6,
          }}>
            Everything below is what Shoresh found in the file. Nothing is added yet — the next
            step shows exactly what would change and lets you review anything worth a second look.
          </div>

          {/* The orientation was detected, not known. Saying so lets a director
              catch a misread before it becomes their data (ADR §7). */}
          {proposal.orientation && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.6 }}>
              {proposal.orientation.confident
                ? `Read as one page per ${proposal.orientation.pages === 'groups' ? 'group, with the days across the top' : 'day, with the groups across the top'}.`
                : 'Could not tell how this file is laid out, so some of the list below may be wrong. Worth checking closely.'}
            </div>
          )}

          {/* T36 — the residual report. Non-blocking transparency: content the
              parser saw and could not turn into an entity or a page, shown
              before commit so the director can judge for themselves whether
              it matters, rather than it vanishing with no trace. */}
          {(() => {
            const residualCells = proposal.residual?.cells ?? []
            if (residualCells.length === 0 && residualSheets.length === 0) return null
            return (
              <div style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '12px 14px', marginBottom: 18, fontSize: 12, lineHeight: 1.6,
              }}>
                <div style={{
                  fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: 'var(--text-secondary)', marginBottom: 8,
                }}>
                  Not recognised
                </div>
                <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Shoresh could not match this to anything above. Nothing was added for it — check
                  whether it matters before you continue.
                </div>
                {residualSheets.length > 0 && (
                  <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                    {residualSheets.map((r, i) => (
                      <li key={i}>
                        Sheet "{r.sheet}" in {r.file}: {r.sample.join(', ')}
                      </li>
                    ))}
                  </ul>
                )}
                {residualCells.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {residualCells.map((c) => (
                      <li key={c.value}>
                        "{c.value}" — {c.count} {c.count === 1 ? 'cell' : 'cells'}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })()}

          {INGESTIBLE_ENTITIES.map(entity => {
            const names = proposal.entities[entity] ?? []
            if (names.length === 0) return null
            return (
              <div key={entity} style={{ marginBottom: 20 }}>
                <div style={{
                  fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: 'var(--text-secondary)', marginBottom: 8,
                }}>
                  {LABEL[entity]}
                </div>

                {/* ADR 2026-08-17-onescreen-reconciliation-merge.md §2 — read-
                    only now: there is no tick step here anymore. A low-
                    confidence create, an ambiguity, or an already-in-camp
                    match is a real decision on the next screen, not a local
                    checkbox default. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {names.map(name => (
                    <span
                      key={name}
                      style={{
                        fontSize: 12, padding: '5px 10px', borderRadius: 6,
                        fontFamily: 'inherit', background: 'var(--bg)',
                        border: '1px solid var(--border)', color: 'var(--text-secondary)',
                      }}
                    >
                      {name}
                    </span>
                  ))}
                </div>

                {/* ADR 2026-08-09 Decision 2 — the reviewable unit column, one
                    per group. Unset (file inference), a picked/typed unit, or
                    an explicit clear. */}
                {entity === 'groups' && names.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
                      Which age division each group belongs to. Left as-is uses what the file itself says.
                    </div>
                    {names.map((name) => {
                      const override = groupUnitOverrides[name]
                      const isClear = !!(override && typeof override === 'object' && override.clear)
                      const isEditing = !!(override && typeof override === 'object' && override.editing)
                      const selectValue = isClear ? '__clear__' : isEditing ? '__new__' : (typeof override === 'string' ? override : '')
                      const tierNames = [...new Set([
                        ...(proposal.entities.tiers ?? []),
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
                            <option value="">{proposal.groupUnits?.[name] ? `From file: ${proposal.groupUnits[name]}` : 'No age division (from file)'}</option>
                            {tierNames.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                            <option value="__new__">+ New age division…</option>
                            <option value="__clear__">No age division</option>
                          </select>
                          {isEditing && (
                            <input
                              autoFocus
                              value={override.value}
                              placeholder="Age division name"
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

                {/* Inferred scheduling rules (T35) — for every proposed
                    activity now (§2: nothing is ticked here anymore). */}
                {entity === 'activities' && names.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        Guessed how often and for whom, from the file. Edit anything that looks wrong.
                      </div>
                      <button className="press-97" onClick={clearInferredRules} style={{ ...S.btnSecondary, padding: '4px 10px', fontSize: 11 }}>
                        Clear inferred rules
                      </button>
                    </div>
                    {names.map((name) => (
                      <ActivityRuleRow
                        key={name}
                        name={name}
                        rule={activityRules[name]}
                        allGroups={proposal.entities.groups ?? []}
                        onChange={(patch) => updateActivityRule(name, patch)}
                        onToggleGroup={(g) => toggleRuleGroup(name, g, proposal.entities.groups ?? [])}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {/* Recurring Events (T34). Activities pinned to the same period across a
              group's days — Mifkad, Lunch, Swim. Sub-slice 4: no local tick —
              every inferred event is shown and ships to ReconciliationScreen,
              which is where a low-confidence one gets reconciled (or held
              back if left unresolved). An imported recurring event is an ordinary
              anchor, so its full editor already exists on the Recurring Events
              screen (spec §4.2). */}
          {fixedEvents.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{
                fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                color: 'var(--text-secondary)', marginBottom: 8,
              }}>
                Recurring Events
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
                These activities sat at the same time across a group’s days, so they look fixed rather
                than scheduled fresh each day. They’re added as recurring events you can edit later.
              </div>
              {fixedEvents.some((fe) => fe.confidence === 'low') && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
                  Some appeared on a majority of a group’s days but not all — you’ll be asked to confirm
                  those on the next step.
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'flex-start' }}>
                {(() => {
                  // Slice 2b — a dual-use name can appear as more than one
                  // fixedEvents entry (different time/days); the disclosure
                  // must render once per name, not once per entry.
                  const suggestedNames = new Set()
                  return fixedEvents.map((fe) => {
                    const key = `${fe.name} ${fe.time_block} ${fe.days.join(',')}`
                    const scope = fe.scope.is_all_groups ? 'every group' : fe.scope.groups.join(', ')
                    const daysLabel = operatingDayCount > 0 && fe.days.length >= operatingDayCount
                      ? 'every day'
                      : fe.days.join(', ')
                    // The split acts on a real existing camp activity row (it
                    // stamps recurrence_truth_status on it and dedupes the new
                    // row's name against existingActivities) — there is
                    // nothing yet to split for a name that only exists inside
                    // this not-yet-committed file.
                    const existingActivity = existingRecordsAll.activities?.find(
                      (a) => normalizeName(a.name) === normalizeName(fe.name)
                    )
                    const showSplit = dualUseNames.has(fe.name) && !!existingActivity && !suggestedNames.has(fe.name)
                    if (showSplit) suggestedNames.add(fe.name)
                    const decision = splitDecisions[fe.name]
                    const preview = computeSplitPreview(
                      fe.name,
                      decision?.suffix ?? DEFAULT_SPLIT_SUFFIX,
                      proposal.entities.activities,
                      existingRecordsAll.activities
                    )
                    return (
                      <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                        <div
                          style={{
                            fontSize: 12, padding: '5px 10px', borderRadius: 6,
                            fontFamily: 'inherit', textAlign: 'left',
                            background: 'color-mix(in srgb, var(--success) 12%, var(--surface))',
                            border: '1px solid var(--success)',
                            color: 'var(--text)',
                          }}
                        >
                          {fe.name}
                          <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>
                            · {fe.time_block} · {scope} · {daysLabel}
                          </span>
                        </div>
                        {showSplit && (
                          <TwoRowSplitSuggestion
                            name={fe.name}
                            decision={decision}
                            preview={preview}
                            onChangeSuffix={(suffix) => updateSplitDecision(fe.name, { suffix, errorMessage: null })}
                            onToggleExpanded={() => updateSplitDecision(fe.name, { expanded: !decision?.expanded })}
                            onSplit={() => confirmSplit(fe.name, existingActivity)}
                            onDecline={() => declineSplit(fe.name)}
                            onReuse={() => reuseCollision(fe.name, existingActivity)}
                            onPickDifferent={() => updateSplitDecision(fe.name, { suffix: '', outcome: 'idle', errorMessage: null })}
                          />
                        )}
                      </div>
                    )
                  })
                })()}
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
                { key: 'replace', title: 'Replace them', sub: `This will replace all Age Divisions, Groups, Days, Time Blocks, and Activities across the entire camp — every Program, not just this one. Clears the ${existingCountAll} existing ${existingCountAll === 1 ? 'item' : 'items'} first, then imports.` },
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
                  Recurring Events — share one bordered
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
                      <>Your <strong>{anchorCount}</strong> Recurring {anchorCount === 1 ? 'Event' : 'Events'} will
                      be cleared. {anchorCount === 1 ? 'It is' : 'They are'} recoverable from Trash.</>) },
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
            <button className="press-97" onClick={() => { setProposal(null); setFileNames([]) }} style={S.btnSecondary}>
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

// Slice 2b — the two-rows split suggestion attached to a dual-use Recurring
// Events chip (docs/work/specs/2026-08-23-two-rows-slice2-affordance.md).
// Off-by-default, calm, easily ignored: a quiet disclosure link that expands
// into the suffix editor, then either a quiet confirmation line or (on
// collision) a three-way micro-decision. `decision` is undefined until the
// director interacts with this name.
//
// Copy discipline: never surface "occurrence-pattern", "truth-status",
// "asserted", "obligation", or "permission" here — plain scheduling language
// only, matching ActivityRuleRow and the Keep-vs-Replace block above.
function TwoRowSplitSuggestion({ name, decision, preview, onChangeSuffix, onToggleExpanded, onSplit, onDecline, onReuse, onPickDifferent }) {
  const expanded = decision?.expanded ?? false
  const accepted = decision?.accepted ?? false
  const suffix = decision?.suffix ?? DEFAULT_SPLIT_SUFFIX
  const errorMessage = decision?.errorMessage
  // preview.collision is the live client precheck (recomputed every
  // keystroke); outcome:'collision' is what emitTwoRowSplit itself reported
  // (a race the precheck missed, or a surfaced write failure) — either swaps
  // the card to the three-way.
  const showCollision = preview.collision || decision?.outcome === 'collision'

  if (accepted) {
    // Calm, not celebratory — a plain line, no chevron (spec "Outcome handling").
    return (
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '2px 6px' }}>
        Split into {name} + {decision.confirmedName}.
      </div>
    )
  }

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

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggleExpanded}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'inherit',
          border: 'none', background: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text) 5%, transparent)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
      >
        Also a flexible activity — split into two?
        {chevron}
      </button>
    )
  }

  const revealKeyframes = (
    <style>{`
      @keyframes importSplitReveal { from { max-height: 0; opacity: 0; } to { max-height: 200px; opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .import-split-reveal { animation: none !important; } }
    `}</style>
  )
  const cardStyle = {
    display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px',
    borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)',
    fontSize: 12, maxWidth: 360, overflow: 'hidden',
  }
  const revealStyle = { animation: 'importSplitReveal var(--motion-base) var(--ease-standard)' }

  if (showCollision) {
    // Reuses the Keep-vs-Replace radio-card idiom (import mode block above):
    // bordered, clickable rows, no "on" state (these are one-shot actions,
    // not a persisted toggle).
    const optionStyle = {
      display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
      padding: '8px 10px', borderRadius: 7, fontFamily: 'inherit',
      background: 'var(--surface)', border: '1px solid var(--border)',
    }
    return (
      <div style={cardStyle}>
        {revealKeyframes}
        <div className="import-split-reveal" style={revealStyle}>
          {errorMessage && (
            <div style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 6 }}>{errorMessage}</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={onReuse} style={optionStyle}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Reuse it</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                Attach the flexible pattern to the existing "{preview.newName}" activity.
              </div>
            </button>
            <button onClick={onPickDifferent} style={optionStyle}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Pick a different name</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Choose another suffix.</div>
            </button>
            <button onClick={onDecline} style={optionStyle}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Cancel</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Leave "{name}" as one activity.</div>
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={cardStyle}>
      {revealKeyframes}
      <div className="import-split-reveal" style={revealStyle}>
        <div style={{ color: 'var(--text)', marginBottom: 6 }}>
          "{name}" also appears on its own, outside the fixed time — split it into two activities?
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{name}</span>
          <input
            autoFocus
            value={suffix}
            onChange={(e) => onChangeSuffix(e.target.value)}
            style={{ width: 90, padding: '3px 5px', fontSize: 12, borderRadius: 5, border: '1px solid var(--border)', color: 'var(--text)', background: 'var(--surface)' }}
          />
        </div>
        {preview.degenerate ? (
          <div style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 6 }}>
            Add a suffix so the two activities have different names.
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginBottom: 6 }}>
            → "{name}{suffix}" (flexible)
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="press-97"
            onClick={onSplit}
            disabled={preview.degenerate}
            style={{ ...S.btnPrimary, padding: '4px 10px', fontSize: 11, opacity: preview.degenerate ? 0.45 : 1 }}
          >
            Split
          </button>
          <button className="press-97" onClick={onDecline} style={{ ...S.btnSecondary, padding: '4px 10px', fontSize: 11 }}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
