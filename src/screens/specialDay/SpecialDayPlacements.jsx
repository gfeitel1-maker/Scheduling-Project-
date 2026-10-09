// T350 slice 5 (docs/work/specs/T350-slice5-binding-ui.md): the special day editor's
// "Placed on" strip and its week x weekday picker. Binds and unbinds only through
// bindSpecialDay/unbindSpecialDay (the generic write refuses placements, ADR D8), and
// re-reads after every write, success or failure, so the screen equals the document.
import { useEffect, useRef, useState } from 'react'
import { localClient } from '../../localClient'
import { S, useEnterTransition, prefersReducedMotion } from '../../styles/shared'
import { CloseIcon } from '../../components/icons'
import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { buildReplacements } from '../schedule/replacedLane'
import { placementChips, shortDay } from './placementDisplay'
import FailureLine from './FailureLine'

const LIVE_ENTITIES = new Set(['special_day_placements', 'special_days', 'schedule_weeks'])
const SLOW_MS = 400
const bySort = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
const cellKey = (weekId, dayId) => `${weekId}|${dayId}`

const EMPTY = { placements: [], weeks: [], days: [], specialDays: [], conflictTitles: new Map() }

async function readAll(campId) {
  const [placements, weeks, days, specialDays] = await Promise.all([
    localClient.list('special_day_placements'),
    localClient.list('schedule_weeks'),
    localClient.list('days_of_operation'),
    localClient.list('special_days'),
  ])
  const mine = (rows) => (rows || []).filter((r) => r.camp_id === campId).sort(bySort)
  const data = { placements: placements || [], weeks: mine(weeks), days: mine(days), specialDays: mine(specialDays) }
  // The conflict dot is decoration and fails open, as slice 4's read does.
  const conflicts = await Promise.resolve(localClient.listPendingConflicts?.()).catch(() => []) || []
  const conflictTitles = new Map()
  for (const w of data.weeks) {
    const map = buildReplacements({ ...data, weekId: w.id, specialBlocks: [], specialSlots: [], conflicts })
    for (const r of map.values()) if (r.conflictTitle) conflictTitles.set(cellKey(w.id, r.dayId), r.conflictTitle)
  }
  return { ...data, conflictTitles }
}

export default function SpecialDayPlacements({ campId, specialDayId, specialDayName, onDeletedElsewhere }) {
  const [data, setData] = useState(EMPTY)
  const [panelOpen, setPanelOpen] = useState(false)
  const [inFlight, setInFlight] = useState(() => new Set())
  const [slow, setSlow] = useState(() => new Set())
  const [pendingReplace, setPendingReplace] = useState(null)
  const [failure, setFailure] = useState(null)
  const [focusIdx, setFocusIdx] = useState(0)
  const inFlightRef = useRef(new Set())
  const placeBtnRef = useRef(null)
  const gridRef = useRef(null)
  const confirmRef = useRef(null)
  const onDeletedRef = useRef(onDeletedElsewhere)
  useEffect(() => { onDeletedRef.current = onDeletedElsewhere }, [onDeletedElsewhere])

  async function reload() {
    const next = await readAll(campId)
    setData(next)
    // A pending replace names an occupant; if that is no longer true it is stale.
    setPendingReplace((prev) => prev && next.placements.some((p) =>
      p.week_id === prev.week.id && p.day_id === prev.day.id && p.special_day_id === prev.occupantId) ? prev : null)
  }
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { reload() }, [campId, specialDayId])

  useEffect(() => {
    if (typeof localClient.onOpApplied !== 'function') return
    const unsub = localClient.onOpApplied((op) => {
      if (LIVE_ENTITIES.has(op?.entity)) reloadRef.current()
    })
    return () => { unsub?.() }
  }, [])

  useEffect(() => { if (pendingReplace) confirmRef.current?.focus() }, [pendingReplace])

  const nameOf = (id) => data.specialDays.find((s) => s.id === id)?.name
  const occupantAt = (weekId, dayId) =>
    data.placements.find((p) => p.week_id === weekId && p.day_id === dayId && nameOf(p.special_day_id) !== undefined)

  async function run(action) {
    const { kind, week, day, replace = false } = action
    const k = cellKey(week.id, day.id)
    if (inFlightRef.current.has(k)) return
    inFlightRef.current.add(k)
    setInFlight(new Set(inFlightRef.current))
    setFailure(null)
    const slowTimer = setTimeout(() => setSlow((s) => new Set(s).add(k)), SLOW_MS)
    let result
    let error
    try {
      result = kind === 'bind'
        ? await localClient.bindSpecialDay({ weekId: week.id, dayId: day.id, specialDayId, replace })
        : await localClient.unbindSpecialDay({ weekId: week.id, dayId: day.id })
    } catch (err) {
      error = err
    }
    clearTimeout(slowTimer)
    inFlightRef.current.delete(k)
    setInFlight(new Set(inFlightRef.current))
    setSlow((s) => { const n = new Set(s); n.delete(k); return n })

    if (!error && result?.ok === false && result.reason === 'unknown-special-day') {
      onDeletedRef.current?.()
      return
    }
    try { await reload() } catch { /* the failure line below still reports the write */ }
    if (!error && result?.ok === true) return
    if (!error && result?.reason === 'occupied') {
      setPendingReplace({ week, day, occupantId: result.currentSpecialDayId })
      return
    }
    const whatFailed = kind === 'bind'
      ? `Could not place ${specialDayName} on ${week.name} ${day.label}.`
      : `Could not remove ${specialDayName} from ${week.name} ${day.label}.`
    const message = result?.reason === 'unknown-week' ? 'That week no longer exists.'
      : result?.reason === 'unknown-day' ? "That day is no longer in this camp's schedule."
      : describeWriteFailure(error ?? new Error(result?.reason ?? 'no result'), whatFailed)
    setFailure({ action, key: k, message })
  }

  function clickCell(week, day) {
    if (inFlightRef.current.has(cellKey(week.id, day.id))) return
    const here = occupantAt(week.id, day.id)
    if (here?.special_day_id === specialDayId) { setPendingReplace(null); run({ kind: 'unbind', week, day, where: 'grid' }); return }
    if (here) { setFailure(null); setPendingReplace({ week, day, occupantId: here.special_day_id }); return }
    setPendingReplace(null)
    run({ kind: 'bind', week, day, where: 'grid' })
  }

  function confirmReplace() {
    const { week, day } = pendingReplace
    setPendingReplace(null)
    run({ kind: 'bind', week, day, replace: true, where: 'grid' })
  }

  function closePanel() {
    setPanelOpen(false)
    setPendingReplace(null)
    setFailure((f) => (f?.action.where === 'grid' ? null : f))
    placeBtnRef.current?.focus()
  }

  const chips = placementChips({ specialDayId, placements: data.placements, weeks: data.weeks, days: data.days })
  const gridWeeks = data.weeks.filter((w) => !w.is_archived)
  const cols = data.days.length

  function onGridKeyDown(e) {
    const idx = Number(e.target.dataset?.idx)
    if (e.key === 'Escape') { e.preventDefault(); closePanel(); return }
    if (Number.isNaN(idx)) return
    const row = Math.floor(idx / cols)
    const last = gridWeeks.length * cols - 1
    const moves = {
      ArrowRight: Math.min(idx + 1, row * cols + cols - 1),
      ArrowLeft: Math.max(idx - 1, row * cols),
      ArrowDown: idx + cols <= last ? idx + cols : idx,
      ArrowUp: idx - cols >= 0 ? idx - cols : idx,
      Home: row * cols,
      End: row * cols + cols - 1,
    }
    if (!(e.key in moves)) return
    e.preventDefault()
    const next = moves[e.key]
    setFocusIdx(next)
    gridRef.current?.querySelector(`[data-idx="${next}"]`)?.focus()
  }

  const stripFailure = failure?.action.where === 'strip' ? failure : null
  const gridFailure = failure?.action.where === 'grid' ? failure : null
  const occupantName = pendingReplace ? nameOf(pendingReplace.occupantId) ?? 'another special day' : null

  return (
    <div>
      <div style={styles.strip}>
        <span style={S.sectionCount}>Placed on</span>
        {chips.map(({ placement, week, day, label }) => {
          const k = cellKey(week.id, day.id)
          const busy = inFlight.has(k)
          const conflictTitle = data.conflictTitles.get(k)
          return (
            <FadeIn key={placement.id} style={{ position: 'relative', display: 'inline-flex' }}>
              <span style={{ ...S.chip('var(--anchor)', true, styles.chip), opacity: busy ? 0.6 : 1 }}>
                {label}
                <button
                  type="button"
                  aria-label={`Remove from ${week.name} ${day.label}`}
                  disabled={busy}
                  onClick={() => run({ kind: 'unbind', week, day, where: 'strip' })}
                  style={styles.chipX}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = 1 }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = 0.8 }}
                  onFocus={(e) => { e.currentTarget.style.opacity = 1 }}
                  onBlur={(e) => { e.currentTarget.style.opacity = 0.8 }}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
              {conflictTitle && <span title={conflictTitle} style={styles.conflictDot} />}
            </FadeIn>
          )
        })}
        <button
          ref={placeBtnRef}
          type="button"
          className="press-97"
          aria-expanded={panelOpen}
          onClick={() => (panelOpen ? closePanel() : setPanelOpen(true))}
          style={{ ...S.btnSecondary, border: '1.5px dashed var(--border)' }}
        >
          {panelOpen ? 'Done' : '+ Place on a day'}
        </button>
      </div>
      {stripFailure && (
        <FailureLine key={stripFailure.key} message={stripFailure.message} onRetry={() => run(stripFailure.action)} />
      )}

      {panelOpen && (
        <div style={styles.panel}>
          {gridWeeks.length === 0 ? (
            <div style={S.emptyState}><div style={S.emptyStateTitle}>No weeks yet.</div></div>
          ) : (
            <div
              ref={gridRef}
              role="grid"
              aria-label={`Days for ${specialDayName}`}
              onKeyDown={onGridKeyDown}
              style={{ ...styles.grid, gridTemplateColumns: `96px repeat(${cols}, minmax(52px, 1fr))` }}
            >
              <div role="row" style={{ display: 'contents' }}>
                <div role="columnheader" style={styles.colHeader} />
                {data.days.map((d) => (
                  <div key={d.id} role="columnheader" title={d.label} style={styles.colHeader}>{shortDay(d)}</div>
                ))}
              </div>
              {gridWeeks.map((week, r) => (
                <div key={week.id} role="row" style={{ display: 'contents' }}>
                  <div role="rowheader" title={week.name} style={styles.rowHeader}>{week.name}</div>
                  {data.days.map((day, c) => {
                    const idx = r * cols + c
                    const k = cellKey(week.id, day.id)
                    const here = occupantAt(week.id, day.id)
                    const state = here?.special_day_id === specialDayId ? 'mine' : here ? 'taken' : 'free'
                    return (
                      <div key={day.id} role="gridcell" style={styles.gridcell}>
                        <DayCell
                          idx={idx}
                          state={state}
                          occupant={here ? nameOf(here.special_day_id) : null}
                          ariaLabel={cellAriaLabel({ state, week, day, specialDayName, occupant: here && nameOf(here.special_day_id) })}
                          tabIndex={idx === focusIdx ? 0 : -1}
                          busy={inFlight.has(k)}
                          slow={slow.has(k)}
                          pending={pendingReplace && cellKey(pendingReplace.week.id, pendingReplace.day.id) === k}
                          failed={gridFailure?.key === k}
                          onFocus={() => setFocusIdx(idx)}
                          onClick={() => clickCell(week, day)}
                        />
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {panelOpen && pendingReplace && (
        <ReplacePrompt
          week={pendingReplace.week}
          day={pendingReplace.day}
          occupantName={occupantName}
          specialDayName={specialDayName}
          confirmRef={confirmRef}
          onConfirm={confirmReplace}
          onCancel={() => setPendingReplace(null)}
        />
      )}
      {panelOpen && gridFailure && (
        <FailureLine key={gridFailure.key} message={gridFailure.message} onRetry={() => run(gridFailure.action)} />
      )}
    </div>
  )
}

function cellAriaLabel({ state, week, day, specialDayName, occupant }) {
  const where = `${week.name}, ${day.label}`
  if (state === 'free') return `${where}, free. Place ${specialDayName} here.`
  if (state === 'mine') return `${where}, ${specialDayName} is here. Remove.`
  return `${where}, ${occupant ?? 'another special day'}. Replace with ${specialDayName}.`
}

function DayCell({ idx, state, occupant, ariaLabel, tabIndex, busy, slow, pending, failed, onFocus, onClick }) {
  const base = CELL_STYLES[state]
  const style = {
    ...styles.cell,
    ...base,
    transition: prefersReducedMotion() ? 'none' : 'background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)',
    opacity: busy ? 0.6 : 1,
    cursor: busy ? 'progress' : 'pointer',
    ...(pending ? { outline: '2px solid var(--accent)', outlineOffset: -2 } : null),
    ...(failed ? { outline: '1.5px solid var(--danger)', outlineOffset: -1.5 } : null),
  }
  const hoverable = state === 'free'
  return (
    <button
      type="button"
      data-idx={idx}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      title={state === 'mine' ? 'Remove from this day' : state === 'taken' ? occupant ?? 'Another' : undefined}
      tabIndex={tabIndex}
      onFocus={(e) => { onFocus(); if (hoverable) tint(e.currentTarget, true) }}
      onBlur={(e) => { if (hoverable) tint(e.currentTarget, false) }}
      onMouseEnter={(e) => { if (hoverable) tint(e.currentTarget, true) }}
      onMouseLeave={(e) => { if (hoverable) tint(e.currentTarget, false) }}
      onClick={() => { if (!busy) onClick() }}
      style={style}
    >
      {slow ? <Spinner /> : state === 'mine' ? <CheckGlyph /> : state === 'taken' ? (
        <span style={styles.takenLabel}>{occupant ?? 'Another'}</span>
      ) : null}
    </button>
  )
}

function tint(el, on) {
  el.style.borderColor = on ? 'var(--anchor)' : 'var(--border)'
  el.style.background = on ? 'color-mix(in srgb, var(--anchor) 10%, var(--surface))' : 'transparent'
}

function ReplacePrompt({ week, day, occupantName, specialDayName, confirmRef, onConfirm, onCancel }) {
  const enter = useEnterTransition('liftFade')
  return (
    <div
      role="group"
      aria-label="Confirm replace"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() } }}
      style={{ ...enter, margin: '0 0 14px' }}
    >
      <div style={{ fontSize: 13, color: 'var(--text)' }}>
        {week.name} {day.label} already uses {occupantName}. Use {specialDayName} instead?
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '2px 0 8px' }}>
        ({occupantName} stays saved; bind it again to undo.)
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button ref={confirmRef} type="button" className="press-97" onClick={onConfirm} style={S.btnPrimary}>Use {specialDayName}</button>
        <button type="button" className="press-97" onClick={onCancel} style={S.btnSecondary}>Cancel</button>
      </div>
    </div>
  )
}

function FadeIn({ children, style }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])
  const reduced = prefersReducedMotion()
  return (
    <span style={{ ...style, opacity: reduced || shown ? 1 : 0, transition: reduced ? 'none' : 'opacity var(--motion-fast) var(--ease-out)' }}>
      {children}
    </span>
  )
}

function CheckGlyph() {
  return (
    <svg aria-hidden="true" width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg aria-hidden="true" width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round">
      <path d="M12 3a9 9 0 1 1-9 9">
        {!prefersReducedMotion() && (
          <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
        )}
      </path>
    </svg>
  )
}

const CELL_STYLES = {
  free: { border: '1.5px dashed var(--border)', background: 'transparent', color: 'var(--text-secondary)' },
  mine: { border: '1.5px solid var(--anchor)', background: 'var(--anchor)', color: 'var(--surface)' },
  taken: {
    border: '1px solid color-mix(in srgb, var(--anchor) 30%, var(--border))',
    background: 'color-mix(in srgb, var(--anchor) 8%, var(--surface))',
    color: 'color-mix(in srgb, var(--anchor) 75%, var(--text))',
  },
}

const styles = {
  strip: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 14px' },
  chip: { padding: '4px 4px 4px 12px', fontSize: 12, fontFamily: 'var(--font-sans)', display: 'inline-flex', alignItems: 'center', gap: 2, cursor: 'default' },
  chipX: {
    width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', opacity: 0.8, borderRadius: 12,
  },
  conflictDot: {
    position: 'absolute', top: -2, right: -2, width: 7, height: 7, borderRadius: '50%',
    background: 'var(--accent)', boxShadow: '0 0 0 1.5px var(--surface)',
  },
  panel: {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 12,
    maxWidth: 560, marginBottom: 16, maxHeight: 8 * 36 + 28 + 24, overflowY: 'auto',
  },
  grid: { display: 'grid', columnGap: 4, rowGap: 4 },
  colHeader: {
    position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1,
    fontFamily: 'var(--font-condensed)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--text-secondary)', textAlign: 'center', padding: '4px 0 6px',
  },
  rowHeader: {
    fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    display: 'flex', alignItems: 'center', height: 32,
  },
  gridcell: { display: 'flex' },
  cell: {
    width: '100%', height: 32, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, fontFamily: 'inherit', padding: '0 4px', minWidth: 0,
  },
  takenLabel: { fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
}
