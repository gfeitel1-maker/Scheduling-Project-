import { describe, it, expect } from 'vitest'
import { matchActivitiesToLocations, candidatePlaceNames } from './locationsFromActivities'

// T147 — bind on identity, never infer meaning.
//
// A location is not a caption, it is a CONSTRAINT: buildSchedule's placeUsage
// caps who can be in a place in a block. A wrongly-guessed location silently
// refuses a pairing that would have been fine, or admits two groups into a room
// that holds one — and the director sees an ordinary-looking schedule shaped by
// an assignment they never made.
//
// The owner's own camp is the evidence, in both directions:
//   "virtual sports is in the room with that name, same for art, same for clay"
//   "slingshots is at the archery range, not the slingshot range"
//   "sports is usually outside on the field but could be in the gym"

const loc = (id, name) => ({ id, name })

describe('matchActivitiesToLocations — binds on identity', () => {
  const locations = [loc('l1', 'Art'), loc('l2', 'Virtual Sports'), loc('l3', 'Archery Range')]

  it('binds an activity to the place the director already named the same thing', () => {
    const { bindings } = matchActivitiesToLocations(['Art', 'Virtual Sports'], locations)
    expect(bindings).toEqual([
      { activityName: 'Art', locationId: 'l1', locationName: 'Art' },
      { activityName: 'Virtual Sports', locationId: 'l2', locationName: 'Virtual Sports' },
    ])
  })

  it('ignores spacing and capitals, which are not a different place', () => {
    const { bindings } = matchActivitiesToLocations(['  virtual   sports '], locations)
    expect(bindings.map((b) => b.locationId)).toEqual(['l2'])
  })

  it('does NOT bind Slingshots to the Slingshot Range', () => {
    // The decisive case. "Slingshots is at the archery range, not the slingshot
    // range" — a name-based guess is backwards here, and reads plausibly enough
    // to be skimmed past in a review list.
    const withSlingshot = [...locations, loc('l4', 'Slingshot Range')]
    expect(matchActivitiesToLocations(['Slingshots'], withSlingshot).bindings).toEqual([])
  })

  it('does NOT treat "Room2" and "Room 2" as one place', () => {
    // Red Hat: whitespace-INSENSITIVE matching deletes spaces entirely, making
    // these one key. A doubled space between words is typing; a missing space
    // is a different name, and this module's premise is that two similar
    // strings are not one fact.
    expect(matchActivitiesToLocations(['Room2'], [loc('l8', 'Room 2')]).bindings).toEqual([])
    expect(matchActivitiesToLocations(['Room 2'], [loc('l8', 'Room2')]).bindings).toEqual([])
  })

  it('does NOT bind Art to an "Art Room" — a similar string is not the same name', () => {
    expect(matchActivitiesToLocations(['Art'], [loc('l9', 'Art Room')]).bindings).toEqual([])
  })

  it('does NOT bind Sports to anything, however many plausible places exist', () => {
    // "Usually outside on the field but could be in the gym" — genuinely
    // variable, so there is no answer to confirm.
    const places = [loc('l5', 'Field'), loc('l6', 'Gym'), loc('l7', 'Sports Field')]
    expect(matchActivitiesToLocations(['Sports'], places).bindings).toEqual([])
  })

  it('refuses to bind when two places share a name, and says so', () => {
    // "Two playgrounds not named differently" — a disambiguation question, not
    // an inference one. "You have two of these" and "you have none" need
    // different fixes and must not read the same.
    const dup = [loc('l1', 'Playground'), loc('l2', 'playground ')]
    const { bindings, ambiguous } = matchActivitiesToLocations(['Playground'], dup)
    expect(bindings).toEqual([])
    expect(ambiguous).toEqual(['Playground'])
  })

  it('leaves an activity the FILE already placed alone', () => {
    // A stated fact always beats a proposal. The file said where Archery is.
    const { bindings } = matchActivitiesToLocations(
      ['Art', 'Archery'], locations, { alreadyPlaced: ['Archery'] })
    expect(bindings.map((b) => b.activityName)).toEqual(['Art'])
  })

  it('never throws on degenerate input', () => {
    expect(matchActivitiesToLocations(null, null)).toEqual({ bindings: [], ambiguous: [] })
    expect(matchActivitiesToLocations([], [])).toEqual({ bindings: [], ambiguous: [] })
  })

  it('is deterministic and stably ordered', () => {
    const a = matchActivitiesToLocations(['Virtual Sports', 'Art'], locations)
    const b = matchActivitiesToLocations(['Virtual Sports', 'Art'], locations)
    expect(a).toEqual(b)
    // Activity order in, activity order out — the director reads the list they
    // gave us.
    expect(a.bindings.map((x) => x.activityName)).toEqual(['Virtual Sports', 'Art'])
  })
})

describe('candidatePlaceNames — typing saved, not a guess', () => {
  it('offers activity names the camp has no place for yet', () => {
    expect(candidatePlaceNames(['Art', 'Clay', 'Swim'], [loc('l1', 'Art')]))
      .toEqual(['Clay', 'Swim'])
  })

  it('does not re-offer a place that already exists under another spelling', () => {
    expect(candidatePlaceNames(['  art '], [loc('l1', 'Art')])).toEqual([])
  })

  it('offers Slingshots as a possible PLACE without claiming it is one', () => {
    // The tier distinction: ticking a place you do not use costs nothing;
    // asserting a binding costs a distorted schedule. So the name may be
    // offered here even though it must never be bound.
    expect(candidatePlaceNames(['Slingshots'], [])).toEqual(['Slingshots'])
  })

  it('de-duplicates and keeps the camp\'s own order', () => {
    expect(candidatePlaceNames(['Art', 'art', 'Clay'], [])).toEqual(['Art', 'Clay'])
  })

  it('never throws on degenerate input', () => {
    expect(candidatePlaceNames(null, null)).toEqual([])
    expect(candidatePlaceNames(['', '  '], [])).toEqual([])
  })
})
