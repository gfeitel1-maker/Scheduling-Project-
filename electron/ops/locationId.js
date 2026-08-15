// Pure, dependency-free id derivation for `locations` rows, shared between
// electron code (the v32 migration backfill in electron/db/localDb.js, which
// mints one locations row per distinct free-text place string) and the restore
// path (electron/ops/restore.js, which re-binds a restored pre-v32 activity's
// location_id from its frozen `location` string — INV-2).
//
// It lives under electron/ rather than src/ on purpose — same reasoning as
// electron/ops/scheduleTemplateId.js: electron-builder ships only `electron/**`,
// so an electron-side import of a src/ module fails in the installed app at
// migration time. The renderer may import in this direction (Vite bundles it
// into dist/, which ships).
//
// WHY DETERMINISTIC (INV-1, docs/adr/2026-08-15-camp-locations-entity.md): the
// backfill is a DDL-time side effect that emits NO op (exactly like the v27
// schedule_weeks backfill `schedule-week:${campId}:1`). Every device runs its
// own v32 migration independently, so the id minted for the same place MUST be
// byte-identical across devices — computed only from replicated inputs
// (camp_id + the place name). A random UUID or a device-scoped id would make an
// already-paired Host and its tablets mint different ids for the same "Pool",
// and a later capacity/rename/exclusion op would match zero rows on every other
// device — the silent cross-device hole this whole initiative exists to close.
//
// NORMALIZATION CONTRACT: `name` MUST already be the canonical trimmed name —
// `String(location).trim()`, case-sensitive, NO case-fold (INV-1 / §9.1). The
// id key and the dedupe key are the SAME key: `"Pool"` and `"pool"` derive two
// distinct ids and remain two distinct rows (CONSTITUTION Art. V forbids the
// silent merge). Callers trim with plain JS `.trim()` — never SQL `TRIM()`,
// whose whitespace semantics differ — so the migration and restore agree.
//
// campId is a randomUUID (hyphens, no colon), so the `location:` prefix and the
// two colon separators are unambiguous even when the name itself contains a
// colon. Mirrors the `schedule-week:${campId}:1` precedent.
export function deriveLocationId(campId, trimmedName) {
  return `location:${campId}:${trimmedName}`
}
