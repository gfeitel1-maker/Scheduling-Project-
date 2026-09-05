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

// T119 (docs/work/tickets/T119-imported-location-capacity-provenance.md):
// the tier vocabulary (label, dot color, dot shape) below is shared between
// Activities' RuleProvenanceDot and Locations' capacity provenance dot so
// the meaning of each tier can never drift between the two screens. Moved
// here (out of ActivitiesScreen.jsx, which owned it first) rather than
// copy-pasted, because it is pure and carries WCAG-driven decisions (the
// contrast guard on the dot color, and shape-not-just-hue distinguishability)
// that a second hand-copied version would risk silently diverging from.
export const TIER_LABEL = { confirmed: 'Confirmed', observed: 'Observed', inferred: 'Inferred' }
// Contrast guard: --accent (#B8833A) on --surface (#FCFBF8) at 11px text
// measures ~3.2:1, under the 4.5:1 AA floor for small text. The tier TEXT
// label always renders in --text; only the dot itself carries the tier hue
// (WCAG 1.4.1 — the dot is never the only signal, the label always
// accompanies it).
export const TIER_DOT_COLOR = { confirmed: 'var(--secondary)', observed: 'var(--primary)', inferred: 'var(--accent)' }

// WCAG 1.4.1 — tier must be distinguishable by dot SHAPE, not hue alone:
// confirmed = filled solid, observed = ring (no fill), inferred =
// outlined-fill (a filled dot plus a --surface gap ring, so it reads
// distinct from confirmed's plain fill at 6px). Color is unchanged; this
// only adds shape on top of it.
export function tierShapeStyle(tier) {
  if (tier === 'observed') {
    return { background: 'transparent', border: `1.5px solid ${TIER_DOT_COLOR.observed}`, boxShadow: 'none' }
  }
  if (tier === 'inferred') {
    return { background: TIER_DOT_COLOR.inferred, border: 'none', boxShadow: `0 0 0 1.5px var(--surface), 0 0 0 2.5px ${TIER_DOT_COLOR.inferred}` }
  }
  return { background: TIER_DOT_COLOR.confirmed, border: 'none', boxShadow: 'none' }
}

// locationCapacityProvenanceHandler (electron/main.js) returns a binary
// 'confirmed'|'unconfirmed' — capacity has no import_evidence record (unlike
// the activity rule fields), so tierForField's three-way tier collapses to
// two cases. This maps that binary onto the shared 3-tier vocabulary above.
export function tierForCapacitySource(capacitySource) {
  return capacitySource === 'unconfirmed' ? 'inferred' : 'confirmed'
}
