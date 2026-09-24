import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities'
import { inferFixedEvents } from './fixedEvents'
import { buildPlan } from './buildPlan'
import { buildReconciliationReport } from './reconciliationReport'
import { applyResolutions } from '../screens/reconciliationResolutions'

// T141 — docs/work/tickets/T141-fixed-event-eligibility-ignores-group-coverage.md
//
// Arm 2 of the eligibility rule: an event that recurs on a FIXED SUBSET of
// weekdays is pinned by group-coverage, not day-coverage. Modelled on the
// owner's real file (Schedule by Group.xlsx): All Camp Activity holds
// 02:25-03:15 on Tue+Thu in all 14 sheets, Shabbat holds the same block on
// Friday, Ruach holds 01:40-02:20 on Friday. All three are 1-2 days of 5 and
// were therefore dropped outright by the day-majority gate.
//
// Fabricated camp {A, B, C}, Monday-Friday:
//   - Mifkad            @ 09:00 A,B,C every day     -> arm 1 (unchanged), HIGH, fixed
//   - All Camp Activity @ 14:00 A,B,C Tue,Thu       -> arm 2, 3/3 groups, HIGH, fixed
//   - Shabbat           @ 14:00 A,B,C Fri           -> arm 2, same block, different
//                                                      day-set -> its own event
//   - Ruach             @ 15:00 A,B   Fri           -> arm 2, 2/3 groups, LOW, recurring
//   - Clay              @ 16:00 A     Tue           -> 1/3 groups -> DROPPED
//   - Swim              @ 17:00 A Tue / 18:00 B Tue -> not block-invariant -> DROPPED
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const row = (label, cells) => ({ label, cells })

// day-keyed cell helper: '' everywhere except the named days.
const on = (days, value) => DAYS.map((d) => (days.includes(d) ? value : ''))

function orientationA() {
  return {
    pages: [
      {
        title: 'A',
        columns: DAYS,
        rows: [
          row('09:00-09:30', on(DAYS, 'Mifkad')),
          row('14:00-14:30', DAYS.map((d) =>
            d === 'Tuesday' || d === 'Thursday' ? 'All Camp Activity' : d === 'Friday' ? 'Shabbat' : '')),
          row('15:00-15:30', on(['Friday'], 'Ruach')),
          row('16:00-16:30', on(['Tuesday'], 'Clay')),
          row('17:00-17:30', on(['Tuesday'], 'Swim')),
        ],
      },
      {
        title: 'B',
        columns: DAYS,
        rows: [
          row('09:00-09:30', on(DAYS, 'Mifkad')),
          row('14:00-14:30', DAYS.map((d) =>
            d === 'Tuesday' || d === 'Thursday' ? 'All Camp Activity' : d === 'Friday' ? 'Shabbat' : '')),
          row('15:00-15:30', on(['Friday'], 'Ruach')),
          row('18:00-18:30', on(['Tuesday'], 'Swim')),
        ],
      },
      {
        title: 'C',
        columns: DAYS,
        rows: [
          row('09:00-09:30', on(DAYS, 'Mifkad')),
          row('14:00-14:30', DAYS.map((d) =>
            d === 'Tuesday' || d === 'Thursday' ? 'All Camp Activity' : d === 'Friday' ? 'Shabbat' : '')),
        ],
      },
    ],
  }
}

// The exact transpose: one page per day, groups as columns.
function orientationB() {
  const GROUPS = ['A', 'B', 'C']
  const a = orientationA()
  const blocks = [...new Set(a.pages.flatMap((p) => p.rows.map((r) => r.label)))]
  return {
    pages: DAYS.map((day) => ({
      title: day,
      columns: GROUPS,
      rows: blocks.map((block) => row(block, GROUPS.map((g) => {
        const page = a.pages.find((p) => p.title === g)
        const r = page.rows.find((rr) => rr.label === block)
        return r ? r.cells[DAYS.indexOf(day)] : ''
      }))),
    })),
  }
}

describe('inferFixedEvents — arm 2, weekly recurrence by group coverage (T141)', () => {
  const parsed = orientationA()
  const proposal = extractEntities(parsed)
  const { fixedEvents } = inferFixedEvents(parsed, proposal)
  const find = (name, block) => fixedEvents.find((e) => e.name === name && e.time_block === block)

  it('proposes an all-groups two-day event that no group holds a majority of days', () => {
    const aca = find('All Camp Activity', '14:00-14:30')
    expect(aca).toBeTruthy()
    expect(aca.days).toEqual(['Tuesday', 'Thursday'])
    expect(aca.scope).toEqual({ is_all_groups: true, groups: null })
    expect(aca.kind).toBe('fixed')
    expect(aca.confidence).toBe('high')
  })

  it('proposes a single-day all-groups event', () => {
    const shabbat = find('Shabbat', '14:00-14:30')
    expect(shabbat).toBeTruthy()
    expect(shabbat.days).toEqual(['Friday'])
    expect(shabbat.scope).toEqual({ is_all_groups: true, groups: null })
    expect(shabbat.confidence).toBe('high')
  })

  it('keeps two different day-sets in the same block as separate events', () => {
    expect(find('All Camp Activity', '14:00-14:30').days).toEqual(['Tuesday', 'Thursday'])
    expect(find('Shabbat', '14:00-14:30').days).toEqual(['Friday'])
  })

  it('proposes a two-thirds-coverage event as low confidence, scoped to its groups', () => {
    const ruach = find('Ruach', '15:00-15:30')
    expect(ruach).toBeTruthy()
    expect(ruach.confidence).toBe('low')
    expect(ruach.kind).toBe('recurring')
    expect(ruach.scope).toEqual({ is_all_groups: false, groups: ['A', 'B'] })
  })

  it('drops a one-group single-day occurrence', () => {
    expect(find('Clay', '16:00-16:30')).toBeUndefined()
  })

  it('drops an activity that is not block-invariant across groups', () => {
    expect(find('Swim', '17:00-17:30')).toBeUndefined()
    expect(find('Swim', '18:00-18:30')).toBeUndefined()
  })

  it('marks why each event was admitted', () => {
    expect(find('Mifkad', '09:00-09:30').support.basis).toBe('daily')
    expect(find('All Camp Activity', '14:00-14:30').support.basis).toBe('weekly')
  })

  it('holds the transpose invariant', () => {
    const bParsed = orientationB()
    const bProposal = extractEntities(bParsed)
    const b = inferFixedEvents(bParsed, bProposal).fixedEvents
    expect(bProposal.orientation.columns).toBe('groups')
    expect(b).toEqual(fixedEvents)
  })
})

// T234 — the owner's live bug: "things that are recurring events are also
// being pulled as activities when they should not." Ruach is exactly this
// shape — kind:'recurring', confidence:'low', dualUseNames: [] (it never
// occurs outside its own event footprint). Root cause (ADR 2026-08-09
// Decision 1 / T234 fix, ImportScreen.jsx): the pinOnlyActivityNames guard
// used to be seeded from autoAccepts(fe.confidence) (HIGH only), so a
// recurring event — which the fixedEvents formula can readily produce at
// LOW confidence via arm 2's group-coverage math — could never reach the
// guard and would mint straight into the activity catalog at tier:'new'
// whenever its raw name-frequency happened to look high (which Ruach's
// does: it occurs twice, and createConfidenceTier's own frequency
// threshold is >=2).
describe('T234 — recurring events must not silently mint as activities (owner regression)', () => {
  const parsed = orientationA()
  const proposal = extractEntities(parsed)
  const { fixedEvents: inferred, dualUseNames: dualUseNamesRaw } = inferFixedEvents(parsed, proposal)

  it('reproduces the exact shape: Ruach is recurring, low-confidence, and not dual-use', () => {
    const ruach = inferred.find((e) => e.name === 'Ruach')
    expect(ruach.kind).toBe('recurring')
    expect(ruach.confidence).toBe('low')
    expect(dualUseNamesRaw).not.toContain('Ruach')
  })

  it('without the guard, Ruach would mint at tier "new" (proves the guard is load-bearing, not redundant with createConfidenceTier)', () => {
    const plan = buildPlan(
      { approved: { activities: ['Ruach'] }, camp_id: 'camp-1', seenCounts: proposal.seenCounts },
      null,
    )
    expect(plan.items[0].evidence.tier).toBe('new')
  })

  it('with the fixed guard (every inferred name minus dual-use, confidence-independent), Ruach is forced to tier "low" — never a silent mint, always an explicit director decision', () => {
    const dualUseSet = new Set(dualUseNamesRaw)
    const eventNonDualUseNames = [...new Set(inferred.map((fe) => fe.name).filter((n) => !dualUseSet.has(n)))]
    const plan = buildPlan(
      {
        approved: { activities: ['Ruach'] },
        camp_id: 'camp-1',
        seenCounts: proposal.seenCounts,
        pinOnlyActivityNames: eventNonDualUseNames,
      },
      null,
    )
    expect(plan.items[0].evidence.tier).toBe('low')
  })
})

// T234 non-vacuity — the guard excludes by FOOTPRINT (dual-use), not by
// kind/confidence. A name whose occurrences are fully covered by the UNION
// of its confirmed FIXED-kind footprint and its confirmed RECURRING-kind
// footprint must NOT be flagged dual-use, even though neither kind covers
// its occurrences alone — proving footprintByActivity accumulates across
// BOTH passes into one Set rather than testing each kind independently
// (the property behind the owner's "ordered passes" request; swapping the
// fixed/recurring pass order cannot change this result, since Set union
// commutes — see fixedEvents.js's footprint-accumulation loop).
describe('T234 — dual-use test unions FIXED and RECURRING footprints for the same name', () => {
  const row = (label, cells) => ({ label, cells })
  const GROUPS3 = ['A', 'B', 'C']
  // Combo: all 3 groups every day at 10:00 (-> kind:'fixed', all-groups
  // footprint) AND groups A,B only on Friday at 14:00 (-> kind:'recurring',
  // A/B footprint). No occurrence of "Combo" exists anywhere outside those
  // two confirmed events.
  const parsed = {
    pages: GROUPS3.map((g) => ({
      title: g,
      columns: DAYS,
      rows: [
        row('10:00-10:30', on(DAYS, 'Combo')),
        ...(g === 'A' || g === 'B' ? [row('14:00-14:30', on(['Friday'], 'Combo'))] : []),
      ],
    })),
  }
  const proposal = extractEntities(parsed)
  const { fixedEvents: inferred, dualUseNames } = inferFixedEvents(parsed, proposal)

  it('confirms both a fixed and a recurring event exist for the same name', () => {
    expect(inferred.find((e) => e.name === 'Combo' && e.kind === 'fixed')).toBeTruthy()
    expect(inferred.find((e) => e.name === 'Combo' && e.kind === 'recurring')).toBeTruthy()
  })

  it('is NOT dual-use: every raw occurrence is covered by the union of both footprints', () => {
    expect(dualUseNames).not.toContain('Combo')
  })
})

// T234 round 2 (Red Hat) — the prior "tier:'low' means never a silent mint"
// claim was established by TRACING buildPlan's tier assignment, not by
// EXECUTING the rest of the chain a low-confidence create actually travels
// through end to end: buildPlan -> reconciliationReport.classifyItem (which
// turns tier:'low' into a needsAttention/confirm_value decision) ->
// reconciliationResolutions.applyResolutions (which holds back any
// confirm_value the director never resolved). Nothing upstream of this test
// executes applyResolutions, so the load-bearing claim — that an
// unconfirmed low-confidence recurring-event name never reaches the
// `approved` list applyResolutions hands to commitIngest's create path —
// was never actually run. This runs the real functions, no mocks, on the
// owner's own Ruach fixture.
describe('T234 round 2 — the tier:"low" hold executed end to end (buildPlan -> reconciliationReport -> applyResolutions)', () => {
  const parsed = orientationA()
  const proposal = extractEntities(parsed)
  const { fixedEvents: inferred, dualUseNames: dualUseNamesRaw } = inferFixedEvents(parsed, proposal)
  const dualUseSet = new Set(dualUseNamesRaw)
  const pinOnlyActivityNames = [...new Set(inferred.map((fe) => fe.name).filter((n) => !dualUseSet.has(n)))]

  function runChain(answers) {
    const source = {
      approved: { activities: ['Ruach'] },
      camp_id: 'camp-1',
      seenCounts: proposal.seenCounts,
      pinOnlyActivityNames,
    }
    const plan = buildPlan(source, null)
    const report = buildReconciliationReport({ planItems: plan.items })
    const { approved } = applyResolutions({
      approved: source.approved,
      decisions: report.decisions,
      answers,
      fixedEvents: plan.fixedEvents,
    })
    return { plan, report, approved }
  }

  it('holds the name back: with no director resolution, Ruach is ABSENT from the approved list applyResolutions hands to commitIngest', () => {
    const { plan, report, approved } = runChain({})
    expect(plan.items[0].evidence.tier).toBe('low')
    const decision = report.decisions.find((d) => d.entity === 'activities' && d.entityName === 'Ruach')
    expect(decision).toBeTruthy()
    expect(decision.kind).toBe('confirm_value')
    expect(approved.activities).not.toContain('Ruach')
  })

  it('non-vacuity (positive control): with the director explicitly confirming the decision, Ruach DOES survive into approved — proving absence above is the hold-back, not an unrelated reason the name was never there', () => {
    const { report, approved } = runChain(undefined)
    const decision = report.decisions.find((d) => d.entity === 'activities' && d.entityName === 'Ruach')
    const resolved = runChain({ [decision.id]: { action: 'looks_right' } }).approved
    expect(resolved.activities).toContain('Ruach')
    // and the unresolved run really did differ from the resolved one
    expect(approved.activities).not.toContain('Ruach')
  })
})
