import { useState, useEffect } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition, prefersReducedMotion } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import { useCurrentStructureCounts } from '../hooks/useCurrentStructureCounts.js'
import { useOpenReconciliationDecisions } from '../hooks/useOpenReconciliationDecisions.js'
import { buildAttentionList, buildStructureIssues } from '../ingest/attentionList.js'
import { INGESTIBLE_ENTITIES } from '../ingest/extractEntities'
import { downloadWorkbook } from '../utils/exportWorkbook.js'
import { ACTIVITY_COLORS } from '../components/schedule/slotCellConstants.js'

// ADR docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md — the Roots
// home is a distinct screen from now on: no census/diff vocabulary, no
// RootMap/RootMapPanel. "What has taken root" reads the camp's live
// structure via useCurrentStructureCounts; "Needs your attention" unions
// unresolved reconciliation items with a minimal set of live structure
// checks (buildAttentionList/buildStructureIssues).
//
// The Governor brief cuts the spec's verdict banner ("STANDING" kicker,
// "Ready to build a week.") — Schedule is a plain door, never a verdict.
//
// WS4 polish pass (docs/scratchpad WS4-polish-spec.md): name-chips on the
// large/wide cards, rooted/attention color semantics, restrained motion,
// and explicit grid coordinates (see CARD_GRID) so the bento can't leave a
// gap under CSS Grid's default sparse auto-placement.
const BENTO_CARDS = [
  { key: 'activities', label: 'Activities', size: 'large' },
  { key: 'groups', label: 'Groups', size: 'large' },
  { key: 'tiers', label: 'Age Divisions', size: 'small' },
  { key: 'locations', label: 'Locations', size: 'small' },
  { key: 'days_and_blocks', label: 'Days & Blocks', size: 'small' },
  { key: 'anchor_activities', label: 'Anchors', size: 'wide' },
]

// Explicit start coordinates for the same DOM order / footprint sizes as
// shipped. Span-only sizing (`gridColumn: 'span N'` with no start) lets CSS
// Grid's sparse auto-placement leave a permanent gap at row1-2/col3 once the
// second large card is pushed to row 3 — the placement cursor advances past
// that cell and never backfills it. See spec §7 note 9.
const CARD_GRID = {
  activities: { gridColumn: '1 / span 2', gridRow: '1 / span 2' },
  groups: { gridColumn: '1 / span 2', gridRow: '3 / span 2' },
  tiers: { gridColumn: '3', gridRow: '1' },
  locations: { gridColumn: '3', gridRow: '2' },
  days_and_blocks: { gridColumn: '3', gridRow: '3' },
  anchor_activities: { gridColumn: '1 / span 3', gridRow: '5' },
}

const CHIP_CAP = { large: 4, wide: 6 }

function countFor(collections, key) {
  if (!collections) return 0
  if (key === 'days_and_blocks') {
    return (collections.days_of_operation?.length ?? 0) + (collections.time_blocks?.length ?? 0)
  }
  return collections[key]?.length ?? 0
}

// Stagger-fade a list of items in once `active` flips true (loading resolved),
// same rAF-then-flip recipe as useEnterTransition in src/styles/shared.js,
// parameterized per-item via transitionDelay instead of a single style.
function useStaggerEnter(active, stepMs) {
  const reduced = prefersReducedMotion()
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (!active) return undefined
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [active])

  return function styleFor(index) {
    const transitionDelay = `${index * stepMs}ms`
    if (reduced) {
      return { opacity: entered ? 1 : 0, transition: 'opacity var(--motion-fast) var(--ease-out)', transitionDelay }
    }
    return {
      opacity: entered ? 1 : 0,
      transform: entered ? 'none' : 'translateY(6px)',
      transition: 'opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)',
      transitionDelay,
    }
  }
}

function ChipRow({ card, collections }) {
  const cap = CHIP_CAP[card.size]
  if (!cap) return null
  const items = collections?.[card.key] ?? []
  if (items.length === 0) return null
  const shown = items.slice(0, cap)
  const overflow = items.length - shown.length
  return (
    <div style={styles.chipRow}>
      {shown.map((item, i) => (
        <span key={item.id ?? item.name ?? i} style={styles.chip}>
          {card.key === 'activities' && (
            <span style={{ ...styles.chipDot, background: ACTIVITY_COLORS[i % ACTIVITY_COLORS.length] }} />
          )}
          {item.name}
        </span>
      ))}
      {overflow > 0 && <span style={styles.overflowChip}>+{overflow} more</span>}
    </div>
  )
}

function scheduleBarHover(e, on) {
  if (prefersReducedMotion()) return
  e.currentTarget.style.borderColor = on
    ? 'color-mix(in srgb, var(--primary) 40%, var(--border))'
    : 'color-mix(in srgb, var(--primary) 24%, var(--border))'
  e.currentTarget.style.transform = on ? 'translateY(-1px)' : 'none'
  const arrow = e.currentTarget.querySelector('[data-arrow]')
  if (arrow) arrow.style.transform = on ? 'translateX(var(--space-1))' : 'none'
}

function cardHover(e, on) {
  if (prefersReducedMotion()) return
  e.currentTarget.style.borderColor = on ? 'color-mix(in srgb, var(--secondary) 12%, var(--border))' : 'var(--border)'
  e.currentTarget.style.transform = on ? 'translateY(-1px)' : 'none'
}

function attentionRowHover(e, on) {
  e.currentTarget.style.borderLeftColor = on ? 'var(--accent)' : 'transparent'
  e.currentTarget.style.background = on ? 'color-mix(in srgb, var(--accent) 4%, var(--surface))' : 'var(--surface)'
}

export default function RootsHomeScreen({ campId, onNavigate }) {
  const { activeCohort } = useCohorts(campId)
  const { collections, loading } = useCurrentStructureCounts(campId)
  // Persisted unresolved import decisions (host-local) — the reconciliation
  // half of the attention list (docs/adr/2026-08-28-persisted-reconciliation-
  // decisions.md §5). buildRootMapModel(...,{mode:'inspect'}) yields only
  // 'understood' rows, so the reconciliation half was structurally empty until
  // this store existed; the hook's { model, decisionsById } carries the real
  // attention/changed rows.
  const { model: openModel, decisionsById: openDecisionsById } = useOpenReconciliationDecisions()
  const [preparingWorksheet, setPreparingWorksheet] = useState(false)
  const enterStyle = useEnterTransition('liftFade')
  const emptyStateEnterStyle = useEnterTransition('liftFade')
  const bentoStyleFor = useStaggerEnter(!loading, 40)
  const attentionStyleFor = useStaggerEnter(!loading, 30)

  const attentionRows = collections
    ? buildAttentionList({
        model: openModel,
        decisionsById: openDecisionsById,
        structureIssues: buildStructureIssues(collections),
      })
    : []

  async function downloadWorksheet() {
    if (preparingWorksheet) return
    setPreparingWorksheet(true)
    try {
      const camp = await localClient.getCamp().catch(() => null)
      const entities = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        entities[entity] = await localClient.list(entity).catch(() => [])
      }
      const base_generation = await localClient.latestOpSeq().catch(() => 0)
      downloadWorkbook({ ...entities, camp_id: camp?.id ?? null, cohort_id: activeCohort?.id ?? null, base_generation })
    } finally {
      setPreparingWorksheet(false)
    }
  }

  return (
    <div data-testid="roots-screen" style={{ maxWidth: 920, margin: '0 auto', ...enterStyle }}>
      <h1 style={styles.title}>Roots</h1>

      <button
        className="press-97"
        onClick={() => onNavigate('schedule')}
        onMouseEnter={(e) => scheduleBarHover(e, true)}
        onMouseLeave={(e) => scheduleBarHover(e, false)}
        style={styles.scheduleBar}
      >
        <span>Schedule</span> <span data-arrow style={styles.scheduleArrow}>→</span>
      </button>

      <section style={{ marginTop: 'var(--space-5)' }}>
        <div style={styles.sectionLabel}>What has taken root</div>
        {loading ? (
          <div style={styles.skeleton}>Reading your camp setup…</div>
        ) : (
          <div style={styles.bentoGrid}>
            {BENTO_CARDS.map((card, index) => {
              const count = countFor(collections, card.key)
              const hasChips = Boolean(CHIP_CAP[card.size])
              return (
                <div
                  key={card.key}
                  onMouseEnter={(e) => cardHover(e, true)}
                  onMouseLeave={(e) => cardHover(e, false)}
                  style={{ ...styles.card, ...CARD_GRID[card.key], ...bentoStyleFor(index) }}
                >
                  <div style={cardHeaderStyle(card.size)}>
                    <span>{card.label}</span>
                    <span style={countStyle(count, hasChips)}>{count}</span>
                  </div>
                  <ChipRow card={card} collections={collections} />
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section style={{ marginTop: 'var(--space-6)' }}>
        <div style={styles.sectionLabel}>Needs your attention</div>
        {attentionRows.length === 0 ? (
          <div style={{ ...styles.emptyState, ...emptyStateEnterStyle }}>
            <svg
              data-testid="attention-empty-check"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--success)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={styles.emptyStateIcon}
            >
              <circle cx="12" cy="12" r="9.5" />
              <path d="M8 12.5l2.5 2.5L16 9.5" />
            </svg>
            <div>Nothing needs you right now.</div>
          </div>
        ) : (
          <div>
            {attentionRows.map((row, index) => (
              <div
                key={row.id}
                onMouseEnter={(e) => attentionRowHover(e, true)}
                onMouseLeave={(e) => attentionRowHover(e, false)}
                style={{ ...styles.attentionRow, ...attentionStyleFor(index) }}
              >
                <div>
                  <div style={styles.attentionName}>{row.name}</div>
                  <div style={styles.attentionWhy}>{row.why}</div>
                </div>
                <span style={styles.domainChip}>{row.domainTag}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div style={styles.bottomActions}>
        <button className="press-97" onClick={() => onNavigate('import')} style={S.btnSecondary}>Import last year</button>
        <button className="press-97" disabled={preparingWorksheet} onClick={downloadWorksheet} style={S.btnSecondary}>
          Download worksheet
        </button>
      </div>
    </div>
  )
}

function cardHeaderStyle(size) {
  return { ...styles.cardHeader, fontSize: size === 'small' ? 13.5 : 14.5 }
}

// WS4b refinement #4 — the count steps up to 18px/tabular-nums only on
// chip-bearing cards (large/wide), so it holds its own next to the chip row
// without competing with it. Small cards have no chips to balance against
// and keep inheriting cardHeader's 14.5px.
function countStyle(count, hasChips) {
  const base = count > 0 ? styles.cardCountRooted : styles.cardCount
  return hasChips ? { ...base, fontSize: 18, fontVariantNumeric: 'tabular-nums' } : base
}

const styles = {
  title: {
    // WS4b refinement #5 — steps to 28px/700 as a slightly firmer anchor now
    // that the content below it (chips, richer cards) reads heavier than
    // 26px/600. 700 reserved for true emphasis per DESIGN_STANDARD §2.
    fontFamily: 'var(--font-condensed)',
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: '-0.015em',
    color: 'var(--text)',
    margin: '0 0 var(--space-4)',
  },
  scheduleBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    textAlign: 'left',
    padding: 'var(--space-4)',
    // WS4b refinement #1 — a light navy tint weights this as the forward
    // door, distinct from the plain-surface bento cards below it. Resting
    // fill/border only; the existing press-97/hover behavior is untouched.
    background: 'color-mix(in srgb, var(--primary) 6%, var(--surface))',
    border: '1px solid color-mix(in srgb, var(--primary) 24%, var(--border))',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text)',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'border-color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-out)',
  },
  scheduleArrow: {
    display: 'inline-block',
    color: 'var(--primary)',
    fontSize: 17,
    fontWeight: 700,
    transition: 'transform var(--motion-fast) var(--ease-out)',
  },
  sectionLabel: {
    fontSize: 12.5,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--text-secondary)',
    marginBottom: 10, // documented exception — see WS4-polish-spec.md §0
  },
  skeleton: {
    fontSize: 13,
    color: 'var(--text-secondary)',
  },
  bentoGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 'var(--space-3)',
  },
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-4)',
    transition: 'border-color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-out)',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: 'var(--font-condensed)',
    fontWeight: 600,
    color: 'var(--text)',
  },
  cardCount: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
  },
  cardCountRooted: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--secondary)',
  },
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'var(--space-1) var(--space-2)',
    marginTop: 'var(--space-2)',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    padding: '3px var(--space-2)', // documented exception — see WS4-polish-spec.md §0
    borderRadius: 'var(--radius-pill)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    fontSize: 11.5,
    fontWeight: 500,
    color: 'var(--text-secondary)',
  },
  chipDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flex: 'none',
  },
  overflowChip: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '3px var(--space-2)',
    borderRadius: 'var(--radius-pill)',
    background: 'transparent',
    border: '1px dashed var(--border)',
    fontSize: 11.5,
    fontWeight: 500,
    color: 'var(--text-secondary)',
  },
  emptyState: {
    // WS4b refinement #3 — steps from 24px 4px to the token scale, per
    // DESIGN_STANDARD §5a: no card, no border, but real presence.
    padding: 'var(--space-6) var(--space-1)',
    textAlign: 'center',
    fontSize: 13,
    color: 'var(--text-secondary)',
  },
  emptyStateIcon: {
    display: 'block',
    margin: '0 auto var(--space-2)',
  },
  attentionRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-3)',
    padding: 'var(--space-3)',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderLeft: '2px solid transparent',
    borderRadius: 'var(--radius-sm)',
    marginBottom: 'var(--space-2)',
    transition: 'border-left-color var(--motion-fast) var(--ease-standard), background var(--motion-fast) var(--ease-standard)',
  },
  attentionName: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--text)',
  },
  attentionWhy: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  domainChip: {
    padding: '3px var(--space-3)',
    borderRadius: 'var(--radius-pill)',
    fontSize: 11,
    background: 'color-mix(in srgb, var(--accent) 14%, var(--surface))',
    color: 'color-mix(in srgb, var(--accent) 70%, var(--text))',
    whiteSpace: 'nowrap',
  },
  bottomActions: {
    display: 'flex',
    gap: 'var(--space-3)',
    marginTop: 'var(--space-6)',
    paddingTop: 'var(--space-4)',
    borderTop: '1px solid var(--border)',
  },
}
