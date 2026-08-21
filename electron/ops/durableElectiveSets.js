// The one query every reuse/durable-inventory surface must use (T103,
// docs/adr/2026-08-20-electives-authoring.md D2;
// docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md D3): a
// tier-(a)/(b) elective set (is_reusable = 0) must never appear in a durable
// listing. This is the load-bearing invariant the durability ADR names as
// the failure mode to guard — get it wrong and a one-off "Slip-n-Slide"
// becomes permanent camp vocabulary. Tier (c) durable electives surface in
// the Roots CONTEXT inventory, never the ingestible census (electives are
// authored, never reconstructed from a file) — this helper is the query that
// feeds that Context listing and the reuse palette alike; callers do not
// filter is_reusable themselves.
export function listDurableElectiveSets(db, campId) {
  return db
    .prepare(
      `SELECT * FROM elective_sets
        WHERE camp_id = ? AND is_reusable = 1
        ORDER BY sort_order IS NULL, sort_order, name`
    )
    .all(campId)
}
