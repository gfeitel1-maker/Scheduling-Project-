import { describe, it, expect } from 'vitest'
import { importKeyOf } from './importSessions.js'

// Red Hat, PR #916: the per-import session (undone auto-applies, "Back to unanswered") was keyed by
// file name, mode and the LENGTH of the approved set, so two different files of the same name and
// size shared it. It is keyed by content now.
describe('importKeyOf', () => {
  const base = (approved, fixedEvents = []) => ({ mode: 'add', approved, fixedEvents })

  it('differs for two different imports with the same name, mode and approved-set size', () => {
    const a = importKeyOf(base({ activities: ['Archery'] }), 'Schedule.xlsx')
    const b = importKeyOf(base({ activities: ['Gardens'] }), 'Schedule.xlsx')
    expect(JSON.stringify(['Archery']).length).toBe(JSON.stringify(['Gardens']).length)
    expect(a).not.toBe(b)
  })

  it('differs when only the fixed events differ', () => {
    const a = importKeyOf(base({}, [{ name: 'Lunch', time_block: '12:00', days: ['Mon'] }]), 'x')
    const b = importKeyOf(base({}, [{ name: 'Lunch', time_block: '12:30', days: ['Mon'] }]), 'x')
    expect(a).not.toBe(b)
  })

  it('is the same for the same import, so a remount finds its session', () => {
    const inputs = base({ activities: ['Archery'] }, [{ name: 'Lunch', time_block: '12:00', days: ['Mon'] }])
    expect(importKeyOf(inputs, 'Schedule.xlsx')).toBe(importKeyOf(structuredClone(inputs), 'Schedule.xlsx'))
  })
})
