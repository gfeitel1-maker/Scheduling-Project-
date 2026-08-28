import { useState } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import { useCurrentStructureCounts } from '../hooks/useCurrentStructureCounts.js'
import { buildRootMapModel } from '../ingest/rootMapModel.js'
import { buildAttentionList, buildStructureIssues } from '../ingest/attentionList.js'
import { INGESTIBLE_ENTITIES } from '../ingest/extractEntities'
import { downloadWorkbook } from '../utils/exportWorkbook.js'

// ADR docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md — the Roots
// home is a distinct screen from now on: no census/diff vocabulary, no
// RootMap/RootMapPanel. "What has taken root" reads the camp's live
// structure via useCurrentStructureCounts; "Needs your attention" unions
// unresolved reconciliation items with a minimal set of live structure
// checks (buildAttentionList/buildStructureIssues).
//
// The Governor brief cuts the spec's verdict banner ("STANDING" kicker,
// "Ready to build a week.") — Schedule is a plain door, never a verdict.
const BENTO_CARDS = [
  { key: 'activities', label: 'Activities', size: 'large' },
  { key: 'groups', label: 'Groups', size: 'large' },
  { key: 'tiers', label: 'Age Divisions', size: 'small' },
  { key: 'locations', label: 'Locations', size: 'small' },
  { key: 'days_and_blocks', label: 'Days & Blocks', size: 'small' },
  { key: 'anchor_activities', label: 'Anchors', size: 'wide' },
]

function countFor(collections, key) {
  if (!collections) return 0
  if (key === 'days_and_blocks') {
    return (collections.days_of_operation?.length ?? 0) + (collections.time_blocks?.length ?? 0)
  }
  return collections[key]?.length ?? 0
}

export default function RootsHomeScreen({ campId, onNavigate }) {
  const { activeCohort } = useCohorts(campId)
  const { collections, loading } = useCurrentStructureCounts(campId)
  const [preparingWorksheet, setPreparingWorksheet] = useState(false)
  const enterStyle = useEnterTransition('liftFade')

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

      <button className="press-97" onClick={() => onNavigate('schedule')} style={styles.scheduleBar}>
        Schedule →
      </button>

      <section style={{ marginTop: 24 }}>
        <div style={styles.sectionLabel}>What has taken root</div>
        {loading ? (
          <div style={styles.skeleton}>Reading your camp setup…</div>
        ) : (
          <div style={styles.bentoGrid}>
            {BENTO_CARDS.map((card) => (
              <div key={card.key} style={{ ...styles.card, ...cardSizeStyle(card.size) }}>
                <div style={styles.cardHeader}>
                  <span>{card.label}</span>
                  <span style={styles.cardCount}>{countFor(collections, card.key)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <div style={styles.sectionLabel}>Needs your attention</div>
        {attentionRows.length === 0 ? (
          <div style={styles.emptyState}>Nothing needs you right now.</div>
        ) : (
          <div>
            {attentionRows.map((row) => (
              <div key={row.id} style={styles.attentionRow}>
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

function cardSizeStyle(size) {
  if (size === 'large') return { gridColumn: 'span 2', gridRow: 'span 2' }
  if (size === 'wide') return { gridColumn: 'span 3' }
  return {}
}

const styles = {
  title: {
    fontFamily: 'var(--font-condensed)',
    fontSize: 26,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: 'var(--text)',
    margin: '0 0 16px',
  },
  scheduleBar: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '14px 16px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    color: 'var(--text)',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  sectionLabel: {
    fontSize: 12.5,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--text-secondary)',
    marginBottom: 10,
  },
  skeleton: {
    fontSize: 13,
    color: 'var(--text-secondary)',
  },
  bentoGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 12,
  },
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: 14,
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: 'var(--font-condensed)',
    fontSize: 13.5,
    fontWeight: 600,
    color: 'var(--text)',
  },
  cardCount: {
    fontFamily: 'var(--font-mono)',
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
    gap: 12,
    padding: '10px 12px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    marginBottom: 6,
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
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 11,
    background: 'color-mix(in srgb, var(--secondary) 12%, var(--surface))',
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap',
  },
  bottomActions: {
    display: 'flex',
    gap: 10,
    marginTop: 32,
    paddingTop: 16,
    borderTop: '1px solid var(--border)',
  },
}
