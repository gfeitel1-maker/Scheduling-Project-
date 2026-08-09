import { useState } from 'react'
import { localClient } from '../localClient'
import { useCohorts } from '../hooks/useCohorts'
import { S } from '../styles/shared'
import * as XLSX from 'xlsx'
import { parseTextGrid } from '../ingest/textGrid'
import { workbookToPages, groupNameFromFilename, sharedFilenamePrefix } from '../ingest/sheetGrid'
import { extractEntities, INGESTIBLE_ENTITIES } from '../ingest/extractEntities'
import { inferFixedEvents } from '../ingest/fixedEvents'
import { inferActivityRules } from '../ingest/activityRules'
import { buildPreview, describePreview } from '../ingest/preview'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { assertImportFileSize, assertWorkbookComplexity, unescapeRow } from '../utils/exportSanitize.js'

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
  activities: 'Activities',
}

// Identifies a proposed fixed event for tick toggling (spec §4.1).
const fixedEventKey = (fe) => `${fe.name} ${fe.time_block} ${fe.days.join(',')}`

// activities.priority is the engine's two-valued contract — 'high'/'low',
// never a third value (ActivitiesScreen.jsx, buildSchedule.js's runRound).
// inferActivityRules already returns exactly one of these two strings, so
// this screen displays and writes the same value throughout; no conversion
// at commit (round 2 review, Fix 1 — an earlier 1/2/3 draft was wrong).
const PRIORITY_LABEL = { high: 'High', low: 'Low' }

// T73 — a plain-camp phrase for each field a stale conflict can name, so the
// kept-change card never shows a raw column name (design spec §9). Unknowns fall
// back to a humanized column name.
const FIELD_LABEL = {
  location: 'where it happens',
  sort_order: 'the order it appears in',
  day_of_week: 'which day of the week it is',
  start_time: 'when it starts',
  end_time: 'when it ends',
  availability: 'when it’s available',
  min_per_week: 'how many times a week (fewest)',
  max_per_week: 'how many times a week (most)',
  priority: 'how important it is',
  name: 'its name',
  label: 'its name',
}
const fieldLabel = (f) => FIELD_LABEL[f] ?? String(f).replace(/_/g, ' ')

const sumCounts = (counts) => Object.values(counts ?? {}).reduce((n, c) => n + c, 0)

// T73 — a stable per-conflict id for the resolution queue. Derived from the
// fields the conflict already carries, so it survives a re-derive after a peer
// race (design spec §9). normalizeName-free (renderer-local) but lower-cased so
// the same name keys the same item across renders.
const conflictKey = (entity, name, reason, field) =>
  `${entity}|${String(name).trim().toLowerCase()}|${reason}|${field ?? ''}`

// Flatten held `conflicts[]` into one queue item per decision the director must
// make: one per ambiguous_identity, one per stale FIELD. Ordered most-fundamental
// first — identity questions before kept-change, then INGESTIBLE_ENTITIES order —
// computed once and stable (design spec §2.3).
function deriveQueue(conflicts) {
  const items = []
  for (const c of conflicts ?? []) {
    if (c.reason === 'ambiguous_identity') {
      items.push({
        id: conflictKey(c.entity, c._name, 'ambiguous_identity', ''),
        kind: 'identity', entity: c.entity, name: c._name, conflict: c,
      })
    } else if (c.reason === 'stale') {
      for (const field of Object.keys(c.fields ?? {})) {
        items.push({
          id: conflictKey(c.entity, c._name, 'stale', field),
          kind: 'stale', entity: c.entity, name: c._name, field, delta: c.fields[field], conflict: c,
        })
      }
    }
  }
  const rank = (it) => (it.kind === 'identity' ? 0 : 1000) + INGESTIBLE_ENTITIES.indexOf(it.entity)
  return items
    .map((it, i) => ({ ...it, _i: i }))
    .sort((a, b) => rank(a) - rank(b) || a._i - b._i)
}

export default function ImportScreen({ campId, onNavigate }) {
  // Units and time blocks are scoped to a Program; an import files them under
  // the active one so the setup screens will show them (T33).
  const { activeCohort } = useCohorts(campId)
  const [fileNames, setFileNames] = useState([])
  const [preview, setPreview] = useState(null)
  const [chosen, setChosen] = useState({})
  // Proposed recurring fixed events (T34), and which the director has ticked.
  // High-confidence events start ticked; low-confidence start unticked, mirroring
  // the rare-entity treatment. operatingDayCount is only for the "every day" hint.
  const [fixedEvents, setFixedEvents] = useState([])
  const [chosenFixedEvents, setChosenFixedEvents] = useState(new Set())
  const [operatingDayCount, setOperatingDayCount] = useState(0)
  // Inferred (or director-edited) rules per activity name (T35). Plain object,
  // not a Map, so it sits in React state cleanly: name -> { eligible_group_names,
  // min_per_week, max_per_week, priority, _inferred }.
  const [activityRules, setActivityRules] = useState({})
  const [error, setError] = useState(null)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState(null)
  // T73 — a held import: { conflicts, context } where context is the exact
  // inputs to re-submit. `resolving` toggles the entry banner → resolution queue.
  const [held, setHeld] = useState(null)
  const [resolving, setResolving] = useState(false)
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
    setHeld(null)
    setResolving(false)
    setFixedEvents([])
    setChosenFixedEvents(new Set())
    setActivityRules({})
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
      // Everything starts approved except values the file gives no reason to
      // trust — seen once across the camp AND not universal in any one unit,
      // or a name that is two other proposed names welded together. Nothing is
      // hidden either way; the unticked rows are right there with their count.
      const initial = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        const { create, lowConfidence = [] } = next.perEntity[entity]
        const low = new Set(lowConfidence)
        initial[entity] = new Set(create.filter((n) => !low.has(n)))
      }
      setChosen(initial)

      // Recurring fixed events implied by the grid (T34). High-confidence ones
      // (holding on every operating day) start ticked; low-confidence ones (a
      // majority but not all) start unticked — the same treatment rare entities
      // get. All are shown; ticking is the director's act.
      const { fixedEvents: inferred } = inferFixedEvents({ pages }, proposal)
      setFixedEvents(inferred)
      setChosenFixedEvents(new Set(inferred.filter((fe) => fe.confidence === 'high').map(fixedEventKey)))
      setOperatingDayCount(proposal.entities.days_of_operation.length)

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
  // styling reflects it is now the director's value rather than a proposal.
  function updateActivityRule(name, patch) {
    setActivityRules((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? {}), ...patch, _inferred: false },
    }))
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
    // Only the units of groups actually being created are sent, so a bunk
    // the director unticked cannot drag a unit in behind it.
    const groupUnits = {}
    for (const name of approved.groups ?? []) {
      if (preview.groupUnits?.[name]) groupUnits[name] = preview.groupUnits[name]
    }
    // Only the fixed events the director ticked; unticked ones are not sent.
    const tickedFixedEvents = fixedEvents.filter((fe) => chosenFixedEvents.has(fixedEventKey(fe)))
    // Only rules for activities the director actually approved — an
    // activity they unticked must not carry a rule into commitIngest, same
    // principle as groupUnits above. priority is already 'high'/'low', the
    // same value the activities table reads — no conversion at this
    // boundary (round 2 review, Fix 1).
    const outgoingRules = {}
    for (const name of approved.activities ?? []) {
      const rule = activityRules[name]
      if (!rule) continue
      outgoingRules[name] = {
        eligible_group_names: rule.eligible_group_names ?? null,
        min_per_week: rule.min_per_week,
        max_per_week: rule.max_per_week,
        priority: rule.priority,
      }
    }
    return {
      approved,
      links: { groups: groupUnits },
      cohort_id: activeCohort?.id ?? null,
      fixedEvents: tickedFixedEvents,
      activityRules: outgoingRules,
      mode: importMode === 'replace' ? 'replace' : 'add',
    }
  }

  // Held is NOT an error (design spec §1.1): a held return wrote nothing, so it
  // must not route through the catch or S.errorBanner. A real thrown failure
  // still does.
  function mapCommitError(err) {
    const message = err?.message ?? ''
    // The main-process host-only refusal (T61) already says the one thing the
    // director can act on. Passed through rather than mapped, or
    // describeWriteFailure's honest "not something the app recognised"
    // fallback would bury it.
    return /admin role required/i.test(message) ? 'Only an admin can import a schedule.'
      : /can only be run on the main computer/i.test(message) ? `${message} Nothing was imported.`
      : describeWriteFailure(err, 'Nothing was imported. Your camp is exactly as it was.')
  }

  async function commit() {
    setWorking(true)
    setError(null)
    try {
      const inputs = buildCommitInputs()
      // T61 — Replace is ONE awaited call. The teardown that used to run here,
      // one IPC round trip per row with no atomicity across them, now happens
      // inside the same main-process transaction as the create half.
      const outcome = await localClient.ingestCommit(inputs)
      if (outcome.held) {
        // A pause, not a failure — surface the held items for resolution (T73).
        setHeld({ conflicts: outcome.conflicts, context: inputs })
        setResolving(false)
        setPreview(null)
        return
      }
      setResult(outcome)
      setHeld(null)
      setPreview(null)
      setFixedEvents([])
      setChosenFixedEvents(new Set())
      setActivityRules({})
    } catch (err) {
      setError(mapCommitError(err))
    } finally {
      setWorking(false)
    }
  }

  // T73 — the director resolved every held item and clicked Finish. Re-submit the
  // SAME original inputs (minus any skipped identity names) plus the resolutions.
  // Returns the outcome so the queue can honestly re-enter on a peer-race re-hold
  // (design spec §4.3). On success, tears the surface down to the normal result.
  async function finishHeld(resolutions, skips) {
    const base = held.context
    const approved = {}
    for (const entity of INGESTIBLE_ENTITIES) approved[entity] = [...(base.approved[entity] ?? [])]
    for (const s of skips ?? []) {
      approved[s.entity] = (approved[s.entity] ?? []).filter((n) => n !== s.name)
    }
    setWorking(true)
    setError(null)
    try {
      const outcome = await localClient.ingestCommit({ ...base, approved, resolutions })
      if (outcome.held) return outcome
      setResult(outcome)
      setHeld(null)
      setResolving(false)
      setPreview(null)
      setFixedEvents([])
      setChosenFixedEvents(new Set())
      setActivityRules({})
      return outcome
    } catch (err) {
      setError(mapCommitError(err))
      return null
    } finally {
      setWorking(false)
    }
  }

  function dismissHeld() {
    setHeld(null)
    setResolving(false)
    setPreview(null)
    setFileNames([])
    setFixedEvents([])
    setChosenFixedEvents(new Set())
    setActivityRules({})
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
          {/* What the Replace destroyed, stated rather than implied — an
              import never silently omits (ADR §1), and that cuts both ways. */}
          {result.replaced && (
            <div style={{ marginTop: 8 }}>
              {sumCounts(result.replaced.entities)} old setup {sumCounts(result.replaced.entities) === 1 ? 'record was' : 'records were'} cleared first,
              along with {sumCounts(result.replaced.dependents)} schedule {sumCounts(result.replaced.dependents) === 1 ? 'row' : 'rows'} that used {sumCounts(result.replaced.entities) === 1 ? 'it' : 'them'}.
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="press-97" onClick={() => onNavigate('groups')} style={S.btnSecondary}>Go to Groups</button>
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
      </div>

      {held && (() => {
        const heldQueue = deriveQueue(held.conflicts)
        const n = heldQueue.length
        if (!resolving) {
          return (
            <div style={{
              background: 'color-mix(in srgb, var(--accent) 6%, var(--surface))',
              border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)',
              borderRadius: 8, padding: '12px 14px', marginBottom: 16, fontSize: 13, lineHeight: 1.6,
              animation: 'importHeldIn var(--motion-base) var(--ease-out)',
            }}>
              <strong>
                Almost there — your import is ready except for {n} {n === 1 ? 'item' : 'items'} I need you on.
              </strong>
              <div style={{ marginTop: 8 }}>
                Nothing has been added or changed yet. Once you’ve answered {n === 1 ? 'it' : `these ${n}`}, the whole import goes in together.
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
                <button className="press-97" onClick={() => setResolving(true)} style={S.btnPrimary}>
                  Review the {n} {n === 1 ? 'item' : 'items'}
                </button>
                <button className="press-97" onClick={dismissHeld} disabled={working} style={S.btnSecondary}>
                  Not now
                </button>
              </div>
            </div>
          )
        }
        return (
          <HeldResolution
            key={held.conflicts}
            conflicts={held.conflicts}
            working={working}
            onFinish={finishHeld}
            onLeave={dismissHeld}
          />
        )
      })()}

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
                { key: 'replace', title: 'Replace them', sub: `This will replace all Units, Groups, Days, Time Blocks, and Activities across the entire camp — every Program, not just this one. Clear the ${existingCountAll} existing ${existingCountAll === 1 ? 'item' : 'items'} first, then import. These are ordinary records — anything replaced can be brought back from Trash.` },
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
              disabled={working || approvedCount === 0 || !activeCohort}
              style={{ ...S.btnPrimary, opacity: working || approvedCount === 0 || !activeCohort ? 0.45 : 1 }}
            >
              {working
                ? 'Importing…'
                : importMode === 'replace' && existingCountAll > 0
                  ? `Replace with ${approvedCount} ${approvedCount === 1 ? 'record' : 'records'}`
                  : `Add ${approvedCount} ${approvedCount === 1 ? 'record' : 'records'}`}
            </button>
            <button className="press-97" onClick={() => { setPreview(null); setFileNames([]) }} disabled={working} style={S.btnSecondary}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// T73 — the held-import resolution surface: one focused decision at a time with
// a slim orientation rail (design spec §2). Owns only its own queue UI state;
// the re-commit itself is the parent's finishHeld (the single privileged
// committer, re-run with resolutions). Renderer state only — leaving loses it,
// and that is honest because the backend wrote nothing (spec §5).
function HeldResolution({ conflicts: initialConflicts, working, onFinish, onLeave }) {
  const [conflicts, setConflicts] = useState(initialConflicts)
  const queue = deriveQueue(conflicts)
  // answers[id] = { choice, entity_id? }. A stale item is answered once SEEN
  // (keep-mine is the safe default, spec §4.1); an identity item only by an
  // explicit click.
  const [answers, setAnswers] = useState({})
  const [seen, setSeen] = useState(() => (queue.length ? new Set([queue[0].id]) : new Set()))
  const [currentId, setCurrentId] = useState(queue.length ? queue[0].id : null)
  const [raceNote, setRaceNote] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const isAnswered = (it, ans = answers, sn = seen) =>
    it.kind === 'identity' ? !!ans[it.id] : sn.has(it.id)
  const answeredCount = queue.filter((it) => isAnswered(it)).length
  const waiting = queue.length - answeredCount
  const allAnswered = queue.length > 0 && waiting === 0
  const current = queue.find((it) => it.id === currentId) ?? queue[0]

  function focus(id) {
    setCurrentId(id)
    setSeen((s) => { const n = new Set(s); n.add(id); return n })
  }

  function advanceFrom(fromId, nextAns, nextSeen) {
    const idx = queue.findIndex((q) => q.id === fromId)
    const order = [...queue.slice(idx + 1), ...queue.slice(0, idx)]
    const next = order.find((q) => !isAnswered(q, nextAns, nextSeen))
    if (next) focus(next.id)
  }

  function answer(item, value) {
    const nextAns = { ...answers, [item.id]: value }
    setAnswers(nextAns)
    // Stale items are already in `seen` (they were focused); identity items get
    // marked seen too so the gate math is uniform.
    const nextSeen = new Set(seen); nextSeen.add(item.id)
    setSeen(nextSeen)
    advanceFrom(item.id, nextAns, nextSeen)
  }

  const staleChoice = (id) => answers[id]?.choice ?? 'keep'

  async function finish() {
    const resolutions = []
    const skips = []
    for (const item of queue) {
      if (item.kind === 'identity') {
        const a = answers[item.id]
        if (!a) continue
        if (a.choice === 'same') resolutions.push({ entity: item.entity, name: item.name, reason: 'ambiguous_identity', choice: 'existing', entity_id: a.entity_id })
        else if (a.choice === 'new') resolutions.push({ entity: item.entity, name: item.name, reason: 'ambiguous_identity', choice: 'create' })
        else if (a.choice === 'skip') skips.push({ entity: item.entity, name: item.name })
      } else {
        resolutions.push({ entity: item.entity, name: item.name, reason: 'stale', field: item.field, choice: staleChoice(item.id) })
      }
    }
    const outcome = await onFinish(resolutions, skips)
    if (outcome?.held) {
      // Peer race (spec §4.3): a new held item appeared while resolving. Keep the
      // answers already given, fold the new conflict into the queue, and say so.
      setConflicts(outcome.conflicts)
      setRaceNote(true)
      const newQueue = deriveQueue(outcome.conflicts)
      const firstUnanswered = newQueue.find((q) => !isAnswered(q, answers, seen))
      if (firstUnanswered) focus(firstUnanswered.id)
    }
  }

  // A choice echo for the rail (spec §2.2).
  function echo(item) {
    if (item.kind === 'identity') {
      const a = answers[item.id]
      if (!a) return null
      if (a.choice === 'same') return `→ using your existing ${item.name}`
      if (a.choice === 'new') return `→ added as new`
      if (a.choice === 'skip') return `→ skipped, not added`
    }
    return staleChoice(item.id) === 'accept' ? `→ using the file’s value` : `→ kept yours`
  }

  const surface = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', marginBottom: 16 }
  const cardStyle = { background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', animation: 'importCardIn var(--motion-base) var(--ease-out)' }

  if (queue.length === 0) return null

  return (
    <div style={{ ...surface, animation: 'importCardIn var(--motion-base) var(--ease-out)' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
        A few things to sort out before this import goes in
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, marginBottom: 14 }}>
        {allAnswered ? `All ${queue.length} answered.` : `You’re on ${Math.min(answeredCount + 1, queue.length)} of ${queue.length}.`}
      </div>

      {raceNote && (
        <div style={{
          background: 'color-mix(in srgb, var(--accent) 6%, var(--surface))',
          border: '1px solid color-mix(in srgb, var(--accent) 40%, var(--border))',
          borderRadius: 7, padding: '8px 10px', fontSize: 12, lineHeight: 1.6, color: 'var(--text)', marginBottom: 12,
        }}>
          One more came up while you were working — someone else made a change. Just answer it too, and the whole import goes in together.
        </div>
      )}

      {/* Orientation rail — glyph + word + colour, never colour alone (spec §2.2). */}
      <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 14 }}>
        {queue.map((it) => {
          const answered = isAnswered(it)
          const isCurrent = it.id === current?.id
          const glyph = answered ? '✓' : isCurrent ? '●' : '○'
          const color = answered ? 'var(--success)' : isCurrent ? 'var(--accent)' : 'var(--text-secondary)'
          const question = it.kind === 'identity'
            ? `Is “${it.name}” the same as before?`
            : `${it.name} — ${fieldLabel(it.field)}`
          return (
            <button
              key={it.id}
              onClick={() => focus(it.id)}
              style={{
                display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
                background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                padding: '4px 0', fontSize: 13, lineHeight: 1.5,
                color: answered || isCurrent ? 'var(--text)' : 'var(--text-secondary)',
                fontWeight: isCurrent ? 600 : 400,
              }}
            >
              <span style={{ color, fontSize: 13 }}>{glyph}</span>
              <span style={{ flex: 1 }}>{question}</span>
              {answered && <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{echo(it)}</span>}
              {isCurrent && !answered && <span style={{ color: 'var(--accent)', fontSize: 12 }}>← now</span>}
            </button>
          )
        })}
      </div>

      {/* Focused slot: the current decision card, or the Finish card once all answered. */}
      {allAnswered
        ? <FinishCard queue={queue} answers={answers} staleChoice={staleChoice} working={working} onFinish={finish} />
        : current?.kind === 'identity'
          ? <IdentityCard key={current.id} item={current} answer={answers[current.id]} onAnswer={(v) => answer(current, v)} style={cardStyle} />
          : <StaleCard key={current.id} item={current} choice={staleChoice(current.id)} onChoose={(c) => answer(current, { kind: 'stale', choice: c })} style={cardStyle} />}

      {/* Footer gate — hold-the-whole made visible (spec §4.2). */}
      {!allAnswered && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Nothing goes in until all {queue.length} are answered.
            {waiting > 0 && <span> Waiting on {waiting}.</span>}
          </div>
          <button className="press-97" onClick={() => setLeaving(true)} disabled={working} style={{ ...S.btnSecondary, fontSize: 12, padding: '5px 10px' }}>
            Leave
          </button>
        </div>
      )}

      {leaving && (
        <div style={{
          marginTop: 14, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', fontSize: 13, lineHeight: 1.6,
        }}>
          <strong>Leave without finishing?</strong>
          <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>
            Your import hasn’t gone in yet, and the answers you’ve given won’t be saved. You can start it again anytime from the same file — nothing in your camp has changed.
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
            <button className="press-97" onClick={() => setLeaving(false)} style={S.btnPrimary}>Stay and finish</button>
            <button className="press-97" onClick={onLeave} style={S.btnSecondary}>Leave</button>
          </div>
        </div>
      )}
    </div>
  )
}

// Equal-weight, no-default choice button (spec §3.1). Selected = 1.5px primary
// border + 8% navy tint + leading ●, matching the keep-vs-replace selector.
function ChoiceButton({ selected, onClick, disabled, children }) {
  return (
    <button
      className="press-97"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
        padding: '10px 12px', borderRadius: 7, fontFamily: 'inherit',
        background: selected ? 'color-mix(in srgb, var(--primary) 8%, var(--surface))' : 'var(--surface)',
        border: `1.5px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}

// Confirm-identity card (spec §3.1). Two named things joined by ≟ (asking, not
// proposing), three equal-weight choices, no pre-selection. "Create new" is
// suppressed when a candidate shares the incoming raw name (UNIQUE would re-hold).
function IdentityCard({ item, answer, onAnswer, style }) {
  const candidates = item.conflict.evidence?.candidates ?? []
  const rawDup = candidates.some((c) => c.name === item.name)
  const chosenId = answer?.choice === 'same' ? answer.entity_id : null

  return (
    <div style={style}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
        {candidates.length > 1 ? 'Which one is this?' : 'Is this the same thing?'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
        In this file: <strong style={{ color: 'var(--text)' }}>“{item.name}”</strong>
        {candidates.length > 1 && <> — you already have {candidates.length} things this could be. <span style={{ fontFamily: 'var(--font-mono)' }}>≟</span></>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {candidates.map((c) => (
          <ChoiceButton key={c.id} selected={chosenId === c.id} onClick={() => onAnswer({ kind: 'identity', choice: 'same', entity_id: c.id })}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {chosenId === c.id ? '● ' : '○ '}{candidates.length > 1 ? `Use “${c.name}”` : `Same thing — use my existing “${c.name}”`}
            </div>
          </ChoiceButton>
        ))}

        {!rawDup && (
          <ChoiceButton selected={answer?.choice === 'new'} onClick={() => onAnswer({ kind: 'identity', choice: 'new' })}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {answer?.choice === 'new' ? '● ' : '○ '}A different, new one — add “{item.name}” as new
            </div>
          </ChoiceButton>
        )}

        <ChoiceButton selected={answer?.choice === 'skip'} onClick={() => onAnswer({ kind: 'identity', choice: 'skip' })}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {answer?.choice === 'skip' ? '● ' : '○ '}Skip this for now
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, marginLeft: 16 }}>
            Leave this one out — everything else still goes in.
          </div>
        </ChoiceButton>
      </div>
    </div>
  )
}

// Kept-change card (spec §3.2). The director hand-edited a value; the file would
// overwrite it. Keep-mine is the safe pre-selected default; the FULL-CONTRAST
// value is always the one that will take effect (the emphasis swaps on toggle).
function StaleCard({ item, choice, onChoose, style }) {
  const mine = item.delta?.from ?? null      // the value the director typed (from)
  const theirs = item.delta?.to               // the file's value (to)
  const keeping = choice !== 'accept'
  const fmt = (v) => (v === null || v === undefined || v === '' ? '(empty)' : String(v))

  return (
    <div style={style}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
        You changed this by hand
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 12 }}>
        {item.name} — {fieldLabel(item.field)}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14, fontSize: 13 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12, width: 96 }}>You set this to</span>
          <span style={{ color: keeping ? 'var(--text)' : 'var(--text-secondary)', fontWeight: keeping ? 600 : 400, textDecoration: keeping ? 'none' : 'line-through' }}>{fmt(mine)}</span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12, width: 96 }}>The file says</span>
          <span style={{ color: keeping ? 'var(--text-secondary)' : 'var(--text)', fontWeight: keeping ? 400 : 600 }}>{fmt(theirs)}</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ChoiceButton selected={keeping} onClick={() => onChoose('keep')}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {keeping ? '● ' : '○ '}Keep mine ({fmt(mine)})
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, marginLeft: 16 }}>
            The file’s value won’t be applied.
          </div>
        </ChoiceButton>
        <ChoiceButton selected={!keeping} onClick={() => onChoose('accept')}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {!keeping ? '● ' : '○ '}Use the file’s ({fmt(theirs)})
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, marginLeft: 16 }}>
            Replace what I typed.
          </div>
        </ChoiceButton>
      </div>
    </div>
  )
}

// Pre-commit summary (spec §4.2): a quiet green-forward echo of every decision,
// with the outcome-counting Finish button. On click → the atomic re-commit.
function FinishCard({ queue, answers, staleChoice, working, onFinish }) {
  const added = queue.filter((it) => it.kind === 'identity' && answers[it.id]?.choice === 'new').length
  const lines = queue.map((it) => {
    if (it.kind === 'identity') {
      const a = answers[it.id]
      if (a?.choice === 'same') return `“${it.name}” — using your existing one`
      if (a?.choice === 'new') return `“${it.name}” — added as new`
      return `${it.name} — skipped, not added`
    }
    return `${it.name}’s ${fieldLabel(it.field)} — ${staleChoice(it.id) === 'accept' ? 'using the file’s value' : 'kept yours'}`
  })

  return (
    <div style={{
      background: 'color-mix(in srgb, var(--success) 6%, var(--surface))',
      border: '1px solid var(--border)', borderLeft: '3px solid var(--success)',
      borderRadius: 10, padding: '16px 18px', fontSize: 13, lineHeight: 1.6,
      animation: 'importCardIn var(--motion-settle) var(--ease-out)',
    }}>
      <strong>All sorted. Here’s what will go in:</strong>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--success)' }}>✓</span>
            <span style={{ color: 'var(--text)' }}>{l}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="press-97" onClick={onFinish} disabled={working} style={{ ...S.btnPrimary, opacity: working ? 0.45 : 1 }}>
          {working ? 'Finishing…' : `Finish import${added > 0 ? ` — add ${added} new ${added === 1 ? 'item' : 'items'}` : ''}`}
        </button>
      </div>
    </div>
  )
}

// One activity's inferred (or edited) rule: a compact summary line plus
// inline editing. `rule` is undefined for an activity nothing was inferred
// for (e.g. it never appeared in a `days`-oriented grid, T35 gotcha) — that
// activity gets blank inputs, same as before this work, not a crash.
function ActivityRuleRow({ name, rule, allGroups, onChange, onToggleGroup }) {
  const inferred = rule?._inferred !== false && rule != null
  const textColor = inferred ? 'var(--text-secondary)' : 'var(--text)'
  const groupNames = rule?.eligible_group_names ?? null // null = all groups
  // T35 Fix 2b — no page-level signal existed for this activity at all, so
  // "All groups" below would be an absence of evidence dressed as a
  // conclusion. Full-contrast, not muted like other inferred fields: this is
  // a thing worth the director's attention, not a confident default.
  const eligibilityUnknown = rule != null && rule.eligibility_known === false

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
      padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)',
      marginBottom: 6, fontSize: 12, background: 'var(--bg)',
    }}>
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
        <span style={{ color: textColor }}>
          {/* An empty selection and "all groups" (null) both write the same
              thing — no restriction (T35 Fix 3) — so they must say the same
              thing, or unticking every chip would silently lie about what
              gets committed. */}
          {groupNames === null || groupNames.length === 0
            ? 'All groups'
            : `Groups: ${groupNames.join(', ')}`}
        </span>
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
  )
}
