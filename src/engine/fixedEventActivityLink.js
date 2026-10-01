// A fixed event (`fixed_events`) references its activity BY ID via
// `fixed_events.activity_id`, set at write time by ingest (electron/ops/
// ingest.js) and the Fixed Events screen (src/screens/FixedEventsScreen.jsx). T267
// PR 1 (docs/adr/2026-09-26-fixed-recurring-event-identity-model.md) added
// the column and backfilled it; PR 2 (this cutover) wires every write path
// to set it and deletes the name-matching fallback that used to stand in for
// it. A fixed event with no resolvable activity_id resolves to `[]` — that
// is now a real gap (see buildSchedule.js's FIXED_EVENT_IDENTITY_GAP finding),
// not a name-lookup miss.
//
// This module is the one place that link is resolved, so buildSchedule (pass 1
// placement) and weekCatalog (week-exclusion suppression) cannot drift apart.
export function resolveFixedEventActivityIds(fixedEvent) {
  return fixedEvent?.activity_id != null ? [fixedEvent.activity_id] : []
}
