---
title: "Per-peer erasure state surfaced to the director (T233 S3)"
document_type: ticket
status: open
created: 2026-10-01
archive_when: a director can see, per peer, whether a purge-tombstone has been applied (UNKNOWN until the peer reports, LOGICALLY_ERASED only when its reported applied-version >= the tombstone's), read-only on DeviceManagerScreen, with the four never-claims met and Verifier PASS recorded
task_class: security-auth
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-19-multi-device-erasure-propagation.md, docs/adr/2026-09-30-elective-run-durability.md]
related_tickets: [docs/work/tickets/T233-multi-device-erasure-propagation.md]
related_specs: [docs/work/specs/2026-10-01-t233-s3-per-peer-erasure-state-ui-design.md]
---

# T322 — Per-peer erasure state surfaced to the director (T233 S3)

Closes the still-open "Visibility only" slice of
[T233](T233-multi-device-erasure-propagation.md). The erasure **mechanism** (S1 + S2)
shipped: a Host-signed, monotonic purge-tombstone, gated at projection time, so a purged
camper is refused fleet-wide. Only the return-value half of S3 shipped
(`purgeCamperRecord` returns `propagationPending`). The director still has **no** view of
per-peer erasure state. This ticket builds it.

Design and decisions are fixed by the organizer-ruled scoping note
[docs/work/specs/2026-10-01-t233-s3-per-peer-erasure-state-ui-design.md](../specs/2026-10-01-t233-s3-per-peer-erasure-state-ui-design.md)
(PR #706). This ticket is the build brief for it.

## Success predicate (observable)

Given two paired devices A and B sharing a camp, after A purges a camper:
- B reports, over the authenticated sync channel, the highest purge-tombstone **version
  it has applied**; that value is persisted on B's `devices` row.
- On A's **Device Manager** screen, B's row shows a read-only erasure-state flag:
  `UNKNOWN` until B has reported at all, and `LOGICALLY_ERASED` only once B's reported
  applied-version is `>=` the tombstone's version. A peer A cannot currently hear from
  stays `UNKNOWN`.
- No new screen, no per-peer action button, `revokeDevice` untouched.

## Slices (build in this order)

### S3a — backing signal (primary's seam: `electron/sync/automerge/**`), sequenced AFTER the camper-id build (T321)

A peer **self-reports its highest APPLIED purge-tombstone version** over the existing
authenticated sync channel — not a per-op ack, a single self-reported frontier. Persist
it on the reporting peer's `devices` row (new column, e.g. `applied_tombstone_version`,
default NULL = never reported). The report is the receiver's own truth (the highest
tombstone version its projector has actually applied), consistent with T233's
"receiver-applied, not sender-sent" principle and with the Stage-6 reality that the
legacy per-peer delivery watermark (`devices.last_synced_seq`, the retired `ws://`
`op_applied_ack` path) no longer exists.

- Test-first at the sync + schema seam (constitution rule 5): a peer that has applied
  tombstone vN reports `>= N`; a peer that has not reports `< N` or NULL; the column is
  written from the authenticated channel only, never from an unauthenticated source.
- Trust: the reported value is advisory display data about that peer's own state; it must
  not weaken any admission gate. Do not route it through the document (same off-document
  trust-root discipline T233 S1 established).

### S3b — director UI (this worker's seam: `src/screens/DeviceManagerScreen.jsx`), follows S3a

Render a **read-only flag** on each device row derived from that peer's
`applied_tombstone_version` vs the current max tombstone version: `UNKNOWN` vs
`LOGICALLY_ERASED`. Flag vocabulary, **not a banner**; no new screen; no per-peer action.

**Acceptance criteria — the four never-claims (adopted verbatim from the scoping note):**
1. Never "deleted" / "gone" / "wiped" — say *suppressed / invisible fleet-wide*, not
   destroyed (raw fields remain mergeable in CRDT history by accepted tradeoff).
2. Never cryptographic or physical erasure — this is guess-resistant logical erasure with
   a documented confirmation oracle (see #684's digest work, commit `16f809b6` /
   `4faf80c4`,
   [docs/work/runs/2026-10-01-a-finalized-run-s-digest-map-no-longer-carries-a-purged-camp.md](../runs/2026-10-01-a-finalized-run-s-digest-map-no-longer-carries-a-purged-camp.md)),
   closed only by the high-entropy camper-id change (T321).
3. Never certainty about a peer it cannot hear from — offline/never-returning peer reads
   `UNKNOWN`, never silently erased; off-device copies are out of scope.
4. Never a count it cannot back — render only the per-peer state the S3a column supports.

## Deferred (NOT in this ticket)

- The **event-level "propagation pending"** signal shown to a human, and any **in-app
  purge trigger**: the purge stays a headless support command until the owner asks for a
  director-facing purge. The organizer is putting that question to the owner separately.
- Physical byte-erasure across the fleet — out of scope by owner decision (logical
  erasure is the guarantee; genesis rotation is the break-glass).

## Seams needing test-first attention

- `electron/sync/automerge/**` + the `devices` schema column (S3a) — sync + security +
  migration seam.
- `src/screens/DeviceManagerScreen.jsx` (S3b) — reads the column; no write path.
