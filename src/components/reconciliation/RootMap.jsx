import { useState, useEffect } from 'react'
import { prefersReducedMotion, useEnterTransition } from '../../styles/shared'
import { DOMAIN_LABELS } from './domainRollup.js'
import { CONFIDENCE_COPY, plainEvidenceSentence } from './reconciliationCards.jsx'
import forestCircle from '../../assets/brand/forest-circle.png'

// RootMap — foundation-first stacked layout, replacing the SVG orb/backdrop
// canvas per docs/work/specs/2026-08-21-roots-metaphor-visual.md (Governor
// consolidation is authoritative where it refines the baseline). A director
// certifying their camp's foundation: information and precise detail, never
// spectacle. Presentational only, controlled by props — zero business logic.

const STATE_TOKEN = {
  understood: 'var(--secondary)',
  attention: 'var(--accent)',
  changed: 'var(--primary)',
  absent: 'var(--anchor)',
  // Required-5 only — "this domain applies and nobody has touched it yet",
  // distinct from 'absent' ("positive evidence this domain doesn't apply").
  not_set_up: 'var(--border)',
}

// Chip-facing status vocabulary — pinned by the spec, replacing the old
// crown-tile-era STATE_LABEL. 'absent' is domain-only (Context, import mode)
// and stays visually/textually distinct from 'not_set_up'.
const STATE_LABEL = {
  understood: 'Rooted',
  changed: 'Rooted · Changed',
  attention: 'Not yet rooted',
  not_set_up: 'Not started',
}
const ABSENT_LABEL = 'Not in source'

function statusLabelFor(state) {
  if (state === 'absent') return ABSENT_LABEL
  return STATE_LABEL[state] ?? state
}

const TILE_STATES = ['understood', 'attention', 'changed', 'absent']
// Filter-row tile labels — the old crown-tile copy, kept distinct from the
// chip-facing STATE_LABEL above (they read differently: "Understood" the
// count-tile heading vs. "Rooted" the per-entity chip sub-label).
const TILE_LABEL = {
  understood: 'Understood',
  attention: 'Needs attention',
  changed: 'Changed',
  absent: 'Not in source',
}

function selectionMatchesNode(selection, domainKey, childKey) {
  if (selection.type !== 'node') return false
  if (childKey) return selection.domainKey === domainKey && selection.childKey === childKey
  return selection.domainKey === domainKey && !selection.childKey
}

// Hover-driven affordances are a mouse convenience; a touch tap fires the
// same mouseenter without a matching leave, so gate them to a real pointer.
// Computed once (matchMedia is undefined in SSR/jsdom without a mock, so
// default to true — fine pointer — there).
function hasFinePointer() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

// One-line "why" + light provenance cue for a decision-backed attention
// chip, built ONLY from data already present on the decision (reason /
// confidence / evidence / unknowns) — reusing the existing copy maps
// verbatim, per the spec's Information layer section. Returns null when
// there is nothing decision-backed to say (clean nodes stay quiet — that
// case is explicitly deferred, not built here).
function describeWhy(decision) {
  if (!decision) return null
  if (decision.reason) return decision.reason
  const sentence = plainEvidenceSentence(decision.evidence)
  const confidence = decision.confidence ? CONFIDENCE_COPY[decision.confidence] : null
  if (sentence) return confidence ? `${sentence} — ${confidence}` : sentence
  if (confidence) return confidence
  if (Array.isArray(decision.unknowns) && decision.unknowns.length > 0) {
    return `Unclear: ${decision.unknowns.join(', ')}`
  }
  return null
}

// The "takes root" signature confirm micro-animation (spec + Governor
// consolidation): a chip's state transitioning attention/changed -> understood
// between renders plays as a CSS TRANSITION (not a keyframe bounce, so rapid
// confirms retarget cleanly) — a brief transform bump that eases back to rest,
// concurrent with the root-tick underline draw-in (kept as a keyframe, it's a
// one-shot decorative accent, not a retargetable gesture).
function useTakesRoot(state) {
  const [prevState, setPrevState] = useState(state)
  const [phase, setPhase] = useState('idle') // 'idle' | 'bump' | 'settle'
  if (prevState !== state) {
    setPrevState(state)
    if ((prevState === 'attention' || prevState === 'changed') && state === 'understood') {
      setPhase('bump')
    }
  }
  useEffect(() => {
    if (phase !== 'bump') return
    const id = requestAnimationFrame(() => setPhase('settle'))
    return () => cancelAnimationFrame(id)
  }, [phase])
  useEffect(() => {
    if (phase !== 'settle') return
    const id = setTimeout(() => setPhase('idle'), 260)
    return () => clearTimeout(id)
  }, [phase])
  return phase
}

function Chip({ child, selected, dimmedOut, onSelect, decisionsById, pulseEligible }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [finePointer] = useState(hasFinePointer)
  const reduced = prefersReducedMotion()

  const rootPhase = useTakesRoot(child.state)
  const rooting = rootPhase !== 'idle'

  const label = statusLabelFor(child.state)
  const decision = child.decisionIds?.length ? decisionsById?.get(child.decisionIds[0]) : null
  const why = child.state === 'attention' ? describeWhy(decision) : null

  const showHint = child.state === 'attention' && (focused || (hovered && finePointer))
  const pulse = child.state === 'attention' && pulseEligible && !reduced

  const tintedBorder = child.state === 'understood' || child.state === 'changed'
    ? `color-mix(in srgb, ${STATE_TOKEN[child.state]} 32%, var(--border))`
    : selected
      ? STATE_TOKEN[child.state]
      : (hovered || focused) && child.state === 'attention'
        ? 'var(--accent)'
        : 'var(--border)'

  const style = {
    ...styles.chip,
    opacity: dimmedOut ? 0.35 : 1,
    borderColor: tintedBorder,
    borderWidth: selected ? 2 : 1,
    transform: !reduced && rootPhase === 'bump' ? 'scale(1.035)' : 'scale(1)',
    transition: reduced
      ? 'opacity var(--motion-base) var(--ease-out)'
      : rootPhase === 'bump'
        ? 'border-color var(--motion-base) var(--ease-out), background var(--motion-base) var(--ease-out), opacity var(--motion-base) var(--ease-out)'
        : 'border-color var(--motion-base) var(--ease-out), background var(--motion-base) var(--ease-out), opacity var(--motion-base) var(--ease-out), transform var(--motion-base) var(--ease-out)',
    alignItems: why ? 'flex-start' : 'center',
  }

  return (
    <button
      type="button"
      className="press-97"
      aria-label={`${child.name} — ${label}`}
      aria-pressed={selected}
      data-pulse={pulse ? 'true' : undefined}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={style}
    >
      <span style={{ ...styles.dot, background: STATE_TOKEN[child.state] }} />
      <span style={styles.chipTextCol}>
        <span style={styles.chipLabelRow}>
          <span style={styles.chipLabel}>{child.count ? `${child.name} — ${child.count}` : child.name}</span>
          <span style={styles.chipSub}>{label}</span>
        </span>
        {why && <span style={styles.chipWhy}>{why}</span>}
      </span>
      {showHint && <span style={styles.confirmHint}>Click to confirm →</span>}
      {rooting && !reduced && <span key={rootPhase === 'bump' ? 'tick-on' : 'tick-off'} data-rooting="true" style={styles.rootTick} />}
    </button>
  )
}

function CensusTile({ state, active, count, onClick }) {
  const [hovered, setHovered] = useState(false)
  const reduced = prefersReducedMotion()
  const baseStyle = active
    ? {
        ...styles.tile,
        borderWidth: 2,
        borderColor: STATE_TOKEN[state],
        background: `color-mix(in srgb, var(--surface) 92%, ${STATE_TOKEN[state]} 8%)`,
      }
    : { ...styles.tile, borderLeftWidth: 3, borderLeftColor: STATE_TOKEN[state] }
  const style = {
    ...baseStyle,
    transform: hovered && !reduced ? 'translateY(-2px)' : 'none',
    boxShadow: hovered
      ? '0 4px 10px color-mix(in srgb, var(--text) 12%, transparent)'
      : '0 1px 3px color-mix(in srgb, var(--text) 8%, transparent)',
    transition: 'transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)',
  }
  return (
    <button
      type="button"
      className="press-97"
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={style}
    >
      <div style={styles.tileCount}>{count}</div>
      <div style={styles.tileLabel}>{TILE_LABEL[state]}</div>
    </button>
  )
}

function DomainHead({ domainKey, state, selected, onSelect }) {
  return (
    <button
      type="button"
      className="press-97"
      aria-label={`${DOMAIN_LABELS[domainKey] ?? domainKey} — ${statusLabelFor(state)}`}
      aria-pressed={selected}
      onClick={onSelect}
      style={styles.domainHead}
    >
      <span style={styles.domainName}>
        <span style={{ ...styles.depthMark, background: STATE_TOKEN[state] }} />
        {DOMAIN_LABELS[domainKey] ?? domainKey}
      </span>
      <span style={styles.domainStatus}>{statusLabelFor(state)}</span>
    </button>
  )
}

export default function RootMap({ model, selection, onSelectTile, onSelectNode, onClearSelection, canvasWrapRef, decisionsById }) {
  const wholeCampEnter = useEnterTransition('settle')
  const wholeCampEmpty = model.domains.every((d) => d.children.length === 0)
  const dimmed = (domainKey, childKey) => {
    if (selection.type !== 'tile') return false
    const domain = model.domains.find((d) => d.key === domainKey)
    if (childKey) {
      const child = domain?.children.find((c) => c.key === childKey)
      return child ? child.state !== selection.state : true
    }
    return domain ? domain.state !== selection.state : true
  }

  const tileCounts = TILE_STATES.reduce((acc, state) => {
    acc[state] = model.domains.reduce(
      (sum, d) => sum + d.children.filter((c) => c.state === state).length,
      0,
    )
    return acc
  }, {})

  // Pulse scoping (Governor consolidation) — attention chips only breathe
  // inside the currently focused/selected domain layer, never all at once.
  const focusedDomainKey = selection.type === 'node' ? selection.domainKey : null

  return (
    <div>
      <div style={styles.filterRow}>
        {TILE_STATES.map((state) => {
          const active = selection.type === 'tile' && selection.state === state
          return (
            <CensusTile
              key={state}
              state={state}
              active={active}
              count={tileCounts[state]}
              onClick={() => (active ? onClearSelection() : onSelectTile(state))}
            />
          )
        })}
      </div>

      <div style={styles.domainStack} ref={canvasWrapRef}>
        {wholeCampEmpty ? (
          <div style={{ ...styles.wholeCampEmpty, ...wholeCampEnter }}>
            <img src={forestCircle} alt="" style={styles.wholeCampEmptyIcon} />
            <div style={styles.wholeCampEmptyBody}>
              Nothing imported yet — bring in your roster to get started.
            </div>
          </div>
        ) : model.domains.map((domain) => {
          const emphasized = domain.state === 'attention' || domain.state === 'not_set_up'
          // Mosaic: a card's footprint follows its content weight (how many
          // entities it holds) AND its state. A busy or attention-needing
          // domain claims a wider, taller tile; a light one stays compact — so
          // the grid reads as a considered Bento, not four equal cards. Widths
          // are whole grid tracks (span 1/2); height scales continuously with
          // the entity count so tiles vary in both axes.
          const weight = domain.children.length
          const wide = emphasized || weight >= 4
          const cardStyle = {
            ...styles.domainLayer,
            gridColumn: wide ? 'span 2' : 'span 1',
            minHeight: emphasized ? 188 : Math.min(188, 104 + weight * 22),
            borderLeftWidth: emphasized ? 3 : 1,
            borderLeftColor: emphasized ? STATE_TOKEN[domain.state] : 'var(--border)',
            background: emphasized
              ? `color-mix(in srgb, var(--surface) 95%, ${STATE_TOKEN[domain.state]} 5%)`
              : 'var(--surface)',
            transition: prefersReducedMotion()
              ? undefined
              : 'min-height var(--motion-settle) var(--ease-out), border-color var(--motion-settle) var(--ease-out), background var(--motion-settle) var(--ease-out)',
          }
          return (
          <div key={domain.key} style={cardStyle}>
            <DomainHead
              domainKey={domain.key}
              state={domain.state}
              selected={selectionMatchesNode(selection, domain.key, null)}
              onSelect={() => onSelectNode(domain.key, undefined)}
            />
            {domain.children.length === 0 ? (
              <div style={styles.emptyNote}>No entities imported yet — this layer has no root.</div>
            ) : (
              <div style={styles.chipRow}>
                {domain.children.map((child) => (
                  <Chip
                    key={child.key}
                    child={child}
                    selected={selectionMatchesNode(selection, domain.key, child.key)}
                    dimmedOut={dimmed(domain.key, child.key)}
                    onSelect={() => onSelectNode(domain.key, child.key)}
                    decisionsById={decisionsById}
                    pulseEligible={focusedDomainKey === domain.key}
                  />
                ))}
              </div>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}

const styles = {
  filterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  tile: {
    background: 'var(--surface)',
    opacity: 0.94,
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '10px 14px',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
    minWidth: 120,
  },
  tileCount: { fontSize: 20, fontWeight: 600, color: 'var(--text)' },
  tileLabel: { fontSize: 12, color: 'var(--text-secondary)' },
  domainStack: {
    display: 'grid',
    // Lower floor (240 vs 320) so the mosaic forms 3–4 columns at normal app
    // width, not just on wide screens; still collapses to one column below it.
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gridAutoFlow: 'dense',
    gap: 10,
  },
  domainLayer: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '14px 16px 16px',
  },
  domainHead: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  domainName: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text)',
  },
  depthMark: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
    transition: 'background var(--motion-base) var(--ease-out)',
  },
  domainStatus: {
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
  },
  emptyNote: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
    marginTop: 12,
  },
  // W12b (docs/work/specs/2026-08-22-brand-placement-round2.md §3) — the
  // one-time, whole-camp "open and waiting" moment; gone the instant any
  // entity exists anywhere in the camp. Per-domain-layer emptyNote above
  // stays untouched — this doesn't layer icons onto every domain, just this
  // single first-impression state.
  wholeCampEmpty: {
    textAlign: 'center',
    padding: '48px 16px',
  },
  wholeCampEmptyIcon: {
    width: 140,
    height: 140,
    display: 'block',
    margin: '0 auto 16px',
    objectFit: 'contain',
  },
  wholeCampEmptyBody: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    maxWidth: '48ch',
    margin: '0 auto',
  },
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  chip: {
    position: 'relative',
    display: 'inline-flex',
    gap: 8,
    padding: '9px 14px 9px 12px',
    borderRadius: 8,
    borderStyle: 'solid',
    background: 'var(--surface)',
    cursor: 'pointer',
    fontSize: 13.5,
    fontWeight: 500,
    fontFamily: 'inherit',
    userSelect: 'none',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
    marginTop: 5,
    transition: 'background var(--motion-base) var(--ease-out)',
  },
  chipTextCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  chipLabelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  chipLabel: { color: 'var(--text)' },
  chipSub: {
    color: 'var(--text-secondary)',
    fontSize: 11.5,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
  },
  chipWhy: {
    color: 'var(--text-secondary)',
    fontSize: 11.5,
    maxWidth: 260,
  },
  confirmHint: {
    color: 'var(--accent)',
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    alignSelf: 'center',
  },
  rootTick: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: -1,
    height: 2,
    borderRadius: 2,
    background: 'var(--secondary)',
    transformOrigin: 'left center',
    // Governor consolidation: the root-tick must stay "under the 300ms
    // feel" — --motion-settle (340ms) is too slow; --motion-base (220ms) is
    // the sub-300ms token. Only the tick, not the bump/settle transition.
    animation: 'chipRootTick var(--motion-base) var(--ease-out) 1',
  },
}
