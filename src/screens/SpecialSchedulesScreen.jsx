// docs/work/specs/2026-08-23-schedule-build-ia.md — the Schedule-side build
// entry for special days and events. A picker, not a route: it lists every
// authored special day and event (same two categories, same order as Roots's
// "Special Schedule" heading, navSections.js:80-97) and opens the EXISTING
// SpecialDayGridEditor / EventGridEditor components unchanged when a card is
// clicked. No independent schedule state — no slots/overlays/stats route
// slice, per the spec's "why this doesn't read as a third route" §2.
import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import SpecialDayGridEditor from './specialDay/SpecialDayGridEditor'
import EventGridEditor from './event/EventGridEditor'

const LABELS = {
  specialDaysHeading: 'Special Days',
  eventsHeading: 'Events',
  emptyMessage: 'No special days or events yet. Author one from Roots.',
  notStarted: 'Not started',
  partiallyFilled: 'Partially filled',
  complete: 'Complete',
  // Matches SpecialDaysScreen's own deletedElsewhere copy — a live delete on
  // another device surfaces here the same way it used to inside that screen.
  dayDeletedElsewhere: 'This special day was deleted.',
  eventDeletedElsewhere: 'This event was deleted.',
}

// 150ms opacity-only crossfade (spec's "Animation" table) — dropped to 0ms
// under prefers-reduced-motion, per the reduced-motion principle of removing
// movement while keeping state changes legible.
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

function completeness(filled, total) {
  if (total === 0 || filled === 0) return LABELS.notStarted
  if (filled === total) return LABELS.complete
  return LABELS.partiallyFilled
}

function statusColor(status) {
  return status === LABELS.complete ? 'var(--success)' : 'var(--text-secondary)'
}

function Card({ name, status, sublabel, onClick }) {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {sublabel && <div style={styles.cardSublabel}>{sublabel}</div>}
        <div style={{ ...styles.cardStatus, color: statusColor(status) }}>{status}</div>
      </div>
    </div>
  )
}

export default function SpecialSchedulesScreen({ campId, onNavigate, initialSelection = null }) {
  const [specialDays, setSpecialDays] = useState([])
  const [sdTimeBlocks, setSdTimeBlocks] = useState([])
  const [sdSlots, setSdSlots] = useState([])
  const [groups, setGroups] = useState([])
  const [events, setEvents] = useState([])
  const [eventTimeBlocks, setEventTimeBlocks] = useState([])
  const [eventGroups, setEventGroups] = useState([])
  const [eventSlots, setEventSlots] = useState([])
  const [templateSlots, setTemplateSlots] = useState([])
  const [days, setDays] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(initialSelection)
  const [toast, setToast] = useState(null)
  const crossfade = useCrossfade()

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [
        specialDaysData, sdBlocksData, sdSlotsData, groupsData,
        eventsData, eventBlocksData, eventGroupsData, eventSlotsData,
        templateSlotsData, daysData,
      ] = await Promise.all([
        localClient.list('special_days'),
        localClient.list('special_day_time_blocks'),
        localClient.list('special_day_slots'),
        localClient.list('groups'),
        localClient.list('events'),
        localClient.list('event_time_blocks'),
        localClient.list('event_groups'),
        localClient.list('event_slots'),
        localClient.list('template_slots'),
        localClient.list('days_of_operation'),
      ])
      setSpecialDays((specialDaysData || []).filter((d) => d.camp_id === campId))
      setSdTimeBlocks(sdBlocksData || [])
      setSdSlots(sdSlotsData || [])
      setGroups((groupsData || []).filter((g) => g.camp_id === campId))
      setEvents((eventsData || []).filter((e) => e.camp_id === campId))
      setEventTimeBlocks(eventBlocksData || [])
      setEventGroups(eventGroupsData || [])
      setEventSlots(eventSlotsData || [])
      setTemplateSlots((templateSlotsData || []).filter((s) => s.event_id))
      setDays((daysData || []).filter((d) => d.camp_id === campId))
    } catch {
      setError("Couldn't load your camp setup — check your connection and refresh.")
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [campId])

  useEffect(() => {
    if (initialSelection) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(initialSelection)
    }
  }, [initialSelection])

  if (selected?.type === 'day') {
    return (
      <div style={crossfade}>
        <SpecialDayGridEditor
          campId={campId}
          specialDayId={selected.id}
          onBack={() => { setSelected(null); load() }}
          onDeletedElsewhere={() => {
            setSelected(null)
            setToast(LABELS.dayDeletedElsewhere)
            load()
          }}
        />
      </div>
    )
  }
  if (selected?.type === 'event') {
    return (
      <div style={crossfade}>
        <EventGridEditor
          campId={campId}
          eventId={selected.id}
          onBack={() => { setSelected(null); load() }}
          onDeletedElsewhere={() => {
            setSelected(null)
            setToast(LABELS.eventDeletedElsewhere)
            load()
          }}
        />
      </div>
    )
  }

  if (loading) return <div style={S.stateLoading}>Loading…</div>

  const sortedDays = [...specialDays].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
  const sortedEvents = [...events].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
  const isEmpty = sortedDays.length === 0 && sortedEvents.length === 0

  return (
    <div style={{ maxWidth: 760, ...crossfade }}>
      {toast && (
        <div style={{ ...S.errorBanner, background: 'var(--surface)', marginBottom: 16 }}>{toast}</div>
      )}
      {error && <div style={S.errorBanner}>{error}</div>}

      {isEmpty ? (
        <div style={S.emptyState}>
          <div style={S.emptyStateBody}>
            {LABELS.emptyMessage}{' '}
            <button
              className="press-97"
              onClick={() => onNavigate?.('roots')}
              style={styles.linkButton}
            >
              Go to Roots
            </button>
          </div>
        </div>
      ) : (
        <>
          {sortedDays.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={styles.heading}>{LABELS.specialDaysHeading}</div>
              <div style={styles.list}>
                {sortedDays.map((d) => {
                  const blocks = sdTimeBlocks.filter((b) => b.special_day_id === d.id)
                  const filled = sdSlots.filter((s) => s.special_day_id === d.id && s.activity_id).length
                  const total = groups.length * blocks.length
                  return (
                    <Card
                      key={d.id}
                      name={d.name}
                      status={completeness(filled, total)}
                      onClick={() => setSelected({ type: 'day', id: d.id })}
                    />
                  )
                })}
              </div>
            </div>
          )}

          {sortedEvents.length > 0 && (
            <div>
              <div style={styles.heading}>{LABELS.eventsHeading}</div>
              <div style={styles.list}>
                {sortedEvents.map((ev) => {
                  const evGroups = eventGroups.filter((g) => g.event_id === ev.id)
                  const evBlocks = eventTimeBlocks.filter((b) => b.event_id === ev.id)
                  const filled = eventSlots.filter((s) => s.event_id === ev.id && s.activity_id).length
                  const total = evGroups.length * evBlocks.length
                  const placement = templateSlots.find((s) => s.event_id === ev.id)
                  const dayLabel = placement ? days.find((d) => d.id === placement.day_id)?.label : null
                  return (
                    <Card
                      key={ev.id}
                      name={ev.name}
                      status={completeness(filled, total)}
                      sublabel={dayLabel ? `Placed ${dayLabel}` : null}
                      onClick={() => setSelected({ type: 'event', id: ev.id })}
                    />
                  )
                })}
              </div>
            </div>
          )}
        </>
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
  cardSublabel: { fontSize: 12, color: 'var(--text-secondary)' },
  cardStatus: { fontSize: 12, fontFamily: 'var(--font-mono)' },
  linkButton: {
    background: 'none', border: 'none', padding: 0, color: 'var(--primary)',
    fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
    textDecoration: 'underline',
  },
}
