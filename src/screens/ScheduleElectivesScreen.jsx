// docs/work/specs/2026-08-23-electives-gap.md Part (b) — the Schedule-side
// build entry for Electives, a SEPARATE row from "Special Schedules"
// (electives are core recurring structure, not an exception category — see
// the spec's "key IA decision"). A picker, not a route: lists every
// authored elective set (data, not nav structure) and opens the existing
// ElectiveSetDetail builder unmodified when a card is clicked. Mirrors
// SpecialSchedulesScreen's shape (single category here instead of two).
import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import ElectiveSetDetail from './elective/ElectiveSetDetail'

const LABELS = {
  heading: 'Elective Sets',
  emptyMessage: 'No elective sets yet. Author one from Roots.',
}

// 150ms opacity-only crossfade, dropped to 0ms under prefers-reduced-motion —
// identical to SpecialSchedulesScreen's useCrossfade, reused verbatim rather
// than reauthored (spec's Animation table).
function useCrossfade() {
  const reduced = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return {
    opacity: entered ? 1 : 0,
    transition: `opacity ${reduced ? '0ms' : '150ms'} var(--ease-out)`,
  }
}

function Card({ name, sublabel, onClick }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      className="press-97"
      style={styles.card}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface)')}
    >
      <div style={styles.cardName}>{name}</div>
      <div style={styles.cardSublabel}>{sublabel}</div>
    </div>
  )
}

export default function ScheduleElectivesScreen({ campId, role, onNavigate, initialElectiveSetId = null }) {
  const [sets, setSets] = useState([])
  const [offerings, setOfferings] = useState([])
  const [activities, setActivities] = useState([])
  const [locations, setLocations] = useState([])
  const [tiers, setTiers] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(initialElectiveSetId)
  const crossfade = useCrossfade()

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [setsData, offeringsData, activitiesData, locationsData, tiersData, groupsData] = await Promise.all([
        localClient.list('elective_sets'),
        localClient.list('elective_set_activities'),
        localClient.list('activities'),
        localClient.list('locations'),
        localClient.list('tiers'),
        localClient.list('groups'),
      ])
      setSets((setsData || []).filter((s) => s.camp_id === campId))
      setOfferings(offeringsData || [])
      setActivities((activitiesData || []).filter((a) => a.camp_id === campId))
      setLocations((locationsData || []).filter((l) => l.camp_id === campId))
      setTiers((tiersData || []).filter((t) => t.camp_id === campId))
      setGroups((groupsData || []).filter((g) => g.camp_id === campId))
    } catch {
      setError("Couldn't load your camp setup — check your connection and refresh.")
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [campId])

  useEffect(() => {
    if (initialElectiveSetId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedId(initialElectiveSetId)
    }
  }, [initialElectiveSetId])

  const selectedSet = sets.find((s) => s.id === selectedId)

  if (selectedSet) {
    return (
      <div style={crossfade}>
        <ElectiveSetDetail
          set={selectedSet}
          role={role}
          activities={activities}
          locations={locations}
          tiers={tiers}
          groups={groups}
          refreshActivities={load}
          onBack={() => { setSelectedId(null); load() }}
        />
      </div>
    )
  }

  if (loading) return <div style={S.stateLoading}>Loading…</div>

  const sortedSets = [...sets].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))

  return (
    <div style={{ maxWidth: 760, ...crossfade }}>
      {error && <div style={S.errorBanner}>{error}</div>}

      {sortedSets.length === 0 ? (
        <div style={S.emptyState}>
          <div style={S.emptyStateBody}>
            {LABELS.emptyMessage}{' '}
            <button
              className="press-97"
              onClick={() => onNavigate?.('electives')}
              style={styles.linkButton}
            >
              Go to Roots
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div style={styles.heading}>{LABELS.heading}</div>
          <div style={styles.list}>
            {sortedSets.map((set) => {
              const count = offerings.filter((o) => o.elective_set_id === set.id).length
              return (
                <Card
                  key={set.id}
                  name={set.name || '(untitled set)'}
                  sublabel={`${count} offering${count === 1 ? '' : 's'}`}
                  onClick={() => setSelectedId(set.id)}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

const styles = {
  heading: {
    fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13,
    color: 'var(--text-secondary)', textTransform: 'uppercase',
    letterSpacing: '0.05em', marginBottom: 10,
  },
  list: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 12, overflow: 'hidden',
  },
  card: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px', borderBottom: '1px solid var(--border)',
    cursor: 'pointer', background: 'var(--surface)',
  },
  cardName: { fontSize: 14, fontWeight: 500 },
  cardSublabel: { fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' },
  linkButton: {
    background: 'none', border: 'none', padding: 0, color: 'var(--primary)',
    fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
    textDecoration: 'underline',
  },
}
