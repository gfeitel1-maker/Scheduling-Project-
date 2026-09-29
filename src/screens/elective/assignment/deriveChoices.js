// T301 (docs/adr/2026-09-29-linked-elective-bundles.md D10). Expands
// authored elective bundles into this run's per-tier linked choices and
// their member offerings — the run-scoped derivation deriveOccurrences.js is
// to template_slots. Pure, no IPC, no db.
//
// SCOPE RESOLUTION is tier-level only (ADR D2/D5): a bundle's scope_mode/
// bundleTiers resolve against the DISTINCT tier_ids present among
// `occurrences` for the bundle's OWN elective_set_id — never the camp's full
// tier list — so a tier with nothing scheduled in this elective set this run
// never gets a manufactured, guaranteed-empty choice.
//
// MEMBER-PERIOD RESOLUTION IS NOT FILTERED (ADR D5): for every tier the
// scope resolves to, every member (day_id, time_block_id) gets a
// choiceOfferings row, computed via the SAME deriveElectiveOccurrenceId call
// deriveOccurrences.js uses, regardless of whether that occurrence exists in
// `occurrences`. A mismatch surfaces via buildElectiveAssignments' own
// existing UNSUPPORTED_LINKED_CHOICE case (a) — not duplicated here.
//
// DEDUPE, NOT UNIQUENESS, is the correctness boundary for bundlePeriods/
// bundleTiers (ADR D1): storage allows duplicate rows for the same
// (bundle_id, day_id, time_block_id) or (bundle_id, tier_id) fact
// (offline-concurrent authoring), so this function deduplicates via Set
// before iterating rather than trusting a DB constraint that does not exist.
//
// RETURN SHAPE. buildElectiveAssignments.js's own JSDoc (:156-159) is the
// authority for what the engine reads: choices need `labelKey` (not `label`)
// and choiceOfferings need `choice_id`/`occurrence_id`/`activity_id`. This
// module returns those PLUS `id`/`run_id`/`label` on each choice and `id` on
// each offering — the shape a persisted elective_choices/
// elective_choice_offerings row would need (what slice 3 owes its write
// path) — a strict superset the engine simply ignores the extra fields of.
import {
  deriveLinkedElectiveChoiceId,
  deriveElectiveOccurrenceId,
  deriveElectiveChoiceOfferingId,
  electiveChoiceLabelKey,
} from '../../../../electron/ops/electiveDerivedIds.js'

export function deriveChoices({
  bundles = [],
  bundlePeriods = [],
  bundleTiers = [],
  occurrences = [],
  runId,
} = {}) {
  const periodsByBundle = new Map()
  for (const p of bundlePeriods) {
    if (!periodsByBundle.has(p.bundle_id)) periodsByBundle.set(p.bundle_id, new Set())
    periodsByBundle.get(p.bundle_id).add(`${p.day_id}\u0000${p.time_block_id}`)
  }
  const tiersByBundle = new Map()
  for (const t of bundleTiers) {
    if (!tiersByBundle.has(t.bundle_id)) tiersByBundle.set(t.bundle_id, new Set())
    tiersByBundle.get(t.bundle_id).add(t.tier_id)
  }
  // D2: tiers PRESENT IN THIS RUN, grouped by elective_set_id up front (one
  // pass over `occurrences`, matching the pre-grouping pattern above) rather
  // than re-filtering the full array once per bundle — more than one bundle
  // commonly shares one elective_set_id (decision 3 permits several bundles
  // per activity, all typically on the same set).
  const tiersByElectiveSet = new Map()
  for (const o of occurrences) {
    if (!tiersByElectiveSet.has(o.elective_set_id)) tiersByElectiveSet.set(o.elective_set_id, new Set())
    tiersByElectiveSet.get(o.elective_set_id).add(o.tier_id)
  }

  const choices = []
  const choiceOfferings = []

  for (const bundle of bundles) {
    const memberPeriods = [...(periodsByBundle.get(bundle.id) ?? new Set())].map((key) => {
      // ROUND-2 FINDING 3 (Security): the delimiter above is a hard-coded
      // join key, so a day_id/time_block_id that itself contained one would
      // silently corrupt this split -- day_id/time_block_id are unvalidated
      // soft-pointer TEXT columns in principle. Not guarded: every current
      // producer mints them as either a bare crypto.randomUUID()
      // (TimeBlocksScreen.jsx; legacy pre-T205 day rows) or deriveDayId's
      // day:${campId}:${dayOfWeek} shape (electron/ops/dayId.js) -- both are
      // hex digits, dashes, and colons only, structurally unable to contain
      // U+0000. A guard here would defend against a shape nothing in this
      // codebase can produce.
      const [day_id, time_block_id] = key.split('\u0000')
      return { day_id, time_block_id }
    })
    // A bundle with no authored member periods yet is a legal, incomplete
    // authoring state — nothing to expand, and a choice with no members is
    // something tier 1 could never place into anyway.
    if (memberPeriods.length === 0) continue

    // D2: resolve against tiers PRESENT IN THIS RUN for THIS BUNDLE'S OWN
    // elective set — never the camp's full tier list, and never another
    // elective set's occurrences.
    const tiersPresent = tiersByElectiveSet.get(bundle.elective_set_id) ?? new Set()
    const named = tiersByBundle.get(bundle.id) ?? new Set()
    let resolvedTiers
    if (bundle.scope_mode === 'only') {
      resolvedTiers = [...tiersPresent].filter((t) => named.has(t))
    } else if (bundle.scope_mode === 'except') {
      resolvedTiers = [...tiersPresent].filter((t) => !named.has(t))
    } else {
      resolvedTiers = [...tiersPresent]
    }

    const labelKey = electiveChoiceLabelKey(bundle.name)
    // "Linked" = more than one member occurrence, the same definition
    // buildElectiveAssignments.js's own tier 1 uses (deliberately not read
    // back by the engine — see that module's comment — but included here as
    // the accurate, persistable value slice 3's write path can reuse).
    const isLinked = memberPeriods.length > 1 ? 1 : 0

    for (const tierId of resolvedTiers) {
      const choiceId = deriveLinkedElectiveChoiceId(runId, bundle.id, tierId)
      choices.push({
        id: choiceId,
        run_id: runId,
        label: bundle.name,
        labelKey,
        is_linked: isLinked,
        // T301 slice 3 (ADR D6) — not read by the engine (a strict superset
        // it ignores, per this module's own header), but the commit-time
        // coexistence mechanism needs "which tier does this choice belong
        // to" to route a camper's preference to THEIR tier's choice, and
        // must not re-derive the scope resolution above a second time to
        // get it.
        tier_id: tierId,
      })
      for (const { day_id, time_block_id } of memberPeriods) {
        const occurrenceId = deriveElectiveOccurrenceId(
          runId,
          bundle.elective_set_id,
          day_id,
          time_block_id,
          tierId
        )
        const offeringId = deriveElectiveChoiceOfferingId(choiceId, occurrenceId, bundle.activity_id)
        choiceOfferings.push({
          id: offeringId,
          choice_id: choiceId,
          occurrence_id: occurrenceId,
          activity_id: bundle.activity_id,
        })
      }
    }
  }

  return { choices, choiceOfferings }
}
