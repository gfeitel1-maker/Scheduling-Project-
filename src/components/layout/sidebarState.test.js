import { describe, it, expect } from 'vitest'
import {
  SECTION_DEFAULTS,
  syncStatusLabel,
  loadSidebarState,
  nextFoldStateAfterAnswer,
  sectionRollup,
  shouldOfferFold,
} from './sidebarState'

// docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md §6.1, §7, §8, §12.
//
// The rule that makes collapsing safe: a collapsed header must say what its
// contents would have said. Without it, tidying the sidebar in June is a way to
// stop seeing a problem in August.

const NO_GAPS = []
// tiers/groups/days/timeblocks live in Germination; activities lives in
// Sprouts (docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 3) — a
// gap in 'days' is attributed to Germination's rollup, a gap in 'activities'
// to Sprouts's.
const TWO_GAPS = [{ key: 'days' }, { key: 'activities' }]

describe('sectionRollup', () => {
  it('says nothing while a section is open — the rows speak for themselves', () => {
    expect(sectionRollup({ section: 'germination', open: true, gaps: TWO_GAPS })).toBeNull()
  })

  it('carries the unmet count out to a collapsed Germination header (3 required areas: tiers/groups/days/timeblocks minus the "days" gap)', () => {
    const rollup = sectionRollup({ section: 'germination', open: false, gaps: TWO_GAPS })
    expect(rollup).toEqual({ mark: '!', text: '3 / 4', tone: 'danger' })
  })

  it('shows a complete Germination as complete, not as silence', () => {
    const rollup = sectionRollup({ section: 'germination', open: false, gaps: NO_GAPS })
    expect(rollup).toEqual({ mark: '✓', text: '4 / 4', tone: 'success' })
  })

  it('carries the unmet count out to a collapsed Sprouts header (1 required area: activities)', () => {
    const rollup = sectionRollup({ section: 'sprouts', open: false, gaps: TWO_GAPS })
    expect(rollup).toEqual({ mark: '!', text: '0 / 1', tone: 'danger' })
  })

  it('shows a complete Sprouts as complete, not as silence', () => {
    const rollup = sectionRollup({ section: 'sprouts', open: false, gaps: NO_GAPS })
    expect(rollup).toEqual({ mark: '✓', text: '1 / 1', tone: 'success' })
  })

  // Roots-as-Hub Slice B: 'system' is no longer a foldable nav section —
  // Camp/Conflicts/Trash/LAN & Devices live in the Settings gear instead,
  // which is a popup with no persisted rollup of its own (the gear button
  // itself carries the conflicts badge — see Sidebar.jsx). Roots itself is
  // a fixed row with no fold state at all (ADR Decision 3).
  it('rolls up nothing — never a zero — when a collapsed section has nothing to report', () => {
    // "0" reads as a value worth looking at. Absence is the honest rendering.
    expect(sectionRollup({ section: 'plants', open: false, gaps: NO_GAPS })).toBeNull()
  })

  it('counts started weeks on a collapsed Plants header', () => {
    expect(sectionRollup({ section: 'plants', open: false, gaps: NO_GAPS, startedRoutes: 2 }))
      .toEqual({ mark: null, text: '2', tone: 'secondary' })
  })
})

describe('shouldOfferFold', () => {
  it('does not offer on first load of an already-complete camp', () => {
    // The trigger is the transition, not the state. A returning director who
    // finished setup in May must not be asked every time they open the app.
    expect(shouldOfferFold({ gaps: NO_GAPS, previousGaps: null, alreadyOffered: false })).toBe(false)
  })

  it('offers on the render where the last gap closes', () => {
    expect(shouldOfferFold({ gaps: NO_GAPS, previousGaps: TWO_GAPS, alreadyOffered: false })).toBe(true)
  })

  it('never offers while gaps remain', () => {
    expect(shouldOfferFold({ gaps: TWO_GAPS, previousGaps: TWO_GAPS, alreadyOffered: false })).toBe(false)
  })

  it('never offers twice, whichever way the director answered', () => {
    // "Keep open" is remembered as firmly as "Tuck away". Asking again next
    // week is the same silent imposition in slower motion.
    expect(shouldOfferFold({ gaps: NO_GAPS, previousGaps: TWO_GAPS, alreadyOffered: true })).toBe(false)
  })
})

describe('nextFoldStateAfterAnswer', () => {
  it('records that the question was asked, whichever answer was given', () => {
    expect(nextFoldStateAfterAnswer({ germination: true }, 'tuck')).toEqual({
      sections: { germination: false }, offered: true,
    })
    expect(nextFoldStateAfterAnswer({ germination: true }, 'keep')).toEqual({
      sections: { germination: true }, offered: true,
    })
  })
})

describe('loadSidebarState', () => {
  function storage(value) {
    return { getItem: () => value }
  }

  it('opens every section by default', () => {
    expect(loadSidebarState(storage(null)).sections).toEqual(SECTION_DEFAULTS)
    expect(loadSidebarState(storage(null)).offered).toBe(false)
  })

  it('restores what the director chose last time', () => {
    const saved = JSON.stringify({ sections: { germination: false, sprouts: true, plants: true }, offered: true })
    const state = loadSidebarState(storage(saved))
    expect(state.sections.germination).toBe(false)
    expect(state.offered).toBe(true)
  })

  it('carries no rootsOpen — Roots is a fixed row with no fold state (ADR Decision 3)', () => {
    expect(loadSidebarState(storage(null)).rootsOpen).toBeUndefined()
  })

  it('falls back to defaults on malformed state instead of throwing', () => {
    // A sidebar preference is never worth a white screen.
    for (const bad of ['not json', '{"sections":', '[]', '42', '"a string"']) {
      expect(() => loadSidebarState(storage(bad))).not.toThrow()
      expect(loadSidebarState(storage(bad)).sections).toEqual(SECTION_DEFAULTS)
    }
  })

  it('ignores a persisted section that no longer exists', () => {
    const saved = JSON.stringify({ sections: { germination: false, setup: false }, offered: false })
    const state = loadSidebarState(storage(saved))
    expect(state.sections).toEqual({ germination: false, sprouts: true, plants: true })
    expect('setup' in state.sections).toBe(false)
    expect('system' in state.sections).toBe(false)
  })

  it('survives storage that throws', () => {
    // Private browsing, a locked profile, a stubbed test environment.
    const throwing = { getItem: () => { throw new Error('denied') } }
    expect(() => loadSidebarState(throwing)).not.toThrow()
    expect(loadSidebarState(throwing).sections).toEqual(SECTION_DEFAULTS)
  })

  it('survives no storage at all', () => {
    expect(loadSidebarState(undefined).sections).toEqual(SECTION_DEFAULTS)
  })
})

describe('syncStatusLabel (T27)', () => {
  it('tells a director this computer is the main one', () => {
    expect(syncStatusLabel({ state: 'host' }).text).toBe('main')
    expect(syncStatusLabel({ state: 'host' }).tone).toBe('success')
  })

  it('distinguishes "never joined anything" from "cannot reach the main computer"', () => {
    // The whole point. A device on its own is working correctly; a client that
    // has lost the Host is not, and conflating them hides the only case worth
    // acting on.
    const alone = syncStatusLabel({ state: 'client-disconnected' })
    const standalone = syncStatusLabel({ state: 'standalone' })
    expect(alone.text).not.toBe(standalone.text)
    expect(alone.tone).toBe('danger')
    expect(standalone.tone).toBe('secondary')
  })

  it('reassures rather than alarms when a client is disconnected — the work is not lost', () => {
    expect(syncStatusLabel({ state: 'client-disconnected' }).title)
      .toMatch(/saved here and will reach it/)
  })

  it('uses no developer vocabulary', () => {
    for (const state of ['host', 'client-connected', 'client-connecting', 'client-disconnected', 'standalone']) {
      const label = syncStatusLabel({ state })
      expect(`${label.text} ${label.title}`).not.toMatch(/host|client|socket|mDNS|LAN|sync\b|peer/i)
    }
  })

  it('falls back to standalone for an unknown or missing status', () => {
    expect(syncStatusLabel(null).text).toBe('on its own')
    expect(syncStatusLabel({ state: 'something-new' }).text).toBe('on its own')
  })

  // T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 4): the window
  // between the socket opening and the Host confirming (or rejecting) this
  // device's session needs its own honest state — neither the reassuring
  // "linked" nor the alarming "alone".
  describe('client-connecting (T87)', () => {
    it('is distinct from both client-connected and client-disconnected', () => {
      const connecting = syncStatusLabel({ state: 'client-connecting' })
      const connected = syncStatusLabel({ state: 'client-connected' })
      const disconnected = syncStatusLabel({ state: 'client-disconnected' })
      expect(connecting.text).not.toBe(connected.text)
      expect(connecting.text).not.toBe(disconnected.text)
    })

    it('does not claim the connection is confirmed, and does not alarm', () => {
      const connecting = syncStatusLabel({ state: 'client-connecting' })
      expect(connecting.tone).not.toBe('success')
      expect(connecting.tone).not.toBe('danger')
    })

    it('does not regress the existing three entries (host/client-connected/client-disconnected unchanged)', () => {
      expect(syncStatusLabel({ state: 'host' })).toEqual({
        text: 'main', tone: 'success', title: 'This computer is the main one. The others follow what is on it.',
      })
      expect(syncStatusLabel({ state: 'client-connected' })).toEqual({
        text: 'linked', tone: 'success', title: 'Connected to the main computer.',
      })
      expect(syncStatusLabel({ state: 'client-disconnected' })).toEqual({
        text: 'alone', tone: 'danger', title: 'Cannot reach the main computer right now. Your changes are saved here and will reach it when it is back.',
      })
    })
  })

  // Migration guard (ADR §Migration): an old main process's getSyncStatus()
  // return shape has no `authenticated` field at all, and a stale cached
  // status object could be missing it too — syncStatusLabel must never throw
  // on either, and must fall back to a defined label.
  it('never throws on a status object missing the authenticated field entirely', () => {
    expect(() => syncStatusLabel({ mode: 'client', connected: true, state: 'client-connected' })).not.toThrow()
    expect(syncStatusLabel({ mode: 'client', connected: true, state: 'client-connected' }).text).toBe('linked')
  })
})
