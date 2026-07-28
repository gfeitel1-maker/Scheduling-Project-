> **ARCHIVED — historical record, not current authority.**
> Completed implementation plan. Describes work as planned at its date; the code has moved on since.
> Current law: [`docs/governance/GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md)

# camp_id projection guard

Design: `docs/superpowers/specs/2026-07-25-camp-id-projection-guard-design.md`. Single task, single file (plus tests).

## Task 1 — Guard `applyProjection` against foreign camp_id writes

**Success predicate:** `electron/ops/projections.js`'s `applyProjection(db, op)` rejects (silently drops with a `console.error`, does not throw) any op where `op.field === 'camp_id'` and `op.value` does not equal the device's own single camp id (`SELECT id FROM camps LIMIT 1`). Ops writing a matching `camp_id` continue to apply exactly as before (regression-safe). The guard runs after the existing `!projection.fields.includes(op.field)` check and before `ensureExists?.()` is invoked, per the design doc.

**Not done if:** the guard changes behavior for any non-`camp_id` field, or breaks any currently-passing test in `npm run test`.

**Files:** `electron/ops/projections.js`. Add/extend a test file (`electron/ops/projections.test.js` — create if it doesn't exist) with the 4 cases listed in the design doc's Testing section.

**Constraints carried forward:**
- Reject malformed/foreign input before it touches any DB write (default-deny).
- No throw — this runs during op-log replay/sync, a thrown error would abort a whole batch rather than skip one bad op.
