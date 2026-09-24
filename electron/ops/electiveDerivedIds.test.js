import { describe, it, expect } from 'vitest'
import {
  deriveCamperId,
  electiveChoiceLabelKey,
  deriveElectiveOccurrenceId,
  deriveElectiveChoiceId,
  deriveElectiveChoiceOfferingId,
  deriveElectivePreferenceId,
  deriveElectiveAssignmentId,
  deriveImportedElectiveRunId,
  opaque,
} from './electiveDerivedIds.js'

// T194 §8.2. The invariant everything else in the slice rests on: two devices
// that independently create the same logical row must produce the SAME id, so
// the merge is a per-field conflict on one record rather than two records.

describe('frozen output vectors', () => {
  // Pinned exactly, in the style of electron/sync/campIdHash.test.js. Changing
  // any of these strings re-keys live rows and must be a deliberate act (bump
  // the version tag in the module, do not edit the expectation).
  it('pins deriveElectiveOccurrenceId', () => {
    expect(deriveElectiveOccurrenceId('run-1', 'set-1', 'day-1', 'tb-1', 'tier-1')).toBe(
      'eocc1:5.run-15.set-15.day-14.tb-16.tier-1'
    )
  })

  it('pins deriveElectiveChoiceId', () => {
    expect(deriveElectiveChoiceId('run-1', 'swimadvanced')).toBe('echo1:5.run-112.swimadvanced')
  })

  it('pins deriveElectiveChoiceOfferingId', () => {
    expect(deriveElectiveChoiceOfferingId('choice-1', 'occ-1', 'act-1')).toBe(
      'ecof1:8.choice-15.occ-15.act-1'
    )
  })

  it('pins deriveElectivePreferenceId', () => {
    expect(deriveElectivePreferenceId('run-1', 'camper-1', 'choice-1')).toBe(
      'epref1:5.run-18.camper-18.choice-1'
    )
  })

  it('pins deriveElectiveAssignmentId', () => {
    expect(deriveElectiveAssignmentId('run-1', 'camper-1', 'occ-1')).toBe(
      'easgn1:5.run-18.camper-15.occ-1'
    )
  })
})

describe('injectivity', () => {
  // The precedent, deriveScheduleTemplateId, is plain ':'-joining, which is
  // injective only because its components happen never to contain ':'. Length
  // prefixing makes it a property rather than an accident.
  it('separates component tuples that plain delimiter joining would collide', () => {
    // 'a-b' + 'c' vs 'a' + 'b-c' collide under `${x}-${y}`.
    expect(deriveElectiveChoiceOfferingId('a-b', 'c', 'z')).not.toBe(
      deriveElectiveChoiceOfferingId('a', 'b-c', 'z')
    )
  })

  it('separates a component boundary shifted by one character', () => {
    expect(deriveElectivePreferenceId('ru', 'n-1camper', '1')).not.toBe(
      deriveElectivePreferenceId('run', '-1camper', '1')
    )
  })

  it('is order sensitive — the argument order is part of the contract', () => {
    expect(deriveElectiveAssignmentId('run-1', 'camper-1', 'occ-1')).not.toBe(
      deriveElectiveAssignmentId('run-1', 'occ-1', 'camper-1')
    )
  })
})

describe('component rejection (§2.2)', () => {
  const BAD = [
    // ':' and '.' are deliberately NOT rejected: derived ids COMPOSE (an
    // offering's key contains a derived choice id), so the alphabet must admit
    // this function's own output. Injectivity does not depend on excluding the
    // delimiter — length-prefixing is what provides it. What the guard actually
    // keeps out is human free text, which is everything in this list.
    ['a slash', 'a/b'],
    ['a space', 'a b'],
    ['a tab', 'a\tb'],
    ['a combining mark', 'café'],
    ['a zero-width space', 'a​b'],
    ['an ampersand', 'a&b'],
    ['an empty string', ''],
  ]

  for (const [label, value] of BAD) {
    it(`throws on ${label} in an opaque component`, () => {
      expect(() => deriveElectiveAssignmentId('run-1', value, 'occ-1')).toThrow(/component/i)
    })
  }

  it('throws on a non-string component', () => {
    expect(() => deriveElectiveAssignmentId('run-1', null, 'occ-1')).toThrow(/component/i)
    expect(() => deriveElectiveAssignmentId('run-1', 7, 'occ-1')).toThrow(/component/i)
    expect(() => deriveElectiveAssignmentId('run-1', undefined, 'occ-1')).toThrow(/component/i)
  })

  // Non-vacuity: the guard must ACCEPT the shape the app actually mints.
  it('accepts a uuid-shaped component', () => {
    expect(() =>
      deriveElectiveAssignmentId('run-1', '3f2a9c10-4b8e-4d6f-9a11-0c2d3e4f5a6b', 'occ-1')
    ).not.toThrow()
  })

  // THE COMPOSITION CASE — what the integration scenario caught and what the
  // unit tests above could NOT, because every one of them passes a hand-written
  // FLAT id and so never feeds one derivation's output into another.
  it('accepts a DERIVED id as a component — the derivations compose', () => {
    const choiceId = deriveElectiveChoiceId('run-1', 'swimadvanced')
    const occId = deriveElectiveOccurrenceId('run-1', 'set-1', 'day-1', 'tb-1', 'tier-1')
    expect(() => deriveElectiveChoiceOfferingId(choiceId, occId, 'act-1')).not.toThrow()
    expect(() => deriveElectivePreferenceId('run-1', 'camper-1', choiceId)).not.toThrow()
    expect(() => deriveElectiveAssignmentId('run-1', 'camper-1', occId)).not.toThrow()
  })

  it('stays injective when a component is itself a derived id', () => {
    const a = deriveElectiveChoiceId('run-1', 'swim')
    const b = deriveElectiveChoiceId('run-1', 'swima')
    expect(deriveElectiveChoiceOfferingId(a, 'occ-1', 'act-1')).not.toBe(
      deriveElectiveChoiceOfferingId(b, 'occ-1', 'act-1')
    )
  })
})

describe('recomputability from a row (candidate E drift check)', () => {
  it('re-derives an elective_assignments row id from the row own columns', () => {
    const row = {
      run_id: 'run-9',
      camper_id: 'camper-9',
      occurrence_id: 'occ-9',
      activity_id: 'act-9',
    }
    const id = deriveElectiveAssignmentId(row.run_id, row.camper_id, row.occurrence_id)
    expect(deriveElectiveAssignmentId(row.run_id, row.camper_id, row.occurrence_id)).toBe(id)
    // activity_id is NOT part of the key — a re-place of the same camper in the
    // same occurrence must hit the same row, not mint a second one.
    expect(id).toBe(deriveElectiveAssignmentId('run-9', 'camper-9', 'occ-9'))
  })
})

// ---------------------------------------------------------------------------
// The choice label key. R2 (owner ruling 2026-09-17): elective_choices keys on
// the NORMALIZED LABEL, so editing a choice's member activities keeps the same
// choice and campers' existing preferences stay attached. That makes the label
// load-bearing, and this corpus is the required deliverable.
// ---------------------------------------------------------------------------
describe('electiveChoiceLabelKey — adversarial corpus', () => {
  const collapses = (a, b) =>
    expect(electiveChoiceLabelKey(a), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
      electiveChoiceLabelKey(b)
    )
  const separates = (a, b) =>
    expect(electiveChoiceLabelKey(a), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).not.toBe(
      electiveChoiceLabelKey(b)
    )

  it('collapses leading and trailing whitespace', () => {
    collapses('  Swim Advanced  ', 'Swim Advanced')
    collapses('\tSwim Advanced\n', 'Swim Advanced')
  })

  it('collapses interior whitespace runs', () => {
    collapses('Swim  Advanced', 'Swim Advanced')
    collapses('Swim\tAdvanced', 'Swim Advanced')
  })

  it('collapses case', () => {
    collapses('SWIM ADVANCED', 'swim advanced')
    collapses('Swim Advanced', 'sWiM aDvAnCeD')
  })

  // ---- the classes this normalization does NOT close. Asserted rather than
  // assumed, because a corpus that only proves the designed-for case proves
  // nothing (feedback_plant_the_defect_the_guard_cannot_see).
  it('does NOT collapse Unicode confusables', () => {
    // Cyrillic Е (U+0415) vs Latin E.
    separates('Еlective', 'Elective')
  })

  it('does NOT collapse NFD against NFC', () => {
    separates('Café Art', 'Café Art')
  })

  it('does NOT collapse zero-width characters', () => {
    separates('Swim​Advanced', 'SwimAdvanced')
  })

  // The deliberate, reported semantic: whitespace is DELETED, not collapsed to
  // one space, so a missing space is the same key as a present one.
  it('treats a missing interior space as the same choice', () => {
    collapses('Swim Advanced', 'SwimAdvanced')
  })

  it('keeps genuinely different labels apart', () => {
    separates('Swim Advanced', 'Swim Beginner')
    separates('Archery', 'Arts and Crafts')
  })

  it('handles the null and undefined shapes a DB row can carry', () => {
    expect(electiveChoiceLabelKey(null)).toBe('')
    expect(electiveChoiceLabelKey(undefined)).toBe('')
  })
})

describe('deriveElectiveChoiceId accepts a label key, not a raw label', () => {
  it('accepts the output of electiveChoiceLabelKey for a punctuated label', () => {
    // 'Arts & Crafts' would be rejected by the opaque-component alphabet; the
    // canonicalized label key is validated by its own rule instead.
    const key = electiveChoiceLabelKey('Arts & Crafts')
    expect(() => deriveElectiveChoiceId('run-1', key)).not.toThrow()
  })

  it('rejects an empty label key', () => {
    expect(() => deriveElectiveChoiceId('run-1', '')).toThrow(/label/i)
  })

  it('rejects a non-string label key', () => {
    expect(() => deriveElectiveChoiceId('run-1', null)).toThrow(/label/i)
  })

  it('still rejects a bad opaque run id', () => {
    expect(() => deriveElectiveChoiceId('run 1', 'swim')).toThrow(/component/i)
  })

  it('rejects a label key that was not canonicalized', () => {
    // Passing a raw label is the mistake that would let two devices key the
    // same choice differently. It must be loud, not silently accepted.
    expect(() => deriveElectiveChoiceId('run-1', 'Swim Advanced')).toThrow(/label/i)
  })
})

// ---------------------------------------------------------------------------
// THE CROSS PRODUCT (round-2 H3). The two describe blocks above never meet:
// the composition case proves composition with 'swimadvanced' (alphabet-safe)
// while the corpus proves the adversarial labels are ACCEPTED BY THE
// CANONICALIZER. Neither runs an adversarial label through the full chain, and
// that gap is exactly where the defect lived — `electiveChoiceLabelKey` does
// not restrict the alphabet, so a choice id derived from 'Arts & Crafts' or a
// Hebrew label is outside the opaque alphabet and was rejected as a component
// of the offering and preference ids that must contain it.
//
// This app is for a Hebrew-named camp: a Hebrew elective label is the NORMAL
// case, not an edge case.
// ---------------------------------------------------------------------------
describe('cross product — every corpus label through the full derivation chain', () => {
  const LABELS = [
    'Arts & Crafts',
    'שחייה',
    'שחייה מתקדמת',
    'Café',
    'Café',
    "Kids' Choice",
    'Swim Advanced',
    'Swim/Dive',
    'Еlective',
    'Swim​Advanced',
    'Arts and Crafts (Session 2)',
    '100% Fun',
  ]

  for (const label of LABELS) {
    it(`derives choice, offering and preference ids for ${JSON.stringify(label)}`, () => {
      const key = electiveChoiceLabelKey(label)
      const occId = deriveElectiveOccurrenceId('run-1', 'set-1', 'day-1', 'tb-1', 'tier-1')

      const choiceId = deriveElectiveChoiceId('run-1', key)
      const offeringId = deriveElectiveChoiceOfferingId(choiceId, occId, 'act-1')
      const preferenceId = deriveElectivePreferenceId('run-1', 'camper-1', choiceId)

      expect(choiceId).toContain(key)
      expect(offeringId).toContain(choiceId)
      expect(preferenceId).toContain(choiceId)
    })
  }

  it('keeps the whole chain injective across two different labels', () => {
    const occId = deriveElectiveOccurrenceId('run-1', 'set-1', 'day-1', 'tb-1', 'tier-1')
    const a = deriveElectiveChoiceId('run-1', electiveChoiceLabelKey('שחייה'))
    const b = deriveElectiveChoiceId('run-1', electiveChoiceLabelKey('Arts & Crafts'))
    expect(a).not.toBe(b)
    expect(deriveElectiveChoiceOfferingId(a, occId, 'act-1')).not.toBe(
      deriveElectiveChoiceOfferingId(b, occId, 'act-1')
    )
    expect(deriveElectivePreferenceId('run-1', 'camper-1', a)).not.toBe(
      deriveElectivePreferenceId('run-1', 'camper-1', b)
    )
  })

  // A raw label must STILL be refused wherever a choice id is expected — the
  // fix widens what a *derived choice id* may contain, it does not turn the
  // choice_id component into a free-text field.
  it('still rejects a non-derived string where a choice id is expected', () => {
    expect(() => deriveElectiveChoiceOfferingId('Arts & Crafts', 'occ-1', 'act-1')).toThrow(
      /choice_id/i
    )
    expect(() => deriveElectivePreferenceId('run-1', 'camper-1', 'Arts & Crafts')).toThrow(
      /choice_id/i
    )
  })
})

// T226 — camper identity. Owner-approved 2026-09-18: key on external_id when
// the sheet supplies one, otherwise on the normalized display name, with
// same-name collisions surfaced to the director rather than merged.
describe('deriveCamperId', () => {
  it('is stable for the same external id — two devices importing one sheet converge', () => {
    const a = deriveCamperId('camp-1', { externalId: 'CM-4417' })
    const b = deriveCamperId('camp-1', { externalId: 'CM-4417' })
    expect(a).toBe(b)
  })

  it('is stable for the same name when there is no external id', () => {
    expect(deriveCamperId('camp-1', { displayName: 'Ari Green' }))
      .toBe(deriveCamperId('camp-1', { displayName: 'Ari Green' }))
  })

  // The whole point of keying on the camp: two camps may both have an "Ari
  // Green", and they are not the same child.
  it('separates the same name in different camps', () => {
    expect(deriveCamperId('camp-1', { displayName: 'Ari Green' }))
      .not.toBe(deriveCamperId('camp-2', { displayName: 'Ari Green' }))
  })

  // An external-id camper and a name-keyed camper must never be able to
  // collide. The probe uses an external id that is EXACTLY what the name
  // canonicalizer produces for 'Ari Green' — without the mode tag in the key
  // these two derivations would be byte-identical, so this is the case the tag
  // exists for, not a decorative assertion.
  it('cannot collide across the two key modes', () => {
    expect(electiveChoiceLabelKey('Ari Green')).toBe('arigreen') // the collision this guards
    expect(deriveCamperId('camp-1', { externalId: 'arigreen' }))
      .not.toBe(deriveCamperId('camp-1', { displayName: 'Ari Green' }))
  })

  // An external id is a surrogate from another system, and is held to the same
  // opaque alphabet as every other surrogate component — which closes the
  // whitespace/Unicode skew at the source rather than normalizing it later.
  // Refusing loudly is the point: a camp-management id with a space in it is
  // a mapping mistake worth stopping on, not something to silently fold.
  it('refuses a non-opaque external id rather than folding it', () => {
    expect(() => deriveCamperId('camp-1', { externalId: 'Ari Green' })).toThrow(/opaque/i)
  })

  // Same normalization rule as the choice-label key: two devices transcribing
  // one sheet plausibly differ in spacing, and that must not fork the camper.
  it('folds whitespace and case the way the choice-label key does', () => {
    expect(deriveCamperId('camp-1', { displayName: 'Ari  Green' }))
      .toBe(deriveCamperId('camp-1', { displayName: 'ari green' }))
  })

  it('prefers the external id when both are present, so a rename cannot fork the camper', () => {
    expect(deriveCamperId('camp-1', { externalId: 'CM-4417', displayName: 'Ari Green' }))
      .toBe(deriveCamperId('camp-1', { externalId: 'CM-4417', displayName: 'Ari Greene' }))
  })

  it('refuses a camper with neither key rather than minting an unstable id', () => {
    expect(() => deriveCamperId('camp-1', {})).toThrow(/external_id or display_name/i)
    expect(() => deriveCamperId('camp-1', { displayName: '   ' })).toThrow(/external_id or display_name/i)
  })
})

// T226 round 2 — the IMPORT path's run id. The renderer's solve path still
// mints a random run id; only a sheet import derives one, because only there
// is there a document whose bytes identify the run.
describe('deriveImportedElectiveRunId', () => {
  const SHA_A = 'a'.repeat(64)
  const SHA_B = 'b'.repeat(64)

  it('pins its output', () => {
    expect(deriveImportedElectiveRunId('camp-1', 'abc123')).toBe('erun1:6.camp-16.abc123')
  })

  // The property the finding is about: the SAME bytes re-imported land on the
  // same run, so a retry after an ambiguous MCP timeout converges.
  it('is stable for the same camp and the same bytes', () => {
    expect(deriveImportedElectiveRunId('camp-1', SHA_A)).toBe(deriveImportedElectiveRunId('camp-1', SHA_A))
  })

  it('separates different bytes — a corrected sheet is a different document', () => {
    expect(deriveImportedElectiveRunId('camp-1', SHA_A)).not.toBe(deriveImportedElectiveRunId('camp-1', SHA_B))
  })

  it('separates camps', () => {
    expect(deriveImportedElectiveRunId('camp-1', SHA_A)).not.toBe(deriveImportedElectiveRunId('camp-2', SHA_A))
  })

  // A hex digest satisfies the opaque alphabet; a missing or free-text one
  // must refuse rather than mint an unstable key.
  it('refuses a non-opaque source hash', () => {
    expect(() => deriveImportedElectiveRunId('camp-1', 'not a hash')).toThrow(/opaque/i)
    expect(() => deriveImportedElectiveRunId('camp-1', '')).toThrow(/non-empty/i)
  })

  // commitElectiveRun validates a provided run id with opaque(); this module's
  // own output must pass that gate, or the import path cannot use it.
  it('produces an id commitElectiveRun will accept as a provided run id', () => {
    expect(opaque('run_id', deriveImportedElectiveRunId('camp-1', SHA_A))).toBeTruthy()
  })
})
