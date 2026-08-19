import { useEffect, useRef, useState } from 'react'
import { DecisionCard, RequiredGapCard, RequiredGapSummaryCard } from './reconciliationCards.jsx'
import { DOMAIN_LABELS } from './domainRollup.js'
import { screenForNode, SCREEN_LABEL } from './rootMapNav.js'
import { prefersReducedMotion } from '../../styles/shared'
import { isDecisionResolvedFor } from '../../screens/reconciliationTriage.js'

// Display labels for the four ingested states — match RootMap's tile labels so the
// panel heading reads "Needs attention", not the raw state key "attention".
const STATE_LABEL = {
  understood: 'Understood', attention: 'Needs attention', changed: 'Changed', absent: 'Not in this source',
}

// RootMapPanel — root-map port, docs/adr/2026-08-18-rootmap-screen-port.md §1/§3.
//
// Thin adapter: computes which decisions are in scope for `selection` and
// hands them to the existing, unchanged card components. Owns zero card
// rendering itself.
//
// selection: { type: 'none' } | { type: 'tile', state } | { type: 'node', domainKey, childKey? }

function decisionsForNode(model, domainKey, childKey) {
  const domain = model.domains.find((d) => d.key === domainKey)
  if (!domain) return []
  if (childKey) {
    const child = domain.children.find((c) => c.key === childKey)
    return child ? child.decisionIds : []
  }
  return domain.children.flatMap((c) => c.decisionIds)
}

function decisionsForTileState(model, state) {
  const ids = new Set()
  for (const domain of model.domains) {
    for (const child of domain.children) {
      if (child.state === state) child.decisionIds.forEach((id) => ids.add(id))
    }
  }
  return ids
}

// Resolves a node selection's heading to display labels: the domain part
// through DOMAIN_LABELS (so it reads "Resources" like the canvas node, not
// the raw key "Facility"), the child part through the model's own child
// name (not the internal selection.childKey) — guarded, since a selection
// can outlive the model it was made against (e.g. mid re-ingest).
function headingForNode(model, selection) {
  const domainLabel = DOMAIN_LABELS[selection.domainKey] ?? selection.domainKey
  if (!selection.childKey) return domainLabel
  const domain = model.domains.find((d) => d.key === selection.domainKey)
  const child = domain?.children.find((c) => c.key === selection.childKey)
  return child ? `${domainLabel} · ${child.name}` : domainLabel
}

// Panel content crossfade (finding 7 / Emil) — bespoke rather than the
// cards' useContentCrossfade: that hook fades opacity only, symmetric
// duration; this needs an added exit blur and an exit faster than its
// enter (motion-fast out, motion-base in), so it can't reuse the same
// style shape.
function usePanelCrossfade(dep) {
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
  const reduced = prefersReducedMotion()
  if (reduced) return {}
  return {
    opacity: entered ? 1 : 0,
    filter: entered ? 'blur(0px)' : 'blur(2px)',
    transition: entered
      ? 'opacity var(--motion-base) var(--ease-out), filter var(--motion-base) var(--ease-out)'
      : 'opacity var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out)',
  }
}

export default function RootMapPanel({
  model, selection, lanes, dismissedGaps, answers, onAnswer, onDismissGap, onUndismissGap,
  expandedEvidence, onToggleEvidence, onNavigate, onClearSelection,
}) {
  const allDecisions = [...lanes.hold, ...lanes.standard]
  const byId = new Map(allDecisions.map((d) => [d.id, d]))

  // H1 (docs/work/specs/2026-08-19-roots-reconciliation-audit.md §12 Slice 1)
  // — the default view must be honest to its "Needs your attention" header:
  // scope it to the unresolved subset, not the whole hold+standard queue.
  // Resolved items stay reachable via the "N resolved · Show all" footer
  // below (the Red Hat MEDIUM companion), never lost.
  const [showResolved, setShowResolved] = useState(false)
  // RootMapPanel isn't remounted on selection change (same instance,
  // `selection` is just a changing prop), so `showResolved` would otherwise
  // stay stuck true for the rest of the session after one "Show all" click
  // — silently re-defeating "quiet at first glance" on every later return
  // to the default view. Reset it by comparing against the selection seen
  // on the previous render, in the render body (React's documented pattern
  // for "adjusting state when a prop changes") rather than an effect —
  // an effect-based reset here trips react-hooks/set-state-in-effect.
  const [prevSelectionType, setPrevSelectionType] = useState(selection.type)
  if (selection.type !== prevSelectionType) {
    setPrevSelectionType(selection.type)
    if (showResolved) setShowResolved(false)
  }

  let scoped
  let heading
  let targetScreen = null
  let resolvedCount = 0
  if (selection.type === 'node') {
    const ids = decisionsForNode(model, selection.domainKey, selection.childKey)
    scoped = ids.map((id) => byId.get(id)).filter(Boolean)
    heading = headingForNode(model, selection)
    targetScreen = screenForNode(selection.domainKey, selection.childKey)
  } else if (selection.type === 'tile') {
    const ids = decisionsForTileState(model, selection.state)
    scoped = allDecisions.filter((d) => ids.has(d.id))
    heading = STATE_LABEL[selection.state] ?? selection.state
  } else {
    const unresolved = allDecisions.filter((d) => !isDecisionResolvedFor(d, answers, dismissedGaps))
    resolvedCount = allDecisions.length - unresolved.length
    scoped = showResolved ? allDecisions : unresolved
    heading = null
  }

  const gaps = scoped.filter((d) => d.kind === 'required_gap')
  const rest = scoped.filter((d) => d.kind !== 'required_gap')
  const selectionKey = `${selection.type}:${selection.domainKey ?? ''}:${selection.childKey ?? ''}:${selection.state ?? ''}`
  const crossfade = usePanelCrossfade(selectionKey)

  return (
    <div style={styles.panel} aria-label="Needs your attention">
      <div style={styles.panelHeader}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
          {heading ? heading : 'Needs your attention'}
        </span>
        {selection.type !== 'none' && (
          <button className="press-97" onClick={onClearSelection} style={styles.showAll}>Show all</button>
        )}
      </div>

      <div style={crossfade}>
      {selection.type === 'node' && (
        targetScreen ? (
          <>
            {scoped.length === 0 && (
              <div style={styles.empty}>Everything here looks right.</div>
            )}
            <button
              className="press-97"
              onClick={() => onNavigate?.(targetScreen)}
              style={styles.openButton}
            >
              {`Open in ${SCREEN_LABEL[targetScreen] ?? targetScreen} →`}
            </button>
          </>
        ) : (
          <div style={styles.empty}>
            Nothing about camp culture was in this file yet.
          </div>
        )
      )}
      {scoped.length === 0 ? (
        selection.type !== 'node' && (
          <div style={styles.empty}>
            Nothing needs you right now. Shoresh understood everything it found.
          </div>
        )
      ) : (
        <div>
          {gaps.length >= 2 ? (
            <RequiredGapSummaryCard
              decisions={gaps}
              dismissedGaps={dismissedGaps}
              onDismiss={onDismissGap}
              onUndismiss={onUndismissGap}
              onNavigate={onNavigate}
            />
          ) : (
            gaps.map((d) => (
              <RequiredGapCard
                key={d.id}
                decision={d}
                dismissed={dismissedGaps.has(d.id)}
                onDismiss={() => onDismissGap(d.id)}
                onUndismiss={() => onUndismissGap(d.id)}
                onNavigate={onNavigate}
              />
            ))
          )}
          {rest.map((d) => (
            <DecisionCard
              key={d.id}
              decision={d}
              rank={lanes.hold.includes(d) ? 'hold' : 'standard'}
              answer={answers[d.id]}
              onAnswer={(a) => onAnswer(d.id, a)}
              expanded={expandedEvidence.has(d.id)}
              onToggleEvidence={() => onToggleEvidence(d.id)}
            />
          ))}
        </div>
      )}
      </div>

      {selection.type === 'none' && resolvedCount > 0 && (
        <div style={styles.resolvedFooter}>
          <button className="press-97" onClick={() => setShowResolved((v) => !v)} style={styles.showAll}>
            {showResolved ? 'Hide resolved' : `${resolvedCount} resolved · Show all`}
          </button>
        </div>
      )}
    </div>
  )
}

const styles = {
  panel: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 16,
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  showAll: {
    background: 'none',
    border: 'none',
    color: 'var(--primary)',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  empty: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    padding: '8px 0',
  },
  resolvedFooter: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px dashed var(--border)',
    textAlign: 'right',
  },
  openButton: {
    display: 'block',
    width: '100%',
    padding: '9px 14px',
    marginBottom: 12,
    background: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'center',
  },
}
