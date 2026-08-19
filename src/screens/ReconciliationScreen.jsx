import { useEffect, useRef, useState } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition, prefersReducedMotion } from '../styles/shared'
import { buildReconciliationReport } from '../ingest/reconciliationReport.js'
import { buildBlastRadiusIndex } from '../ingest/blastRadius.js'
import { reportToLanes } from '../ingest/reportToLanes.js'
import { getReadiness } from '../engine/readiness.js'
import { fetchCensusSnapshot } from '../ingest/existingSnapshot.js'
import { describeWriteFailure } from '../utils/writeErrorMessage.js'
import ScreenIntro from '../components/ScreenIntro.jsx'
import { heldConflictsToDecisions, foldTriageInputs, isDecisionResolvedFor, mapCommitError, identityRememberCalls } from './reconciliationTriage.js'
import { computeDomainCounts } from '../components/reconciliation/domainRollup.js'
import ReconstructionMoment from '../components/reconciliation/ReconstructionMoment.jsx'
import { shouldShowReconstructionMoment } from '../components/reconciliation/reconstructionMoment.gate.js'
import { buildRootMapModel } from '../ingest/rootMapModel.js'
import RootMap from '../components/reconciliation/RootMap.jsx'
import RootMapPanel from '../components/reconciliation/RootMapPanel.jsx'

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

export default function ReconciliationScreen({ baseInputs, sourceLabel, onCommitted, onDiscard, onNavigate, factCount = 0, isFirstImport = false }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Roots census roster (Slice 2, docs/adr/2026-08-19-roots-census-and-
  // persistent-inspector.md §(a)/(e)) — canonical table-name-keyed live
  // rows, feeding buildRootMapModel's per-child roster. Separate from
  // `report`/fetchReadiness on purpose; see fetchCensusSnapshot's own doc.
  const [censusSnapshot, setCensusSnapshot] = useState({})
  const [answers, setAnswers] = useState({})
  // ADR docs/adr/2026-08-18-rootmap-screen-port.md §5 — replaces the old
  // `activeFilters` multi-select Set with one selection union: 'none' (the
  // default needs-attention queue), a tile (single state, across domains),
  // or a root node (a specific domain or child, any state). This is an
  // intentional UX narrowing from the old chip row's additive multi-domain
  // filtering, dictated by the interaction spec's single-select model.
  const [selection, setSelection] = useState({ type: 'none' })
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

  // Roots reconstruction moment (docs/adr/2026-08-18-roots-reconstruction-
  // moment-gating.md) — the show/skip decision is made ONCE, before the
  // moment ever paints, from props computed at parse time in ImportScreen.
  // Recomputing it after mount would let a flash of the wrong branch through.
  const [showMoment] = useState(() => shouldShowReconstructionMoment({
    factCount,
    isFirstImport,
    prefersReducedMotion: prefersReducedMotion(),
  }))
  const [momentSettled, setMomentSettled] = useState(false)

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
      const snapshot = await fetchCensusSnapshot(localClient.list)
      if (requestGenRef.current !== myGen) return
      setCensusSnapshot(snapshot)
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
      // U1 (docs/adr/2026-08-17-onescreen-reconciliation-undo.md) — opt into
      // capturing this commit's field-update inverses so the parent can offer
      // a grace-window "Undo this import" affordance. No-op when mode is
      // 'replace' (commitPlan's own Invariant-3 guard would throw otherwise);
      // buildCommitInputs never sets mode:'replace' AND captureInverse
      // together — foldTriageInputs' mode comes straight from baseInputs.
      const outcome = await localClient.ingestCommit({ ...inputs, captureInverse: inputs.mode !== 'replace' })
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
      // maintain here. U1: the grace-window undo affordance now lives on
      // ImportScreen too (it outlives this screen, which unmounts on
      // success) — outcome.invertibleOps/createdEntityIds ride along on the
      // same onCommitted callback ImportScreen already consumes.
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

  if (showMoment && !momentSettled && !error) {
    // Phase 1 (growing) while report is null, Phase 2 (settling) the instant
    // it lands — driven by promise resolution, not a timer (Gate 1). The
    // rollup reuses the exact filter/resolution logic the main render uses
    // below, via the shared domainRollup helper.
    const momentLanes = report ? reportToLanes(report) : null
    const momentDomainCounts = momentLanes
      ? computeDomainCounts([...momentLanes.hold, ...momentLanes.standard], (d) => isDecisionResolvedFor(d, answers, dismissedGaps))
      : null
    return (
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <ScreenIntro screen="reconciliation" />
        <ReconstructionMoment
          settling={!!report}
          domainCounts={momentDomainCounts}
          onSettled={() => setMomentSettled(true)}
        />
      </div>
    )
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

  const rootMapModel = buildRootMapModel(report, { answers, dismissedGaps, snapshot: censusSnapshot })

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

  // Interaction spec §1 — tile click toggles (re-clicking the active tile
  // clears the filter); node click always replaces the selection, never
  // appends.
  function selectTile(state) {
    setSelection({ type: 'tile', state })
  }
  function selectNode(domainKey, childKey) {
    setSelection({ type: 'node', domainKey, childKey: childKey ?? undefined })
  }
  function clearSelection() {
    setSelection({ type: 'none' })
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

      <RootMap
        model={rootMapModel}
        selection={selection}
        onSelectTile={selectTile}
        onSelectNode={selectNode}
        onClearSelection={clearSelection}
      />

      <div style={{ marginTop: 16 }}>
        <RootMapPanel
          model={rootMapModel}
          selection={selection}
          lanes={lanes}
          answers={answers}
          dismissedGaps={dismissedGaps}
          onAnswer={(id, a) => stage(id, a)}
          onDismissGap={(id) => setDismissedGaps((prev) => new Set(prev).add(id))}
          onUndismissGap={(id) => setDismissedGaps((prev) => { const next = new Set(prev); next.delete(id); return next })}
          expandedEvidence={expandedEvidence}
          onToggleEvidence={toggleEvidence}
          onNavigate={onNavigate}
          onClearSelection={clearSelection}
        />
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
