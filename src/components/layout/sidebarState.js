// The sidebar's derived state, kept out of the component so it can be tested
// without React.
//
// docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md §6.1, §7, §8.
//
// Nothing here touches the op log. How one director likes their sidebar is not
// camp data: it is per-device, never synced, and must not change what a
// counsellor sees on another laptop.

import { REQUIRED_AREAS } from '../../engine/readiness'

export const SECTION_KEYS = ['setup', 'schedule', 'system']
export const SECTION_DEFAULTS = { setup: true, schedule: true, system: true }

const STORAGE_KEY = 'shoresh-sidebar-state'

/**
 * What a collapsed section header must say on behalf of its hidden rows.
 *
 * Returns `null` when there is nothing to report — including when a count is
 * zero. Rendering "0" invites a director to look at something that is fine.
 *
 * This is the rule that makes collapsing safe. A director who tidied their
 * sidebar in June must still see a sync problem in August.
 */
export function sectionRollup({ section, open, gaps = [], badges = {}, startedRoutes = 0 }) {
  if (open) return null

  if (section === 'setup') {
    const total = REQUIRED_AREAS.length
    const done = total - gaps.length
    return gaps.length > 0
      ? { mark: '!', text: `${done} / ${total}`, tone: 'danger' }
      : { mark: '✓', text: `${done} / ${total}`, tone: 'success' }
  }

  if (section === 'schedule') {
    return startedRoutes > 0 ? { mark: null, text: String(startedRoutes), tone: 'secondary' } : null
  }

  const conflicts = Number(badges.conflicts) || 0
  return conflicts > 0 ? { mark: null, text: String(conflicts), tone: 'warning' } : null
}

/**
 * Should the tuck-away offer appear on this render?
 *
 * The trigger is the **transition** from short to complete, never the state.
 * `previousGaps === null` means this is the first render we have seen, so a
 * camp that was already complete when the app opened is not asked — that would
 * greet a returning director with a question every session.
 */
export function shouldOfferFold({ gaps, previousGaps, alreadyOffered }) {
  if (alreadyOffered) return false
  if (gaps.length > 0) return false
  if (previousGaps === null || previousGaps === undefined) return false
  return previousGaps.length > 0
}

/**
 * Both answers are final. "Keep open" is remembered exactly as firmly as "Tuck
 * away" — a director who said no must not be asked again next week.
 */
export function nextFoldStateAfterAnswer(sections, answer) {
  return {
    sections: { ...sections, setup: answer !== 'tuck' },
    offered: true,
  }
}

/**
 * Read persisted state, discarding anything unrecognisable.
 *
 * Malformed or unreadable state falls back to defaults rather than throwing: a
 * sidebar preference is never worth a white screen, and storage can be absent
 * (private browsing, a locked profile, a test environment).
 */
export function loadSidebarState(storage) {
  const fallback = { sections: { ...SECTION_DEFAULTS }, offered: false }

  let raw
  try {
    raw = storage?.getItem?.(STORAGE_KEY)
  } catch {
    return fallback
  }
  if (!raw) return fallback

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback

  const sections = { ...SECTION_DEFAULTS }
  const saved = parsed.sections
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    // Only keys we still have. A section that no longer exists is ignored
    // rather than carried forward as a phantom.
    for (const key of SECTION_KEYS) {
      if (typeof saved[key] === 'boolean') sections[key] = saved[key]
    }
  }

  return { sections, offered: parsed.offered === true }
}

// T27 — what the LAN row says, in camp language. A director does not know what
// a host, a client or a socket is; they know whether the schedule they just
// changed will reach the other iPad.
//
// 'standalone' and 'client-disconnected' are deliberately different sentences.
// A device that never joined anything is working correctly. A device that
// joined and cannot see the main computer is not, and conflating the two hides
// the only case worth acting on.
const SYNC_STATUS_COPY = {
  host: { text: 'main', tone: 'success', title: 'This computer is the main one. The others follow what is on it.' },
  'client-connected': { text: 'linked', tone: 'success', title: 'Connected to the main computer.' },
  'client-disconnected': { text: 'alone', tone: 'danger', title: 'Cannot reach the main computer right now. Your changes are saved here and will reach it when it is back.' },
  standalone: { text: 'on its own', tone: 'secondary', title: 'This computer is not sharing with any other yet.' },
}

export function syncStatusLabel(status) {
  return SYNC_STATUS_COPY[status?.state] ?? SYNC_STATUS_COPY.standalone
}

export function saveSidebarState(storage, state) {
  try {
    storage?.setItem?.(STORAGE_KEY, JSON.stringify({ sections: state.sections, offered: state.offered }))
  } catch {
    // Persisting a preference must never break navigation.
  }
}
