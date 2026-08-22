// Slice D (docs/adr/2026-08-22-roots-as-hub-setup-ia.md §7): tier derivation
// for the 3 owner-locked inferred-rule fields on the Activities screen.
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

// A row-level provenance dot renders only when at least one of the 3 fields
// actually has an import_evidence record — a hand-created activity (no
// import ever touched it) shows nothing, quiet by default.
export function hasAnyEvidence(evidenceByField) {
  return RULE_FIELDS.some((rf) => Boolean(evidenceByField?.[rf.evidenceField]))
}
