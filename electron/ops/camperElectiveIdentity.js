// WHICH GROUP AND WHICH TIER A CAMPER IS IN, as one rule, for every elective
// path that has to answer it (board item 9b).
//
// Three places were answering it separately and two of them were wrong:
// `commitElectiveRun`'s bundle-choice resolution went camper -> group_id ->
// groups.tier_id, so a camp whose sheet Division column carries a TIER name
// (T279 §12.2a leaves `group_id` null for exactly that shape) resolved NO tier
// and every linked choice landed as a mismatch; `AssignmentPanel` hand-rolled
// the roster merge inline; and `resolvePreferenceCoordinates` did not ask at
// all. One resolver, constructed per solve/commit, is what stops those three
// from drifting again.
//
// WHY THE SHEET'S DIVISION BEATS THE ROSTER GROUP'S TIER — the one thing a
// future reader will get backwards, so it is stated first rather than
// discovered. `buildAttendance` (src/screens/elective/assignment/) resolves a
// camper's ATTENDANCE tier from `division_label`, and uses `group_id` only to
// narrow WITHIN that tier. A camper whose sheet says "Older" and whose roster
// group belongs to Younger therefore attends OLDER occurrences. Binding their
// preference from the roster's tier would bind it to a choice they can never be
// placed into — a row that looks resolved and can never be honoured, which is
// worse than the mismatch it replaced. The two facts genuinely disagree here,
// and `buildAttendance` already reports that disagreement (`divisionMismatches`);
// this module must not quietly answer it the other way.
//
// AN AMBIGUOUS TIER NAME IS NO MATCH, the same posture `buildAttendance` takes
// via `mapWithCollisions` — schema v73 lets two tiers share a name, and binding
// to whichever row came last is a guess. Divergence between these two modules
// on that point would seat a camper in one tier's occurrences while binding
// their preference to another's, so it is held identical deliberately.
//
// PURE. No db, no IPC: each caller reads its own rows (the panel from
// `localClient`, the commit path from SQLite) and passes plain arrays.
import { deriveCamperId, electiveChoiceLabelKey } from './electiveDerivedIds.js'
import { mapWithCollisions } from '../../src/ingest/mapWithCollisions.js'

/**
 * @param {object}   args
 * @param {string}   [args.campId]       needed to recompute a roster camper's OWN lookup
 *   key (see below) — omit only when every `sheetCampers[].id` is already a real roster id
 *   (hand-built test data), in which case the direct-id match still works unchanged.
 * @param {Array}    args.sheetCampers   `parsed.campers` — `{id, group_id, division_label}`.
 * @param {Array}    args.rosterCampers  the camp's own `campers` rows, same three fields
 *   plus `external_id`/`display_name` (used only for the lookup-key match below).
 *   Fills NULL gaps only; it never overrides a value the sheet resolved (#670's rule:
 *   "A preference sheet may SET a group it resolved; it may never clear one it simply
 *   failed to resolve" — commitElectiveRun.js's own comment, inverted for this direction).
 * @param {Array}    args.groups         `{id, tier_id}`.
 * @param {Array}    args.tiers          `{id, name}`.
 *
 * @returns {{enriched: Array, groupIdOf: (id: string) => string|null, tierIdOf: (id: string) => string|null}}
 *   `enriched` is `sheetCampers` in the same order and length, gaps filled.
 *   Both lookups answer `null` for an id nobody knows — never a throw.
 *   `tierIdByCamperId` is the same answer as `tierIdOf` as a Map, for callers that
 *   need to hand the whole table to a pure function (resolvePreferenceCoordinates).
 *   `groupIdOf` completes the pair `enriched` already exposes; it is part of this
 *   module's declared surface rather than an inferred need.
 */
export function makeCamperIdentityResolver({
  campId = null,
  sheetCampers = [],
  rosterCampers = [],
  groups = [],
  tiers = [],
} = {}) {
  const rosterById = new Map(rosterCampers.map((c) => [c.id, c]))

  // T321 (docs/adr/2026-10-01-camper-id-high-entropy-format.md). `sheetCampers[].id`
  // is `deriveCamperId`'s output — src/ingest/preferenceSheet.js's own comment calls
  // it a LOOKUP KEY, never the final `campers.id` (that parser has no `db` and cannot
  // resolve through `camper_identity_keys`). `campers.id` for a real roster row is now
  // an unrelated random `camper2:...` token, so `rosterById.get(c.id)` above matches
  // nothing for an ordinary identified camper — group_id silently never enriches, and
  // every camper falls back to tier-wide attendance. Fixed the same way
  // commitElectiveRun.js's `resolveParsedCamperId` resolves it (electron/ops/
  // camperIdentityResolver.js), but without `db`: recompute each ROSTER camper's OWN
  // lookup key from its `external_id`/`display_name` (the identical derivation), and
  // index by that too. `ext` then `name`, mirroring `deriveCamperId`'s own precedence
  // (`sub`-mode subjects are not recoverable from roster columns and are left to the
  // direct-id match below, unchanged).
  const rosterByLookupId = new Map()
  if (campId != null) {
    for (const roster of rosterCampers) {
      const external = String(roster.external_id ?? '').trim()
      const displayName = String(roster.display_name ?? '').trim()
      if (external.length === 0 && displayName.length === 0) continue
      const lookupId = deriveCamperId(campId, { externalId: external || null, displayName: displayName || null })
      rosterByLookupId.set(lookupId, roster)
    }
  }

  const enriched = sheetCampers.map((c) => {
    const roster = rosterById.get(c.id) ?? rosterByLookupId.get(c.id)
    if (!roster) return c
    const group_id = c.group_id ?? roster.group_id ?? null
    const division_label = c.division_label ?? roster.division_label ?? null
    if (group_id === (c.group_id ?? null) && division_label === (c.division_label ?? null)) return c
    return { ...c, group_id, division_label }
  })

  const byId = new Map(enriched.map((c) => [c.id, c]))
  const tierIdByGroupId = new Map(groups.map((g) => [g.id, g.tier_id ?? null]))
  const { map: tierIdByNameKey } = mapWithCollisions(
    tiers,
    (t) => electiveChoiceLabelKey(t.name ?? ''),
    (t) => t.id
  )

  // RESOLVED ONCE PER CAMPER, at construction, rather than per call. The commit
  // path asks for a camper's tier once per preference and again per assignment —
  // thousands of times on a real sheet, for at most one distinct answer per
  // camper — and each ask would otherwise re-run `electiveChoiceLabelKey`'s
  // lowercase-and-strip over the division label.
  const tierIdByCamperId = new Map(enriched.map((c) => {
    const divisionKey = c.division_label ? electiveChoiceLabelKey(c.division_label) : ''
    // `mapWithCollisions` omits an ambiguous key entirely, so this is undefined
    // for a name two tiers share — and falls through, rather than picking one.
    const byDivision = divisionKey ? tierIdByNameKey.get(divisionKey) : undefined
    if (byDivision != null) return [c.id, byDivision]
    return [c.id, c.group_id == null ? null : tierIdByGroupId.get(c.group_id) ?? null]
  }))

  const groupIdOf = (camperId) => byId.get(camperId)?.group_id ?? null
  const tierIdOf = (camperId) => tierIdByCamperId.get(camperId) ?? null

  return { enriched, groupIdOf, tierIdOf, tierIdByCamperId }
}
