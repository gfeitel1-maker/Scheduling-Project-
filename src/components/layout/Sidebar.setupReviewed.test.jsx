// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import Sidebar from './Sidebar'

// A new camp pre-fills Monday to Friday. The sidebar must not tick Days as done
// before the director has looked at it; a camp already in use keeps its tick.

const NEW_CAMP_COUNTS = {
  cohorts: 1, tiers: 0, groups: 0, days: 5, timeblocks: 0, activities: 0,
  recurringevents: 0, fixedevents: 0, locations: 0, electives: 0,
}
const USED_CAMP_COUNTS = { ...NEW_CAMP_COUNTS, tiers: 4, groups: 14, timeblocks: 6, activities: 8 }

let storage
beforeEach(() => {
  cleanup()
  storage = {}
  vi.stubGlobal('localStorage', {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = v },
    removeItem: (k) => { delete storage[k] },
  })
})

function el(props = {}) {
  return (
    <Sidebar
      current="roots" onNavigate={() => {}} campId="camp-1" role="admin" badges={{}}
      counts={NEW_CAMP_COUNTS} campName="Camp Test" syncStatus={null}
      projectPath={null} isDevDb={false} buildLabel={null} backupStatus={null}
      handleBackupNow={() => {}} offerShown={false} setOfferShown={() => {}}
      {...props}
    />
  )
}

const daysRow = () => screen.getByRole('button', { name: /Days/ })
const daysTick = () => daysRow().querySelector('[role="img"][aria-label="Done"]')
const daysLook = () => daysRow().querySelector('[role="img"][aria-label="Needs a look"]')

describe('Sidebar: a pre-filled setup step needs a look before it is ticked', () => {
  it('a new camp shows Days as needing a look, not done', () => {
    render(el())
    expect(daysTick()).toBeNull()
    expect(daysLook()).not.toBeNull()
  })

  it('opening Days gives the tick, and it survives a remount from storage', () => {
    const { rerender, unmount } = render(el())
    rerender(el({ current: 'days' }))
    expect(daysTick()).not.toBeNull()
    expect(daysLook()).toBeNull()

    unmount()
    render(el({ current: 'roots' }))
    expect(daysTick()).not.toBeNull()
    expect(daysLook()).toBeNull()
  })

  it('the mark is per camp: another camp on the same device still needs a look', () => {
    const { rerender } = render(el())
    rerender(el({ current: 'days' }))
    cleanup()
    render(el({ campId: 'camp-2' }))
    expect(daysLook()).not.toBeNull()
  })

  it('an existing camp already in use keeps its tick without being asked to look', () => {
    render(el({ counts: USED_CAMP_COUNTS }))
    expect(daysTick()).not.toBeNull()
    expect(daysLook()).toBeNull()
  })

  it('a new camp that later gains other data does not have Days ticked behind the director', () => {
    const { rerender } = render(el())
    rerender(el({ counts: USED_CAMP_COUNTS }))
    expect(daysTick()).toBeNull()
    expect(daysLook()).not.toBeNull()
  })

  it('steps the director fills from empty keep today\'s behaviour', () => {
    render(el({ counts: USED_CAMP_COUNTS }))
    const groups = screen.getByRole('button', { name: /Groups/ })
    expect(groups.querySelector('[role="img"][aria-label="Done"]')).not.toBeNull()
  })

  it('a storage that throws still renders, and the tick holds for the session', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => {},
    })
    const { rerender } = render(el())
    expect(daysLook()).not.toBeNull()
    rerender(el({ current: 'days' }))
    expect(daysTick()).not.toBeNull()
  })
})
