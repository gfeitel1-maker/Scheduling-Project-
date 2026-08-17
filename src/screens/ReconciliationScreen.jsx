import { useEffect, useRef, useState } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition, prefersReducedMotion } from '../styles/shared'
import { buildReconciliationReport } from '../ingest/reconciliationReport.js'
import { buildBlastRadiusIndex } from '../ingest/blastRadius.js'
import { reportToLanes } from '../ingest/reportToLanes.js'
import { getReadiness } from '../engine/readiness.js'
import { describeWriteFailure } from '../utils/writeErrorMessage.js'
import ScreenIntro from '../components/ScreenIntro.jsx'
import { heldConflictsToDecisions, foldTriageInputs, isDecisionResolvedFor, mapCommitError, identityRememberCalls } from './reconciliationTriage.js'

// docs/work/specs/2026-08-17-reconciliation-onescreen-design.md — the one
// continuous surface that replaces ImportScreen's six-gate reconciliation
// flow. Seams 1-3+5, docs/adr/2026-08-17-onescreen-reconciliation-projection.md.
//
// This screen is a pure PROJECTION over buildReconciliationReport's output
// (ADR invariant 1): the only state it owns beyond the report itself is the
// director's in-progress triage answers, in the exact shape commitIngest
// already accepts (reconciliationResolutions.js). Every triage action re-runs
// the REAL dry-run transaction (localClient.ingestReconcile) — the staged
// tray is not a client-side guess, it is commitPlan re-run to completion and
// rolled back.

const DOMAIN_OF = {
  cohorts: 'Structure',
  tiers: 'Structure',
  groups: 'Structure',
  days_of_operation: 'Time',
  time_blocks: 'Time',
  locations: 'Facility',
  activities: 'Scheduling',
  anchor_activities: 'Scheduling',
}
const DOMAINS = ['Structure', 'Scheduling', 'Time', 'Facility']

// F3 — required_gap decisions carry no `entity` (DOMAIN_OF is keyed by
// entity name); they carry `screen` instead (readiness.js's REQUIRED_AREAS
// key). Same four-domain vocabulary, no second domain table.
const REQUIRED_GAP_DOMAIN = {
  tiers: 'Structure',
  groups: 'Structure',
  days: 'Time',
  timeblocks: 'Time',
  activities: 'Scheduling',
}

function domainOf(decision) {
  return decision.kind === 'required_gap'
    ? (REQUIRED_GAP_DOMAIN[decision.screen] ?? 'Structure')
    : DOMAIN_OF[decision.entity]
}

const CONFIDENCE_COPY = {
  high: 'clearly stated in the file',
  medium: 'inferred from context',
  low: 'a guess — worth a second look',
  conflict: 'in conflict with what Shoresh already has',
}

// FIX 2 (Tester, design spec §4) — human-readable evidence disclosure.
// decision.evidence never actually carries a row/sheet locator or an editor
// identity today (see src/ingest/reconciliationReport.js's activitySupportFor
// and src/ingest/fixedEvents.js's `support` shape: matched_groups/appearances
// or occupied_days/groups_in_scope — never a `row`/`sheet`/`editedBy`). The
// spec's §11 note 5 anticipates exactly this gap and requires falling back to
// the plain collapsed line rather than an empty table — so the two-column
// path below is forward-compatible (it activates the day evidence carries a
// locator + editor identity) but every decision in the app today degrades to
// the plain sentence, honestly built from what evidence IS present.
function formatFieldValue(value) {
  if (value == null) return 'unset'
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}: ${formatFieldValue(v)}`).join(', ')
  return String(value)
}

function plainEvidenceSentence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const parts = []
  if (Array.isArray(evidence.matched_groups) && evidence.matched_groups.length > 0) {
    parts.push(`seen across ${evidence.matched_groups.length} group${evidence.matched_groups.length === 1 ? '' : 's'}`)
  }
  if (typeof evidence.occupied_days === 'number' && typeof evidence.operating_days === 'number') {
    parts.push(`observed on ${evidence.occupied_days} of ${evidence.operating_days} operating days`)
  }
  if (Array.isArray(evidence.groups_in_scope) && evidence.groups_in_scope.length > 0) {
    parts.push(`across ${evidence.groups_in_scope.join(', ')}`)
  }
  return parts.length > 0 ? parts.join('; ') : null
}

// A comparison table only renders when evidence carries BOTH a locator (row
// or sheet) and an editor identity (editedBy or editedAt) — the exact two
// things §11 note 2 says the copy depends on. Neither is populated by any
// current caller, so this path is dormant but correct: it never fabricates a
// row/editor that wasn't actually reported.
function evidenceDisclosure(decision) {
  const confidenceLine = decision.confidence ? (CONFIDENCE_COPY[decision.confidence] ?? decision.confidence) : null
  const evidence = decision.evidence
  const hasLocator = evidence && typeof evidence === 'object' && (evidence.row != null || evidence.sheet != null)
  const hasEditorIdentity = evidence && typeof evidence === 'object' && (evidence.editedBy != null || evidence.editedAt != null)

  if (hasLocator && hasEditorIdentity) {
    return {
      table: true,
      fromFile: formatFieldValue(decision.proposedValue),
      fromFileDetail: evidence.row != null ? `seen in row ${evidence.row}${evidence.sheet ? `, ${evidence.sheet}` : ''}` : `seen in ${evidence.sheet}`,
      current: formatFieldValue(evidence.currentValue),
      currentDetail: evidence.editedBy
        ? `set by hand${evidence.editedAt ? ` ${evidence.editedAt}` : ''} (${evidence.editedBy})`
        : `set by hand${evidence.editedAt ? ` ${evidence.editedAt}` : ''}`,
    }
  }

  const sentence = plainEvidenceSentence(evidence)
  const text = [confidenceLine ? `From this file — ${confidenceLine}.` : null, sentence].filter(Boolean).join(' ')
  return { table: false, text: text || 'No evidence details available for this field.' }
}

// Measured max-height reveal (design spec §8 "Evidence panel expand"): the
// content stays mounted so both directions animate; under reduced motion it
// falls back to an opacity-only crossfade with no height animation, per the
// spec's global "every reveal ... opacity-only" rule.
function useMaxHeightReveal(expanded) {
  const ref = useRef(null)
  const reduced = prefersReducedMotion()
  const [maxHeight, setMaxHeight] = useState(0)
  useEffect(() => {
    if (expanded && ref.current) setMaxHeight(ref.current.scrollHeight)
    else if (!expanded) setMaxHeight(0)
  }, [expanded])
  const style = reduced
    ? { overflow: 'hidden', opacity: expanded ? 1 : 0, transition: `opacity var(--motion-base) var(--ease-out)` }
    : { overflow: 'hidden', maxHeight, transition: `max-height var(--motion-base) var(--ease-out)` }
  return { ref, style }
}

function EvidenceDetail({ decision, expanded }) {
  const { ref, style } = useMaxHeightReveal(expanded)
  const disclosure = evidenceDisclosure(decision)
  return (
    <div style={style}>
      <div ref={ref} style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, paddingBottom: 2 }}>
        {disclosure.table ? (
          <div style={styles.evidenceTable}>
            <div style={styles.evidenceTableHeader}>From this file</div>
            <div style={styles.evidenceTableHeader}>Current Shoresh record</div>
            <div>{disclosure.fromFile}</div>
            <div>{disclosure.current}</div>
            <div style={styles.evidenceTableDetail}>{disclosure.fromFileDetail}</div>
            <div style={styles.evidenceTableDetail}>{disclosure.currentDetail}</div>
          </div>
        ) : (
          disclosure.text
        )}
      </div>
    </div>
  )
}

// R7 — review_legacy_priority's consolidated batch decision carries a clear
// `reason` and the actual `activities` list; render both so the director can
// see what they're acknowledging instead of a bare button. Names-only list,
// disclosed via the same measured-reveal pattern as evidence — the batch can
// be large and the list shouldn't dominate the card by default.
function LegacyPriorityBody({ decision }) {
  const [showActivities, setShowActivities] = useState(false)
  const { ref, style } = useMaxHeightReveal(showActivities)
  const activities = decision.activities ?? []
  return (
    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
      {decision.reason}
      {activities.length > 0 && (
        <>
          {' '}
          <button className="press-97" onClick={() => setShowActivities((v) => !v)} style={styles.linkButton}>
            {showActivities ? 'Hide the activities' : `Show the ${activities.length} activities`}
          </button>
          <div style={style}>
            <ul ref={ref} style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {activities.map((a) => (
                <li key={a.entityId}>{a.name}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

async function fetchReadiness() {
  const collections = {
    cohorts: await localClient.list('cohorts').catch(() => []),
    tiers: await localClient.list('tiers').catch(() => []),
    groups: await localClient.list('groups').catch(() => []),
    days: await localClient.list('days_of_operation').catch(() => []),
    timeBlocks: await localClient.list('time_blocks').catch(() => []),
    activities: await localClient.list('activities').catch(() => []),
    anchors: await localClient.list('anchor_activities').catch(() => []),
    dayOverrides: await localClient.list('day_override_templates').catch(() => []),
  }
  return getReadiness(collections, null)
}

export default function ReconciliationScreen({ baseInputs, sourceLabel, onCommitted, onDiscard, onNavigate }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [answers, setAnswers] = useState({})
  const [activeFilters, setActiveFilters] = useState(new Set())
  const [expandedEvidence, setExpandedEvidence] = useState(new Set())
  const [showUnderstood, setShowUnderstood] = useState(false)
  const [showNotInSource, setShowNotInSource] = useState(false)
  const [applying, setApplying] = useState(false)
  const [rememberNotes, setRememberNotes] = useState([])
  // F3 — session-local only. Never written to `answers`, never folded into
  // foldTriageInputs, never sent to commitIngest (docs/adr/2026-08-17-
  // onescreen-reconciliation-merge.md §5).
  const [dismissedGaps, setDismissedGaps] = useState(new Set())

  const requestGenRef = useRef(0)
  const lastGoodReportRef = useRef(null)
  const debounceRef = useRef(null)

  async function runDryRun(answersForRun) {
    const myGen = ++requestGenRef.current
    setLoading(true)
    setError(null)
    try {
      const inputs = lastGoodReportRef.current
        ? foldTriageInputs(baseInputs, lastGoodReportRef.current.decisions, answersForRun)
        : baseInputs
      const result = await localClient.ingestReconcile(inputs)
      if (requestGenRef.current !== myGen) return // last-issued-wins: a newer request has already superseded this one

      if (result?.held) {
        const heldDecisions = heldConflictsToDecisions(result.conflicts)
        const prior = lastGoodReportRef.current
        const carryOver = (prior?.decisions ?? []).filter((d) => d.kind !== 'resolve_conflict')
        const merged = {
          decisions: [...heldDecisions, ...carryOver],
          buckets: prior?.buckets ?? { understood: 0, needsAttention: heldDecisions.length, notInSource: 0, changed: 0 },
          readiness: prior?.readiness ?? [],
        }
        if (requestGenRef.current !== myGen) return
        setReport(merged)
        setLoading(false)
        return
      }

      const readiness = await fetchReadiness()
      if (requestGenRef.current !== myGen) return
      const blastRadiusIndex = buildBlastRadiusIndex(result?.planItems ?? [])
      const nextReport = buildReconciliationReport({
        planItems: result?.planItems ?? [],
        readiness,
        now: new Date(),
        fixedEventsReport: result?.fixedEventsReport,
        legacyPriorityActivities: result?.legacyPriorityActivities,
        fieldProvenance: new Map(Object.entries(result?.fieldProvenance ?? {})),
        evidenceSupport: result?.evidenceSupport,
        blastRadiusIndex,
      })
      if (requestGenRef.current !== myGen) return
      lastGoodReportRef.current = nextReport
      setReport(nextReport)
    } catch (err) {
      if (requestGenRef.current !== myGen) return
      setError(describeWriteFailure(err, 'Could not check this file against your camp.'))
    } finally {
      if (requestGenRef.current === myGen) setLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial mount fetch, same pattern as ActivitiesScreen's load()
    runDryRun({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function stage(decisionId, answer) {
    const next = { ...answers, [decisionId]: answer }
    setAnswers(next)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runDryRun(next), 250)
  }

  async function apply(mode) {
    setApplying(true)
    setError(null)
    try {
      const decisions = report?.decisions ?? []
      const answersForApply = mode === 'confirmedOnly'
        ? Object.fromEntries(Object.entries(answers).filter(([id]) => decisions.some((d) => d.id === id && isDecisionResolvedFor(d, answers))))
        : answers
      const inputs = foldTriageInputs(baseInputs, decisions, answersForApply)
      const outcome = await localClient.ingestCommit(inputs)
      if (outcome?.held) {
        // A peer race held the real commit — surface it the same way the dry
        // run does, as fresh hold-lane cards, never a silent failure.
        const heldDecisions = heldConflictsToDecisions(outcome.conflicts)
        setReport((prev) => ({
          decisions: [...heldDecisions, ...(prev?.decisions ?? []).filter((d) => d.kind !== 'resolve_conflict')],
          buckets: prev?.buckets ?? { understood: 0, needsAttention: heldDecisions.length, notInSource: 0, changed: 0 },
          readiness: prev?.readiness ?? [],
        }))
        setApplying(false)
        return
      }
      // The apply is the FIRST dryRun:false call (ADR Seam 3). On success the
      // parent (ImportScreen) tears this screen down and shows its own
      // post-import receipt/readiness banner — no separate receipt state to
      // maintain here (per §9's v1 scope, no undo button either way).
      await confirmRemembers(identityRememberCalls(decisions, answersForApply, baseInputs.cohort_id))
      onCommitted?.(outcome)
    } catch (err) {
      setError(mapCommitError(err))
    } finally {
      setApplying(false)
    }
  }

  // S1b, restored — confirm each remembered alias mapping AFTER a successful
  // commit, one call per item, best-effort: a rejection (permission/locked/
  // non-host) is caught and surfaced as a subtle note, never thrown back into
  // apply() (the import itself already succeeded and must stay that way).
  async function confirmRemembers(calls) {
    if (!calls || calls.length === 0) return
    const notes = []
    for (const call of calls) {
      try {
        await localClient.confirmAlias(call)
      } catch {
        notes.push(`Couldn’t remember “${call.source_label}”`)
      }
    }
    if (notes.length > 0) setRememberNotes(notes)
  }

  if (loading && !report) {
    return (
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <ScreenIntro screen="reconciliation" />
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Checking this file against your camp…</p>
      </div>
    )
  }

  if (error && !report) {
    return (
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <ScreenIntro screen="reconciliation" />
        <div style={styles.errorBanner}>{error}</div>
        <button className="press-97" onClick={onDiscard} style={S.btnSecondary}>Back</button>
      </div>
    )
  }

  // reportToLanes already gives the exact two in-lane ranks the spec's visual
  // table needs (hold/standard); salienceOf's finer 0|1|2 rank is a rendering
  // hint reserved for a future finer-grained weight WITHIN a lane and is not
  // consulted here — order within each lane stays report.decisions order
  // (ADR invariant 2: salience never reorders truth).
  const lanes = reportToLanes(report ?? { decisions: [], buckets: {}, readiness: [] })

  const domainCounts = {}
  for (const domain of DOMAINS) {
    domainCounts[domain] = [...lanes.hold, ...lanes.standard].filter(
      (d) => domainOf(d) === domain && !isDecisionResolvedFor(d, answers, dismissedGaps),
    ).length
  }

  const visible = (d) => activeFilters.size === 0 || activeFilters.has(domainOf(d))
  const visibleHold = lanes.hold.filter(visible)
  const visibleStandard = lanes.standard.filter(visible)
  const visibleHoldGaps = visibleHold.filter((d) => d.kind === 'required_gap')

  const totalCount = lanes.hold.length + lanes.standard.length
  const doneCount = [...lanes.hold, ...lanes.standard].filter((d) => isDecisionResolvedFor(d, answers, dismissedGaps)).length
  const pct = totalCount === 0 ? 100 : Math.round((doneCount / totalCount) * 100)
  const confirmedCount = Object.keys(answers).filter((id) =>
    [...lanes.hold, ...lanes.standard].some((d) => d.id === id && isDecisionResolvedFor(d, answers, dismissedGaps)),
  ).length

  const understoodCount = report?.buckets?.understood ?? 0
  const notInSourceCount = report?.buckets?.notInSource ?? 0

  // A GENUINELY empty report (nothing to review, nothing understood, nothing
  // left out) has no write pending at all — that is the only case §10's end
  // state may short-circuit the tray, because the tray's two buttons are the
  // FIRST dryRun:false call (ADR Seam 3) and an 'understood' bucket, however
  // high-confidence, is still an UNCOMMITTED write until one of them runs.
  // Reaching the end state any other way (decisions resolved, or nothing to
  // decide but something to commit) goes through the real apply -> Receipt.
  const isGenuinelyEmpty = totalCount === 0 && understoodCount === 0 && notInSourceCount === 0 && lanes.readinessGreen

  function toggleFilter(domain) {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }

  function toggleEvidence(id) {
    setExpandedEvidence((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (isGenuinelyEmpty) {
    return <EndState onNavigate={onNavigate} />
  }

  return (
    <div style={{ maxWidth: 920, margin: '0 auto' }}>
      <ScreenIntro screen="reconciliation" />
      {error && <div style={styles.errorBanner}>{error}</div>}
      {rememberNotes.length > 0 && (
        <div style={styles.rememberNotesBanner}>{rememberNotes.join(' · ')}</div>
      )}

      <div style={styles.headerStrip}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
          Reconciling {sourceLabel}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {doneCount} of {totalCount} done
          </div>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${pct}%` }} />
          </div>
        </div>
      </div>

      {understoodCount > 0 && (
        <div style={styles.understoodRow}>
          <span>{understoodCount} rows read cleanly — nothing needed from you.</span>{' '}
          <button className="press-97" onClick={() => setShowUnderstood((v) => !v)} style={styles.linkButton}>
            {showUnderstood ? 'Hide details' : 'Show details'}
          </button>
        </div>
      )}

      <div style={styles.filterRow}>
        {DOMAINS.map((domain) => (
          <button
            key={domain}
            className="press-97"
            onClick={() => toggleFilter(domain)}
            style={activeFilters.has(domain) ? styles.chipSelected : styles.chip}
          >
            {domain} ({domainCounts[domain]})
          </button>
        ))}
      </div>

      <div>
        {visibleHoldGaps.length >= 2 ? (
          <RequiredGapSummaryCard
            decisions={visibleHoldGaps}
            dismissedGaps={dismissedGaps}
            onDismiss={(id) => setDismissedGaps((prev) => new Set(prev).add(id))}
            onUndismiss={(id) => setDismissedGaps((prev) => { const next = new Set(prev); next.delete(id); return next })}
            onNavigate={onNavigate}
          />
        ) : (
          visibleHoldGaps.map((d) => (
            <RequiredGapCard
              key={d.id}
              decision={d}
              dismissed={dismissedGaps.has(d.id)}
              onDismiss={() => setDismissedGaps((prev) => new Set(prev).add(d.id))}
              onUndismiss={() => setDismissedGaps((prev) => { const next = new Set(prev); next.delete(d.id); return next })}
              onNavigate={onNavigate}
            />
          ))
        )}
        {visibleHold.filter((d) => d.kind !== 'required_gap').map((d) => (
          <DecisionCard
            key={d.id}
            decision={d}
            rank="hold"
            answer={answers[d.id]}
            onAnswer={(a) => stage(d.id, a)}
            expanded={expandedEvidence.has(d.id)}
            onToggleEvidence={() => toggleEvidence(d.id)}
          />
        ))}
        {visibleStandard.map((d) => (
          <DecisionCard
            key={d.id}
            decision={d}
            rank="standard"
            answer={answers[d.id]}
            onAnswer={(a) => stage(d.id, a)}
            expanded={expandedEvidence.has(d.id)}
            onToggleEvidence={() => toggleEvidence(d.id)}
          />
        ))}
      </div>

      {notInSourceCount > 0 && (
        <div style={styles.notInSourceGap}>
          <span>{notInSourceCount} items not mentioned in this file — left as-is, not a problem.</span>{' '}
          <button className="press-97" onClick={() => setShowNotInSource((v) => !v)} style={styles.linkButton}>
            {showNotInSource ? 'Hide' : 'Show them'}
          </button>
        </div>
      )}

      <div style={styles.tray}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {confirmedCount > 0 ? `${confirmedCount} decisions staged` : 'Resolve at least one item, or apply what’s understood as-is.'}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="press-97"
            disabled={confirmedCount === 0 || applying}
            onClick={() => apply('confirmedOnly')}
            style={confirmedCount === 0 ? { ...S.btnSecondary, ...S.buttonDisabled } : S.btnSecondary}
            title={confirmedCount === 0 ? 'Resolve at least one item first.' : undefined}
          >
            Apply confirmed changes and keep the rest for review
          </button>
          <button
            className="press-97"
            disabled={doneCount < totalCount || applying}
            onClick={() => apply('all')}
            style={doneCount < totalCount ? { ...S.btnPrimary, ...S.buttonDisabled } : S.btnPrimary}
            title={doneCount < totalCount ? `Resolve the ${totalCount - doneCount} items marked for your attention first.` : undefined}
          >
            Use this setup
          </button>
        </div>
      </div>
    </div>
  )
}

function isIdentityDecision(decision) {
  return decision.kind === 'resolve_conflict' && (decision._held ? decision._heldKind === 'identity' : true)
}

function DecisionCard({ decision, rank, answer, onAnswer, expanded, onToggleEvidence }) {
  const resolved = isDecisionResolvedFor(decision, { [decision.id]: answer })
  const cardStyle = rank === 'hold' ? styles.cardHold : styles.cardStandard
  const question = questionFor(decision)
  // S1b, restored — the "remember this" alias checkbox only makes sense once
  // the director has pointed at an EXISTING record ('existing'); 'create' has
  // no existing record to alias to. Default-on, per the old flow's contract.
  const showRemember = resolved && isIdentityDecision(decision) && answer?.choice === 'existing'
  // design spec §8 "Card resolves" — opacity 1->0.6, --motion-fast; the
  // resolved-vs-controls content swap crossfades in via the same duration,
  // keyed on `resolved` so it re-fires on both resolve and Undo.
  const contentFade = useContentCrossfade(resolved)

  return (
    <div style={{ ...cardStyle, opacity: resolved ? 0.6 : 1, transition: 'opacity var(--motion-fast) var(--ease-out)' }}>
      <div style={{ fontWeight: 600, fontSize: rank === 'hold' ? 14 : 13, color: 'var(--text)' }}>{question}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
        {decision.entity} · {decision.entityName ?? 'unnamed'} · {DOMAIN_OF[decision.entity] ?? 'Structure'}
      </div>

      <div style={contentFade}>
      {resolved ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          {`✓ ${summaryOf(decision, answer)}`}
          {' '}
          <button className="press-97" onClick={() => onAnswer(null)} style={styles.linkButton}>Undo</button>
          {showRemember && (
            <label style={styles.rememberRow}>
              <input
                type="checkbox"
                checked={answer.remember ?? true}
                onChange={(e) => onAnswer({ ...answer, remember: e.target.checked })}
              />
              Remember this for next time
            </label>
          )}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8 }}>
            {`From this file${decision.confidence ? ` · ${CONFIDENCE_COPY[decision.confidence] ?? decision.confidence}` : ''}`}
            {' '}
            <button className="press-97" onClick={onToggleEvidence} style={styles.linkButton}>Why?</button>
          </div>
          {decision.from && decision.to && (
            // F2 — structured day/time-block relocation for a moved fixed
            // event (ADR §4). Minimal inline rendering; a fuller from/to
            // panel is Designer-scoped follow-up work, not this slice.
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              {`${decision.from.day} · ${decision.from.timeBlock} → ${decision.to.day} · ${decision.to.timeBlock}`}
            </div>
          )}
          {decision.kind === 'review_legacy_priority' ? (
            <LegacyPriorityBody decision={decision} />
          ) : (
            <EvidenceDetail decision={decision} expanded={expanded} />
          )}
          <ResolutionControls decision={decision} onAnswer={onAnswer} />
        </>
      )}
      </div>
    </div>
  )
}

// F3 — a required setup gap ("can I build at all") rather than a
// reconciliation choice ("which value is right"). Reuses the cardHold shell
// verbatim; the one visual addition is the small mono-caps "READY TO BUILD?"
// tab, the owner-approved exception to "no badge colour beyond the bronze
// bar" (docs/work/specs/2026-08-17-reconciliation-r8-honesty-compression-design.md §F3).
// Dismissal ("Skip for now") is local-only — it never calls stage()/onAnswer,
// so it can never reach answers/foldTriageInputs/commitIngest.
function RequiredGapCard({ decision, dismissed, onDismiss, onUndismiss, onNavigate }) {
  const question = decision.message
    ? `${decision.label} aren't set up yet — ${decision.message}`
    : `${decision.label} is required before you can build a schedule.`

  return (
    <div style={{ ...styles.cardHold, position: 'relative', opacity: dismissed ? 0.6 : 1, transition: 'opacity var(--motion-fast) var(--ease-out)' }}>
      <div style={styles.readyToBuildTab}>READY TO BUILD?</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{question}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
        setup · {decision.label} · {REQUIRED_GAP_DOMAIN[decision.screen] ?? 'Structure'}
      </div>

      {dismissed ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          {`Skipped — ${decision.label} still isn't set up.`}
          {' '}
          <button className="press-97" onClick={onUndismiss} style={styles.linkButton}>Undo</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            className="press-97"
            onClick={() => onNavigate?.(decision.screen)}
            style={styles.btnCompactAccent}
          >
            {`Set up ${decision.label}`}
          </button>
          <button className="press-97" onClick={onDismiss} style={styles.btnCompactSecondary}>
            {`Skip ${decision.label} for now — I'll add it later`}
          </button>
        </div>
      )}
    </div>
  )
}

// §22 compression — Tester's finding: 5+ stacked RequiredGapCards read as a
// "setup gauntlet." When 2+ required_gap decisions are in the hold lane,
// fold them into ONE card instead. Rendering-only fold: each gap stays
// individually dismissible (onDismiss/onUndismiss per decision.id) and the
// spine's doneCount still counts each dismissed gap separately, via the same
// isDecisionResolvedFor(d, answers, dismissedGaps) per-decision check.
function RequiredGapSummaryCard({ decisions, dismissedGaps, onDismiss, onUndismiss, onNavigate }) {
  const labels = decisions.map((d) => d.label).join(', ')

  return (
    <div style={{ ...styles.cardHold, position: 'relative' }}>
      <div style={styles.readyToBuildTab}>READY TO BUILD?</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
        {`Your camp still needs: ${labels}`}
      </div>

      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {decisions.map((d) => {
          const dismissed = dismissedGaps.has(d.id)
          return (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              {dismissed ? (
                <>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {`Skipped — ${d.label} still isn't set up.`}
                  </span>
                  <button className="press-97" onClick={() => onUndismiss(d.id)} style={styles.linkButton}>Undo</button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{d.label}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="press-97"
                      onClick={() => onNavigate?.(d.screen)}
                      style={styles.btnCompactAccent}
                    >
                      {`Set up ${d.label}`}
                    </button>
                    <button className="press-97" onClick={() => onDismiss(d.id)} style={styles.btnCompactSecondary}>
                      {`Skip ${d.label} for now — I'll add it later`}
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// design spec §8 "Card resolves" content swap — a short opacity crossfade,
// --motion-fast (140ms), re-triggered whenever `dep` changes. Reduced motion
// still crossfades (opacity-only was already the whole effect, nothing to
// strip), per the spec's global reduced-motion rule.
function useContentCrossfade(dep) {
  const [entered, setEntered] = useState(true)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    setEntered(false)
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [dep])
  return {
    opacity: entered ? 1 : 0,
    transition: 'opacity var(--motion-fast) var(--ease-out)',
  }
}

function questionFor(decision) {
  const name = decision.entityName ?? 'this record'
  if (decision.kind === 'resolve_conflict') {
    return decision._held && decision._heldKind === 'stale'
      ? `Keep the current value for "${name}"'s ${decision.field?.[0]} or use the file's value?`
      : `Is "${name}" a new record, or one you already have?`
  }
  if (decision.kind === 'confirm_change') return `"${name}" was hand-edited — keep it or overwrite from the file?`
  if (decision.kind === 'review_legacy_priority') {
    const count = decision.count ?? 0
    return `Review priority for ${count} ${count === 1 ? 'activity' : 'activities'} carried over from an earlier import`
  }
  return `Use the file's value for "${name}"?`
}

function summaryOf(decision, answer) {
  if (!answer) return 'Resolved'
  if (answer.action === 'looks_right') return 'Using the file’s value'
  if (answer.choice === 'accept') return 'Will use the file’s value'
  if (answer.choice === 'keep') return 'Keeping the current value'
  if (answer.choice === 'existing') return 'Using your existing record'
  if (answer.choice === 'create') return 'Adding as new'
  if (answer.resolved) return 'Acknowledged'
  return 'Resolved'
}

function ResolutionControls({ decision, onAnswer }) {
  if (decision.kind === 'confirm_value') {
    return (
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="press-97" onClick={() => onAnswer({ action: 'looks_right' })} style={styles.btnCompactPrimary}>Use this value</button>
        <button className="press-97" onClick={() => onAnswer({ action: 'edited' })} style={styles.btnCompactSecondary}>Keep current</button>
      </div>
    )
  }

  if (decision.kind === 'review_legacy_priority') {
    return (
      <div style={{ marginTop: 10 }}>
        <button className="press-97" onClick={() => onAnswer({ resolved: true })} style={styles.btnCompactSecondary}>Acknowledge</button>
      </div>
    )
  }

  if (decision.kind === 'confirm_change') {
    return (
      <div style={{ marginTop: 10 }}>
        <RadioOption label={`Use the file's value${decision.proposedValue != null ? ` — "${JSON.stringify(decision.proposedValue)}"` : ''}`} description="Overwrites what's in Shoresh now." onClick={() => onAnswer({ choice: 'accept' })} />
        <RadioOption label="Keep the current value" description="Ignores this file's value going forward for this field." onClick={() => onAnswer({ choice: 'keep' })} />
      </div>
    )
  }

  // resolve_conflict — identity or stale, held or pre-write.
  if (isIdentityDecision(decision)) {
    return (
      <div style={{ marginTop: 10 }}>
        {(decision._candidates ?? []).map((c) => (
          <RadioOption
            key={c.entity_id}
            label={`Use "${c.name ?? c.entity_id}"`}
            description="Matches an existing record."
            onClick={() => onAnswer({ choice: 'existing', entity_id: c.entity_id })}
          />
        ))}
        <RadioOption label="Something else — add as new" description="Creates a new record from the file's value." onClick={() => onAnswer({ choice: 'create' })} />
        <RadioOption label="Leave unset for now" description="Skip this decision — it stays here for you to come back to; nothing is written for it." onClick={() => onAnswer({ choice: 'skip' })} />
      </div>
    )
  }
  return (
    <div style={{ marginTop: 10 }}>
      <RadioOption label={`Use the file's value — "${JSON.stringify(decision.proposedValue)}"`} description="Overwrites what's in Shoresh now." onClick={() => onAnswer({ choice: 'accept' })} />
      <RadioOption label="Keep the current value" description="Ignores this file's value going forward for this field." onClick={() => onAnswer({ choice: 'keep' })} />
    </div>
  )
}

function RadioOption({ label, description, onClick }) {
  return (
    <label style={styles.radioOption}>
      <input type="radio" onChange={onClick} style={{ marginTop: 3 }} />
      <span>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{description}</div>
      </span>
    </label>
  )
}

function EndState({ onNavigate }) {
  const enterStyle = useEnterTransition('liftFade')
  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: '60px 16px', textAlign: 'center', ...enterStyle }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Nothing left to reconcile.</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8 }}>
        Your camp setup reflects this file. You're ready to build a schedule.
      </div>
      {onNavigate && (
        <button className="press-97" onClick={() => onNavigate('schedule')} style={{ ...S.btnPrimary, marginTop: 16 }}>
          Go to Schedule
        </button>
      )}
    </div>
  )
}

const styles = {
  headerStrip: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '16px 0 12px',
    borderBottom: '1px solid var(--border)',
    position: 'sticky',
    top: 0,
    background: 'var(--bg)',
    zIndex: 5,
  },
  progressTrack: {
    marginTop: 6,
    height: 3,
    background: 'var(--border)',
    borderRadius: 2,
    overflow: 'hidden',
    width: 140,
  },
  progressFill: {
    height: '100%',
    background: 'var(--secondary)',
    transition: 'width var(--motion-base) var(--ease-out)',
  },
  understoodRow: {
    padding: '10px 4px',
    color: 'var(--text-secondary)',
    fontSize: 13,
  },
  filterRow: {
    display: 'flex',
    gap: 8,
    padding: '4px 0 16px',
    flexWrap: 'wrap',
  },
  chip: {
    padding: '5px 12px',
    border: '1px solid var(--border)',
    borderRadius: 999,
    fontSize: 13,
    background: 'var(--surface)',
    color: 'var(--text)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  chipSelected: {
    padding: '5px 12px',
    border: '1px solid var(--primary)',
    borderRadius: 999,
    fontSize: 13,
    background: 'var(--primary)',
    color: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  cardHold: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    borderLeft: '4px solid var(--accent)',
    padding: 16,
    marginBottom: 12,
  },
  cardStandard: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    borderLeft: '4px solid var(--border)',
    padding: 12,
    marginBottom: 6,
  },
  radioOption: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
    padding: '6px 0',
    cursor: 'pointer',
  },
  notInSourceGap: {
    padding: '16px 4px',
    borderTop: '1px dashed var(--border)',
    color: 'var(--text-secondary)',
    fontSize: 13,
    marginTop: 8,
  },
  tray: {
    position: 'sticky',
    bottom: 0,
    background: 'var(--surface-elevated)',
    borderTop: '1px solid var(--border)',
    padding: '14px 20px',
    boxShadow: '0 -2px 12px color-mix(in srgb, var(--text) 6%, transparent)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  linkButton: {
    background: 'none',
    border: 'none',
    color: 'var(--primary)',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  btnCompactPrimary: {
    padding: '5px 12px',
    background: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  readyToBuildTab: {
    position: 'absolute',
    top: -9,
    left: 12,
    background: 'var(--bg)',
    color: 'var(--accent)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.06em',
    fontWeight: 600,
    padding: '0 4px',
  },
  btnCompactAccent: {
    padding: '5px 12px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnCompactSecondary: {
    padding: '5px 12px',
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  errorBanner: {
    background: 'color-mix(in srgb, var(--warning) 8%, var(--surface))',
    border: '1px solid var(--warning)',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 16,
    fontSize: 13,
    color: 'var(--text)',
  },
  rememberRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginLeft: 12,
    fontSize: 12,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
  evidenceTable: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '2px 16px',
  },
  evidenceTableHeader: {
    fontWeight: 600,
    color: 'var(--text)',
  },
  evidenceTableDetail: {
    color: 'var(--text-secondary)',
    fontSize: 11,
  },
  rememberNotesBanner: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 16,
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
  },
}
