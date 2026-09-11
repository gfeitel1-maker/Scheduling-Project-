import { describe, it, expect } from 'vitest'
import { findSuspectRecords } from './suspectRecords'

// T134/T136. The parser will never be clean on input this messy, and that is
// fine — what is not fine is shipping a fragment as a first-class activity with
// a colour dot and a weekly target, indistinguishable from "Swim".
//
// Every rule here FLAGS. Nothing is dropped or renamed: "Art" trips a
// short-name heuristic and is a real activity, which is the whole argument for
// asking rather than deciding.
describe('findSuspectRecords — activities', () => {
  const names = (r) => r.filter((x) => x.entity === 'activities').map((x) => x.name)

  it('flags a name that begins mid-sentence', () => {
    const found = findSuspectRecords({ activities: ['Swim', 'and Mitzvah', 'and Mitzvah Project'] })
    expect(names(found)).toEqual(['and Mitzvah', 'and Mitzvah Project'])
    expect(found[0].reason).toMatch(/begins with/i)
  })

  it('flags the period column leaking into the activity name', () => {
    const found = findSuspectRecords({
      activities: ['Block Sports', 'Block Teva', 'Block 1 Sport Workshop', 'Sports'],
    })
    expect(names(found)).toEqual(['Block Sports', 'Block Teva', 'Block 1 Sport Workshop'])
    expect(found[0].reason).toMatch(/period/i)
  })

  it('does not flag an ordinary short activity name', () => {
    // The reason the rules flag instead of drop.
    expect(names(findSuspectRecords({ activities: ['Art', 'Teva', 'Swim'] }))).toEqual([])
  })

  it('does not flag a name that merely contains the word block', () => {
    expect(names(findSuspectRecords({ activities: ['Cinder Block Art'] }))).toEqual([])
  })
})

describe('findSuspectRecords — shape', () => {
  it('returns an empty list for a clean file', () => {
    expect(findSuspectRecords({ activities: ['Swim', 'Art'], groups: ['Oaks', 'Brook'] })).toEqual([])
  })

  it('stays silent on the corpus files that are not messy', () => {
    // campB (36 activities) and campC (9) produce no flags at all. A detector
    // that fires on every file is noise, not a signal.
    expect(findSuspectRecords({ activities: ['Carpool', 'Group Time', 'Mifkad', 'Chug'] })).toEqual([])
  })

  it('tolerates missing buckets', () => {
    expect(findSuspectRecords({})).toEqual([])
    expect(findSuspectRecords()).toEqual([])
  })
})
