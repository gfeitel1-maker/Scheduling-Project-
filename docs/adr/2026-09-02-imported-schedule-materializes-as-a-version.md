---
status: proposed
---

# Importing a prior-year schedule materializes it as a saved version, not the working grid

## Context

Slice 1 (merged, 68c7ca7) built `src/ingest/capturePlacements.js` — a pure function that walks the
same parsed pages/proposal shape as the rest of ingest and returns
`{ placements: [{ groupName, dayName, blockLabel, activityName }] }`, one entry per activity or
fixed-event occurrence in the imported grid, spelled through `proposal.canonicalMap` so names
already match the catalog. It is not wired into any commit path yet.

Slice 2 has to turn those placements into something a director can pull up: a `schedule_snapshots`
row (a "version"), per the product rule "grid = workbench, versions = woodpile" — the imported
placements must never auto-fill the live working grid.

`commitIngest` (`electron/ops/ingest.js`) is host-only, runs in one SQLite transaction, and is
governed by a written, tested invariant: only six setup entities (`cohorts, tiers, groups,
days_of_operation, time_blocks, locations, activities`, plus fixed events as `anchor_activities`)
may be created inside it (`INGESTIBLE_ENTITIES`, docstring at the top of the file, ADR
2026-08-01-ingesting-a-prior-year-schedule.md §2/§4). Widening that whitelist to also write
`schedule_templates` and `schedule_snapshots` is exactly the kind of scope-creep the whitelist
exists to make deliberate rather than accidental.

## Decision

Materialize the version **after `commitIngest` returns, inside the same host-only `ingestCommit`
IPC handler call** (`electron/main.js`), not inside `commitIngest`'s transaction.

`commitIngest` stays untouched — no new entities in its whitelist, no schema change. Immediately
after it returns successfully, still synchronously, still inside the same handler invocation (no
IPC round-trip, no yield back to the event loop that another write could land in), the handler:

1. Resolves `week_id` — the camp's first non-archived `schedule_weeks` row, ordered by
   `sort_order`.
2. Resolves/mints the `schedule_templates` row for `(week_id, kind: 'manual')`, reusing the exact
   pattern `scheduleRepository.js:250` already uses client-side
   (`writeFields('schedule_templates', templateId, { kind, camp_id, week_id, name })`), but called
   host-side through `syncClient.write(...)` so the write goes through the normal op-log/broadcast
   path instead of a bespoke one.
3. Reads the now-committed catalog (`activities`, `anchor_activities`, `groups`,
   `days_of_operation`, `time_blocks`) and builds name→id maps.
4. Calls a new pure resolver (`electron/ops/resolveImportedPlacements.js`) that turns
   `placements` + those maps into snapshot slot rows plus an unresolved list.
5. Writes ONE `schedule_snapshots` row via `syncClient.write`, same shape
   `useSnapshots.js:52` already writes (`template_id, name, is_auto, created_at, slots,
   day_overrides_json`), name `"Imported schedule"`, `is_auto: false`, `day_overrides_json: '[]'`.
6. Returns `{ ...commitOutcome, version: { created, snapshotId, unresolvedCount,
   unresolvedNames } }` so the renderer can surface a distinct message.

This is Option B from the two candidates weighed (materialize inside `commitIngest`'s transaction,
vs. after it returns), refined to close the race the "after it returns" framing suggests: because
JS on the host and better-sqlite3 are both synchronous, and this all happens inside one IPC
handler invocation before control returns to the renderer, there is no window for a second write
(from this device or a peer's replayed op) to land between the catalog commit and the version
materialization. It is two SQLite transactions, not one — non-atomic in the database sense — but
there is no concurrency gap in practice, because nothing else can run on this thread in between.

## Considered alternatives

- **Inside `commitIngest`'s transaction (Option A).** True atomicity, but reopens the whitelist,
  requires threading `placements` through the transaction and adding an `activityIdByName` /
  anchor-name→id map inside it, and duplicates that maintenance burden in
  `localClient.mock.js`'s parity implementation. Rejected: the whitelist is a deliberate, ADR'd
  invariant: the smallest correct change respects it rather than re-litigating it for one caller.
- **Fail the whole import if the version write fails (transactional rollback of the catalog
  too).** Considered and rejected: the catalog import (the six entities) is the load-bearing
  outcome for setup screens; a director who imported a working catalog should not lose it because
  a schedule-placement name collided. The version write's failure is reported distinctly instead
  (see below) — an accepted, documented non-atomicity, not a silent one.
- **A new `source`/`provenance` column on `schedule_snapshots`.** Would satisfy "an imported
  version is traceable as such" more precisely, but is a schema change for a feature this size.
  Rejected for v1: the version's `name` ("Imported schedule") carries that information in the same
  place a director already looks (the version list), at zero migration cost. Revisit only if a
  real need for machine-readable provenance shows up.

## Consequences

- An import failure that leaves 0 of N placements resolved must NOT report as a silent success:
  `version.created: false` with a nonzero `unresolvedCount` equal to `placements.length` is the
  signal, and the ingest UI must surface it, not just the catalog import's own success message.
- Every *successful* `ingestCommit` call that carries `placements` creates exactly one new
  `schedule_snapshots` row — re-importing (Add or Replace) always creates another version, it never
  overwrites or dedupes an earlier import's version. This matches "versions are a woodpile," and
  is the intentionally simple v1 rule; there is no dedicated idempotency key on the snapshot write
  beyond what `ingestCommit` already has. If IPC-level retries of `ingestCommit` turn out to
  happen (none are known today), a duplicate version is the failure mode, not silent data loss —
  acceptable for v1, worth a follow-up ticket if retries are ever added.
- The imported version restores exactly like any other version through the unchanged
  `restoreSnapshot` path (`useSnapshots.js:113`) once written, including anchor/fixed-event cells,
  because the resolver is anchor-aware.
- Anchor names and activity names are resolved through the same `normalizeName` key `commitIngest`
  already uses for the six entities — no new identity rule introduced.
