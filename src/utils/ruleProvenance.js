// Slice D (docs/adr/2026-08-22-roots-as-hub-setup-ia.md §7): tier derivation
// for the inferred-rule fields on the Activities screen (3 at Slice D; a 4th,
// co-schedule, added by T114's follow-up — see RULE_FIELDS below, which is the
// single source of the count).
// min_per_week/max_per_week are ONE logical field (one evidence record under
// 'min_per_week', one popover row, one Confirm writes both — see ingest.js's
// writeEvidence call sites for min_per_week).
//
// opField(s) are the operations.field name(s) this row's Confirm re-writes;
// evidenceField is the import_evidence.field name that key was written under
// during ingest (electron/ops/ingest.js) — the two vocabularies differ for
// eligible groups (`eligible_group_names` -> `eligible_group_ids`) and
// location (`location` -> `location_id`), per the Architect's data-path note.
export const RULE_FIELDS = [
  { key: 'min_per_week', label: 'Min–Max/Wk', opFields: ['min_per_week', 'max_per_week'], evidenceField: 'min_per_week' },
  { key: 'eligible_group_ids', label: 'Eligible groups', opFields: ['eligible_group_ids'], evidenceField: 'eligible_group_names' },
  { key: 'location_id', label: 'Location', opFields: ['location_id'], evidenceField: 'location' },
  // T114 follow-up. max_groups_per_slot/same_tier_only are ONE logical field
  // here for the same reason min/max per week are: the Co-schedule column
  // renders them as a single sentence ("Up to 3 (same age division)"), so
  // splitting them into two popover rows would ask the director to confirm
  // half of something they read as one fact.
  //
  // evidenceField is max_groups_per_slot — the row that is always written when
  // co-schedule is inferred at all. same_tier_only's own row is absent whenever
  // division membership was unknown, so keying on it would make the dot vanish
  // for exactly the camps whose divisions we could not work out.
  { key: 'max_groups_per_slot', label: 'Co-schedule', opFields: ['max_groups_per_slot', 'same_tier_only'], evidenceField: 'max_groups_per_slot' },
]

const TIER_RANK = { confirmed: 0, observed: 1, inferred: 2 }

// source is the last op's `source` for the field (operations.source): null or
// 'human' means a director wrote it -> confirmed, no matter what evidence
// says. Otherwise (source === 'import', or any other importer-stamped value)
// the field is not human-owned: an evidence row's tag decides observed vs.
// inferred, and a field imported with NO evidence row at all (a gap in what
// the Architect found on real fixtures) still reads as inferred rather than
// blank — it was never director-reviewed.
export function tierForField(source, evidenceTag) {
  if (source == null || source === 'human') return 'confirmed'
  if (evidenceTag === 'observed') return 'observed'
  return 'inferred'
}

export function worstTier(tiers) {
  if (!tiers || tiers.length === 0) return null
  return tiers.reduce((worst, t) => (TIER_RANK[t] > TIER_RANK[worst] ? t : worst), tiers[0])
}

// fieldSources: { [opField]: source|null }. evidenceByField: { [evidenceField]: evidenceRow|null }.
export function deriveActivityProvenance(fieldSources, evidenceByField) {
  return RULE_FIELDS.map((rf) => {
    const source = fieldSources?.[rf.opFields[0]] ?? null
    const evidence = evidenceByField?.[rf.evidenceField] ?? null
    return {
      ...rf,
      tier: tierForField(source, evidence?.tag ?? null),
      evidence,
    }
  })
}

// A row-level provenance dot renders only when at least one RULE_FIELDS entry
// actually has an import_evidence record — a hand-created activity (no
// import ever touched it) shows nothing, quiet by default.
export function hasAnyEvidence(evidenceByField) {
  return RULE_FIELDS.some((rf) => Boolean(evidenceByField?.[rf.evidenceField]))
}

// T119 (docs/work/tickets/T119-imported-location-capacity-provenance.md):
// the tier vocabulary (label, needs-a-look dot) below is shared between
// Activities' RuleProvenanceDot and Locations' capacity provenance dot so
// the meaning of each tier can never drift between the two screens. Moved
// here (out of ActivitiesScreen.jsx, which owned it first) rather than
// copy-pasted, because it is pure and carries WCAG-driven decisions (the
// contrast guard on the dot color, and shape-not-just-hue distinguishability)
// that a second hand-copied version would risk silently diverging from.
export const TIER_LABEL = { confirmed: 'Confirmed', observed: 'Observed', inferred: 'Inferred' }
// Owner ruling 2026-10-09 (design inventory batch K5): one visible state.
// Only an inferred field is marked, with a single bronze dot — "needs a look".
// Confirmed and observed fields came from the director or the file and carry
// no mark. The tier TEXT label in a popover always accompanies the dot
// (WCAG 1.4.1), so the dot no longer needs a shape per tier.
export function needsLook(tier) {
  return tier === 'inferred'
}

export const NEEDS_LOOK_DOT_STYLE = { background: 'var(--accent)', border: 'none', boxShadow: 'none' }

// locationCapacityProvenanceHandler (electron/main.js) returns a binary
// 'confirmed'|'unconfirmed' — capacity has no import_evidence record (unlike
// the activity rule fields), so tierForField's three-way tier collapses to
// two cases. This maps that binary onto the shared tier vocabulary above.
export function tierForCapacitySource(capacitySource) {
  return capacitySource === 'unconfirmed' ? 'inferred' : 'confirmed'
}

// Audit E4 (2026-10-10) — ONE rule field's needs-a-look state, for a surface that
// shows a single field rather than the whole Activities row (the elective
// offerings table's "Open to" column reads `eligible_group_ids`). The same tier
// rule as the Activities dot, so the two screens cannot disagree: inferred only
// while the last write was the importer's; a director's confirm or edit makes the
// last write theirs, and the mark clears.
export function fieldNeedsLook(key, fieldSources, evidenceByField) {
  const row = deriveActivityProvenance(fieldSources, evidenceByField).find((r) => r.key === key)
  return Boolean(row) && needsLook(row.tier)
}
