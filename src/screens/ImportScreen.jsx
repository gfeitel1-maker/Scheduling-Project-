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
  // What the camp already holds, and whether to keep it or clear it first.
  // Captured when the preview is built so the keep-vs-replace choice can show a
  // real count. 'add' keeps everything; 'replace' deletes the existing setup
  // (recoverable from Trash) before importing. Programs/"Main" is never deleted
  // — it is structural, auto-created, and not part of a year's schedule.
  const [existingRecords, setExistingRecords] = useState({})
  const [importMode, setImportMode] = useState('add')

  const REPLACEABLE = INGESTIBLE_ENTITIES.filter((e) => e !== 'cohorts')
  const existingCount = REPLACEABLE.reduce((n, e) => n + (existingRecords[e]?.length ?? 0), 0)

  // A camp's schedule can arrive as several files — Camp Mindy exports one
  // spreadsheet per group. They are one camp and must be read as one import,
  // or the same days and activities are proposed four times over and the
  // groups arrive in four separate passes.
  async function readFiles(fileList) {
    setError(null)
    setResult(null)
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
          const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
          const sheets = wb.SheetNames.map((name) => ({
            name,
            // raw:false so Excel formats each cell the way the sheet displays it.
            // A time typed as a time is stored as a fraction of a day — 9:15am
            // is 0.3854166666666667 — and reading it raw puts that number in
            // the camp as the name of a period.
            rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false }),
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
      for (const entity of INGESTIBLE_ENTITIES) {
        let rows = await localClient.list(entity).catch(() => [])
        // Duplicate-detection for the Program-scoped entities is scoped to the
        // active Program, or a re-import into a different Program would skip a
        // unit/time-block that only exists in another one (T33).
        if ((entity === 'tiers' || entity === 'time_blocks') && activeCohort) {
          rows = rows.filter((r) => r.cohort_id === activeCohort.id)
        }
        existing[entity] = rows
      }
      setExistingRecords(existing)
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

  async function commit() {
    setWorking(true)
    setError(null)
    try {
      // Replace = clear the existing setup first. Deletes go to Trash (the
      // director can bring anything back), and "Main" is left alone. Done
      // before the import so a clean slate is what the new records land on.
      if (importMode === 'replace' && existingCount > 0) {
        const token = localStorage.getItem('shoresh-token')
        for (const entity of REPLACEABLE) {
          for (const row of existingRecords[entity] ?? []) {
            await localClient.deleteEntity(token, entity, row.id)
          }
        }
        // Fixed events (anchor_activities) are not in REPLACEABLE because they
        // are not imported through the entity path, but they must be cleared too
        // or a re-import creates duplicates on top of the prior year's anchors.
        const existingAnchors = await localClient.list('anchor_activities').catch(() => [])
        for (const row of existingAnchors) {
          await localClient.deleteEntity(token, 'anchor_activities', row.id)
        }
      }

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
      const outcome = await localClient.ingestCommit(
        approved, { groups: groupUnits }, activeCohort?.id ?? null, tickedFixedEvents, outgoingRules
      )
      setResult(outcome)
      setPreview(null)
      setFixedEvents([])
      setChosenFixedEvents(new Set())
      setActivityRules({})
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can import a schedule.'
          : describeWriteFailure(err, 'Nothing was imported. Your camp is exactly as it was.')
      )
    } finally {
      setWorking(false)
    }
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
          <div style={{ marginTop: 10 }}>
            <button onClick={() => onNavigate('groups')} style={S.btnSecondary}>Go to Groups</button>
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
                      <button onClick={clearInferredRules} style={{ ...S.btnSecondary, padding: '4px 10px', fontSize: 11 }}>
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
              recoverable (Trash), so it is a plain choice, not a scary gate. */}
          {existingCount > 0 && (
            <div style={{
              marginTop: 20, padding: '14px 16px', background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 8,
            }}>
              <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 10 }}>
                Your camp already has <strong>{existingCount}</strong> {existingCount === 1 ? 'item' : 'items'} set up. What should happen to {existingCount === 1 ? 'it' : 'them'}?
              </div>
              {[
                { key: 'add', title: 'Keep them', sub: 'Add what I import alongside what’s already here.' },
                { key: 'replace', title: 'Replace them', sub: `Clear the ${existingCount} existing ${existingCount === 1 ? 'item' : 'items'} first, then import. You can bring anything back from Trash.` },
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
            <button
              onClick={commit}
              disabled={working || approvedCount === 0 || !activeCohort}
              style={{ ...S.btnPrimary, opacity: working || approvedCount === 0 || !activeCohort ? 0.45 : 1 }}
            >
              {working
                ? 'Importing…'
                : importMode === 'replace' && existingCount > 0
                  ? `Replace with ${approvedCount} ${approvedCount === 1 ? 'record' : 'records'}`
                  : `Add ${approvedCount} ${approvedCount === 1 ? 'record' : 'records'}`}
            </button>
            <button onClick={() => { setPreview(null); setFileNames([]) }} disabled={working} style={S.btnSecondary}>
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
