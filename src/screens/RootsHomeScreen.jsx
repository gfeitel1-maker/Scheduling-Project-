import { useState, useEffect } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition, prefersReducedMotion } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import { useCurrentStructureCounts } from '../hooks/useCurrentStructureCounts.js'
import { buildRootMapModel } from '../ingest/rootMapModel.js'
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
  e.currentTarget.style.borderColor = on ? 'color-mix(in srgb, var(--primary) 35%, var(--border))' : 'var(--border)'
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
  const [preparingWorksheet, setPreparingWorksheet] = useState(false)
  const enterStyle = useEnterTransition('liftFade')
  const bentoStyleFor = useStaggerEnter(!loading, 40)
  const attentionStyleFor = useStaggerEnter(!loading, 30)

  const attentionRows = collections
    ? buildAttentionList({
        model: buildRootMapModel(null, { snapshot: collections, mode: 'inspect' }),
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
              return (
                <div
                  key={card.key}
                  onMouseEnter={(e) => cardHover(e, true)}
                  onMouseLeave={(e) => cardHover(e, false)}
                  style={{ ...styles.card, ...CARD_GRID[card.key], ...bentoStyleFor(index) }}
                >
                  <div style={cardHeaderStyle(card.size)}>
                    <span>{card.label}</span>
                    <span style={count > 0 ? styles.cardCountRooted : styles.cardCount}>{count}</span>
                  </div>
                  <ChipRow card={card} collections={collections} />
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section style={{ marginTop: 'var(--space-5)' }}>
        <div style={styles.sectionLabel}>Needs your attention</div>
        {attentionRows.length === 0 ? (
          <div style={styles.emptyState}>Nothing needs you right now.</div>
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

const styles = {
  title: {
    fontFamily: 'var(--font-condensed)',
    fontSize: 26,
    fontWeight: 600,
    letterSpacing: '-0.01em',
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
    background: 'var(--surface)',
    border: '1px solid var(--border)',
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
    padding: '24px 4px',
    textAlign: 'center',
    fontSize: 13,
    color: 'var(--text-secondary)',
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
