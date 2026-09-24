import { useState, useEffect } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition, prefersReducedMotion, useNarrowViewport } from '../styles/shared'
import { CircleCheckIcon } from '../components/icons'
import { useCohorts } from '../hooks/useCohorts'
import { useCurrentStructureCounts } from '../hooks/useCurrentStructureCounts.js'
import { useOpenReconciliationDecisions } from '../hooks/useOpenReconciliationDecisions.js'
import { buildAttentionList, buildStructureIssues } from '../ingest/attentionList.js'
import { INGESTIBLE_ENTITIES } from '../ingest/extractEntities'
import { dedupeChipItems } from './rootsChips'
import { downloadWorkbook } from '../utils/exportWorkbook.js'
import { ACTIVITY_COLORS } from '../components/schedule/slotCellConstants.js'
import { ScheduleDoor } from '../components/ScheduleDoor'

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

// T236 — window width below which the two-column rail layout collapses to a
// single stacked column. matchMedia measures the WINDOW, but Shell.jsx's
// fixed sidebar (measured at 216px — src/components/layout/Sidebar.jsx) plus
// <main>'s 24px padding on each side (48px) come out of that before the
// screen's own content box starts. At 1150 the content box is
// 1150 - 216 - 48 = 886px, leaving the bento ~562px after the 300px rail and
// --space-5 (24px) gap — the minimum width the 3-column bento reads
// comfortably at. Below 1150 the bento would get pinched before it, so the
// layout collapses to a stack instead.
const NARROW_BREAKPOINT_PX = 1150

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
  // Overflow counts distinct names too — the card's own number already says how
  // many ROWS there are, so "+106 more" beside three chips would be answering a
  // question the heading has already answered.
  const items = dedupeChipItems(collections?.[card.key] ?? [])
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
  const attentionStyleFor = useStaggerEnter(!loading, 25)
  const narrow = useNarrowViewport(NARROW_BREAKPOINT_PX)

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
    // T236 — maxWidth grows from 920 to 1180 (documented exception) to hold
    // the new two-column rail layout (rootsMain + rootsRail, see styles
    // below) without pinching the bento.
    <div data-testid="roots-screen" style={{ maxWidth: 1180, margin: '0 auto', ...enterStyle }}>
      <h1 style={styles.title}>Roots</h1>

      <ScheduleDoor label="Schedule" onClick={() => onNavigate('schedule')} />

      <div style={{ ...styles.rootsLayout, flexDirection: narrow ? 'column' : 'row' }}>
        <div style={{ ...styles.rootsMain, order: narrow ? 1 : 0 }}>
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
        </div>

        <aside
          aria-label="Needs your attention"
          style={{
            ...styles.rootsRail,
            order: narrow ? 0 : 1,
            position: narrow ? 'static' : 'sticky',
            top: narrow ? 'auto' : 'var(--space-5)',
            width: narrow ? '100%' : undefined,
            flex: narrow ? 'none' : styles.rootsRail.flex,
          }}
        >
          <div style={{ ...styles.sectionLabel, marginTop: 'var(--space-5)' }}>Needs your attention</div>
          {attentionRows.length === 0 ? (
            <div style={{ ...styles.emptyState, ...emptyStateEnterStyle }}>
              <CircleCheckIcon data-testid="attention-empty-check" style={styles.emptyStateIcon} />
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
                  <div style={styles.attentionName}>{row.name}</div>
                  <span style={styles.domainChip}>{row.domainTag}</span>
                  <div style={{ ...styles.attentionWhy, flexBasis: '100%' }}>{row.why}</div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

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
  // T236 — alignItems 'flex-start' is LOAD-BEARING: flex's default 'stretch'
  // would force rootsRail to the height of rootsMain, which breaks
  // `position: sticky` (a stretched rail has no room to scroll within).
  rootsLayout: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--space-5)',
  },
  rootsMain: {
    flex: '1 1 auto',
    minWidth: 0, // prevents the bento grid overflowing its flex basis
  },
  // Documented exception — fixed rail width so the attention rows read at a
  // consistent measure regardless of how wide the bento's column gets.
  rootsRail: {
    flex: '0 0 300px',
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
    // T236 — reduced from 'var(--space-6) var(--space-1)' (documented
    // exception): full vertical weight in a 300px rail reads as a hole, not
    // restraint.
    padding: 'var(--space-4) var(--space-2)',
    textAlign: 'center',
    fontSize: 13,
    color: 'var(--text-secondary)',
  },
  emptyStateIcon: {
    display: 'block',
    margin: '0 auto var(--space-2)',
  },
  // T236 — wrapping two-line row (name + tag share the top line, `why` forced
  // onto its own full-width line via flexBasis) rather than a single
  // space-between row, so the row reads at rail width (300px) without
  // truncating a camp's own names.
  attentionRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 'var(--space-1) var(--space-2)',
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
