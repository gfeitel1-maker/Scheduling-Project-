---
task: S3a self-report monotonic guard — peer_tombstone_reports upserts only when incoming version >= stored (board q-s3a-self-report-monotonic-guard)
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: []
related_specs: []
related_adrs: [docs/adr/2026-09-19-multi-device-erasure-propagation.md]
selected_agents: [governor, maker, verifier, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: backend auth/persistence seam; no UI surface.
  - agent: tester
    reason: not-applicable
    note: no screen or running-app UX.
  - agent: architect
    reason: not-applicable
    note: a one-clause upsert correctness fix within the shipped S3a design; no new decision.
  - agent: security
    reason: not-applicable
    note: safe-direction-only regression (can lower a reported version, never fabricate erased); Red Hat covered the write path.
deterministic_checks: [electron/auth/connectionAuth.test.js, electron/auth/localAuth.test.js, electron/ops/commitElectiveRun.test.js, npm run check:governance, npm run lint]
human_gates: []
archive_when: superseded when the per-peer erasure badge (T322 S3b, merged #712) and this guard are jointly exercised end to end in a multi-device walk
---

# Run record — S3a self-report monotonic guard

- **Board item:** `q-s3a-self-report-monotonic-guard` (organizer-filed from the #712 Red Hat report)
- **Branch:** `claude/board-appendop-throw-and-monotonic-guard` (off `main`, base #714 `f8626a3c`)
- **Schema change:** none

## What landed
`electron/auth/connectionAuth.js` `persistAppliedTombstones`: the blind `INSERT OR REPLACE` is now a
monotonic upsert — `ON CONFLICT(device_id, tombstone_id) DO UPDATE SET version = excluded.version,
reported_at = excluded.reported_at WHERE excluded.version >= peer_tombstone_reports.version`. A stale or
out-of-order re-authenticate can no longer lower a peer's stored (tombstone_id, version), so a confirmed
peer no longer flickers LOGICALLY_ERASED → UNKNOWN. Safe direction only (it never fabricated erased),
so no privacy change — this is a flicker/monotonicity fix.

## Evidence
- `electron/auth/connectionAuth.test.js` — monotonic-guard tests: a replayed OLDER report after a newer
  one leaves the stored version unchanged; a newer report still advances; a first report inserts
  (red-before-green).
- CI (`.github/workflows/gate.yml`) is the gate of record.

## Scope note — the batch was split
This item was originally batched with `i-appendop-silent-camp-id-rejection` (an appendOp camp_id throw).
That throw was DROPPED after CI (#717) showed its premise was wrong: `camp_id` is a registered
projection field, and applyProjection's `false`-return is a deliberate security guard that refuses a
write whose camp_id does not match the device's single camp (a remote-smuggle defense), NOT a masked
legitimate local write — a local write of the device's own camp_id applies normally. Throwing on it
broke legitimate flows (multi-camp test fixtures; bootstrap before the camps row exists) by rolling back
the whole runAtomic boundary. The board item is marked premise-wrong. This PR ships only the monotonic
guard, which is independent.
