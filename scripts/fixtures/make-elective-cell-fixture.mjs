// Build the T251/T265 per-cell elective preference fixture (ADR
// docs/adr/2026-09-26-per-cell-elective-preferences.md), modeled on the real
// structure of a 2024 camp Activity Selection Sheet — never its content. What
// is copied is the SHAPE the engine has to survive:
//   - a 5-day x 7-period grid where only 18 of 35 cells take a selection
//     (periods 1/4/5 are camp-wide fixtures; Monday period 2 is a no-selection
//     bunk activity; Friday period 2 is the weekly observance)
//   - every selectable cell carries its OWN offering list, uneven in length
//   - activities recur across many cells (so a global rank names no occurrence)
//   - linkage (double periods, multi-day runs) declared on the CATALOG, exactly
//     as the real sheet declares it by glyph
//   - a camper ranks their top N WITHIN each cell, N a per-camp SETTING
//
// EVERY CAMPER IN THIS FILE IS SYNTHETIC. Names are deliberately unmistakable
// as fabricated (`Synthetic Camper NNN`) rather than plausible real people —
// elective_preferences is PII-adjacent by the schema's own comment ("a row
// here plus a campers row is 'this child wants this activity'"), and a
// committed fixture must not read as real roster data even by accident.
//
// RE-IDENTIFICATION CLEARED BY THE OWNER, 2026-09-26. Security could confirm
// there is no camp name, no path and no verbatim content here, but could not
// diff this against a source document it has no access to. The owner, who has
// read the sheet, ruled: "there is no way for someone to recognize what we just
// ran." Recorded so a later reader does not re-open a question that was closed
// by the one person able to answer it. This clearance covers THIS catalog and
// grid; widening the fixture toward the real sheet's content re-opens it.
//
// SEAT ABUNDANCE IS INTENTIONAL AND REALISTIC, not over-provisioning. Owner
// ruling 2026-09-26: a camp deliberately offers far more than it expects to
// run, and the MINIMUM is what culls the rest. A fixture with more seats than
// campers is the true starting state of a run, so do not "fix" the capacities
// down to parity. Measured consequence, and the reason this matters: the share
// of placements matching a camper's in-cell ranking runs 77.8% at these
// capacities and 33.6% when they are scaled toward scarcity. That range is the
// trajectory a two-phase run walks, not an error bar — so any satisfaction
// figure taken from this fixture MUST state where on that curve it was taken.
//
// Deterministic: DJB2 + Mulberry32 seeded PRNG (same construction as
// src/engine/buildSchedule.js), no wall-clock, no Math.random. Re-running this
// script produces byte-identical output; a diff means a real change.
//
// Run from the repo root:  node scripts/fixtures/make-elective-cell-fixture.mjs
// Writes test/fixtures/elective/t251-per-cell-preferences.json. Commit the
// output alongside this script, per scripts/fixtures/make-era-fixtures.mjs's
// precedent.
//
// PREFERENCE ROW SHAPE — the whole point of the ADR. Every row is
// `{ camper_id, occurrence_id, choice_id, rank }`. There is no `labelKey` on a
// preference row: EVERY offering in this fixture, linked or not, is modeled as
// a choice (`elective_choices` + `elective_choice_offerings`) — a linked
// activity's choice has more than one member occurrence, a non-linked one's
// has exactly one (the degenerate case the schema already supports). This
// makes "which occurrence did rank-1 mean" answerable by construction: read
// choice_id, then choiceOfferings, then the occurrence.
//
// DELIBERATE DEFECTS FIXED FROM THE SUPERSEDED DRAFT
// (/private/tmp/.../scratchpad/gen/grid.mjs), not inherited:
//   1. No seat-supply precondition there at all. This script CHECKS it after
//      generating each cell (checkSeatSupply below) and THROWS if any cell is
//      short, rather than topping up a capacity to force the check to pass —
//      a top-up would make the guard's success condition diverge from the
//      system's ("these are CATALOG's real capacities"), so an under-supplied
//      cell must fail the generator, not be silently patched.
//   2. The "leaves a cell short" campers there got 1-2 ranks, never zero, so
//      the ADR's "not every camper needs a placement in every occurrence" case
//      was never produced. Here `wantForCell` below has a genuine zero branch.
//   3. Linkage there built offerings and choice_ids but no preference ever
//      named one — decorative. Here `pickLinkedChoice` decides, per camper per
//      linked choice, whether they want it, and if so writes ONE preference row
//      per member occurrence, same choice_id, same rank — exercising T247's
//      tier-1 bipartite pass on this fixture.
//   4. Preference rows there used `labelKey` exclusively, ambiguous for any
//      linked choice appearing in several occurrences. Fixed by (3)+the choice
//      model above.
//   5. `collapseToGlobal`'s tie-break there favoured early-alphabet activities
//      silently. This generator does not collapse at all — that adapter lives
//      in the measurement script, and it says so at its own tie-break.
//   6. Exported `generate()` with no invocation. This file has a runnable
//      entry point at the bottom that writes the file, and this header states
//      the regeneration check as an operator instruction rather than code,
//      because "does it byte-match" is verified by running it twice, not by
//      the file asserting something about itself.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT_PATH = path.join(ROOT, 'test/fixtures/elective/t251-per-cell-preferences.json')

const DJB2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h }
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const rngFor = (seed) => mulberry32(DJB2(seed))

// --- the grid ---------------------------------------------------------------
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri']
const PERIODS = [1, 2, 3, 4, 5, 6, 7]
const FIXED_PERIODS = { 1: 'Instructional Swim', 4: 'Free Swim', 5: 'Lunch' }

function selectableCells() {
  const cells = []
  for (const p of PERIODS) {
    if (FIXED_PERIODS[p]) continue
    for (const d of DAYS) {
      if (p === 2 && d === 'mon') continue // bunk activity, no selection needed
      if (p === 2 && d === 'fri') continue // weekly observance
      cells.push({ id: `occ-${d}-p${p}`, day: d, period: p })
    }
  }
  return cells
}

// --- the catalog -------------------------------------------------------------
// `ubiquity` is roughly how many of the 18 cells this tends to appear in, drawn
// from the real sheet's shape: a few staples in nearly every cell, a long tail
// appearing once or twice. `cap` is the offering's own seat count. `theme`
// drives a camper's affinity score, purely so preferences are not uniform
// noise — it has no meaning to the engine.
const CATALOG = [
  ['Archery', 'adventure', 15, 12], ['Top Chef', 'arts', 12, 10],
  ['Digi Photo', 'arts', 11, 10], ['Laser Tag', 'adventure', 10, 16],
  ['Gaga', 'sports', 10, 20], ['Lake Inflatables', 'water', 10, 24],
  ['Paddleboarding', 'water', 9, 10], ['Ropes High', 'adventure', 8, 8],
  ['9 Square in the Air', 'sports', 8, 16], ['Ceramics', 'arts', 8, 12],
  ['Mini Golf', 'sports', 7, 12], ['Fishing', 'water', 7, 10],
  ['Zipline', 'adventure', 7, 8], ['Newcombe', 'sports', 7, 18],
  ['Arts and Crafts', 'arts', 7, 16], ['Jewelry', 'arts', 6, 12],
  ['Painting', 'arts', 6, 12], ['Mosaic Art', 'arts', 6, 12],
  ['Basketball', 'sports', 6, 16], ['Court Time', 'sports', 6, 16],
  ['Drawing', 'arts', 6, 14], ['3D Printing', 'stem', 6, 8],
  ['Boating', 'water', 5, 10], ['Circuitry', 'stem', 5, 10],
  ['Games', 'sports', 5, 20], ['Project of Week', 'arts', 5, 12],
  ['Robotics', 'stem', 5, 8], ['Strategic Games', 'stem', 5, 14],
  ['Yoga', 'arts', 5, 14], ['Climbing Boulder', 'adventure', 4, 8],
  ['Bucket Golf', 'sports', 4, 12], ['Teva Nature', 'adventure', 4, 12],
  ['Ropes Low', 'adventure', 4, 10], ['Kickball', 'sports', 4, 18],
  ['Magic', 'arts', 3, 10], ['Mad Science', 'stem', 3, 10],
  ['Chess', 'stem', 3, 10], ['Krav Maga', 'sports', 3, 12],
  ['Improvisation', 'arts', 3, 12], ['Tailgate Games', 'sports', 3, 16],
  ['Hip Hop', 'arts', 2, 14], ['Book Club', 'arts', 2, 10],
  ['Zumba', 'arts', 2, 14], ['Cheerleading', 'sports', 2, 14],
].map(([label, theme, ubiquity, cap]) => ({ label, theme, ubiquity, cap }))

// Linkage declared on the catalog, exactly as the real sheet declares it by
// glyph: a double period occupies two ADJACENT periods on the same day; a
// multi-day run occupies the SAME period across several days. Each entry below
// becomes exactly one `elective_choices` row per instantiation: one choice per
// day for a double period (its two periods are its two member occurrences),
// one choice total for a multi-day run (its many days are its member
// occurrences).
const DOUBLE_PERIODS = [{ label: 'Coding', theme: 'stem', cap: 10, days: ['tue', 'wed', 'fri'], periods: [6, 7] }]
const MULTI_DAY = [{ label: 'Theater', theme: 'arts', cap: 18, period: 3, days: ['tue', 'wed', 'thu', 'fri'] }]

const CAMPER_COUNT = 96
const RANKS_PER_CELL = 4 // a per-camp SETTING modeled here as a fixed value for this fixture, never hardcoded inside the engine or the measurement script

function slugify(label) { return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') }

// Plain codepoint comparison, not `.localeCompare()` — default ICU collation
// can differ between macOS and Linux CI, and this fixture's entire value is
// byte-stable regeneration across machines.
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0 }

// --- offerings, choices, choiceOfferings ------------------------------------
// Every offering, linked or not, belongs to exactly one choice. A non-linked
// offering gets its own single-member (degenerate) choice, so a preference
// naming it still carries `choice_id` — the uniform row shape the ADR wants,
// with no `labelKey` branch for a caller to get wrong.
//
// Each choice row below carries BOTH `label` and `labelKey`, deliberately, not
// as a pick between them: the real `elective_choices` schema column is
// `label` (electron/db/schema.sql:1314), but src/engine/buildElectiveAssignments.js
// reads `c.labelKey` at src/engine/buildElectiveAssignments.js:126,152-171 — its
// own JSDoc claim that `labelKey` "mirrors elective_choices" is already wrong
// against the schema (pre-existing, out of scope to fix here). The measurement
// script never passes `choices` to the engine today, so this divergence is
// currently harmless, but T251's acceptance work will pass choices to exercise
// tier 1, and would get `undefined` from every `c.labelKey` with no error —
// silently degrading the linked-choice pass. Emitting both names avoids
// silently picking the wrong one.
function buildOfferingsAndChoices() {
  const cells = selectableCells()
  const offerings = []
  const choices = []
  const choiceOfferings = []

  for (const cell of cells) {
    let chosen = CATALOG.filter((a) => {
      const r = rngFor(`present:${cell.id}:${a.label}`)
      return r() < a.ubiquity / 18
    })
    // Uneven length is the point (~9 to ~27 per the real sheet), but the RNG
    // above can occasionally land outside that band. Top up or trim
    // deterministically by ubiquity so every cell stays inside it, rather than
    // leaving the range to chance.
    const byUbiquity = [...CATALOG].sort((a, b) => b.ubiquity - a.ubiquity || cmp(a.label, b.label))
    if (chosen.length < 9) {
      for (const a of byUbiquity) {
        if (chosen.length >= 9) break
        if (!chosen.includes(a)) chosen.push(a)
      }
    } else if (chosen.length > 27) {
      const keep = new Set(byUbiquity.slice(0, 27).map((a) => a.label))
      chosen = chosen.filter((a) => keep.has(a.label))
    }

    for (const a of chosen) {
      const activityId = `act-${slugify(a.label)}`
      const choiceId = `choice-${slugify(a.label)}-${cell.id}`
      choices.push({ id: choiceId, label: a.label, labelKey: a.label, is_linked: false })
      choiceOfferings.push({ choice_id: choiceId, occurrence_id: cell.id, activity_id: activityId })
      offerings.push({ occurrence_id: cell.id, labelKey: a.label, activity_id: activityId, capacity: a.cap, choice_id: choiceId, theme: a.theme })
    }
  }

  for (const dp of DOUBLE_PERIODS) {
    const activityId = `act-${slugify(dp.label)}`
    for (const d of dp.days) {
      const choiceId = `choice-${slugify(dp.label)}-${d}`
      choices.push({ id: choiceId, label: `${dp.label} (${d})`, labelKey: dp.label, is_linked: true })
      for (const p of dp.periods) {
        const occ = `occ-${d}-p${p}`
        choiceOfferings.push({ choice_id: choiceId, occurrence_id: occ, activity_id: activityId })
        offerings.push({ occurrence_id: occ, labelKey: dp.label, activity_id: activityId, capacity: dp.cap, choice_id: choiceId, theme: dp.theme })
      }
    }
  }
  for (const md of MULTI_DAY) {
    const activityId = `act-${slugify(md.label)}`
    const choiceId = `choice-${slugify(md.label)}`
    choices.push({ id: choiceId, label: md.label, labelKey: md.label, is_linked: true })
    for (const d of md.days) {
      const occ = `occ-${d}-p${md.period}`
      choiceOfferings.push({ choice_id: choiceId, occurrence_id: occ, activity_id: activityId })
      offerings.push({ occurrence_id: occ, labelKey: md.label, activity_id: activityId, capacity: md.cap, choice_id: choiceId, theme: md.theme })
    }
  }
  return { cells, offerings, choices, choiceOfferings }
}

// --- the seat-supply precondition -------------------------------------------
// SYSTEM-LEVEL predicate this fixture must satisfy for the measurement to mean
// anything: every camper attending a cell can, in principle, get a seat
// somewhere in that cell. THIS check's own predicate is narrower — total
// capacity in the cell >= attendee count — and does NOT verify a good
// distribution across offerings (a cell could pass this with 90 seats in one
// unpopular offering and 0 elsewhere, and still starve a popular one). That
// gap is deliberate and stated, not hidden: it is the same gap the measurement
// script's own precondition check carries, and no fixture-side balancing
// beyond `chosen`'s ubiquity-weighted selection is attempted here.
//
// This THROWS on a short cell rather than topping up a capacity to make the
// check pass. A top-up would make the guard's success condition ("total
// capacity >= attendees") diverge from the system's success condition ("the
// fixture's capacities are the ones CATALOG actually declares") — exactly the
// review-panel finding this fixture must not repeat: a future change to
// CAMPER_COUNT or CATALOG could silently inflate a capacity and distort the
// measurement's fidelity while this check stayed green.
function checkSeatSupply(cells, offerings, attendeeCount) {
  const byCell = new Map()
  for (const o of offerings) {
    if (!byCell.has(o.occurrence_id)) byCell.set(o.occurrence_id, [])
    byCell.get(o.occurrence_id).push(o)
  }
  for (const cell of cells) {
    const here = byCell.get(cell.id) ?? []
    const total = here.reduce((sum, o) => sum + o.capacity, 0)
    if (total < attendeeCount) {
      throw new Error(
        `seat-supply precondition failed for cell ${cell.id}: ${attendeeCount} campers attend, ` +
        `only ${total} seats offered (shortfall ${attendeeCount - total}). Fix CATALOG/DOUBLE_PERIODS/` +
        `MULTI_DAY capacities or CAMPER_COUNT — do not top up a capacity to make this pass.`
      )
    }
  }
}

// --- campers -----------------------------------------------------------------
const THEMES = ['sports', 'arts', 'water', 'stem', 'adventure']

function buildCampers(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const r = rngFor(`camper:${i}`)
    const affinity = {}
    for (const t of THEMES) affinity[t] = 0.15 + r() * 0.85
    const favourite = THEMES[Math.floor(r() * THEMES.length)]
    affinity[favourite] += 1.6
    out.push({ id: `synthetic-camper-${String(i + 1).padStart(3, '0')}`, name: `Synthetic Camper ${String(i + 1).padStart(3, '0')}`, affinity })
  }
  return out
}

// --- per-cell preferences ------------------------------------------------
// How many ranks a camper expresses in a cell, INCLUDING a genuine zero — the
// ADR's "not every camper needs a placement in every occurrence" case. Fixes
// draft defect #2: the withdrawn draft's short-list branch bottomed out at 1,
// so the zero case — and the measurement's exclusion bucket it feeds — was
// never produced.
function wantForCell(r, ranksPerCell) {
  const x = r()
  if (x < 0.08) return 0
  if (x < 0.20) return 1 + Math.floor(r() * 2) // 1 or 2
  return ranksPerCell
}

function scoreOffering(camperAffinity, offering, r) {
  return (camperAffinity[offering.theme] ?? 0.5) * (0.45 + r())
}

function buildPreferences(campers, cells, offerings, choiceOfferings, ranksPerCell) {
  const byCell = new Map()
  for (const o of offerings) {
    if (!byCell.has(o.occurrence_id)) byCell.set(o.occurrence_id, [])
    byCell.get(o.occurrence_id).push(o)
  }
  // choice_id -> its member occurrence ids, for propagating a linked pick.
  const membersOfChoice = new Map()
  for (const co of choiceOfferings) {
    if (!membersOfChoice.has(co.choice_id)) membersOfChoice.set(co.choice_id, [])
    membersOfChoice.get(co.choice_id).push(co.occurrence_id)
  }
  const linkedChoiceIds = [...membersOfChoice.entries()].filter(([, occs]) => occs.length > 1).map(([id]) => id)
  const linkedByPrimaryOccurrence = new Map() // occurrence_id -> [{choice_id, offering}]
  for (const cid of linkedChoiceIds) {
    const occs = membersOfChoice.get(cid).slice().sort()
    const primary = occs[0]
    const offering = offerings.find((o) => o.choice_id === cid && o.occurrence_id === primary)
    if (!linkedByPrimaryOccurrence.has(primary)) linkedByPrimaryOccurrence.set(primary, [])
    linkedByPrimaryOccurrence.get(primary).push({ choiceId: cid, offering, memberOccurrences: occs })
  }

  const prefs = [] // { camper_id, occurrence_id, choice_id, rank }
  for (const c of campers) {
    // rank-1 slots a linked pick has already claimed, per occurrence, so the
    // ordinary per-cell pass below does not re-offer that seat independently.
    const claimedActivityByOccurrence = new Map()

    // Decide linked choices FIRST (one decision per choice, applied to every
    // member occurrence at once) — this is what makes T247's tier-1 bipartite
    // pass exercisable on this fixture at all; the withdrawn draft never wrote
    // this preference.
    for (const [, candidates] of linkedByPrimaryOccurrence) {
      for (const { choiceId, offering, memberOccurrences } of candidates) {
        const r = rngFor(`linked:${c.id}:${choiceId}`)
        const interest = (c.affinity[offering.theme] ?? 0.5) / 2 // linked activities are a smaller slice of demand than a full cell's worth of choice
        if (r() < interest) {
          for (const occ of memberOccurrences) {
            prefs.push({ camper_id: c.id, occurrence_id: occ, choice_id: choiceId, rank: 1 })
            claimedActivityByOccurrence.set(`${c.id}|${occ}`, offering.activity_id)
          }
        }
      }
    }

    for (const cell of cells) {
      const opts = (byCell.get(cell.id) ?? []).filter((o) => o.activity_id !== claimedActivityByOccurrence.get(`${c.id}|${cell.id}`))
      const alreadyClaimed = claimedActivityByOccurrence.has(`${c.id}|${cell.id}`)
      const rankFloor = alreadyClaimed ? 1 : 0 // rank 1 is taken by the linked pick in this cell
      const r = rngFor(`pref:${c.id}:${cell.id}`)
      const want = wantForCell(r, ranksPerCell)
      if (want === 0 || !opts.length) continue
      const scored = opts.map((o) => ({ o, s: scoreOffering(c.affinity, o, r) }))
      scored.sort((a, b) => b.s - a.s || cmp(a.o.labelKey, b.o.labelKey))
      scored.slice(0, Math.min(want, opts.length)).forEach(({ o }, i) => {
        prefs.push({ camper_id: c.id, occurrence_id: cell.id, choice_id: o.choice_id, rank: rankFloor + i + 1 })
      })
    }
  }
  return prefs
}

function generate() {
  const { cells, offerings, choices, choiceOfferings } = buildOfferingsAndChoices()
  checkSeatSupply(cells, offerings, CAMPER_COUNT)
  const campers = buildCampers(CAMPER_COUNT)
  const preferences = buildPreferences(campers, cells, offerings, choiceOfferings, RANKS_PER_CELL)

  return {
    meta: {
      description: 'T251/T265 per-cell elective preference fixture. Every camper is SYNTHETIC. See scripts/fixtures/make-elective-cell-fixture.mjs for provenance.',
      camperCount: CAMPER_COUNT,
      ranksPerCell: RANKS_PER_CELL,
    },
    occurrences: cells.map((c) => ({ id: c.id, day: c.day, period: c.period })),
    offerings: offerings.map(({ occurrence_id, labelKey, activity_id, capacity, choice_id }) => ({ occurrence_id, labelKey, activity_id, capacity, choice_id })),
    choices: choices.map(({ id, label, labelKey, is_linked }) => ({ id, label, labelKey, is_linked })),
    choiceOfferings,
    campers: campers.map(({ id, name }) => ({ id, name })),
    preferences,
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const data = generate()
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2) + '\n')
  process.stdout.write(`wrote ${path.relative(ROOT, OUT_PATH)}\n`)
}

export { generate, CATALOG, DOUBLE_PERIODS, MULTI_DAY }
