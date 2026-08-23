import { useState, useCallback, useRef, useEffect, forwardRef } from 'react'

import { NAV_SECTIONS, ADMIN_MENU_ITEMS, ADMIN_ONLY_MENU_ITEMS } from './navSections'
import { getSetupGaps } from '../../engine/readiness'
import { loadSidebarState, saveSidebarState, sectionRollup, nextFoldStateAfterAnswer, syncStatusLabel } from './sidebarState'
import { useEnterTransition } from '../../styles/shared'

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
// Shared shape for every count pill in the sidebar (nav-row badges, the
// gear button's conflicts count, gear-menu item badges) so the three stay
// visually identical rather than drifting through copy-paste.
const BADGE_PILL = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  minWidth: 16, height: 16, padding: '0 5px', borderRadius: 99,
  background: 'var(--warning)', color: '#fff',
  fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
  lineHeight: '16px', flexShrink: 0,
}

export default function Sidebar({
  current, onNavigate, role, badges = {},
  counts, startedRoutes, campName, syncStatus,
  projectPath, isDevDb, buildLabel,
  backupStatus, handleBackupNow,
  offerShown, setOfferShown,
}) {
  const [sidebar, setSidebar] = useState(() => loadSidebarState(globalThis.localStorage))
  const [gearOpen, setGearOpen] = useState(false)
  const gearBtnRef = useRef(null)
  const gearMenuRef = useRef(null)

  const gaps = counts ? countGaps(counts) : []
  const gapAreas = new Set(gaps.map((g) => g.key))
  const offerOpen = offerShown && !sidebar.offered
  const conflictsCount = Number(badges.conflicts) || 0
  const adminMenuItems = [...ADMIN_MENU_ITEMS, ...(role === 'admin' ? ADMIN_ONLY_MENU_ITEMS : [])]
  const rootsOpen = sidebar.rootsOpen !== false

  // Closing on outside click / Escape, and returning focus to the gear
  // button on close, are both required for a popup menu to be keyboard- and
  // screen-reader-usable (WAI-ARIA menu button pattern) — a menu that traps
  // focus inside itself with no way out but a mouse click elsewhere is not
  // actually keyboard-accessible.
  useEffect(() => {
    if (!gearOpen) return
    function handlePointerDown(e) {
      if (gearMenuRef.current?.contains(e.target) || gearBtnRef.current?.contains(e.target)) return
      setGearOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [gearOpen])

  function closeGearMenu() {
    setGearOpen(false)
    gearBtnRef.current?.focus()
  }

  function navigateFromGear(key) {
    setGearOpen(false)
    onNavigate(key)
  }

  const persist = useCallback((next) => {
    setSidebar(next)
    saveSidebarState(globalThis.localStorage, next)
  }, [])

  function toggleSection(key) {
    persist({ ...sidebar, sections: { ...sidebar.sections, [key]: !sidebar.sections[key] } })
  }

  function toggleRoots() {
    persist({ ...sidebar, rootsOpen: !rootsOpen })
  }

  function answerOffer(answer) {
    setOfferShown(false)
    persist({ ...sidebar, ...nextFoldStateAfterAnswer(sidebar.sections, answer) })
  }

  // One row renderer for both a top-level item and a Roots child — the
  // green ✓ / count / "optional" affordances must read identically at
  // either depth.
  function renderItem(item, { indent = false } = {}) {
    const lan = item.key === 'devices' && syncStatus ? syncStatusLabel(syncStatus) : null
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
          padding: indent ? '8px 12px 8px 33px' : '8px 12px', border: 'none', background: 'none',
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
        {lan && (
          <span title={lan.title} style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, flexShrink: 0,
            color: TONE_COLOR[lan.tone],
          }}>{lan.text}</span>
        )}
        {meta && (
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, flexShrink: 0,
            color: isBlocking ? 'var(--danger)' : 'var(--text-secondary)',
          }}>{meta}</span>
        )}
        {Boolean(badges[item.key]) && (
          <span style={{ ...BADGE_PILL, marginLeft: 6 }}>
            {badges[item.key]}
          </span>
        )}
      </button>
    )
  }

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
          const items = section.items
          const open = sidebar.sections[section.key] !== false
          const rollup = sectionRollup({
            section: section.key, open, gaps, startedRoutes,
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
                if (!item.children) return renderItem(item)

                // Roots — the parent row navigates on click same as any
                // other row; a separate chevron button toggles its child
                // list, independent of the "Camp Set Up" section fold above.
                return (
                  <div key={item.key}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>{renderItem(item)}</div>
                      <button
                        onClick={toggleRoots}
                        aria-expanded={rootsOpen}
                        title={rootsOpen ? `Collapse ${item.label}` : `Expand ${item.label}`}
                        style={{
                          flexShrink: 0, width: 24, height: 24, marginRight: 6,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--text-secondary)', opacity: 0.75, fontSize: 9,
                          transform: rootsOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                          transition: 'transform var(--motion-base, 0.15s) var(--ease-out, ease)',
                        }}
                      >▶</button>
                    </div>
                    {rootsOpen && item.children.map(child => (
                      child.heading
                        ? <div key={child.key} style={subHeadingStyle}>{child.heading}</div>
                        : renderItem(child, { indent: true })
                    ))}
                  </div>
                )
              })}
            </div>
          )
        })}
      </nav>

      {/* Roots-as-Hub Slice B — Camp, Conflicts, Trash and (admin-only) LAN
          & Devices live here instead of an always-open third nav section, so
          the day-to-day sidebar is just Roots + Schedule. Pinned at the
          bottom: it's the one row a director reaches for rarely, not the one
          they scan past every time. */}
      <div style={{ position: 'relative', padding: '6px 12px', borderTop: '1px solid var(--border)' }}>
        <button
          ref={gearBtnRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={gearOpen}
          title="Settings"
          onClick={() => setGearOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '8px 6px', border: 'none', background: 'none', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13, color: 'var(--text-secondary)',
            borderRadius: 6,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 14 }}>⚙</span>
          <span style={{ flex: 1, textAlign: 'left' }}>Settings</span>
          {conflictsCount > 0 && (
            <span style={BADGE_PILL}>{conflictsCount}</span>
          )}
        </button>

        {gearOpen && (
          <GearMenu
            ref={gearMenuRef}
            items={adminMenuItems}
            current={current}
            badges={badges}
            onSelect={navigateFromGear}
            onClose={closeGearMenu}
          />
        )}
      </div>

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

// The Settings popup — WAI-ARIA menu-button pattern. Opens focused on its
// first item, closes and returns focus to the gear button on Escape or a
// click outside, and never designates one item as more important than the
// others (same "no visual difference" instinct as the two schedule rows,
// applied here to admin destinations instead).
const GearMenu = forwardRef(function GearMenu({ items, current, badges, onSelect, onClose }, ref) {
  const transition = useEnterTransition('popFade', { transformOrigin: 'bottom left' })
  const firstItemRef = useRef(null)

  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Settings"
      onKeyDown={handleKeyDown}
      style={{
        position: 'absolute', left: 12, right: 12, bottom: '100%', marginBottom: 6,
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 4, zIndex: 10,
        ...transition,
      }}
    >
      {items.map((item, idx) => {
        const count = item.badgeKey ? Number(badges[item.badgeKey]) || 0 : 0
        return (
          <button
            key={item.key}
            ref={idx === 0 ? firstItemRef : undefined}
            role="menuitem"
            onClick={() => onSelect(item.key)}
            style={{
              display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
              padding: '8px 10px', border: 'none', borderRadius: 5,
              background: current === item.key ? 'var(--bg)' : 'none',
              fontSize: 13, fontFamily: 'inherit',
              fontWeight: current === item.key ? 600 : 400,
              color: current === item.key ? 'var(--primary)' : 'var(--text)',
              cursor: 'pointer',
            }}
            onMouseEnter={e => { if (current !== item.key) e.currentTarget.style.background = 'var(--bg)' }}
            onMouseLeave={e => { e.currentTarget.style.background = current === item.key ? 'var(--bg)' : 'none' }}
          >
            <span style={{ flex: 1 }}>{item.label}</span>
            {count > 0 && (
              <span style={{ ...BADGE_PILL, marginLeft: 6 }}>{count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
})

// A quiet grouping label between Roots children — echoes the section-title
// treatment (condensed, uppercase, tracked-out) at Roots-child indent depth,
// so it reads as a sub-heading rather than a row: no hover state, no click
// target, no mark/count/optional affordance.
const subHeadingStyle = {
  padding: '10px 12px 4px 33px',
  fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase',
  color: 'var(--text-secondary)', opacity: 0.75,
}

const offerButton = {
  flex: 1, padding: '5px 8px', fontSize: 11,
  fontFamily: 'inherit', cursor: 'pointer',
  background: 'var(--surface)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 5,
}
