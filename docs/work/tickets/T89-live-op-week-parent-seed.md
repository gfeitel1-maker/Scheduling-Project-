---
title: T89-live-op-week-parent-seed
document_type: ticket
status: completed
created: 2026-08-16
completed: 2026-08-17
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T88-single-source-full-sync-manifest.md]
related_adrs: []
related_specs: []
related_reports: [docs/work/architecture-reports/2026-08-16-sync-auth-audit-summary.md]
archive_when: "a week-scoped exclusion op that arrives for a schedule_weeks row not yet present on a device seeds (stub) that parent row instead of throwing SQLITE_CONSTRAINT_FOREIGNKEY and silently dropping the projection — matching the T85 device-FK-seeding house pattern — proven by a test that replays such an out-of-order op and asserts the exclusion materializes; and this ticket is merged with owner sign-off"
---

# T89 — Stub-seed the week parent for late exclusion ops

**Source:** Red Hat review of T88 (2026-08-16). Distinct from T88: T88 fixed the first-pairing
SNAPSHOT manifest; this is a pre-existing defect on the LIVE-OP path.

**Scope note (2026-08-17):** trimmed to the mechanism fix only. The original draft included a Part B
field-diagnostic (scan logs for already-affected devices), but Shoresh is **pre-production — no live
users or devices yet** ([[feedback-preproduction-bias-bold]]), so there are no field devices to
diagnose. This is now a purely forward-looking correctness fix. It still matters pre-production: a
swallowed projection failure is silently-dropped functionality, which the quality bar rejects
regardless of live data.

## The defect (pre-existing, not introduced by T88)

`ensureWeekJoinRow` (`electron/ops/projections.js:~30-49`) issues a raw
`INSERT ... REFERENCES schedule_weeks(id)` when applying a `week_*_exclusions` projection. Under
`foreign_keys=ON`, if the referenced `schedule_weeks` row is **not present locally** — any ordering
where the exclusion op outruns the week-level op — the insert throws `SQLITE_CONSTRAINT_FOREIGNKEY`.
That throw is caught by the generic handler at `electron/sync/syncClient.js:~548-553`, logged via
`console.error`, and the op is **marked applied in the log while its projection is permanently
unmaterialized**. No retry re-runs a failed projection. The exclusion is silently missing on that
device, evidenced only by a swallowed log line.

`schedule_weeks` is the odd one out: T85 established the house pattern of **stub-seeding an FK parent**
so a late live op can't orphan itself (it did exactly this for the `devices` row from `op.device_id`).
`week_*_exclusions` ops should seed their `schedule_weeks` parent the same way.

## The fix (test-first)

1. When a `week_activity_exclusions` / `week_group_exclusions` / `week_location_exclusions`
   projection references a `schedule_weeks` row not present locally, **stub-seed** that
   `schedule_weeks` row (minimal valid shape — mirror `PROJECTIONS.schedule_weeks.ensureExists`:
   `name=''`, `sort_order=0`, `is_archived=0`, correct `camp_id`) BEFORE the exclusion insert,
   inside the same transaction, rather than letting the FK throw. A subsequent real week op
   (already idempotent via the op-log) fills in the real week fields.
2. Test-first: replay an out-of-order op stream (exclusion op for a week the device has never seen)
   and assert the exclusion row materializes and the parent week exists as a stub — a test that
   FAILS against current code (FK throw → swallowed → row absent) and passes after.
3. Do NOT weaken `foreign_keys=ON` or the generic catch — the fix removes the orphan condition, it
   does not hide the throw.

## Success predicate (observable)

1. An out-of-order exclusion op seeds its `schedule_weeks` parent instead of throwing; the exclusion
   materializes. Pinned by a new test (fail-before / pass-after).
2. No regression in existing projection/sync tests; `foreign_keys=ON` preserved; `npm run verify` green.

## Review routing

Red Hat (op-log / projection / out-of-order replay — its territory) → Code Reviewer → Verifier →
Grader. No ADR (bug fix consistent with the existing T85 stub-seed pattern; if the seeding approach
turns out to need a design decision, escalate to Architect).

## Non-goals

- Not changing the full_sync snapshot manifest (that is T88).
- No field-device diagnostic/remediation — pre-production, nothing to find (see scope note).
