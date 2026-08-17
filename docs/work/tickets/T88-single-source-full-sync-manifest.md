---
title: T88-single-source-full-sync-manifest
document_type: ticket
status: open
created: 2026-08-16
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md, SECURITY.md]
related_tickets: []
related_adrs: []
related_specs: []
related_reports: [docs/work/architecture-reports/2026-08-16-sync-auth-audit-summary.md]
archive_when: "the camp-scoped entity set + FK order used to build the full_sync snapshot is defined in ONE shared module consumed by both electron/sync/syncServer.js (send side) and electron/sync/syncClient.js (apply side), so a table added on one side cannot be silently dropped on the other; a test proves a first-pairing Client receives and applies week_location_exclusions rows once they exist; and this ticket is merged with owner sign-off"
---

# T88 — Single-source the full_sync snapshot manifest (C2, sync/auth audit)

**Source:** F4 sync/auth audit (2026-08-16), candidate C2 — verified by hand, not just reported.

## The bug (LIVE — M5 has landed)

> **Update 2026-08-16:** M5 shipped. `week_location_exclusions` is now a real projection entity
> (`electron/ops/projections.js:233`), a registered camp-scoped entity (`campScopedEntities.js:62`),
> carries write/delete permissions, and is handled by `duplicateWeek`/`ingest`/`restore`. Rows can
> exist NOW, so this is a **live data-loss bug** — first-pairing Clients silently drop real location
> exclusions — not the pre-M5 guard the original draft described. The `syncServer.js:32` comment
> claiming "no rows exist until slice M5" is now FALSE and must be removed as part of the fix.
> Severity: elevated. The test seeds a row directly, which now reflects real behavior.
>
> **Update 2 (Red Hat, 2026-08-16) — TRUE SCOPE was four omissions, not one.** Code archaeology
> against `origin/main` showed the client apply-manifest was missing **all** of: `schedule_weeks`
> (the weeks themselves), `schedule_templates.week_id` (every template arrived week-unscoped,
> `week_id=NULL`), `week_activity_exclusions`, and `week_group_exclusions` — not just
> `week_location_exclusions`. First-pairing devices were dropping multi-week data wholesale; it only
> avoided visible breakage because the live-op path stub-seeds `schedule_weeks` on any later edit
> (masking, not fixing, the gap). The single-sourced `DOMAIN_SNAPSHOT_ORDER` closes all four at once.
> A SEPARATE pre-existing live-op edge (a late exclusion op can orphan on a missing week → swallowed
> `console.error`, projection never materialized, no retry) is NOT repaired here — tracked as
> [[T89-live-op-week-parent-seed]].

The set of camp-scoped tables (and their FK-safe order) that make up a first-pairing `full_sync`
snapshot is **hand-maintained in two places** and has **already drifted**:

- `electron/sync/syncServer.js` (`DOMAIN_PARENT_SCOPED_ENTITIES`, ~line 33) **includes**
  `week_location_exclusions` — the Host ships those rows in the snapshot.
- `electron/sync/syncClient.js` (the apply-side manifest, ~lines 34–76) **omits**
  `week_location_exclusions` — a first-pairing Client silently drops them.

**Verified:** `grep -c week_location_exclusions` → 3 in syncServer.js, **0** in syncClient.js.

Today this is **latent**: a code comment notes "no `week_location_exclusions` rows exist until
slice M5," so nothing is dropped yet. But **the locations program is actively in flight**
(`claude/locations-m6-map`). When M5 lands and rows appear, a device that pairs for the first time
will silently receive a schedule missing its location exclusions — a data-completeness bug that is
invisible until a director notices a wrong schedule on a newly-paired device. This ticket is a
**pre-M5 guard**: close the drift *before* it can arm.

## Why one module, not "just add the line"

Adding `week_location_exclusions` to the client list fixes today's instance but leaves the
**mechanism** that produced it — two hand-maintained lists that must be kept in lockstep by memory.
The next camp-scoped table added on one side will drift again. The fix is a single shared manifest
(entity set + parent/FK order) that both send and apply sides import, so divergence becomes
structurally impossible. There is precedent: `campScopedEntities.js` already holds the registries
`DIRECT_CAMP_ENTITIES` / `PARENT_SCOPED_ENTITIES` — this manifest belongs beside them (or extends
them) rather than being re-declared per file.

## Success predicate (observable)

1. The full_sync snapshot entity set + FK-safe order is defined ONCE (a shared module; extend
   `campScopedEntities.js` if it fits) and imported by both `syncServer.js` (send) and
   `syncClient.js` (apply). Neither file re-declares the list.
2. `week_location_exclusions` is present on both sides (the current drift is closed).
3. **Test-first at the sync seam:** an integration/characterization test pairs a fresh Client and
   asserts that a `week_location_exclusions` row written on the Host is present in the Client's DB
   after first-pairing full_sync. It must FAIL against current `main` (proving the drop) and pass
   after the fix. Seed a row directly for the test — do not wait on M5.
4. FK-safe apply order preserved (snapshot still applies cleanly under `foreign_keys=ON`; parents
   before children).
5. `npm run verify` green (includes `test:integration`, which is where the sync scenarios live).

## Review routing

Red Hat (this is op-log / full_sync / first-pairing replay — its mandated territory) → Code Reviewer
→ Verifier → Grader. No ADR (bug fix + de-duplication, no new architecture decision).

## Coordination note

Low overlap with `claude/t87-returning-client-reauth` (T87 reworks reauth, not the snapshot manifest),
so this can proceed in parallel. The audit's OTHER candidates (C1 delivery/watermark seam, C3
device-trust predicate, C4 keyed ack registry) DO land on T87's lines and are flagged to that branch
instead — do not pull them into this ticket.

## Non-goals

- No change to the op-log or conflict model; this is snapshot-manifest completeness only.
- Not implementing M5 location-exclusion behavior — only ensuring the sync plumbing won't drop its
  rows when they arrive.
