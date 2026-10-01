---
title: "T233 S3 — where per-peer erasure state lives in the director's UI"
document_type: spec
status: draft
created: 2026-10-01
task_class: security-auth
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_tickets: [docs/work/tickets/T233-multi-device-erasure-propagation.md, docs/work/tickets/T202-camper-record-purge-path.md]
related_adrs: [docs/adr/2026-09-19-multi-device-erasure-propagation.md, docs/adr/2026-09-30-elective-run-durability.md]
archive_when: superseded by the T233 S3 build ticket this note becomes the brief for
---

# T233 S3 — per-peer erasure state in the director's UI (scoping note)

**This is a design note, not an ADR and not a build.** It answers four questions the
organizer posed for T233 slice 3 ("Visibility only") so the organizer can rule, after
which it becomes the build brief. No code is proposed here.

## What already exists (the facts this note rests on)

- The erasure **mechanism** — S1 + S2 — shipped and is verified: a Host-signed,
  monotonically-versioned purge-tombstone, gated at projection time, so a purged
  camper is refused fleet-wide and never re-appears in any device's SQLite/UI
  ([docs/work/tickets/T233-multi-device-erasure-propagation.md](../tickets/T233-multi-device-erasure-propagation.md),
  "Final status (2026-09-19)";
  [docs/adr/2026-09-19-multi-device-erasure-propagation.md](../../adr/2026-09-19-multi-device-erasure-propagation.md)).
- Only the **return-value** half of S3 shipped: `purgeCamperRecord` returns
  `propagationPending: true` and reports fleet-erasure complete only once the tombstone
  has reached ≥1 live peer. The **director-facing** half — per-peer state and the
  pending signal shown to a human — has no home, because **the purge is a support
  command with no director UI at all today** (same ticket, "Remaining (ticket stays
  open for this): S3 per-peer erasure-state UI").
- Erasure also had to reach the finalized elective-run **digest map**: a purged
  camper's id once survived in cleartext in `elective_assignment_runs.snapshot_digest`,
  fixed by run-scoped hashing (#684 "Erasure reaches the finalized-run snapshot",
  commit `16f809b6`, and its follow-up commit `4faf80c4`;
  [docs/work/runs/2026-10-01-a-finalized-run-s-digest-map-no-longer-carries-a-purged-camp.md](../runs/2026-10-01-a-finalized-run-s-digest-map-no-longer-carries-a-purged-camp.md);
  [docs/adr/2026-09-30-elective-run-durability.md](../../adr/2026-09-30-elective-run-durability.md)).
  That work established the hard honesty limit this note carries into the UI:
  **erasure here is logical and guess-resistant, not cryptographic or physical** — a
  confirmation oracle remains until camper-id minting goes high-entropy (the
  concurrent camper-id build), and the UI must not overstate the guarantee.

## 1. Where the state lives

Two attachment points, and the recommendation is to use **both**, because they answer
two different director questions:

- **Per the device that must apply the erasure → [src/screens/DeviceManagerScreen.jsx](../../../src/screens/DeviceManagerScreen.jsx).**
  This is the only existing surface that already enumerates the fleet's peers (it polls
  `localClient.listDevices()` every 5s and renders each peer's `pairing_status` with
  admin approve/deny/revoke actions). The per-peer `UNKNOWN → LOGICALLY_ERASED` badge
  belongs on each device row here — the director's "which of my devices have caught up"
  question is already asked on this screen about pairing, and erasure propagation is the
  same shape of question.
- **Per the erasure event → wherever the purge is triggered.** That trigger does not
  exist in the UI yet, so S3's pending signal ("erased locally, propagation pending")
  is **gated on a purge-trigger surface being designed first.** This note does not
  design that surface; it flags the dependency so the organizer can sequence it.

## 2. Which existing surface it attaches to

`DeviceManagerScreen` — no new screen. A per-device row gains an erasure-state line,
styled as a **flag in the existing finding/flag vocabulary, never a banner** (standing
owner rule). The recommendation is explicitly *not* a new "Erasure" screen: a separate
surface would split the fleet view the director already reads on one page.

## 3. What the director can do from it

**Read, not act.** S3 is "visibility only" per the ticket. From the per-peer badge the
director can see, for each peer, whether erasure is confirmed-applied
(`LOGICALLY_ERASED`) or not-yet-known (`UNKNOWN`), and — at the event level, once a
purge trigger exists — whether propagation is still pending. No new action verb (no
"force erase on this peer", no retry button): the tombstone propagates through ordinary
sync, and a per-peer push would reintroduce exactly the live-device machinery T233
deliberately avoided (ticket Non-goals). The one thing a director already can do —
`revokeDevice` — stays as-is; evicting a peer is not an erasure action and must not be
relabelled as one.

## 4. What it must never claim

- **Never "deleted" / "gone" / "wiped".** The record is logically suppressed
  (projection-refused), and its raw fields remain mergeable in the CRDT history by
  accepted tradeoff (ADR "erasure guarantee"). The copy must say *suppressed /
  invisible fleet-wide*, not destroyed.
- **Never cryptographic or physical erasure.** Per #684's digest work, the guarantee is
  guess-resistance with a documented confirmation oracle, not unrecoverability. The UI
  must not imply the camper's data is cryptographically unrecoverable or byte-erased
  from disk.
- **Never certainty about a peer it cannot hear from.** `UNKNOWN` means exactly unknown
  — an offline or never-returning peer must read as `UNKNOWN`, never silently as
  erased. Off-device copies (backups, exports, a peer that never reconnects) are out of
  scope (ticket Non-goals) and must not be claimed as covered.
- **Never a count it cannot back.** See the open question below: today there is no
  per-peer "has peer X applied tombstone Y" ledger, so the UI must not render a
  fabricated per-peer confirmation it cannot derive.

## Open question the build ticket must resolve first (flagged, not decided)

**What signal backs `LOGICALLY_ERASED` per peer?** Today only a fleet-level
`propagationPending` (reached ≥1 live peer) exists. The old per-peer delivery watermark
(`devices.last_synced_seq`, the `ws://` `op_applied_ack` path in the retired
`syncServer.js`) is **gone** — Stage 6 replaced Host-socket sync with libp2p + Automerge
and the op log is now device-local history, not the sync channel
([CLAUDE.md](../../../CLAUDE.md), "Op log — local history, not sync"). So there is no
current per-peer ack that a specific tombstone was applied. The build ticket must decide
the backing signal (e.g. a peer self-reporting its highest-applied tombstone version
over the authenticated sync channel) before the badge can show anything stronger than
`UNKNOWN`. This is a real design decision for the S3 build, out of scope for this note.

## Recommendation (confidence: medium-high)

Attach the per-peer `UNKNOWN → LOGICALLY_ERASED` badge to `DeviceManagerScreen`'s
existing device rows as a read-only flag; defer the event-level "propagation pending"
signal until a purge-trigger surface exists; and make the backing-signal decision
(above) an explicit gate on the S3 build. The evidence is the T233 ticket's own S3
scope and `archive_when`, the absence of any other fleet-peer surface, and the
Stage-6 removal of the legacy per-peer watermark. The weak point is the open question:
the badge is only as honest as the per-peer signal the build defines, which is why this
note recommends resolving that signal before the UI is built, not after.
