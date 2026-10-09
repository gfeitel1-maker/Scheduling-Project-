import { useState, useCallback, useRef, useEffect, forwardRef } from 'react'

import RestoreControl from './RestoreControl'
import { NAV_SECTIONS, ROOTS_ITEM, ADMIN_MENU_ITEMS, ADMIN_ONLY_MENU_ITEMS } from './navSections'
import { getSetupGaps } from '../../engine/readiness'
import { loadSidebarState, saveSidebarState, sectionRollup, nextFoldStateAfterAnswer, syncStatusLabel } from './sidebarState'
import { useEnterTransition } from '../../styles/shared'
import { ChevronIcon, GearIcon } from '../icons'

// Marks are fixed-width whether or not one is present, so labels stay aligned
// as ticks appear. Colour is never the only carrier: `!` is a distinct glyph
// AND carries an accessible label ("Needed"); `✓` is labelled "Done". A row
// that is neither blocking nor filled carries nothing — see renderItem.
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

// Fixed width, not role- or collapse-dependent. Exported so other screens
// (e.g. RootsHomeScreen's rail-layout breakpoint) can derive from the real
// value instead of hardcoding a copy that can silently drift.
export const SIDEBAR_WIDTH_PX = 216

const MARK_COLOR = { '✓': 'var(--success)', '!': 'var(--danger)' }
const TONE_COLOR = {
  danger: 'var(--danger)', success: 'var(--success)',
  warning: 'var(--accent)', secondary: 'var(--text-secondary)',
}
// Shared shape for every count pill in the sidebar (nav-row badges, the
// gear button's conflicts count, gear-menu item badges) so the three stay
// visually identical rather than drifting through copy-paste.
const BADGE_PILL = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  minWidth: 16, height: 16, padding: '0 5px', borderRadius: 99,
  background: 'var(--accent)', color: '#fff',
  fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
  lineHeight: '16px', flexShrink: 0,
}

// Bottom edge shadow that shows only while more rows sit below the fold: the
// `local` cover scrolls with the content and hides the `scroll` shadow once the
// end is reached. macOS overlay scrollbars otherwise give no hint the list scrolls.
const NAV_SCROLL_SHADOW = [
  'linear-gradient(transparent, var(--surface) 70%) 0 100% / 100% 40px no-repeat local',
  'radial-gradient(farthest-side at 50% 100%, color-mix(in srgb, var(--text) 18%, transparent), transparent) 0 100% / 100% 12px no-repeat scroll',
  'var(--surface)',
].join(', ')

export default function Sidebar({
  current, onNavigate, role, badges = {},
  counts, campName, syncStatus,
  projectPath, isDevDb, buildLabel,
  backupStatus, handleBackupNow, backupRevealable, handleShowBackup,
  offerShown, setOfferShown,
}) {
  const [sidebar, setSidebar] = useState(() => loadSidebarState(globalThis.localStorage))
  const [gearOpen, setGearOpen] = useState(false)
  const gearBtnRef = useRef(null)
  const gearMenuRef = useRef(null)

  // T275 — host-not-syncing retry affordance. `retrying` is local, UI-only
  // state: it never reflects ground truth by itself, only the optimistic
  // instant of a click. It never needs resetting when ground truth moves
  // past host-not-syncing — the render below only ever consults `retrying`
  // while `isHostNotSyncing` is also true, so a stale `true` left over from
  // an earlier degraded episode is inert the moment sync is healthy again;
  // the cap below is what resets it for the case that matters (still
  // host-not-syncing after the timeout).
  const [retrying, setRetrying] = useState(false)
  const retryCapRef = useRef(null)
  useEffect(() => () => { if (retryCapRef.current) clearTimeout(retryCapRef.current) }, [])
  function handleRetrySync() {
    setRetrying(true)
    window.shoresh?.retrySync?.()
    if (retryCapRef.current) clearTimeout(retryCapRef.current)
    // There is no periodic sync-status poll to bound this on: a push
    // (shoresh:sync-status-changed) fires when the starter settles or peers
    // change (electron/sync/automerge/syncStarter.js), but its own guard
    // early-returns (a node already running, a join session still retained)
    // never push at all — so without a cap, a retry into one of those never
    // clears "trying…". 5s is a plain safety net, not a measured cadence.
    retryCapRef.current = setTimeout(() => setRetrying(false), 5000)
  }

  const gaps = counts ? countGaps(counts) : []
  const gapAreas = new Set(gaps.map((g) => g.key))
  const offerOpen = offerShown && !sidebar.offered
  const conflictsCount = Number(badges.conflicts) || 0
  const adminMenuItems = [...ADMIN_MENU_ITEMS, ...(role === 'admin' ? ADMIN_ONLY_MENU_ITEMS : [])]

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

  function answerOffer(answer) {
    setOfferShown(false)
    persist({ ...sidebar, ...nextFoldStateAfterAnswer(sidebar.sections, answer) })
  }

  // One row renderer for both a top-level item and a Roots child — the
  // green ✓ / count / "optional" affordances must read identically at
  // either depth.
  function renderItem(item, { indent = false } = {}) {
    const count = item.area ? counts?.[item.area] : undefined
    const isBlocking = item.area ? gapAreas.has(item.area) : false
    // Two marks, not three. `✓` and `!` are universal — nobody has to be told
    // what a tick or an exclamation mark means. `·` was the one a director
    // would have had to LEARN, and it said nothing the row was not already
    // saying (T129).
    const mark = !item.area ? null : isBlocking ? '!' : (count > 0 ? '✓' : null)
    const markColor = mark ? MARK_COLOR[mark] : null
    // The mark stands alone: `!` for a missing required area, `✓` for a
    // populated one, nothing otherwise. The word "needed" is gone (audit 2);
    // the label lives on the mark itself. Counts are still computed for the
    // gap detection and the collapsed-section summary.
    const markLabel = mark === '!' ? 'Needed' : mark === '✓' ? 'Done' : undefined

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
        {/* Fixed width whether or not a mark is present, so labels do not
            shift as ticks appear. */}
        <span style={{
          width: 13, flexShrink: 0, fontSize: 11, fontWeight: 700,
          color: mark ? markColor : 'transparent',
        }} title={markLabel} aria-label={markLabel} role={markLabel ? 'img' : undefined}>{mark ?? ''}</span>
        <span style={{ flex: 1, minWidth: 0, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.label}
        </span>
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
      width: SIDEBAR_WIDTH_PX, minWidth: SIDEBAR_WIDTH_PX, background: 'var(--surface)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', height: '100%',
    }}>
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
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

      <nav style={{ flex: 1, minHeight: 0, padding: '8px 0', overflowY: 'auto', background: NAV_SCROLL_SHADOW }}>
        {/* Roots — a fixed, chevron-less top row (docs/adr/2026-08-28-stage-
            aware-nav-landing.md Decision 3). It is no longer doing setup's
            job (lifecycle-IA spec §3/§4), so it carries no fold state and no
            mark: renderItem's `item.area` is undefined for ROOTS_ITEM, which
            already renders no mark/count. */}
        {renderItem(ROOTS_ITEM)}

        {NAV_SECTIONS.map((section, sIdx) => {
          const items = section.items
          // A pinned section (Plants) never folds — its rows are always shown,
          // regardless of any stale persisted fold state (WS5 S1).
          const open = section.pinned ? true : sidebar.sections[section.key] !== false
          const rollup = section.pinned ? null : sectionRollup({
            section: section.key, open, gaps,
          })

          return (
            <div key={section.key}>
              <div style={{
                display: 'flex', alignItems: 'center',
                padding: sIdx === 0 ? '4px 12px 6px' : '14px 12px 6px',
                marginTop: sIdx === 0 ? 0 : 8,
                borderTop: sIdx === 0 ? 'none' : '1px solid var(--border)',
              }}>
                {section.pinned ? (
                  // Pinned header: a plain label, no toggle, no chevron —
                  // there is nothing to collapse, so a click target would lie.
                  // Left-padded to align its text with a collapsible section's
                  // title (whose 10px chevron + 6px gap precede the text).
                  <div style={{
                    flex: 1, display: 'flex', alignItems: 'center',
                    paddingLeft: 16,
                    fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
                    letterSpacing: '0.12em', textTransform: 'uppercase',
                    color: 'var(--text-secondary)', textAlign: 'left',
                  }}>
                    {section.title}
                  </div>
                ) : (
                  // The whole header row is the hit target — 200px is an easy
                  // click, a 12px glyph is not. The chevron stays visible
                  // rather than appearing on hover: a director who does not
                  // know sections collapse will never hover to find out.
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
                    <ChevronIcon
                      style={{
                        opacity: 0.75,
                        transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                        transition: 'transform var(--motion-base, 0.15s) var(--ease-out, ease)',
                      }}
                    />
                    {section.title}
                  </button>
                )}

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
              {open && offerOpen && section.key === 'germination' && (
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

              {/* Special Events sub-heading (lifecycle-IA spec §9): a plain
                  label between Events/Special Days, not a row — no fold, no
                  chevron, no click target. Every other item is a flat row;
                  the old Roots-children nesting is gone (ADR Decision 3). */}
              {open && items.map(item => (
                item.heading
                  ? <div key={item.key} style={subHeadingStyle}>{item.heading}</div>
                  : renderItem(item)
              ))}
            </div>
          )
        })}
      </nav>

      {/* Roots-as-Hub Slice B — Camp, Conflicts, Trash and (admin-only) LAN
          & Devices live here instead of an always-open third nav section, so
          the day-to-day sidebar is just Roots + Schedule. Pinned at the
          bottom: it's the one row a director reaches for rarely, not the one
          they scan past every time. */}
      <div style={{ position: 'relative', padding: '6px 12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
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
          <GearIcon />
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
            syncStatus={syncStatus}
            retrying={retrying}
            onRetrySync={handleRetrySync}
          />
        )}
      </div>

      <div style={{
        padding: '10px 20px', borderTop: '1px solid var(--border)', flexShrink: 0,
        fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
      }}>
        {/* A12: with no other paired device there is nothing to sync with, so a
            node that is not running is not a failure — say nothing. */}
        {syncStatus?.otherDeviceCount > 0 &&
          (syncStatus.state === 'host-not-syncing' || syncStatus.state === 'sync-blocked') && (
          <SyncNotRunningRow
            syncStatus={syncStatus}
            retrying={retrying}
            onRetrySync={handleRetrySync}
            onNavigate={onNavigate}
          />
        )}
        {syncStatus?.otherDeviceCount > 0 && syncStatus.peersUnreachable && (
          <CampUnreachableRow onNavigate={onNavigate} />
        )}
        {projectPath && isDevDb && (
          <div
            title={`Development database — not the installed app's data\n${projectPath}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: 6, cursor: 'default',
              color: 'var(--text-secondary)',
            }}
          >
            <span style={{
              flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
              color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
              padding: '1px 4px', borderRadius: 4,
            }}>
              DEV
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
            title={backupStatus === 'caution' ? 'Backup saved — camp document not included' : undefined}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              padding: '4px 0', border: 'none', background: 'none',
              fontSize: 11, fontFamily: 'var(--font-mono)',
              color: backupStatus === 'ok'
                ? 'var(--success, #22c55e)'
                : backupStatus === 'caution'
                  ? 'var(--accent)'
                  : backupStatus === 'error'
                  ? 'var(--danger, #ef4444)'
                  : 'var(--text-secondary)',
              cursor: backupStatus === 'running' ? 'wait' : 'pointer',
              marginBottom: 4,
            }}
          >
            {backupStatus === 'running' ? 'Backing up…'
              : backupStatus === 'ok' ? 'Backup saved'
              : backupStatus === 'caution' ? 'Backup saved — camp document not included'
              : backupStatus === 'error' ? 'Backup failed'
              : 'Backup now'}
          </button>
        )}
        {role === 'admin' && backupRevealable && (
          <button
            type="button"
            onClick={handleShowBackup}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '0 0 4px', border: 'none', background: 'none',
              fontSize: 11, fontFamily: 'var(--font-mono)', cursor: 'pointer',
              color: 'var(--text-secondary)', textDecoration: 'underline', textUnderlineOffset: 2,
            }}
          >
            Show in Finder
          </button>
        )}
        {role === 'admin' && <RestoreControl />}
        {/* About & Legal — a quiet footer link to the view-only surface
            (about note, version, user agreement, license, attributions). The
            version stays beside it as the plain label it has always been. */}
        <button
          type="button"
          onClick={() => onNavigate('about')}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: '4px 0 0', border: 'none', background: 'none',
            fontFamily: 'inherit', fontSize: 11, cursor: 'pointer',
            color: current === 'about' ? 'var(--text)' : 'var(--text-secondary)',
          }}
        >
          About &amp; Legal · v0.1.0
        </button>
      </div>
    </aside>
  )
}

// T277 — a quiet, always-present footer indicator for the two not-running
// sync states. Gated by the caller on `state` alone (never on `lan.tone`,
// same discipline as T275's GearMenu affordance), so it stays absent —
// actually unmounted, not merely hidden — for every healthy state.
//
// One motion: the whole row is a single button, no nested button, so
// noticing and recovering happen in the same click. host-not-syncing reuses
// Sidebar's own handleRetrySync/retrying (no second retry timer, no second
// window.shoresh.retrySync call site). sync-blocked navigates straight to
// Devices via the same `onNavigate` prop App.jsx already threads through —
// restarting the node does not fix a domain-state refusal, so it must never
// offer a dead retry (T275's boundary, carried over here).
// WAN-ladder round 2: no camp peer has been reachable for a long bound while the camp has other
// devices (electron/sync/automerge/peerReachability.js). Most likely this device was offline
// through a revoke and its peers have rotated their discovery secrets, so it must pair again.
function CampUnreachableRow({ onNavigate }) {
  const transition = useEnterTransition('slideFade', {})
  return (
    <button
      type="button"
      title="No other camp device has been reachable for hours. If one was removed while this device was away, pair again while on the camp's network."
      onClick={() => onNavigate('pairAgain')}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 6, width: '100%',
        padding: '4px 0 8px', border: 'none', background: 'none', cursor: 'pointer',
        textAlign: 'left',
        ...transition,
      }}
    >
      <span style={{ flexShrink: 0, fontSize: 8, color: 'var(--danger)' }}>●</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        <span style={{ color: 'var(--danger)' }}>can't reach the camp</span>
        {' · '}
        <span style={{ color: 'var(--text-secondary)' }}>pair again on the camp's network</span>
      </span>
    </button>
  )
}

function SyncNotRunningRow({ syncStatus, retrying, onRetrySync, onNavigate }) {
  const transition = useEnterTransition('slideFade', {})
  const isHostNotSyncing = syncStatus.state === 'host-not-syncing'
  const title = syncStatusLabel(syncStatus).title

  function handleClick() {
    if (isHostNotSyncing) {
      if (!retrying) onRetrySync()
    } else {
      onNavigate('devices')
    }
  }

  return (
    <button
      type="button"
      title={title}
      onClick={handleClick}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 6, width: '100%',
        padding: '4px 0 8px', border: 'none', background: 'none', cursor: 'pointer',
        textAlign: 'left',
        ...transition,
      }}
    >
      <span style={{ flexShrink: 0, fontSize: 8, color: 'var(--danger)' }}>●</span>
      {/* Wraps rather than ellipsizes: the action word is the point of the flag. */}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {/* Deliberately NOT syncStatusLabel(syncStatus).text — that yields the gear-menu's
            'not sharing'/'not syncing' wording. This footer's visible copy is the owner-mandated
            'sync not running' phrasing (T277); only the .title tooltip is shared with the gear menu.
            Do not "unify" this into lan.text — the divergence is intentional. */}
        <span style={{ color: 'var(--danger)' }}>sync not running</span>
        {' · '}
        {isHostNotSyncing ? (
            <span
              style={{
                display: 'inline-block', minWidth: '4.2em',
                color: 'var(--text-secondary)',
                pointerEvents: retrying ? 'none' : 'auto',
                textUnderlineOffset: 2,
                transition: 'text-decoration-color 0.12s ease',
              }}
              onMouseEnter={e => { if (!retrying) e.currentTarget.style.textDecoration = 'underline' }}
              onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none' }}
            >{retrying ? 'trying…' : 'try again'}</span>
        ) : (
          <span style={{ color: 'var(--text-secondary)' }}>open Devices</span>
        )}
      </span>
    </button>
  )
}

// The Settings popup — WAI-ARIA menu-button pattern. Opens focused on its
// first item, closes and returns focus to the gear button on Escape or a
// click outside, and never designates one item as more important than the
// others (same "no visual difference" instinct as the two schedule rows,
// applied here to admin destinations instead).
const GearMenu = forwardRef(function GearMenu({ items, current, badges, onSelect, onClose, syncStatus, retrying, onRetrySync }, ref) {
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
        // T275 — the devices row's sync label. Gated STRICTLY on the raw
        // state, never on the derived tone/text `lan` carries: sync-blocked
        // is also tone:'danger' and must stay a fully inert span (owner
        // ruling: a retry affordance is fine, anything that reads as "this
        // device is blocked" is not).
        const lan = item.key === 'devices' && syncStatus ? syncStatusLabel(syncStatus) : null
        const isHostNotSyncing = item.key === 'devices' && syncStatus?.state === 'host-not-syncing'
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
            {lan && (isHostNotSyncing ? (
              <button
                type="button"
                title={retrying
                  ? 'Starting sharing…'
                  : 'Not sharing with other computers yet — click to retry.'}
                disabled={retrying}
                onClick={(e) => { e.stopPropagation(); if (!retrying) onRetrySync() }}
                style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, flexShrink: 0, marginLeft: 6,
                  color: TONE_COLOR[retrying ? 'secondary' : 'danger'],
                  background: 'none', border: 'none', padding: 0,
                  cursor: retrying ? 'default' : 'pointer',
                  pointerEvents: retrying ? 'none' : 'auto',
                  textUnderlineOffset: 2,
                  transition: 'text-decoration-color 0.12s ease',
                }}
                onMouseEnter={e => { if (!retrying) e.currentTarget.style.textDecoration = 'underline' }}
                onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none' }}
              >{retrying ? 'trying…' : 'try again'}</button>
            ) : (
              <span title={lan.title} style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, flexShrink: 0, marginLeft: 6,
                color: TONE_COLOR[lan.tone],
              }}>{lan.text}</span>
            ))}
            {count > 0 && (
              <span style={{ ...BADGE_PILL, marginLeft: 6 }}>{count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
})

// A quiet grouping label between nav rows ("Special Events", between Events
// and Special Days) — echoes the section-title treatment (condensed,
// uppercase, tracked-out) at the row's own indent depth, so it reads as a
// sub-heading rather than a row: no hover state, no click target, no
// mark/count/optional affordance.
const subHeadingStyle = {
  padding: '10px 12px 4px',
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
