import { useState, useEffect, useCallback } from 'react'
import { localClient } from '../../localClient'

import { NAV_SECTIONS, AREA_TABLE } from './navSections'
import { getSetupGaps } from '../../engine/readiness'
import { loadSidebarState, saveSidebarState, sectionRollup, shouldOfferFold, nextFoldStateAfterAnswer } from './sidebarState'

// Marks are fixed-width whether or not one is present, so labels stay aligned
// as ticks appear. Colour is never the only carrier: `!` is a distinct glyph
// AND carries the word "needed"; `✓` carries a count.
// Counts are keyed by area; getSetupGaps wants collections and only inspects
// length, so a count becomes an array of that length.
function countGaps(counts) {
  return getSetupGaps({
    cohorts: Array(counts.cohorts || 0),
    tiers: Array(counts.tiers || 0),
    groups: Array(counts.groups || 0),
    days: Array(counts.days || 0),
    timeBlocks: Array(counts.timeblocks || 0),
    activities: Array(counts.activities || 0),
  })
}

const MARK_COLOR = { '✓': 'var(--success)', '!': 'var(--danger)', '·': 'var(--text-secondary)' }
const TONE_COLOR = {
  danger: 'var(--danger)', success: 'var(--success)',
  warning: 'var(--warning)', secondary: 'var(--text-secondary)',
}

export default function Sidebar({ current, onNavigate, campId, role, badges = {} }) {
  const [campName, setCampName] = useState('')
  const [projectPath, setProjectPath] = useState(null)
  // Which database is loaded must be visible, not inferable — see
  // docs/adr/2026-07-28-explicit-userdata-directory.md.
  const [isDevDb, setIsDevDb] = useState(false)
  const [buildLabel, setBuildLabel] = useState(null)
  const [backupStatus, setBackupStatus] = useState(null) // null | 'running' | 'ok' | 'error'
  const [counts, setCounts] = useState(null)
  const [sidebar, setSidebar] = useState(() => loadSidebarState(globalThis.localStorage))
  const [offerShown, setOfferShown] = useState(false)
  // How many of the two weeks have been started, for the Schedule roll-up.
  // Counted from the slots themselves, so an empty template does not read as
  // a started week.
  const [startedRoutes, setStartedRoutes] = useState(0)

  // Count every area the sidebar marks, then work out whether the last gap has
  // just closed. Both happen here, in one async step, because this is the only
  // place the previous and next gap counts are both in hand — the alternative
  // is an effect comparing renders, which the React compiler rightly objects
  // to and which would fire an extra render for a once-per-camp event.
  const refreshCounts = useCallback(async () => {
    const areas = Object.keys(AREA_TABLE)
    const results = await Promise.all(
      areas.map((area) => localClient.list(AREA_TABLE[area]).catch(() => []))
    )
    const next = {}
    areas.forEach((area, i) => {
      const rows = Array.isArray(results[i]) ? results[i] : []
      next[area] = campId ? rows.filter((r) => !r.camp_id || r.camp_id === campId).length : rows.length
    })

    const slots = await localClient.list('template_slots').catch(() => [])
    setStartedRoutes(new Set((Array.isArray(slots) ? slots : []).map((r) => r.template_id)).size)

    setCounts((prev) => {
      // `prev === null` is the first count of this session. A camp that was
      // already complete when the app opened is never asked — the offer is
      // about the moment setup finishes, not about being finished.
      if (prev !== null && shouldOfferFold({
        gaps: countGaps(next),
        previousGaps: countGaps(prev),
        alreadyOffered: loadSidebarState(globalThis.localStorage).offered,
      })) {
        setOfferShown(true)
      }
      return next
    })
  }, [campId])

  useEffect(() => {
    // Wrapped rather than called directly so the lint rule can see that no
    // state is set synchronously during the effect — every setState in
    // refreshCounts happens after an await. Same pattern as TrashScreen.
    void (async () => { await refreshCounts() })()
  }, [refreshCounts])

  // Counts must follow the data, or a tick lags a whole session behind.
  useEffect(() => {
    if (typeof localClient.onOpApplied !== 'function') return
    const unsub = localClient.onOpApplied(() => { refreshCounts() })
    return () => { unsub?.() }
  }, [refreshCounts])

  const gaps = counts ? countGaps(counts) : []
  const gapAreas = new Set(gaps.map((g) => g.key))
  const offerOpen = offerShown && !sidebar.offered

  const persist = useCallback((next) => {
    setSidebar(next)
    saveSidebarState(globalThis.localStorage, next)
  }, [])

  function toggleSection(key) {
    persist({ ...sidebar, sections: { ...sidebar.sections, [key]: !sidebar.sections[key] } })
  }

  function answerOffer(answer) {
    setOfferShown(false)
    persist({ ...sidebar, ...nextFoldStateAfterAnswer(sidebar.sections, answer) })
  }


  useEffect(() => {
    if (!campId) return
    localClient.getCamp()
      .then(data => { if (data) setCampName(data.name) })
      .catch(() => { /* fail silent — leave campName unset */ })
  }, [campId])

  useEffect(() => {
    if (!window.shoresh?.getCurrentProject) return
    window.shoresh.getCurrentProject()
      .then(info => { if (info?.path) setProjectPath(info.path); if (info) { setIsDevDb(!!info.isDev); setBuildLabel(info.build || null) } })
      .catch(() => { /* non-fatal */ })
  }, [campId])

  const handleBackupNow = useCallback(async () => {
    if (!window.shoresh?.backupProject) return
    setBackupStatus('running')
    try {
      const result = await window.shoresh.backupProject()
      setBackupStatus(result?.error ? 'error' : 'ok')
    } catch {
      setBackupStatus('error')
    }
    // Reset status label after 3 s.
    setTimeout(() => setBackupStatus(null), 3000)
  }, [])

  return (
    <aside style={{
      width: 216, minWidth: 216, background: 'var(--surface)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', height: '100%',
    }}>
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 22,
          color: 'var(--primary)', letterSpacing: '-0.3px',
        }}>Shoresh</div>
        {campName && (
          <div style={{
            fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginTop: 2,
          }}>{campName}</div>
        )}
      </div>

      <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>
        {NAV_SECTIONS.map((section, sIdx) => {
          const items = [
            ...section.items,
            ...(role === 'admin' && section.adminItems ? section.adminItems : []),
          ]
          const open = sidebar.sections[section.key] !== false
          const rollup = sectionRollup({
            section: section.key, open, gaps, badges, startedRoutes,
          })

          return (
            <div key={section.key}>
              <div style={{
                display: 'flex', alignItems: 'center',
                padding: sIdx === 0 ? '4px 12px 6px' : '14px 12px 6px',
                marginTop: sIdx === 0 ? 0 : 8,
                borderTop: sIdx === 0 ? 'none' : '1px solid var(--border)',
              }}>
                {/* The whole header row is the hit target — 200px is an easy
                    click, a 12px glyph is not. The chevron stays visible
                    rather than appearing on hover: a director who does not
                    know sections collapse will never hover to find out. */}
                <button
                  onClick={() => toggleSection(section.key)}
                  aria-expanded={open}
                  title={open ? `Collapse ${section.title}` : `Expand ${section.title}`}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', gap: 6,
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
                    letterSpacing: '0.12em', textTransform: 'uppercase',
                    color: 'var(--text-secondary)', textAlign: 'left',
                  }}
                >
                  <span style={{
                    display: 'inline-block', width: 10, flexShrink: 0,
                    opacity: 0.75, fontSize: 9,
                    transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform var(--motion-base, 0.15s) var(--ease-out, ease)',
                  }}>▶</span>
                  {section.title}
                </button>

                {/* A collapsed header must say what its rows would have said,
                    or tidying the sidebar becomes a way to lose alerts. */}
                {rollup && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontFamily: 'var(--font-mono)', fontSize: 10,
                    color: TONE_COLOR[rollup.tone],
                  }}>
                    {rollup.mark && <span style={{ fontWeight: 700 }}>{rollup.mark}</span>}
                    {rollup.text}
                  </span>
                )}

                {section.headerScreen && (
                  <button
                    onClick={() => onNavigate(section.headerScreen)}
                    title="What each of these means"
                    style={{
                      background: 'none', border: 'none', padding: '0 0 0 8px',
                      cursor: 'pointer', color: 'var(--text-secondary)',
                      fontSize: 11, lineHeight: 1, opacity: 0.7,
                    }}
                  >?</button>
                )}
              </div>

              {/* Setup never folds itself silently. Asked once, on the render
                  where the last gap closes; both answers are remembered. */}
              {open && offerOpen && section.key === 'setup' && (
                <div style={{
                  margin: '2px 12px 8px', padding: '10px 12px',
                  background: 'var(--surface-elevated, var(--surface))',
                  borderLeft: '3px solid var(--secondary, var(--primary))',
                  borderRadius: 6, fontSize: 12, lineHeight: 1.5,
                }}>
                  <div style={{ marginBottom: 8, color: 'var(--text)' }}>
                    <strong>Setup looks complete.</strong> Tuck this away?
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => answerOffer('tuck')} style={offerButton}>Tuck away</button>
                    <button onClick={() => answerOffer('keep')} style={offerButton}>Keep open</button>
                  </div>
                </div>
              )}

              {open && items.map(item => {
                const count = item.area ? counts?.[item.area] : undefined
                const isBlocking = item.area ? gapAreas.has(item.area) : false
                const mark = !item.area ? null : isBlocking ? '!' : (count > 0 ? '✓' : '·')
                const meta = !item.area
                  ? null
                  : count > 0 ? String(count)
                  : item.optional ? 'optional'
                  : 'needed'

                return (
                  <button
                    key={item.key}
                    onClick={() => onNavigate(item.key)}
                    style={{
                      display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
                      padding: '8px 12px', border: 'none', background: 'none',
                      fontSize: 13, fontWeight: current === item.key ? 600 : 400,
                      color: current === item.key ? 'var(--primary)' : 'var(--text)',
                      borderLeft: current === item.key
                        ? '3px solid var(--primary)'
                        : '3px solid transparent',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => { if (current !== item.key) e.currentTarget.style.background = 'var(--bg)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                  >
                    {/* Fixed width whether or not a mark is present, so labels
                        do not shift as ticks appear. */}
                    <span style={{
                      width: 13, flexShrink: 0, fontSize: 11, fontWeight: 700,
                      color: mark ? MARK_COLOR[mark] : 'transparent',
                      opacity: mark === '·' ? 0.5 : 1,
                    }}>{mark ?? ''}</span>
                    <span style={{ flex: 1, minWidth: 0, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.label}
                    </span>
                    {meta && (
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 10, flexShrink: 0,
                        color: isBlocking ? 'var(--danger)' : 'var(--text-secondary)',
                      }}>{meta}</span>
                    )}
                    {Boolean(badges[item.key]) && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        minWidth: 16, height: 16, padding: '0 5px', borderRadius: 99,
                        background: 'var(--warning)', color: '#fff', marginLeft: 6,
                        fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
                        lineHeight: '16px', flexShrink: 0,
                      }}>
                        {badges[item.key]}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )
        })}
      </nav>

      <div style={{
        padding: '10px 20px', borderTop: '1px solid var(--border)',
        fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
      }}>
        {projectPath && (
          <div
            title={isDevDb ? `Development database — not the installed app's data\n${projectPath}` : projectPath}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: 6, cursor: 'default',
              color: 'var(--text-secondary)',
            }}
          >
            {isDevDb && (
              <span style={{
                flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
                padding: '1px 4px', borderRadius: 4,
              }}>
                DEV
              </span>
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {projectPath.split(/[\\/]/).pop()}
            </span>
          </div>
        )}
        {buildLabel && (
          // Which build is running, next to which database it opened — the two
          // questions that together explain "why does the app behave like that".
          <div
            title={`Build: ${buildLabel}`}
            style={{
              fontSize: 10, marginBottom: 6, cursor: 'default',
              color: 'var(--text-secondary)', opacity: 0.75,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {buildLabel}
          </div>
        )}
        {role === 'admin' && (
          <button
            onClick={handleBackupNow}
            disabled={backupStatus === 'running'}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '4px 0', border: 'none', background: 'none',
              fontSize: 11, fontFamily: 'var(--font-mono)',
              color: backupStatus === 'ok'
                ? 'var(--success, #22c55e)'
                : backupStatus === 'error'
                  ? 'var(--danger, #ef4444)'
                  : 'var(--text-secondary)',
              cursor: backupStatus === 'running' ? 'wait' : 'pointer',
              marginBottom: 4,
            }}
          >
            {backupStatus === 'running' ? 'Backing up…'
              : backupStatus === 'ok' ? 'Backup saved'
              : backupStatus === 'error' ? 'Backup failed'
              : 'Backup now'}
          </button>
        )}
        v0.1.0
      </div>
    </aside>
  )
}

const offerButton = {
  flex: 1, padding: '5px 8px', fontSize: 11,
  fontFamily: 'inherit', cursor: 'pointer',
  background: 'var(--surface)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 5,
}
