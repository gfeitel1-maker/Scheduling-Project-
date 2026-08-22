// Shared four-domain vocabulary and rollup, used by ReconciliationScreen's
// own filter chips AND the Roots reconstruction moment (ADR
// docs/adr/2026-08-18-roots-reconstruction-moment-gating.md, "Reused vs.
// new"). One source of truth so the moment's Phase 2 settle can never show a
// domain state that disagrees with the workspace it hands off to.

export const DOMAIN_OF = {
  cohorts: 'Structure',
  tiers: 'Structure',
  groups: 'Structure',
  days_of_operation: 'Time',
  time_blocks: 'Time',
  locations: 'Facility',
  activities: 'Scheduling',
  anchor_activities: 'Scheduling',
  // Slice 3a: an elective_candidate decision carries entity: 'elective_sets'
  // (reconciliationReport.js), but 'elective_sets' is deliberately NOT added
  // here — DOMAIN_OF's keys are pinned 1:1 against CHILD_OF/the census
  // snapshot (existingSnapshot.test.js's R1 regression test), a separate
  // concern this slice does not extend. domainOf() falls through to
  // `undefined` for this decision, same as any other entity absent from this
  // table — the decision still renders in the hold lane, just uncategorized
  // in the domain-rollup chips. Revisit alongside a real CHILD_OF/census
  // entry for elective_sets, not silently here.
}
// Root-map port (docs/adr/2026-08-18-rootmap-screen-port.md §3) widens this
// from four domains to five. 'Context' intentionally has NO entry in
// DOMAIN_OF/REQUIRED_GAP_DOMAIN below — no ingested entity maps to it today,
// by design, so it organically renders zero decisions everywhere this
// vocabulary is consulted, with no special-cased boolean anywhere.
export const DOMAINS = ['Structure', 'Scheduling', 'Time', 'Facility', 'Context']

// Presentation-only label map (same ADR §3) — the canonical key stays
// 'Facility' (DOMAIN_OF, filter chips, and existing tests all key on it);
// the root-map's captions display 'Facility' itself for it too — a longer
// form ("Resources", "Location(s)") duplicated the 'Locations' entity node's
// own caption (Tester finding), so the domain keeps its own bare name.
export const DOMAIN_LABELS = {
  Structure: 'Structure',
  Scheduling: 'Scheduling',
  Time: 'Time',
  Facility: 'Facility',
  Context: 'Context',
}

// F3 — required_gap decisions carry no `entity` (DOMAIN_OF is keyed by entity
// name); they carry `screen` instead (readiness.js's REQUIRED_AREAS key).
// Same five-domain vocabulary, no second domain table.
export const REQUIRED_GAP_DOMAIN = {
  tiers: 'Structure',
  groups: 'Structure',
  days: 'Time',
  timeblocks: 'Time',
  activities: 'Scheduling',
}

export function domainOf(decision) {
  return decision.kind === 'required_gap'
    ? (REQUIRED_GAP_DOMAIN[decision.screen] ?? 'Structure')
    : DOMAIN_OF[decision.entity]
}

// Root-map port §2 — a second, small lookup for sub-domain ("child") node
// attribution. Keyed the same way as DOMAIN_OF (by entity name) / a separate
// screen-keyed table for required_gap decisions, same split DOMAIN_OF and
// REQUIRED_GAP_DOMAIN already use. An entity/screen with no entry here falls
// back to a domain-level 'General' pseudo-child (childOf below), never
// silently dropped.
export const CHILD_OF = {
  cohorts: 'Program',
  tiers: 'Age Divisions',
  groups: 'Groups',
  days_of_operation: 'Days',
  time_blocks: 'Time Blocks',
  locations: 'Locations',
  activities: 'Activities',
  anchor_activities: 'Fixed Events',
}

export const REQUIRED_GAP_CHILD_OF = {
  tiers: 'Age Divisions',
  groups: 'Groups',
  days: 'Days',
  timeblocks: 'Time Blocks',
  activities: 'Activities',
}

export function childOf(decision) {
  const child = decision.kind === 'required_gap'
    ? REQUIRED_GAP_CHILD_OF[decision.screen]
    : CHILD_OF[decision.entity]
  return child ?? 'General'
}

// Per-domain count of decisions still needing the director's attention
// (unresolved). A domain with count 0 reads as "understood" for the moment's
// Phase 2 settle; a domain with count > 0 reads as "needs attention" — the
// same binary the ADR's ported prototype draws per root.
export function computeDomainCounts(decisions, isResolved) {
  const counts = {}
  for (const domain of DOMAINS) {
    counts[domain] = decisions.filter((d) => domainOf(d) === domain && !isResolved(d)).length
  }
  return counts
}
