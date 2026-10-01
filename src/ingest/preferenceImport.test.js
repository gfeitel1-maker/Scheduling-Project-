// Board item 9b — a bundle is a RANKABLE CHOICE, so the catalogue a sheet's
// labels resolve against has to contain bundle names. These pin the merge
// itself; the two DOORS that must both carry it are pinned separately
// (scripts/preferenceSheetCli.test.js, AssignmentPanel's own suite) because a
// shared helper being right is not the same fact as both callers using it —
// that is exactly the two-catalogues drift electiveAcceptanceImport's round-2
// note measured.
import { describe, it, expect } from 'vitest'
import { buildPreferenceCatalog } from './preferenceImport.js'

describe('buildPreferenceCatalog — bundle names are part of the catalogue', () => {
  it('merges bundle names into activities', () => {
    const catalog = buildPreferenceCatalog({
      activities: [{ name: 'Swim' }, { name: 'Ropes' }],
      bundles: [{ name: 'Ropes Intensive' }],
    })
    expect(catalog.activities).toEqual(['Swim', 'Ropes', 'Ropes Intensive'])
  })

  it('tolerates plain strings on both legs, exactly as activities already does', () => {
    const catalog = buildPreferenceCatalog({ activities: ['Swim'], bundles: ['Ropes Intensive'] })
    expect(catalog.activities).toEqual(['Swim', 'Ropes Intensive'])
  })

  it('a bundle named after its own activity does not appear twice', () => {
    // The acceptance fixture's live bundle is exactly this shape ('Ropes'
    // named after activity 'Ropes'). A duplicate would be harmless to
    // recognitionKey, which last-write-wins onto the same key — but the
    // catalogue is also the INVERTED-MATRIX header matcher's evidence, and a
    // doubled name is a doubled claim about how many activities a camp has.
    const catalog = buildPreferenceCatalog({
      activities: [{ name: 'Ropes' }],
      bundles: [{ name: 'Ropes' }],
    })
    expect(catalog.activities).toEqual(['Ropes'])
  })

  it('bundles alone make the catalogue NON-EMPTY, which is what un-abstains the resolver', () => {
    // makeLabelResolver's `empty` is keyed on `known.size === 0` and returns
    // {status:'abstained'} for everything when set. So this is not cosmetic:
    // a camp with bundles and no activities must not abstain on the bundle's
    // own name. (In practice `bundles.length > 0` implies at least one
    // activity, since deriveChoices reads `bundle.activity_id` — this pins
    // the direction the contract may never move in.)
    const catalog = buildPreferenceCatalog({ activities: [], bundles: ['Ropes Intensive'] })
    expect(catalog.activities).toEqual(['Ropes Intensive'])
  })

  it('no bundles is the pre-existing behaviour, unchanged', () => {
    expect(buildPreferenceCatalog({ activities: [{ name: 'Swim' }] }).activities).toEqual(['Swim'])
  })
})

// Board item i-declared-camper-dropped-when-all-choices-outside-catalog — the
// roster joins the catalogue so a preference sheet's row can be matched by
// NAME against a camper who already exists, not just by external id.
describe('buildPreferenceCatalog — the roster is part of the catalogue', () => {
  it('maps campers to {id, display_name}, dropping anything missing either field', () => {
    const catalog = buildPreferenceCatalog({
      campers: [
        { id: 'cam-1', display_name: 'Ari Green', external_id: null },
        { id: 'cam-2' },
        { display_name: 'No Id' },
      ],
    })
    expect(catalog.campers).toEqual([{ id: 'cam-1', display_name: 'Ari Green' }])
  })

  it('defaults to an empty roster, the pre-existing behaviour for every caller that does not pass one', () => {
    expect(buildPreferenceCatalog({ activities: ['Swim'] }).campers).toEqual([])
  })
})
