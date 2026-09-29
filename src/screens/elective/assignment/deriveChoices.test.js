// T301 (docs/adr/2026-09-29-linked-elective-bundles.md D10) — expanding
// authored elective bundles into a run's per-tier linked choices and their
// member offerings. Pure, no IPC, no db — same discipline as
// deriveOccurrences.test.js, which this file mirrors.
import { describe, it, expect } from 'vitest'
import { deriveChoices } from './deriveChoices'
import {
  deriveLinkedElectiveChoiceId,
  deriveElectiveOccurrenceId,
  electiveChoiceLabelKey,
} from '../../../../electron/ops/electiveDerivedIds.js'

const RUN_ID = 'run-1'
const SET_ID = 'set-1'

function bundle(overrides = {}) {
  return {
    id: 'bundle-1',
    elective_set_id: SET_ID,
    activity_id: 'act-1',
    name: 'Woodworking',
    scope_mode: 'all',
    ...overrides,
  }
}

function occ(tierId, overrides = {}) {
  return {
    id: `occ-${tierId}-${Math.random()}`,
    elective_set_id: SET_ID,
    day_id: 'day-1',
    time_block_id: 'tb-1',
    tier_id: tierId,
    ...overrides,
  }
}

describe('deriveChoices', () => {
  // ADR test plan item 2, case 1: single-tier, one-member.
  it('expands a single-tier, single-member bundle into one choice and one choiceOffering', () => {
    const bundles = [bundle()]
    const bundlePeriods = [{ bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }]
    const occurrences = [occ('tier-1')]

    const { choices, choiceOfferings } = deriveChoices({ bundles, bundlePeriods, occurrences, runId: RUN_ID })

    const expectedChoiceId = deriveLinkedElectiveChoiceId(RUN_ID, 'bundle-1', 'tier-1')
    expect(choices).toHaveLength(1)
    expect(choices[0].id).toBe(expectedChoiceId)
    expect(choices[0].labelKey).toBe(electiveChoiceLabelKey('Woodworking'))
    expect(choices[0].is_linked).toBe(0)

    const expectedOccId = deriveElectiveOccurrenceId(RUN_ID, SET_ID, 'day-1', 'tb-1', 'tier-1')
    expect(choiceOfferings).toHaveLength(1)
    expect(choiceOfferings[0]).toMatchObject({
      choice_id: expectedChoiceId,
      occurrence_id: expectedOccId,
      activity_id: 'act-1',
    })
  })

  // T301 slice 3 (ADR D6) — commitElectiveRun needs to resolve "which of this
  // bundle's per-tier choices does THIS camper's tier map to" without
  // re-deriving the scope-resolution rule a second time (the exact duplicated-
  // logic trap D5 already warned against, one seam over). Carrying `tier_id`
  // on each choice is what lets it build a (labelKey, tierId) -> choiceId
  // lookup from this module's own output instead.
  it('carries tier_id on each derived choice, so a consumer can resolve by (labelKey, tier) without re-deriving scope', () => {
    const bundles = [bundle()]
    const bundlePeriods = [{ bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }]
    const occurrences = [occ('tier-1')]

    const { choices } = deriveChoices({ bundles, bundlePeriods, occurrences, runId: RUN_ID })

    expect(choices[0].tier_id).toBe('tier-1')
  })

  // ADR test plan item 2, case 2: multi-tier — same label, DISTINCT choice
  // ids (D3's whole reason for being: this is the collision D4/D3 exist to
  // avoid, at the derivation layer rather than the engine layer).
  it('expands a bundle spanning two tiers into two choices sharing a label but with DISTINCT ids', () => {
    const bundles = [bundle({ scope_mode: 'all' })]
    const bundlePeriods = [{ bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }]
    const occurrences = [occ('tier-1'), occ('tier-2')]

    const { choices } = deriveChoices({ bundles, bundlePeriods, occurrences, runId: RUN_ID })

    expect(choices).toHaveLength(2)
    const ids = choices.map((c) => c.id).sort()
    expect(ids).toEqual(
      [
        deriveLinkedElectiveChoiceId(RUN_ID, 'bundle-1', 'tier-1'),
        deriveLinkedElectiveChoiceId(RUN_ID, 'bundle-1', 'tier-2'),
      ].sort()
    )
    expect(new Set(ids).size).toBe(2)
    // Both share the bundle's one label — D6's precondition for a sheet
    // preference to match regardless of the camper's tier.
    expect(choices.every((c) => c.labelKey === electiveChoiceLabelKey('Woodworking'))).toBe(true)
  })

  // ADR test plan item 2, case 3: 'except' excludes the named tier.
  it("scope_mode 'except' resolves to every present tier EXCEPT the ones named", () => {
    const bundles = [bundle({ scope_mode: 'except' })]
    const bundlePeriods = [{ bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }]
    const bundleTiers = [{ bundle_id: 'bundle-1', tier_id: 'tier-2' }]
    const occurrences = [occ('tier-1'), occ('tier-2'), occ('tier-3')]

    const { choices } = deriveChoices({ bundles, bundlePeriods, bundleTiers, occurrences, runId: RUN_ID })

    const tierIdsFromChoiceIds = new Set(choices.map((c) => c.id))
    expect(tierIdsFromChoiceIds.has(deriveLinkedElectiveChoiceId(RUN_ID, 'bundle-1', 'tier-1'))).toBe(true)
    expect(tierIdsFromChoiceIds.has(deriveLinkedElectiveChoiceId(RUN_ID, 'bundle-1', 'tier-3'))).toBe(true)
    expect(tierIdsFromChoiceIds.has(deriveLinkedElectiveChoiceId(RUN_ID, 'bundle-1', 'tier-2'))).toBe(false)
    expect(choices).toHaveLength(2)
  })

  // The mirror image of the case above — 'only' resolves to EXACTLY the
  // named tier(s), not their complement. Included alongside 'except' because
  // a swapped only/except implementation would still pass an 'except'-only
  // suite (it would just be exercising the wrong mode's code path under the
  // right mode's name).
  it("scope_mode 'only' resolves to EXACTLY the named tier(s), not their complement", () => {
    const bundles = [bundle({ scope_mode: 'only' })]
    const bundlePeriods = [{ bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }]
    const bundleTiers = [{ bundle_id: 'bundle-1', tier_id: 'tier-2' }]
    const occurrences = [occ('tier-1'), occ('tier-2'), occ('tier-3')]

    const { choices } = deriveChoices({ bundles, bundlePeriods, bundleTiers, occurrences, runId: RUN_ID })

    expect(choices).toHaveLength(1)
    expect(choices[0].id).toBe(deriveLinkedElectiveChoiceId(RUN_ID, 'bundle-1', 'tier-2'))
  })

  // D2: 'only'/'except' resolve against tiers ACTUALLY PRESENT this run —
  // naming a tier with nothing scheduled must not manufacture a choice for
  // it (no finding, just silently absent).
  it("an 'only' tier not present in this run's occurrences manufactures no choice for it", () => {
    const bundles = [bundle({ scope_mode: 'only' })]
    const bundlePeriods = [{ bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }]
    const bundleTiers = [{ bundle_id: 'bundle-1', tier_id: 'tier-absent' }]
    const occurrences = [occ('tier-1')]

    const { choices } = deriveChoices({ bundles, bundlePeriods, bundleTiers, occurrences, runId: RUN_ID })
    expect(choices).toHaveLength(0)
  })

  // ADR test plan item 2, case 4: a member period with NO matching occurrence
  // this run STILL emits a choiceOffering (D5 — deriveChoices never
  // pre-filters; tier 1's existing UNSUPPORTED_LINKED_CHOICE case (a) is what
  // catches it, not a second exclusion mechanism here).
  it('still emits a choiceOffering for a member period with no matching occurrence this run', () => {
    const bundles = [bundle()]
    // day-2/tb-2 has NO occurrence in this run at all.
    const bundlePeriods = [{ bundle_id: 'bundle-1', day_id: 'day-2', time_block_id: 'tb-2' }]
    const occurrences = [occ('tier-1')] // day-1/tb-1, unrelated to the member period above

    const { choices, choiceOfferings } = deriveChoices({ bundles, bundlePeriods, occurrences, runId: RUN_ID })

    expect(choices).toHaveLength(1)
    const expectedChoiceId = choices[0].id
    const phantomOccId = deriveElectiveOccurrenceId(RUN_ID, SET_ID, 'day-2', 'tb-2', 'tier-1')
    expect(choiceOfferings).toHaveLength(1)
    expect(choiceOfferings[0].occurrence_id).toBe(phantomOccId)
    expect(choiceOfferings[0].choice_id).toBe(expectedChoiceId)
  })

  // ADR test plan item 2, case 5: duplicate period/tier rows (offline-
  // concurrent authoring, D1) produce IDENTICAL output to the deduplicated
  // input — dedupe is deriveChoices' own job, not a DB constraint.
  it('produces identical output whether bundlePeriods/bundleTiers carry duplicate rows or not', () => {
    const bundles = [bundle({ scope_mode: 'only' })]
    const bundleTiers = [{ bundle_id: 'bundle-1', tier_id: 'tier-1' }]
    const occurrences = [occ('tier-1')]

    const clean = deriveChoices({
      bundles,
      bundlePeriods: [{ bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }],
      bundleTiers,
      occurrences,
      runId: RUN_ID,
    })
    const duplicated = deriveChoices({
      bundles,
      bundlePeriods: [
        { bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' },
        { bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' },
      ],
      bundleTiers: [...bundleTiers, { bundle_id: 'bundle-1', tier_id: 'tier-1' }],
      occurrences,
      runId: RUN_ID,
    })

    expect(duplicated).toEqual(clean)
  })

  // THE BLIND SPOT the five cases above (copied straight from the ADR's own
  // test plan) structurally cannot see: every one of them has exactly ONE
  // elective_set_id in play, so an implementation that resolves tier scope
  // from ALL occurrences (forgetting the elective_set_id filter D2 requires
  // — "never the camp's full tier list") produces the IDENTICAL result to a
  // correct one on every case above. This is the actual planted defect: a
  // second elective set's occurrence supplies a tier this bundle's own set
  // has nothing scheduled in — an unfiltered implementation manufactures a
  // choice for it; a correct one does not.
  it("does not resolve tier scope from a DIFFERENT elective set's occurrences (the elective_set_id filter D2 requires)", () => {
    const bundles = [bundle({ elective_set_id: SET_ID })]
    const bundlePeriods = [{ bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }]
    const occurrences = [
      occ('tier-1', { elective_set_id: SET_ID }),
      // A different elective set's occurrence, naming a tier THIS bundle's
      // own set has nothing scheduled in.
      occ('tier-only-in-other-set', { elective_set_id: 'other-set' }),
    ]

    const { choices } = deriveChoices({ bundles, bundlePeriods, occurrences, runId: RUN_ID })

    expect(choices).toHaveLength(1)
    expect(choices[0].id).toBe(deriveLinkedElectiveChoiceId(RUN_ID, 'bundle-1', 'tier-1'))
  })

  it('returns empty rather than throwing on empty input', () => {
    expect(() => deriveChoices({})).not.toThrow()
    expect(deriveChoices({})).toEqual({ choices: [], choiceOfferings: [] })
  })

  // A bundle with no authored member periods yet is a legal, incomplete
  // authoring state — it derives to nothing rather than a choice with no
  // members (which tier 1 could never place into anyway).
  it('a bundle with no member periods derives no choice at all', () => {
    const bundles = [bundle()]
    const occurrences = [occ('tier-1')]
    const { choices, choiceOfferings } = deriveChoices({ bundles, bundlePeriods: [], occurrences, runId: RUN_ID })
    expect(choices).toEqual([])
    expect(choiceOfferings).toEqual([])
  })
})
