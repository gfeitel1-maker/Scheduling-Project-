// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { dedupeChipItems } from './rootsChips'

// T135 — importing one real camp file produced 112 anchors, and the Roots card
// rendered its first six as "Indoor Elective, Indoor Elective, Indoor Elective,
// Instructional, Instructional, Instructional". Anchors legitimately repeat a
// name (one row per activity per day), so the data is right; six chips saying
// three things is the display asking a question nobody asked.
describe('dedupeChipItems', () => {
  it('shows each name once, however many rows carry it', () => {
    const items = [
      { id: '1', name: 'Indoor Elective' }, { id: '2', name: 'Indoor Elective' },
      { id: '3', name: 'Indoor Elective' }, { id: '4', name: 'Instructional' },
      { id: '5', name: 'Instructional' }, { id: '6', name: 'Outdoor Elective' },
    ]
    expect(dedupeChipItems(items).map((x) => x.name))
      .toEqual(['Indoor Elective', 'Instructional', 'Outdoor Elective'])
  })

  it('keeps the first row for a name, so its id stays stable as a React key', () => {
    const items = [{ id: 'a', name: 'Swim' }, { id: 'b', name: 'Swim' }]
    expect(dedupeChipItems(items)).toEqual([{ id: 'a', name: 'Swim' }])
  })

  it('leaves an already-distinct list untouched', () => {
    const items = [{ id: '1', name: 'Art' }, { id: '2', name: 'Swim' }]
    expect(dedupeChipItems(items)).toEqual(items)
  })

  it('does not collapse names that merely look similar', () => {
    // campA carries both "Project" and "Projects" — a real near-duplicate the
    // sweep flags for a human. Chips must not quietly merge them.
    const items = [{ id: '1', name: 'Project' }, { id: '2', name: 'Projects' }]
    expect(dedupeChipItems(items)).toHaveLength(2)
  })

  it('tolerates a row with no name', () => {
    const items = [{ id: '1' }, { id: '2', name: 'Swim' }]
    expect(dedupeChipItems(items)).toHaveLength(2)
  })

  it('tolerates an empty or missing list', () => {
    expect(dedupeChipItems([])).toEqual([])
    expect(dedupeChipItems()).toEqual([])
  })
})
