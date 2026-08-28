// The sidebar's derived state, kept out of the component so it can be tested
// without React.
//
// docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md §6.1, §7, §8.
//
// Nothing here touches the op log. How one director likes their sidebar is not
// camp data: it is per-device, never synced, and must not change what a
// counsellor sees on another laptop.

import { REQUIRED_AREAS } from '../../engine/readiness'

// Roots-as-Hub Slice B: 'system' is no longer a foldable nav section — Camp,
// Conflicts, Trash and LAN & Devices moved to the Settings gear menu, which
// is a popup (open/closed while mounted), not persisted fold state.
//
// Lifecycle IA (docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 3):
// the former 'setup'/'schedule' two-section model is replaced by three
// collapsible stages. Roots is no longer one of them — it is a fixed,
// chevron-less top row (navSections.js's ROOTS_ITEM) with no fold state of
// its own, so the persisted `rootsOpen` key is retired.
export const SECTION_KEYS = ['germination', 'sprouts', 'plants']
export const SECTION_DEFAULTS = { germination: true, sprouts: true, plants: true }

// REQUIRED_AREAS split by which stage each area's row now lives in
// (navSections.js) — used only to attribute a collapsed section's rollup
// mark to the right stage. tiers/groups/days/timeblocks are Germination;
// activities is the one REQUIRED_AREAS entry that lives in Sprouts.
const GERMINATION_AREA_KEYS = new Set(['tiers', 'groups', 'days', 'timeblocks'])

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
export function sectionRollup({ section, open, gaps = [], startedRoutes = 0 }) {
  if (open) return null

  if (section === 'germination' || section === 'sprouts') {
    const inSection = section === 'germination'
      ? (area) => GERMINATION_AREA_KEYS.has(area)
      : (area) => !GERMINATION_AREA_KEYS.has(area)
    const total = REQUIRED_AREAS.filter((a) => inSection(a.key)).length
    const sectionGaps = gaps.filter((g) => inSection(g.key))
    const done = total - sectionGaps.length
    return sectionGaps.length > 0
      ? { mark: '!', text: `${done} / ${total}`, tone: 'danger' }
      : { mark: '✓', text: `${done} / ${total}`, tone: 'success' }
  }

  if (section === 'plants') {
    return startedRoutes > 0 ? { mark: null, text: String(startedRoutes), tone: 'secondary' } : null
  }

  return null
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
    sections: { ...sections, germination: answer !== 'tuck' },
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
  // T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 4): the window
  // between the socket opening and the Host confirming (or rejecting) this
  // device's session — 'client-connected' now means authenticated, not just
  // transport-open, so this in-between moment needs its own honest state.
  'client-connecting': { text: 'connecting', tone: 'secondary', title: 'Talking to the main computer — not yet confirmed.' },
  'client-disconnected': { text: 'alone', tone: 'danger', title: 'Cannot reach the main computer right now. Your changes are saved here and will reach it when it is back.' },
  standalone: { text: 'on its own', tone: 'secondary', title: 'This computer is not sharing with any other yet.' },
}

export function syncStatusLabel(status) {
  return SYNC_STATUS_COPY[status?.state] ?? SYNC_STATUS_COPY.standalone
}

export function saveSidebarState(storage, state) {
  try {
    storage?.setItem?.(STORAGE_KEY, JSON.stringify({
      sections: state.sections, offered: state.offered,
    }))
  } catch {
    // Persisting a preference must never break navigation.
  }
}
