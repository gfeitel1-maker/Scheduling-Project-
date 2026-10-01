// @vitest-environment node
//
// Invariant tests for the T251/T265 per-cell elective preference fixture
// (test/fixtures/elective/t251-per-cell-preferences.json). This lives under
// test/, not src/engine/, because src/engine/fixtureSchemaParity.test.js scans
// ENGINE_DIR by name-matching variables like `slots`/`anchor` against
// `template_slots`/`fixed_events` columns only — it has no classification
// for elective fixtures, so a fixture site here would be an ACCIDENTAL
// COLLISION risk, not a covered case. See that file's header note and
// docs/adr/2026-09-26-per-cell-elective-preferences.md.
//
// STANDING REVIEW LENS. Each assertion below states, in its own comment, the
// SYSTEM-LEVEL question it is meant to answer and the narrower question the
// check actually asks, so a later reader does not assume they coincide.
import { describe, it, expect } from 'vitest'
import { loadT251Fixture } from './fixtures/elective/loadT251Fixture.js'
import { deriveElectivePreferenceId } from '../electron/ops/electiveDerivedIds.js'

describe('T251 per-cell elective preference fixture', () => {
  const fixture = loadT251Fixture()

  it('carries snake_case preference rows of shape {camper_id, occurrence_id, choice_id, rank}', () => {
    // SYSTEM predicate: every preference the fixture emits is directly
    // consumable as the ADR's row shape, with no labelKey escape hatch.
    // CHECK predicate: the exact key set of every row, no more no less.
    expect(fixture.preferences.length).toBeGreaterThan(0)
    for (const p of fixture.preferences) {
      expect(Object.keys(p).sort()).toEqual(['camper_id', 'choice_id', 'occurrence_id', 'rank'])
      expect(typeof p.camper_id).toBe('string')
      expect(typeof p.occurrence_id).toBe('string')
      expect(typeof p.choice_id).toBe('string')
      expect(typeof p.rank).toBe('number')
    }
  })

  it('scopes rank within a cell, not globally', () => {
    // SYSTEM predicate: a camper's rank-1 in one cell and rank-1 in another
    // are independent first choices (ADR Decision 1), never treated as a
    // contradiction. CHECK predicate: no (camper, occurrence) pair repeats a
    // rank value — this proves ranks are scoped per cell, but does NOT prove
    // the ranks were assigned in preference order (a fixture could satisfy
    // this by pure luck); that stronger claim is not tested here.
    const seen = new Map() // "camper|occurrence" -> Set(rank)
    for (const p of fixture.preferences) {
      const key = `${p.camper_id}|${p.occurrence_id}`
      if (!seen.has(key)) seen.set(key, new Set())
      const ranks = seen.get(key)
      expect(ranks.has(p.rank)).toBe(false)
      ranks.add(p.rank)
    }
  })

  it('has 18 selectable occurrences out of the 5x7 grid, per the real artifact structure', () => {
    // SYSTEM predicate: the fixture models the artifact's actual selectable
    // surface, not a simplified stand-in. CHECK predicate: occurrence count
    // only — it cannot see whether day/period labels are sensible, only that
    // there are 18 of them.
    expect(fixture.occurrences.length).toBe(18)
  })

  it('gives every offering a choice_id, and some choices span more than one occurrence', () => {
    // SYSTEM predicate: linkage is expressible and actually expressed by at
    // least one camper (the defect the withdrawn draft had: linkage existed on
    // the catalog but no preference ever named it). CHECK predicate: (a) every
    // offering resolves to a real choice, (b) at least one choice has >1
    // member occurrence, (c) at least one PREFERENCE names such a choice. (a)
    // and (b) alone would pass even if linkage were still decorative — (c) is
    // the one that actually catches that defect shape.
    const choiceIds = new Set(fixture.choices.map((c) => c.id))
    for (const o of fixture.offerings) expect(choiceIds.has(o.choice_id)).toBe(true)

    const membersByChoice = new Map()
    for (const co of fixture.choiceOfferings) {
      if (!membersByChoice.has(co.choice_id)) membersByChoice.set(co.choice_id, new Set())
      membersByChoice.get(co.choice_id).add(co.occurrence_id)
    }
    const linkedChoiceIds = new Set(
      [...membersByChoice.entries()].filter(([, occs]) => occs.size > 1).map(([id]) => id)
    )
    expect(linkedChoiceIds.size).toBeGreaterThan(0)
    const preferencesNamingLinkedChoice = fixture.preferences.filter((p) => linkedChoiceIds.has(p.choice_id))
    expect(preferencesNamingLinkedChoice.length).toBeGreaterThan(0)
  })

  it('produces genuine zero-preference camper-cells, not just short lists of 1-2', () => {
    // SYSTEM predicate: the ADR's "not every camper needs a placement in every
    // occurrence" case must be reachable, because that is exactly what feeds
    // the measurement script's exclusion bucket — if this is vacuous, the
    // exclusion count in measure-elective-cell-loss.mjs is silently always
    // zero and validates nothing. CHECK predicate: at least one (camper,
    // occurrence) pair among all campers x all occurrences has NO preference
    // row at all. This is the fixture-side half of the STANDING REVIEW LENS
    // item the brief calls out by name.
    const withPrefs = new Set(fixture.preferences.map((p) => `${p.camper_id}|${p.occurrence_id}`))
    let zeroCount = 0
    for (const c of fixture.campers) {
      for (const occ of fixture.occurrences) {
        if (!withPrefs.has(`${c.id}|${occ.id}`)) zeroCount++
      }
    }
    expect(zeroCount).toBeGreaterThan(0)
  })

  it('carries no capacity inflated by a seat-supply top-up — every offering capacity is a declared CATALOG/linkage value', async () => {
    // SYSTEM predicate: this fixture's capacities are the ones the generator's
    // CATALOG/DOUBLE_PERIODS/MULTI_DAY tables actually declare, never a value
    // silently patched to satisfy the seat-supply guard (round-2 review
    // finding: a top-up mechanism made checkSeatSupply's success condition
    // diverge from the system's — a future change to CAMPER_COUNT or CATALOG
    // could inflate a capacity and distort fidelity while the guard stayed
    // green). CHECK predicate: every committed offering's capacity is a value
    // present in one of the three declared tables — narrower than "correctly
    // attributed to the right activity", but catches any capacity the
    // generator computed rather than copied verbatim.
    const { CATALOG, DOUBLE_PERIODS, MULTI_DAY } = await import('../scripts/fixtures/make-elective-cell-fixture.mjs')
    const declaredCapacities = new Set([
      ...CATALOG.map((a) => a.cap),
      ...DOUBLE_PERIODS.map((dp) => dp.cap),
      ...MULTI_DAY.map((md) => md.cap),
    ])
    expect(fixture.offerings.length).toBeGreaterThan(0)
    for (const o of fixture.offerings) {
      expect(declaredCapacities.has(o.capacity)).toBe(true)
    }
  })

  it('names campers unmistakably as synthetic', () => {
    // SYSTEM predicate: no row in a committed, PII-adjacent fixture could be
    // mistaken for a real child's name. CHECK predicate: every camper name
    // matches the literal synthetic-naming pattern this generator uses — a
    // narrower, mechanical stand-in for the actual human judgment "does this
    // look fabricated," which no automated check can make.
    expect(fixture.campers.length).toBeGreaterThan(0)
    for (const c of fixture.campers) {
      expect(c.name).toMatch(/^Synthetic Camper \d+$/)
    }
  })

  it('proves the collision this fixture used to demonstrate can no longer occur: deriveElectivePreferenceId now keys on occurrence_id too', () => {
    // SYSTEM predicate: T265 (v78, docs/adr/2026-09-26-per-cell-elective-
    // preferences.md) closed the exact schema gap this fixture was built to
    // scope (round-2 review, Red Hat). `deriveElectivePreferenceId(run_id,
    // camper_id, occurrence_id, choice_id)` (electron/ops/
    // electiveDerivedIds.js) now keys on occurrence_id as well, so a linked
    // choice's multiple member occurrences (e.g. `choice-coding-tue` spans
    // occ-tue-p6 and occ-tue-p7) each derive a DISTINCT id for the same
    // camper+choice. CHECK predicate: derive an id for every one of the
    // fixture's preference rows and assert they are ALL DISTINCT — 177
    // (run_id, camper_id, choice_id) pairs and 429 rows among them were
    // measured (round-2 review) to collide under the OLD 3-tuple id; this
    // re-derives every one of those exact rows and shows none of the 429
    // collide any more, alongside every other row in the fixture.
    const membersByChoice = new Map()
    for (const co of fixture.choiceOfferings) {
      if (!membersByChoice.has(co.choice_id)) membersByChoice.set(co.choice_id, new Set())
      membersByChoice.get(co.choice_id).add(co.occurrence_id)
    }
    const linkedChoiceIds = new Set(
      [...membersByChoice.entries()].filter(([, occs]) => occs.size > 1).map(([id]) => id)
    )

    const occurrencesByPair = new Map() // "camper_id|choice_id" -> Set(occurrence_id)
    for (const p of fixture.preferences) {
      const key = `${p.camper_id}|${p.choice_id}`
      if (!occurrencesByPair.has(key)) occurrencesByPair.set(key, new Set())
      occurrencesByPair.get(key).add(p.occurrence_id)
    }

    let previouslyCollidingPairs = 0
    let previouslyCollidingNonLinkedPairs = 0
    let previouslyCollidingRows = 0
    for (const [key, occs] of occurrencesByPair) {
      if (occs.size > 1) {
        previouslyCollidingPairs++
        previouslyCollidingRows += occs.size
        const choiceId = key.split('|')[1]
        if (!linkedChoiceIds.has(choiceId)) previouslyCollidingNonLinkedPairs++
      }
    }

    // The measured, committed evidence this test moves from demonstrating
    // loss to proving no loss — unchanged from the withdrawn-collision test.
    expect(previouslyCollidingPairs).toBe(177)
    expect(previouslyCollidingNonLinkedPairs).toBe(0)
    // NOTE: the brief that scoped this ticket cited 354 rows spanning the 177
    // colliding pairs; re-measuring against the committed fixture here finds
    // 429 (139 pairs spanning 2 occurrences, 1 spanning 3, 37 spanning 4).
    // Reported rather than forced to match — see the task's final report.
    expect(previouslyCollidingRows).toBe(429)

    // THE ACTUAL PROOF: every preference row in the fixture — not just the
    // previously-colliding ones — now derives a distinct id, run-scoped by a
    // single fixed runId (the fixture carries no run_id of its own; any fixed
    // value proves the same thing since every derivation below shares it).
    const RUN_ID = 'run-t251-fixture'
    const ids = fixture.preferences.map((p) =>
      deriveElectivePreferenceId(RUN_ID, p.camper_id, p.occurrence_id, p.choice_id)
    )
    expect(ids.length).toBe(fixture.preferences.length)
    expect(new Set(ids).size).toBe(ids.length)

    // Specifically exercise the 429 previously-colliding rows: re-derive just
    // those and confirm they are ALSO all distinct from one another (a subset
    // of the whole-fixture distinctness above, called out because it is the
    // exact defect this fixture exists to scope).
    const previouslyCollidingIds = fixture.preferences
      .filter((p) => occurrencesByPair.get(`${p.camper_id}|${p.choice_id}`).size > 1)
      .map((p) => deriveElectivePreferenceId(RUN_ID, p.camper_id, p.occurrence_id, p.choice_id))
    expect(previouslyCollidingIds.length).toBe(429)
    expect(new Set(previouslyCollidingIds).size).toBe(429)
  })

  it('regenerates byte-identically (documents the determinism this suite depends on)', async () => {
    // SYSTEM predicate: the committed fixture is reproducible from the
    // generator, so a diff in either one is a real, reviewable change. CHECK
        // predicate: re-running generate() in-process matches the committed JSON's
    // own JSON.stringify(..., null, 2) serialization exactly. This does not
    // re-run the CLI path (fs.writeFileSync) — that was verified once by hand
    // (two `node` invocations, checksums compared) per the task's success
    // predicate, and is not re-asserted on every test run because it would
    // just be re-testing fs, not this generator's determinism.
    const { generate } = await import('../scripts/fixtures/make-elective-cell-fixture.mjs')
    const regenerated = JSON.stringify(generate(), null, 2) + '\n'
    const committed = await import('node:fs').then((fs) => fs.readFileSync(new URL('./fixtures/elective/t251-per-cell-preferences.json', import.meta.url), 'utf8'))
    expect(regenerated).toBe(committed)
  })
})

describe('T251 fixture invariants — planted-defect check (synthetic inputs, not the committed fixture)', () => {
  // Per feedback_plant_the_defect_the_guard_cannot_see: a passing invariant
  // test proves little unless it can be shown failing against the defect it
  // claims to catch. These re-run the SAME assertions above against small
  // synthetic inputs built to carry exactly the withdrawn draft's defects.
  //
  // WHAT THIS CANNOT SEE, stated rather than left implicit: these are shape
  // checks against hand-built objects, not against a re-run of the real
  // generator with a bug reintroduced — so they prove the assertions can fail
  // for the RIGHT reason, not that this specific generator is bug-free on
  // every path. Structural/statistical defects (e.g. a generator that produces
  // zero-pref cells too rarely to matter) are outside what a boolean
  // "greaterThan(0)" check can ever distinguish from "barely happened once".

  it('rejects a labelKey-only preference row (defect #4 shape)', () => {
    const bad = { camper_id: 'c1', occurrence_id: 'occ-mon-p3', labelKey: 'Archery', rank: 1 }
    expect(Object.keys(bad).sort()).not.toEqual(['camper_id', 'choice_id', 'occurrence_id', 'rank'])
  })

  it('catches a linked choice that no preference ever names (defect #3 shape)', () => {
    const choiceOfferings = [
      { choice_id: 'choice-coding-tue', occurrence_id: 'occ-tue-p6' },
      { choice_id: 'choice-coding-tue', occurrence_id: 'occ-tue-p7' },
    ]
    const preferences = [] // decorative linkage: nobody ever ranks it
    const membersByChoice = new Map()
    for (const co of choiceOfferings) {
      if (!membersByChoice.has(co.choice_id)) membersByChoice.set(co.choice_id, new Set())
      membersByChoice.get(co.choice_id).add(co.occurrence_id)
    }
    const linkedChoiceIds = new Set([...membersByChoice.entries()].filter(([, occs]) => occs.size > 1).map(([id]) => id))
    expect(linkedChoiceIds.size).toBeGreaterThan(0) // linkage exists...
    const preferencesNamingLinkedChoice = preferences.filter((p) => linkedChoiceIds.has(p.choice_id))
    expect(preferencesNamingLinkedChoice.length).toBe(0) // ...but this is the failing shape the real assertion (toBeGreaterThan(0)) catches
  })

  it('catches a short-list branch that never reaches zero (defect #2 shape)', () => {
    const campers = [{ id: 'c1' }]
    const occurrences = [{ id: 'occ-mon-p3' }]
    // withdrawn draft's shape: "want" is always 1 or more, never 0
    const preferences = [{ camper_id: 'c1', occurrence_id: 'occ-mon-p3', choice_id: 'choice-x', rank: 1 }]
    const withPrefs = new Set(preferences.map((p) => `${p.camper_id}|${p.occurrence_id}`))
    let zeroCount = 0
    for (const c of campers) for (const occ of occurrences) if (!withPrefs.has(`${c.id}|${occ.id}`)) zeroCount++
    expect(zeroCount).toBe(0) // the real assertion (toBeGreaterThan(0)) would fail against this input — confirmed here, not asserted as a pass
  })
})
