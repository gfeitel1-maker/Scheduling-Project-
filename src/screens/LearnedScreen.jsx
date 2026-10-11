import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition } from '../styles/shared'
import {
  buildLearnedGroups, formerAnswersSentence, matchesQuery, campChanged, campShapeKey, LAST_SHOWN_SHAPE_KEY, GROUP_LABELS,
} from '../ingest/learnedView.js'
import { Flag, LinkButton } from '../components/learned/parts.jsx'
import Collapse from '../components/learned/Collapse.jsx'
import { meta } from '../components/learned/learnedStyles.js'
import LearnedRow from './learned/LearnedRow.jsx'

// docs/work/specs/2026-10-11-what-shoresh-has-learned-view.md. Reads only through listLearned
// (which is the validated, trust-checked reader); every write is one of four IPCs that re-check the
// viewer's permission. A control the viewer may not use is not rendered.

const OPEN_KEY = 'learned.groups.open'
const PAGE = 25
const SEARCH_AT = 15
const FLASH_MS = 4000

const store = {
  get(key) { try { return JSON.parse(window.localStorage.getItem(key)) } catch { return null } },
  set(key, value) { try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* per-viewer convenience only */ } },
}

const api = {
  change: (memoryId, verdict) => localClient.changeImportAnswer({ memoryId, verdict }),
  forget: (memoryId) => localClient.forgetImportAnswer({ memoryId }),
  forgetPattern: (template, key) => localClient.forgetImportPattern({ template, key }),
  keep: (memoryId) => localClient.keepImportAnswer({ memoryId }),
}

async function currentCampShape() {
  try {
    const [groups, days] = await Promise.all([localClient.list('groups'), localClient.list('days_of_operation')])
    return { groups: groups.length, days: days.length }
  } catch {
    return null
  }
}

async function deviceLocalItems(campId) {
  const items = []
  try {
    const names = await localClient.listDeclinedSplitNames()
    for (const name of names ?? []) items.push({ id: `split:${name}`, title: `${name}: kept as one row`, where: `Used when "${name}" appears as two rows in a file.` })
  } catch { /* an unreadable store is simply not listed */ }
  try {
    const cells = await localClient.listCompoundCellDecisions(campId)
    for (const [pattern] of cells ?? []) items.push({ id: `cell:${pattern}`, title: `A cell that reads "${pattern}"`, where: `Used when a cell reads "${pattern}".` })
  } catch { /* same */ }
  return items
}

export default function LearnedScreen({ campId }) {
  const enter = useEnterTransition('liftFade', {})
  const [state, setState] = useState({ status: 'loading' })
  const [flashes, setFlashes] = useState({})
  const [query, setQuery] = useState('')
  const [effectiveQuery, setEffectiveQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [openKeys, setOpenKeys] = useState(() => store.get(OPEN_KEY))
  const [limits, setLimits] = useState({})
  const [announcement, setAnnouncement] = useState('')
  const lingering = useRef(new Set())
  const gen = useRef(0)

  const load = useCallback(async (quiet = false) => {
    const mine = ++gen.current
    if (!quiet) setState({ status: 'loading' })
    try {
      const [data, shape, local] = await Promise.all([localClient.listLearned(), currentCampShape(), deviceLocalItems(campId)])
      if (mine !== gen.current) return
      setState({ status: 'ready', data, shape, local, lastShown: store.get(LAST_SHOWN_SHAPE_KEY) })
    } catch {
      if (mine === gen.current) setState({ status: 'error' })
    }
  }, [campId])

  useEffect(() => {
    const id = setTimeout(() => load(), 0)
    return () => clearTimeout(id)
  }, [load])

  // The shape is remembered once it has been on screen, so the flag shows once per change.
  useEffect(() => {
    if (state.status === 'ready' && state.shape) store.set(LAST_SHOWN_SHAPE_KEY, campShapeKey(state.shape))
  }, [state])

  useEffect(() => {
    const id = setTimeout(() => setEffectiveQuery(query), 120)
    return () => clearTimeout(id)
  }, [query])

  // A reload while another row still offers its Undo would drop that row, so it waits; the last
  // row to finish reloads for everyone.
  const reloadWhenIdle = useCallback(() => {
    if (lingering.current.size > 0) return
    load(true)
  }, [load])
  const onLinger = useCallback((id, on) => {
    if (on) lingering.current.add(id)
    else lingering.current.delete(id)
    if (!on && lingering.current.size === 0) reloadWhenIdle()
  }, [reloadWhenIdle])
  const onChanged = useCallback((newId, text) => {
    if (newId) {
      setFlashes((f) => ({ ...f, [newId]: text }))
      setTimeout(() => setFlashes((f) => { const next = { ...f }; delete next[newId]; return next }), FLASH_MS)
    }
    reloadWhenIdle()
  }, [reloadWhenIdle])

  const data = state.status === 'ready' ? state.data : null
  const groups = useMemo(() => (data ? buildLearnedGroups(data) : []), [data])
  const total = groups.reduce((n, g) => n + g.count, 0)
  const searching = total > SEARCH_AT
  const q = searching ? effectiveQuery.trim() : ''
  const kindFilter = searching ? kind : 'all'
  const local = state.local ?? []

  const view = useMemo(() => groups
    .filter((g) => kindFilter === 'all' || kindFilter === g.key)
    .map((g) => ({
      ...g,
      patterns: g.patterns.filter((r) => matchesQuery(r, q)),
      answers: g.answers.filter((r) => matchesQuery(r, q)),
    }))
    .filter((g) => g.patterns.length + g.answers.length > 0), [groups, kindFilter, q])

  const changedFlag = (row) => state.status === 'ready' && campChanged(row.camp_shape, state.shape, state.lastShown)
  // Every group starts open; once the viewer has toggled one, their last-used set is what opens.
  const stored = Array.isArray(openKeys) ? openKeys : null
  const isOpen = (g) => q !== '' || (stored ? stored.includes(g.key) : true) || g.answers.some(changedFlag)

  function toggle(g, open) {
    const now = new Set(view.filter((x) => isOpen(x)).map((x) => x.key))
    if (open) now.delete(g.key)
    else now.add(g.key)
    const next = [...now]
    setOpenKeys(next)
    store.set(OPEN_KEY, next)
  }

  const noMatches = searching && view.length === 0 && (q !== '' || kindFilter !== 'all')
  const showDevice = local.length > 0 && (kindFilter === 'all' || kindFilter === 'device')
  const empty = state.status === 'ready' && total === 0 && local.length === 0

  return (
    <div style={{ ...styles.page, ...enter }}>
      <p style={styles.explainer}>
        Shoresh remembers the answers you give during an import and re-uses them next time. After three similar answers it starts to spot patterns. Nothing here changes a schedule you have already imported.
      </p>
      <div role="status" aria-live="polite" style={styles.hidden}>{announcement}</div>

      {state.status === 'loading' && <Skeleton />}

      {state.status === 'error' && (
        <div role="alert" style={{ ...S.errorBanner, display: 'flex', gap: 10, alignItems: 'center' }}>
          <span>Couldn’t load what Shoresh has learned. Check this device is still signed in.</span>
          <LinkButton onClick={() => load()}>Try again</LinkButton>
        </div>
      )}

      {state.status === 'ready' && (
        <>
          {!data.canWrite && (
            <p style={{ ...styles.explainer, marginTop: -8 }}>You can see what Shoresh has learned. Changing it needs import permission.</p>
          )}
          {formerAnswersSentence(data.formerUserAnswers) && (
            <p style={{ ...styles.explainer, display: 'flex', gap: 8, alignItems: 'center', maxWidth: 'none' }}>
              <Flag tone="neutral">as recorded</Flag>
              <span>{formerAnswersSentence(data.formerUserAnswers)}</span>
            </p>
          )}

          {empty && (
            <div style={styles.empty}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 3h8l4 4v14H7z" /><path d="M15 3v4h4" /><path d="m10 14 2 2 3-4" />
              </svg>
              <div style={styles.emptyTitle}>Nothing learned yet</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                When you answer an import question, Shoresh remembers it here, and starts to spot patterns after three similar answers.
              </div>
            </div>
          )}

          {searching && (
            <div style={styles.filterRow}>
              <div style={{ position: 'relative', flex: 1 }}>
                <input
                  type="search"
                  aria-label="Search answers and examples"
                  placeholder="Search answers and examples"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ ...S.input, width: '100%' }}
                />
              </div>
              <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ ...S.input, width: 'auto' }}>
                <option value="all">All kinds</option>
                {GROUP_LABELS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                {local.length > 0 && <option value="device">Remembered on this computer only</option>}
              </select>
            </div>
          )}

          {noMatches && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '8px 0' }}>
              {q !== '' ? `Nothing matches "${q}". ` : 'Nothing in this kind yet. '}
              <LinkButton onClick={() => { setQuery(''); setEffectiveQuery(''); setKind('all') }}>Clear search</LinkButton>
            </div>
          )}

          {view.map((g) => {
            const open = isOpen(g)
            const rows = [...g.patterns, ...g.answers]
            const limit = q !== '' ? rows.length : (limits[g.key] ?? PAGE)
            const shown = rows.slice(0, limit)
            const patterns = shown.filter((r) => r.rowKind === 'pattern')
            const answers = shown.filter((r) => r.rowKind === 'answer')
            const panelId = `learned-group-${g.key}`
            const rowProps = (row) => ({
              row, canWrite: data.canWrite === true, api, flash: flashes[row.id], campChangedFlag: changedFlag(row),
              onLinger, onChanged, onStale: () => load(true), announce: setAnnouncement,
            })
            return (
              <section key={g.key} style={{ marginBottom: 20 }}>
                <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => toggle(g, open)} style={styles.groupHeader}>
                  <span style={S.sectionLabel}>{g.label}</span>
                  <span style={{ ...S.sectionCount, marginLeft: 8 }}>({g.count})</span>
                  <span aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--text-secondary)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--motion-base) var(--ease-out)' }}>›</span>
                </button>
                <Collapse open={open} id={panelId}>
                  {patterns.length > 0 && <div style={styles.subHeading}>Patterns</div>}
                  <ul style={styles.list}>{patterns.map((row) => <LearnedRow key={row.id} {...rowProps(row)} />)}</ul>
                  {answers.length > 0 && <div style={styles.subHeading}>Answers</div>}
                  <ul style={styles.list}>{answers.map((row) => <LearnedRow key={row.id} {...rowProps(row)} />)}</ul>
                  {rows.length > limit && (
                    <LinkButton onClick={() => setLimits((l) => ({ ...l, [g.key]: limit + PAGE }))}>{`Show ${PAGE} more`}</LinkButton>
                  )}
                </Collapse>
              </section>
            )
          })}

          {showDevice && <DeviceLocal items={local} q={q} />}

          {data.diagnostics?.discarded > 0 && (
            <div style={{ ...meta, fontSize: 11, marginTop: 16 }}>
              {`${data.diagnostics.discarded} remembered ${data.diagnostics.discarded === 1 ? 'answer' : 'answers'} couldn’t be read on this device and ${data.diagnostics.discarded === 1 ? 'was' : 'were'} skipped.`}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function DeviceLocal({ items, q }) {
  const [open, setOpen] = useState(false)
  const shown = items.filter((i) => matchesQuery({ title: i.title, why: i.where, names: [] }, q))
  if (shown.length === 0) return null
  return (
    <section style={{ marginTop: 28, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <button type="button" aria-expanded={open || q !== ''} aria-controls="learned-group-device" onClick={() => setOpen((v) => !v)} style={styles.groupHeader}>
        <span style={S.sectionLabel}>Remembered on this computer only</span>
        <span style={{ ...S.sectionCount, marginLeft: 8 }}>({shown.length})</span>
      </button>
      <Collapse open={open || q !== ''} id="learned-group-device">
        <p style={{ ...meta, margin: '0 0 6px' }}>
          These older answers live on this computer and don't sync to other devices. They're listed so you can see them; they can't be changed here.
        </p>
        <ul style={styles.list}>
          {shown.map((i) => (
            <li key={i.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', listStyle: 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{i.title}</span>
                <Flag tone="neutral">This computer only</Flag>
              </div>
              <div style={{ ...meta, marginTop: 2 }}>{i.where}</div>
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  )
}

function Skeleton() {
  return (
    <div aria-hidden="true" data-testid="learned-skeleton">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="shoresh-skeleton-block"
          style={{
            height: 54, borderRadius: 6, marginBottom: 10,
            background: 'color-mix(in srgb, var(--text) 6%, var(--surface))',
            backgroundImage: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--text) 5%, transparent), transparent)',
            backgroundSize: '60% 100%', backgroundRepeat: 'no-repeat', animation: 'shoresh-skeleton-shimmer 1200ms linear infinite',
          }}
        />
      ))}
    </div>
  )
}

const styles = {
  page: { padding: '24px 28px', maxWidth: 880 },
  explainer: { fontSize: 13, color: 'var(--text-secondary)', maxWidth: '62ch', margin: '0 0 16px' },
  hidden: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
  filterRow: { display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' },
  groupHeader: {
    display: 'flex', alignItems: 'baseline', width: '100%', border: 'none', background: 'none', padding: '4px 0', cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left', color: 'var(--text)',
  },
  subHeading: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', margin: '12px 0 6px' },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  empty: { padding: '60px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
  emptyTitle: { fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 15, color: 'var(--text)' },
}
