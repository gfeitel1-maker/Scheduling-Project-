// T302 — nothing stops the NEXT elective finding from printing a label key.
//
// T300 fixed the four findings that were wrong and the render they share. This
// guards the seam it could not: AUTHORING a finding. `findingDisplayMessage`
// substitutes a label key for a display name by anchoring on the QUOTES the
// producers put around labels, so a producer that interpolates a key without
// quoting it is invisible to the substitution and the key reaches a director's
// screen. Nothing else catches that — no ESLint rule, no type system, and (before
// this file) no test beyond the four kinds T300 covered.
//
// HOW IT WORKS, and why it is this shape rather than a list of cases.
//
// The kinds are read OUT OF THE PRODUCER SOURCE, not hand-listed here. A new
// `kind:` literal in either producer is discovered on the next run and fails this
// file until someone adds a fixture for it. That is the whole point: the previous
// state of the world was a hand-maintained set of four, and the fifth author had
// nothing to trip over. Same shape as electron/ops/mergeActivity.test.js, which
// reads referrer columns out of the schema rather than trusting a second list,
// and checks BOTH directions so a stale entry cannot hide a real gap behind a
// passing test.
//
// Each kind then declares whether its message MAY name an activity, and the
// declaration is proved rather than trusted:
//
//   namesActivity: true   the rendered message must contain the activity's
//                         display name AND must not contain its label key.
//   namesActivity: false  the produced message must not contain the label key
//                         at all. Without this half, the table would be an
//                         escape hatch — a future author could silence a real
//                         label-key bug by declaring the kind label-free, and
//                         the assertion above would never run on it.
//
// And every fixture must actually EMIT its kind. A fixture that quietly stopped
// triggering would make its assertion vacuous — which is exactly how T300's first
// guard survived its own planted defect. A kind whose fixture produces nothing is
// reported by name, never skipped.
//
// PROVEN NON-VACUOUS, 2026-09-29, by three plants rather than one — the ticket's
// three failure modes, each restored afterwards. The shapes, so the next author
// can re-run them:
//
//   1. A kind DECLARED label-free starts carrying a key, unquoted. Added
//      `(${here[0].labelKey})` to NO_CAPACITY's message. Red on NO_CAPACITY
//      ALONE. This is the plant that matters most: it is the one a reader would
//      expect the table to hide, and the reason `namesActivity: false` is proved
//      rather than believed.
//   2. An existing producer stops quoting its label. Removed the curly quotes
//      around BELOW_MINIMUM's `labelKey`. Red with the key and the remedy in the
//      failure message: 'expected "arts&crafts had 4 of the 5 campers it…" not to
//      contain "arts&crafts"'.
//   3. A brand-new kind appears. Renamed `UNRANKED_OFFERING` to
//      `BRAND_NEW_FINDING` in findMismatches. Red TWICE and both were right — the
//      divergence check named the new kind and its file, and UNRANKED_OFFERING's
//      own test failed because its fixture no longer emitted it, which is the
//      stopped-triggering guard doing its job.
//
// ── WHAT THIS GUARD STRUCTURALLY CANNOT SEE ─────────────────────────────────
// Read this before trusting it. An accurately described narrow guard is fine; a
// narrow guard described broadly is the defect this file exists to prevent.
//
// 1. A KEY REACHED WITHOUT A `kind:` LITERAL. The enumeration is a text scan for
//    `kind: 'X'` in the two producer files. A kind passed as a variable, built by
//    concatenation, or emitted from a third module is not discovered. This is the
//    text-level blind spot the ticket named for approach (c), inherited here by
//    the enumeration step only — the assertions themselves run against real
//    producer output, not text.
// 2. A PRODUCER OUTSIDE THESE TWO FILES. `AssignmentPanel.jsx` composes the rail
//    from five sources, and only two are scanned here. The other three are out of
//    scope on purpose, and the reason is not convenience:
//      - UNMATCHED_DIVISION / AMBIGUOUS_DIVISION (inline in AssignmentPanel.jsx)
//        quote a DIVISION value off the sheet, never an activity label key, and
//        are deliberately shown as the sheet spells them.
//      - the coordinate residue (resolvePreferenceCoordinates.js) names day and
//        period labels; that file contains no `labelKey` at all.
//      - deriveOccurrences' INCOMPLETE_PLACEMENT / UNTIERED_GROUP never reach
//        this rail — AssignmentPanel destructures only `.templates` from it.
//    If any of those ever carries an activity label, this file will NOT notice.
// 3. THE RENDER WIRING. These assertions call `findingDisplayMessage` directly.
//    If `AssignmentPreview.jsx` stopped calling it, every test here would still
//    pass. That wiring is pinned separately, for four kinds, by the render tests
//    in AssignmentPreview.test.jsx — which drive the real producers for exactly
//    that reason. Do not delete those on the grounds that this file exists.
// 4. WORDING. Nothing here asserts a sentence is well written, only that it does
//    not contain an identity key. A finding can be unreadable and pass.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { buildElectiveAssignments } from '../../../engine/buildElectiveAssignments.js'
import { findMismatches, findBlankCapacities } from './buildOfferings.js'
import { findingDisplayMessage } from './findingDisplayMessage.js'
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'

// The two producers the ticket's archive_when names, and — verified 2026-09-29 —
// the only two that emit a finding whose message can carry an ACTIVITY label key.
const PRODUCERS = [
  'src/engine/buildElectiveAssignments.js',
  'src/screens/elective/assignment/buildOfferings.js',
]

// A name whose label key is NOT the name, in three ways at once: case, the
// deleted whitespace, and a character that is legal in a name. `arts&crafts` is
// unmistakable in a sentence, so an assertion about it cannot pass by accident.
const ARTS = { id: 'a-arts', name: 'Arts & Crafts' }
const SWIM = { id: 'a-swim', name: 'Swim' }
// Derived, never hand-spelled, so this file cannot drift from the canonicaliser
// it is about.
const ARTS_KEY = electiveChoiceLabelKey(ARTS.name)
const SWIM_KEY = electiveChoiceLabelKey(SWIM.name)
const ACTIVITIES = [ARTS, SWIM]

const camper = (id) => ({ id, display_name: id.toUpperCase() })
const offering = (extra) => ({ occurrence_id: 'occ-1', capacity: 10, minimum: null, ...extra })
const artsOffering = (extra) => offering({ labelKey: ARTS_KEY, activity_id: ARTS.id, ...extra })

const solve = (args) => buildElectiveAssignments({ occurrences: [{ id: 'occ-1' }], ...args })

// Every kind, with a fixture that drives the REAL producer and a declaration of
// whether its message may name an activity. Keyed by the same string the producer
// emits, so the divergence check below compares like with like.
const FIXTURES = {
  // ── src/engine/buildElectiveAssignments.js ────────────────────────────────
  // Nothing offered in the period. Names the period, not an activity.
  NO_OFFERINGS: {
    namesActivity: false,
    produce: () => solve({ campers: [camper('c1')], offerings: [], preferences: [] }),
  },
  // Nobody eligible. Names the division mismatch, not an activity.
  NO_CAMPERS: {
    namesActivity: false,
    produce: () => solve({ campers: [], offerings: [artsOffering()], preferences: [] }),
  },
  // An offering that missed its minimum and came off. NAMES THE OFFERING.
  BELOW_MINIMUM: {
    namesActivity: true,
    produce: () => {
      const four = ['c1', 'c2', 'c3', 'c4'].map(camper)
      return solve({
        campers: four,
        offerings: [artsOffering({ minimum: 5 }), offering({ labelKey: SWIM_KEY, activity_id: SWIM.id })],
        preferences: four.flatMap((c) => [
          { camper_id: c.id, labelKey: ARTS_KEY, rank: 1 },
          { camper_id: c.id, labelKey: SWIM_KEY, rank: 2 },
        ]),
      })
    },
  },
  // Under its minimum but kept, because a director locked a seat in it. NAMES IT.
  KEPT_BELOW_MINIMUM: {
    namesActivity: true,
    produce: () => solve({
      campers: [camper('c1'), camper('c2')],
      offerings: [artsOffering({ minimum: 5 }), offering({ labelKey: SWIM_KEY, activity_id: SWIM.id })],
      lockedAssignments: [{ camperId: 'c2', occurrenceId: 'occ-1', activityId: ARTS.id }],
      preferences: [
        { camper_id: 'c1', labelKey: ARTS_KEY, rank: 1 },
        { camper_id: 'c1', labelKey: SWIM_KEY, rank: 2 },
      ],
    }),
  },
  // Nowhere left after a cancellation. Counts campers; names no activity.
  UNPLACED_AFTER_DECLINE: {
    namesActivity: false,
    produce: () => {
      const two = [camper('c1'), camper('c2')]
      return solve({
        campers: two,
        offerings: [artsOffering({ minimum: 5 })],
        preferences: two.map((c) => ({ camper_id: c.id, labelKey: ARTS_KEY, rank: 1 })),
      })
    },
  },
  // Everything full. Counts campers; names no activity.
  NO_CAPACITY: {
    namesActivity: false,
    produce: () => {
      const two = [camper('c1'), camper('c2')]
      return solve({
        campers: two,
        offerings: [artsOffering({ capacity: 1 })],
        preferences: two.map((c) => ({ camper_id: c.id, labelKey: ARTS_KEY, rank: 1 })),
      })
    },
  },
  // A linked set that cannot be honoured. NAMES THE CHOICE — by the choice's own
  // label, not an activity's, so this fixture supplies `choices` to the resolver.
  UNSUPPORTED_LINKED_CHOICE: {
    namesActivity: true,
    choices: [{ id: 'C', label: ARTS.name, labelKey: ARTS_KEY }],
    produce: () => solve({
      campers: [camper('c1')],
      offerings: [artsOffering({ capacity: 5 })],
      preferences: [{ camper_id: 'c1', labelKey: ARTS_KEY, rank: 1 }],
      choices: [{ id: 'C', labelKey: ARTS_KEY, is_linked: 0 }],
      choiceOfferings: [
        { choice_id: 'C', occurrence_id: 'occ-1', activity_id: ARTS.id },
        { choice_id: 'C', occurrence_id: 'occ-gone', activity_id: ARTS.id },
      ],
    }),
  },

  // ── src/screens/elective/assignment/buildOfferings.js (findMismatches) ────
  // A label the SHEET used that matches no offering. Deliberately NOT resolved:
  // the point of the sentence is the spelling the sheet used, and there is no
  // activity to resolve it to. `namesActivity: false` is therefore a statement
  // that the message holds no key of a KNOWN activity — `nosuchthing` below is
  // not in ACTIVITIES, so the assertion still means something.
  UNMATCHED_PREFERENCE_LABEL: {
    namesActivity: false,
    produce: () => ({
      findings: findMismatches({
        offerings: [artsOffering()],
        preferences: [{ camper_id: 'c1', labelKey: 'nosuchthing', label: 'No Such Thing', rank: 1 }],
      }),
    }),
  },
  // An offering nobody ranked. NAMES THE OFFERING, and carries only a labelKey,
  // so it is resolved back through the activity list rather than by id.
  UNRANKED_OFFERING: {
    namesActivity: true,
    produce: () => ({ findings: findMismatches({ offerings: [artsOffering()], preferences: [] }) }),
  },
  // T316 — a confirmed offering declared 'limited' with a blank capacity.
  // NAMES THE OFFERING: this producer has `activities` to hand, unlike the
  // pure engine, so it names the activity directly rather than through a
  // quoted labelKey substitution.
  INVALID_CAPACITY: {
    namesActivity: true,
    produce: () => ({
      findings: findBlankCapacities({
        setActivities: [{ id: 'osa-arts', activity_id: ARTS.id, status: 'confirmed', capacity_mode: 'limited', capacity_limit: null }],
        activities: ACTIVITIES,
      }),
    }),
  },
}

// Read straight off disk. `import.meta.dirname` rather than process.cwd(), so
// this does not depend on where vitest was invoked from.
function emittedKinds() {
  const repoRoot = path.resolve(import.meta.dirname, '../../../..')
  const kinds = new Map()
  for (const rel of PRODUCERS) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8')
    for (const m of src.matchAll(/\bkind:\s*'([A-Z][A-Z0-9_]*)'/g)) {
      if (!kinds.has(m[1])) kinds.set(m[1], rel)
    }
  }
  return kinds
}

const render = (finding, fixture) =>
  findingDisplayMessage(finding, { activities: ACTIVITIES, choices: fixture.choices ?? [] })

describe('T302 — no elective finding reaches a director naming an activity by its label key', () => {
  it('has a fixture for every kind the producers emit, and emits every kind it has a fixture for', () => {
    const emitted = emittedKinds()
    // Guards the scanner itself. If the regex or the paths ever stop matching,
    // every other test in this file passes over an empty set — the vacuity this
    // whole file is built to refuse.
    expect(emitted.size, 'the producer scan found no finding kinds at all — the regex or PRODUCERS paths are wrong').toBeGreaterThan(5)

    const unknown = [...emitted.keys()].filter((k) => !(k in FIXTURES))
    expect(
      unknown,
      `finding kind(s) with no fixture in this file: ${unknown.map((k) => `${k} (${emitted.get(k)})`).join(', ')} — ` +
        'add each one to FIXTURES with a fixture that drives the real producer, and declare whether its ' +
        'message names an activity. A new kind that interpolates a label key UNQUOTED reaches a director ' +
        'unresolved, which is the defect T302 exists to stop.'
    ).toEqual([])

    // The other direction, for the same reason mergeActivity.test.js checks it:
    // a fixture for a kind nobody emits any more is a stale entry that makes this
    // file look broader than it is.
    const stale = Object.keys(FIXTURES).filter((k) => !emitted.has(k))
    expect(stale, `FIXTURES covers kind(s) the producers no longer emit: ${stale.join(', ')}`).toEqual([])
  })

  for (const [kind, fixture] of Object.entries(FIXTURES)) {
    it(`${kind}: its fixture really emits it, and its message carries no label key`, () => {
      const produced = (fixture.produce().findings ?? []).filter((f) => f.kind === kind)
      // NOT a skip. A fixture that stopped triggering its kind would make every
      // assertion below vacuous, and pass.
      expect(
        produced.length,
        `the fixture for ${kind} produced no finding of that kind — it no longer drives the branch it ` +
          'was written for, so the assertions below would pass over nothing'
      ).toBeGreaterThan(0)

      for (const finding of produced) {
        const message = render(finding, fixture)
        expect(typeof message, `${kind} produced no message string`).toBe('string')

        // THE ASSERTION. Whatever the kind claims, a key of a KNOWN activity must
        // never survive into the rendered sentence.
        for (const key of [ARTS_KEY, SWIM_KEY]) {
          expect(
            message,
            `${kind} renders the label key "${key}" to a director instead of the activity's name. ` +
              'If this kind quotes its label, findingDisplayMessage resolves it; if it interpolates the ' +
              'key bare, the quote-anchored substitution cannot see it. Quote the label.'
          ).not.toContain(key)
        }

        if (fixture.namesActivity) {
          // And it resolved to something, rather than passing by saying nothing.
          expect(
            message,
            `${kind} is declared to name an activity but its rendered message contains neither ` +
              `"${ARTS.name}" nor "${SWIM.name}" — either the fixture stopped naming one, or the ` +
              'resolution silently returned the message unchanged'
          ).toMatch(new RegExp(`${ARTS.name.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}|${SWIM.name}`))
        }
      }
    })
  }
})
