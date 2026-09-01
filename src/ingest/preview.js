// Recognition-key helpers shared by the whole ingest pipeline (and the live
// schedule grid — useSlotMutations.js, CellInlineEditor.jsx). Despite the
// filename, this module is no longer about UI preview: ADR
// 2026-08-17-onescreen-reconciliation-merge.md §2/A2 deleted `buildPreview`/
// `describePreview`/`ENTITY_WORD` (their gating and skip/already-in-camp role
// is redundant with buildPlan's own matching, now that ReconciliationScreen —
// not this screen's tick step — is the one workspace) and moved
// `looksLikeAMerge` into buildPlan.js (§1). `normalizeName`/`recognitionKey`
// are load-bearing identity-matching primitives used by 10+ modules and stay
// here.

// The same rule the per-screen imports use. Both paths must agree, or the same
// file imported two ways gives two different camps.
export function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// Like normalizeName but ALSO space-insensitive (removes all whitespace, not
// just collapsing runs): "Lunch 2" and "Lunch2" share this key, while
// normalizeName keeps them distinct. Used where a whitespace/case typo must NOT
// mint a duplicate — the ingest typo-canonicalization and the live create gates.
// It does NOT merge word-form differences ("Swim Return" vs "Swim Returning").
export function whitespaceInsensitiveName(name) {
  return String(name ?? '').toLowerCase().replace(/\s+/g, '')
}

// M4 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D3). The
// recognition key every entity's identity is keyed by. `locations` is the ONE
// deviation: its id (deriveLocationId) and its UNIQUE(camp_id, name) constraint
// are TRIM-only, case-sensitive — "Pool" and "pool" are two legitimate rows the
// M3c merge gate can heal, not one entity two spellings of. Recognizing them the
// same way every other entity does (case-folded) would silently resolve a
// schedule-grid "pool" onto an existing "Pool" row, contradicting the migration's
// own dedupe key. Every call site that builds a recognition-map key or does a
// recognition lookup for entity identity must use this, not normalizeName
// directly — see the ADR's Red Hat note: the enumeration there is a starting
// list, not exhaustive.
export function recognitionKey(entity, name) {
  return entity === 'locations' ? String(name ?? '').trim() : normalizeName(name)
}
