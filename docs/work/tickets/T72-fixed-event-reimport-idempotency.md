---
title: T72-fixed-event-reimport-idempotency
document_type: ticket
status: open
created: 2026-08-08
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md, docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md, docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
related_tickets: [docs/work/tickets/T61-replace-ingest-atomic-transaction.md, docs/work/tickets/T34-ingest-infer-fixed-event-blocks.md]
archive_when: a re-import of an unchanged schedule produces zero new anchor_activities rows, and the ingest suite covers fixed-event re-import idempotency
---

# T72 — Fixed-event (anchor) re-import is not idempotent

**Raised:** 2026-08-08, split out of the S1a design (Red Hat finding R5). S1a scopes its F4
"identical re-import → zero ops" guarantee to the **six ingestible entities only** and explicitly
does **not** claim fixed-event idempotency. This ticket owns that gap so it is not silently lost.

## The problem

The fixed-event loop in `commitPlan` (`electron/ops/ingest.js` ~363–420) runs **unconditionally** on
every import. For each fixed event it mints a fresh `randomUUID()` anchor per resolved day and
`appendOp`s it — with **no recognition of an already-created anchor**. So re-importing an unchanged
schedule creates **duplicate `anchor_activities` rows** every time, unlike the six ingestible entities,
which S1a now recognizes as `unchanged` (zero ops).

This is a pre-existing behavior (it predates S1), not a regression S1a introduces. S1a deliberately
leaves it in place and documents it rather than fixing it, because anchor identity-matching is its own
design problem (anchors have no name-unique constraint and fan out per-day).

## What "done" looks like (success predicate)

- A re-import of an **unchanged** schedule produces **zero new `anchor_activities` rows** — the
  fixed-event loop recognizes an already-present anchor and emits no op for it.
- The recognition key for an anchor is specified (candidate: `(camp_id, cohort_id, day_id,
  time_block_id, name, is_all_groups, group_ids)` or a subset that is the true identity of a fixed
  event) — this is the core design question and must be settled before code.
- A **changed** fixed event (e.g. a group added, a day removed) is handled per the reconciliation model
  in force when this ticket is built — at minimum it must not silently duplicate; ideally it recognizes
  and updates. Whether update lands here or defers to a reconciliation slice is a scoping decision for
  the design.
- The ingest suite covers re-import idempotency for fixed events (a fixture that imports the same
  fixed-event set twice and asserts no new anchor rows on the second pass).

## Notes / dependencies

- Interacts with T34 (infer fixed-event blocks) and the broader reconciliation program — coordinate the
  anchor-identity key with any anchor work those introduce.
- Anchors are written **only** in this loop and nowhere else in ingest; the generic op whitelist never
  lets `anchor_activities` through (`ingest.js` ~360–362), so the recognition logic lives entirely in
  this one loop.
- This is an **architecturally-significant** change (it defines anchor identity) — likely warrants an
  ADR or a design pass before implementation, not a straight Maker ticket.
