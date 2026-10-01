---
title: "Camper ids stop embedding the display name"
document_type: ticket
status: completed
created: 2026-10-01
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-10-01-camper-id-high-entropy-format.md]
related_tickets: [docs/work/tickets/T233-multi-device-erasure-propagation.md]
archive_when: "campers.id is a random opaque token for every newly-created camper, indistinguishable by inspection from any other high-entropy id; a new replicated camper_identity_keys entity resolves (camp_id, key_mode, key_value) -> camper_id before minting, replicates, and is denylisted on purge; two devices importing the identical sheet for a camper neither has seen, without syncing first, converge on one camper_id after merge with nothing lost, proven by an integration test; the cross-device orphan case (two devices minting two different random ids for the same logical camper) is detected and resolved on next touch by moving the losing device's dependent rows onto the winning id, not dropping them; purgeCamperRecord deletes the camper's camper_identity_keys row in the same transaction as its other dependent deletes and refuses to purge the losing side of an unresolved identity contest; a re-imported sheet for an already-known camper resolves to the same campers.id it always has, both pre- and post-migration; SECURITY.md's purge section reflects the new, narrower camper_identity_keys caveat"
---

# T321 — Camper ids stop embedding the display name

Implements [docs/adr/2026-10-01-camper-id-high-entropy-format.md](../../adr/2026-10-01-camper-id-high-entropy-format.md)
(Option B, organizer-accepted 2026-10-01, board item `q-camper-id-embeds-display-name`).

## Problem

`electron/ops/electiveDerivedIds.js`'s `deriveCamperId` `name` mode returned a length-prefixed
concatenation carrying the canonicalized display name, assigned directly as `campers.id` on the
sheet-import path. That id then propagated in cleartext into purge tombstones, the elective-run
digest-map keys, and every log line or export that carried a `camper_id` — a replicated, permanent,
fleet-wide record of a child's name, for an entity this app otherwise treats as deliberately
minimal-footprint PII.

## What shipped

- `campers.id` is now a random, opaque, high-entropy token (`mintCamperId()`,
  `electron/ops/electiveDerivedIds.js`) for every newly-created camper, across all three key modes
  (`sub`/`ext`/`name`).
- A new replicated entity, `camper_identity_keys` (schema v85), holds the deterministic,
  convergent mapping `(camp_id, key_mode, key_value) -> camper_id` — keyed on exactly
  `deriveCamperId`'s existing derivation, repurposed as a lookup-row id rather than discarded.
- All four real camper-id-minting call sites (`attributeElectiveSubject.js`,
  `src/ingest/preferenceSheet.js` x2, `src/localClient.mock.js`, plus `commitElectiveRun.js`'s
  parsed-camper resolution) resolve through `electron/ops/camperIdentityResolver.js`'s
  `resolveOrMintCamperId`/`resolveParsedCamperId` before minting.
- Cross-device orphan convergence: a silent background rekey on next touch moves a losing device's
  dependent rows across all four camper-scoped tables (`elective_preferences`,
  `elective_assignments`, `elective_run_outer_snapshots`, `elective_run_findings`) onto the winning
  camper id, following `attributeElectiveSubject.js`'s existing rekey discipline.
- `purgeCamperRecord` deletes the purged camper's `camper_identity_keys` row in the same transaction
  as its other dependent deletes, the tombstone denylist covers it (keyed on `camper_id`), and the
  purge path refuses outright when the target id is the known-losing side of an unresolved identity
  contest (a Red Hat finding from this ticket's build) rather than silently destroying unmerged data.
- Migration v85 back-fills `camper_identity_keys` for every existing `ext`/`name`-mode camper by
  re-deriving `(key_mode, key_value)` from the camper's own columns, without re-keying any existing
  `campers.id` (deliberate, pre-production, no live data — see the ADR's "Tombstones & digest keys
  already written" section). The back-fill does not itself replicate (no migration in this codebase
  writes through the op log); a device joining fresh after the migration self-heals via the same
  orphan-rekey mechanism on its own first touch — documented as an accepted limitation in both the
  migration's comment and the ADR.
- `SECURITY.md`'s purge section and `docs/current/PLATFORM_STATE.md` updated per ADR acceptance
  criterion 7.

## Review

Verifier PASS (full migration glob, focused suite, integration suite x2, independent red-before-green
reproduction of the orphan-rekey plant). Dedicated Red Hat pass on the convergence/orphan-rekey
mechanism found and this ticket fixed: incomplete rekey table coverage (2 of 4 tables), a purge race
against an unresolved orphan, and a migration-backfill replication gap — see the ADR and commit
history for the resolution of each. Security: no findings — the privacy payoff is delivered as
designed (`camper_identity_keys` correctly denylisted, purged transactionally, admin-scoped at least
as tightly as `campers`). Code Reviewer: REQUEST CHANGES on first pass (a currently-failing
`restore.js` registry gap, a `PARTICIPANT_ENTITIES` registration gap, branch staleness) — all
resolved in this ticket's follow-up commits.
