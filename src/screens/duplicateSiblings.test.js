// @vitest-environment node
//
// The comparison rule behind both duplicate-catchers. The judgement lives here,
// so the tests that matter are the ones pinning what must NOT match.
import { describe, it, expect } from 'vitest'
import { groupDuplicatesByName, duplicateSiblingsByIdFor, withinOneEdit } from './duplicateSiblings.js'

const rows = (...names) => names.map((name, i) => ({ id: `id-${i}`, name }))
const groupNames = (g) => [...g.values()].map((m) => m.map((r) => r.name).sort())

describe('EXACT — what Locations uses, unchanged', () => {
  it('groups case and whitespace variants', () => {
    // The KEY is normalized; the row keeps the name the director actually typed,
    // which is what the marker has to show them.
    expect(groupNames(groupDuplicatesByName(rows('Gym', 'gym', ' Gym ')))).toEqual([[' Gym ', 'Gym', 'gym']])
  })

  it('does NOT group a one-letter typo — exact means exact', () => {
    // The Locations caller relies on this. Loosening it here would change a
    // second screen's behaviour as a side effect of an Activities feature.
    expect(groupDuplicatesByName(rows('Music', 'Musik')).size).toBe(0)
  })
})

describe('NEAR — what Activities uses, because a spreadsheet typo creates a real second row', () => {
  const near = (...names) => groupDuplicatesByName(rows(...names), { near: true })

  it('groups a single substituted character — the case the feature exists for', () => {
    expect(groupNames(near('Music', 'Musik'))).toEqual([['Music', 'Musik']])
  })

  it('groups a single inserted or deleted character', () => {
    expect(near('Archery', 'Archary').size).toBe(1)
    expect(near('Basketball', 'Baskteball').size).toBe(0) // two edits (transposition) — deliberately NOT caught
  })

  it('groups the suffix variants the ingest sweep already flags', () => {
    expect(groupNames(near('Swim Return', 'Swim Returning'))).toEqual([['Swim Return', 'Swim Returning']])
  })

  it('still groups exact case/whitespace variants', () => {
    expect(near('Music', 'music').size).toBe(1)
  })
})

describe('what must NOT be grouped — the false positives that would make this noise', () => {
  const near = (...names) => groupDuplicatesByName(rows(...names), { near: true })

  it('leaves genuinely different activities alone', () => {
    expect(near('Archery', 'Drama', 'Swim', 'Gaga Field', 'Music').size).toBe(0)
  })

  it('does not group short names where one edit is most of the word', () => {
    // "Art"/"Arc" are different activities. The 4-character floor exists for
    // exactly this, and a camp really does have three-letter activity names.
    expect(near('Art', 'Arc').size).toBe(0)
  })

  it('does not group names that differ by a whole word', () => {
    expect(near('Drama', 'Drama Club').size).toBe(0)
    expect(near('Swim', 'Swimming').size).toBe(0)
  })

  it('does not group a NUMBERED SERIES — measured against the real corpus', () => {
    // Without this guard the rule flagged seven groups across the eight real
    // camp workbooks: three genuine typos and FOUR numbered series. On the main
    // file it was two series against one typo — the ratio at which a director
    // learns to ignore the marker, which is worse than not having it.
    expect(near('Lunch 1', 'Lunch 2', 'Lunch 3', 'Lunch 4', 'Lunch 5').size).toBe(0)
    expect(near('Tent 2', 'Tent 3', 'Tent 4').size).toBe(0)
    expect(near('CIT Block 1', 'CIT Block 2', 'CIT Block 3').size).toBe(0)
    expect(near('Sports (w/G1)', 'Sports (w/G2)').size).toBe(0)
  })

  it('still catches the real typos that live beside those series', () => {
    // The three the real corpus actually contains. A guard that silenced these
    // too would have made the feature pointless.
    expect(near('Classroom', 'Classrroom').size).toBe(1)
    expect(near('Swim Return', 'Swim Returning').size).toBe(1)
    expect(near('classroom', 'Classrooms').size).toBe(1)
  })

  it('does not group bunk-style names that differ by their distinguishing character', () => {
    // The worst plausible false positive: a camp naming activities per group.
    // These differ by one character and ARE different — but so are "Music"/
    // "Musik". This test records the limit honestly rather than pretending the
    // rule is smarter than it is: they WILL be flagged, and the marker is
    // advisory precisely so that costs a director one glance.
    const g = near('Bunk A Swim', 'Bunk B Swim')
    expect(g.size, 'known and accepted false positive — FLAG, NEVER BLOCK').toBe(1)
  })
})

describe('clustering is order-independent', () => {
  it('puts a chain of near-matches in one group however the rows are ordered', () => {
    // Near-matching is not transitive, so a naive shared-key grouping would put
    // the same rows in different groups depending on iteration order.
    const forward = groupDuplicatesByName(rows('Music', 'Musik', 'Musib'), { near: true })
    const backward = groupDuplicatesByName(rows('Musib', 'Musik', 'Music'), { near: true })
    expect(forward.size).toBe(1)
    expect(backward.size).toBe(1)
    expect(groupNames(forward)).toEqual(groupNames(backward))
  })
})

describe('withinOneEdit', () => {
  it('accepts one substitution, insertion or deletion', () => {
    expect(withinOneEdit('music', 'musik')).toBe(true)
    expect(withinOneEdit('music', 'musics')).toBe(true)
    expect(withinOneEdit('musics', 'music')).toBe(true)
  })

  it('rejects identical strings, two edits, and big length gaps', () => {
    expect(withinOneEdit('music', 'music')).toBe(false)
    expect(withinOneEdit('music', 'muzik')).toBe(false)  // TWO substitutions: s->z and c->k
    expect(withinOneEdit('music', 'muzic')).toBe(true)   // one: s->z
    expect(withinOneEdit('swim', 'swimming')).toBe(false)
  })
})

describe('duplicateSiblingsByIdFor', () => {
  it('gives every row in a group the others, and non-duplicates nothing', () => {
    const list = rows('Music', 'Musik', 'Archery')
    const map = duplicateSiblingsByIdFor(list, { near: true })
    expect(map.get('id-0').map((r) => r.name)).toEqual(['Musik'])
    expect(map.get('id-1').map((r) => r.name)).toEqual(['Music'])
    expect(map.get('id-2')).toBeUndefined()
  })
})
