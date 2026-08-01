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
const TWO_GAPS = [{ key: 'days' }, { key: 'activities' }]

describe('sectionRollup', () => {
  it('says nothing while a section is open — the rows speak for themselves', () => {
    expect(sectionRollup({ section: 'setup', open: true, gaps: TWO_GAPS, badges: {} })).toBeNull()
  })

  it('carries the unmet count out to a collapsed Camp Set Up header', () => {
    const rollup = sectionRollup({ section: 'setup', open: false, gaps: TWO_GAPS, badges: {} })
    expect(rollup).toEqual({ mark: '!', text: '4 / 6', tone: 'danger' })
  })

  it('shows a complete setup as complete, not as silence', () => {
    const rollup = sectionRollup({ section: 'setup', open: false, gaps: NO_GAPS, badges: {} })
    expect(rollup).toEqual({ mark: '✓', text: '6 / 6', tone: 'success' })
  })

  it('rolls the conflicts badge up to a collapsed System header', () => {
    const rollup = sectionRollup({ section: 'system', open: false, gaps: NO_GAPS, badges: { conflicts: 2 } })
    expect(rollup).toEqual({ mark: null, text: '2', tone: 'warning' })
  })

  it('rolls up nothing — never a zero — when a collapsed section has nothing to report', () => {
    // "0" reads as a value worth looking at. Absence is the honest rendering.
    expect(sectionRollup({ section: 'system', open: false, gaps: NO_GAPS, badges: { conflicts: 0 } })).toBeNull()
    expect(sectionRollup({ section: 'schedule', open: false, gaps: NO_GAPS, badges: {} })).toBeNull()
  })

  it('counts started weeks on a collapsed Schedule header', () => {
    expect(sectionRollup({ section: 'schedule', open: false, gaps: NO_GAPS, badges: {}, startedRoutes: 2 }))
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
    expect(nextFoldStateAfterAnswer({ setup: true }, 'tuck')).toEqual({
      sections: { setup: false }, offered: true,
    })
    expect(nextFoldStateAfterAnswer({ setup: true }, 'keep')).toEqual({
      sections: { setup: true }, offered: true,
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
    const saved = JSON.stringify({ sections: { setup: false, schedule: true, system: true }, offered: true })
    const state = loadSidebarState(storage(saved))
    expect(state.sections.setup).toBe(false)
    expect(state.offered).toBe(true)
  })

  it('falls back to defaults on malformed state instead of throwing', () => {
    // A sidebar preference is never worth a white screen.
    for (const bad of ['not json', '{"sections":', '[]', '42', '"a string"']) {
      expect(() => loadSidebarState(storage(bad))).not.toThrow()
      expect(loadSidebarState(storage(bad)).sections).toEqual(SECTION_DEFAULTS)
    }
  })

  it('ignores a persisted section that no longer exists', () => {
    const saved = JSON.stringify({ sections: { setup: false, operations: false }, offered: false })
    const state = loadSidebarState(storage(saved))
    expect(state.sections).toEqual({ setup: false, schedule: true, system: true })
    expect('operations' in state.sections).toBe(false)
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
    for (const state of ['host', 'client-connected', 'client-disconnected', 'standalone']) {
      const label = syncStatusLabel({ state })
      expect(`${label.text} ${label.title}`).not.toMatch(/host|client|socket|mDNS|LAN|sync\b|peer/i)
    }
  })

  it('falls back to standalone for an unknown or missing status', () => {
    expect(syncStatusLabel(null).text).toBe('on its own')
    expect(syncStatusLabel({ state: 'something-new' }).text).toBe('on its own')
  })
})
