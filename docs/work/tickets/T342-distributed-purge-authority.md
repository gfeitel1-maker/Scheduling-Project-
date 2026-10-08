---
ticket: T342
document_type: ticket
title: Make data-erase/purge survive a fired/absent founder — distributed purge authority
status: wont-fix
created: 2026-10-07
closed: 2026-10-07
archive_when: "SHELVED / wont-fix (owner, 2026-10-07, decided-not-worth-it) — recorded as closed; no code ships"
task_class: security-auth
parent: ""
governing_docs: [docs/adr/2026-10-07-distributed-purge-authority.md, docs/adr/2026-10-02-distributed-revocation-authority.md, docs/adr/2026-09-19-multi-device-erasure-propagation.md, SECURITY.md]
related_prs: []
related_tickets: [docs/work/tickets/T233-multi-device-erasure-propagation.md, docs/work/tickets/T333-two-device-revocation-recovery.md]
---

# T342 — Distributed purge authority (purge survives a fired/absent founder)

## SHELVED — wont-fix (owner, 2026-10-07, decided-not-worth-it)

The owner shelved this after design + a two-round build attempt. Reasoning: the app runs on a camp
host's work laptop that is physically turned in on departure, so physical device return + the
already-shipped T331 distributed revocation cover the fired/absent-founder concern in practice; the
unique case this ticket adds (erase a camper when the founding device is gone *and* not returned) does
not justify the cost; and the only sound fix (binding causal context into the signed payload, reopening
the merged T331 signature crypto) was rejected outright. The faithful-carry design hit an intrinsic
forgery class — deriving signer-validity from re-authorable Automerge ancestry while the signature binds
content, not ancestry. **No code ships**; `main`'s purge/erasure behaviour stands unchanged. Full record
and gate history: [`docs/adr/2026-10-07-distributed-purge-authority.md`](../../adr/2026-10-07-distributed-purge-authority.md)
(status: rejected). Abandoned WIP: commits `5992313d` / `0fd89cec`, never merged.

## Context

Owner-directed follow-up (board item `h-purge-survives-fired-founder`), sequenced AFTER the now
fully-merged T331/T332/T335/T336/T337 revocation + WAN ladder. The signed purge-tombstone (T233,
ADR `docs/adr/2026-09-19-multi-device-erasure-propagation.md`) is **Host-signed**:
`electron/automerge/tombstoneSignature.js` signs with `host_signing_key`, and the only device that
can mint a purge today is the Host (`purgeSupportCommand.js:219-245`). That is the same single
permanent-founding-device assumption T331 removed for device revocation. Under the owner's
distributed-hosting requirement (no permanent host since the Stage-6 cutover; a fired or absent
founder must not block camp operation), purge must also survive a fired/absent founder.

Design of record: **`docs/adr/2026-10-07-distributed-purge-authority.md`** (status: proposed — awaiting
organizer acceptance under the owner's standing ADR delegation, since it applies the already-accepted
T331 distributed-authority model to the purge seam).

## What it does

A purge-tombstone becomes a new `kind: 'purge'` entry in the T331 `camp_authority_log`, signed with the
signer's `device_identity_key` under a new domain-separated context and judged by the existing T331
causal-ancestor replay (`authorityReplay.js`): a purge counts only if its signer held a live admin grant
among the causal ancestors of the change it was authored in. The founder is not special and a fired
founder's later purge is dropped identically on every peer. Existing Host-signed v1 tombstones stay
honored (read-only); new code cannot mint one. Monotonicity is re-rooted on a grow-only verified
denylist (the T331 pattern that replaced the unsigned `camp_epoch` scalar), not a host-signed version
counter.

## Two premise corrections the ADR records (verified in code)

1. **A purge is per camper record, not whole-camp** (`purgeSupportCommand.js:392`). Whole-camp erasure
   is a loop of per-record purges. This is what makes a one-admin threshold defensible.
2. **Latent T331 gap — the authority log does not survive a purge's document regeneration.**
   `purgeCamperRecord` regenerates the document via `seedAllFromSqlite` (`purgeSupportCommand.js:400`),
   and `seedAllFromSqlite` deliberately skips `camp_authority_log` (`seed.js:154`). So after a purge the
   regenerated document holds an empty authority log on the purging device until a peer re-merges — and
   the causal-ancestor rule cannot validate a distributed purge from that document. This must be fixed
   first (Slice 0).

## Slices (each through the full security + battle-test gate)

- **S0 — authority carry-forward through purge.** Fixes the latent T331 gap; ships independently.
  Feasibility ~60%; fallback (already written into the ADR) is to refuse a lone-device purge rather than
  degrade silently. BT-8, BT-9, BT-10.
- **S1 — the `purge` kind end to end.** Sign/verify, mint, replay, projector derivation, schema v91 +
  rollback. BT-1 to BT-7, BT-11 to BT-14.
- **S2 — rewire the purge command and key recovery**, docs and SECURITY.md. BT-1, BT-2, BT-15.

## Battle tests

BT-1 … BT-15 as defined in the ADR (red-before-green; real keys, real Automerge documents, the real
projector; no mocks on the crypto/merge seams). Includes the convergence property/fuzz against an
independent oracle (BT-8), fired-founder-can-still-purge (BT-1/BT-2), rogue-removed-admin-purge-dropped
(BT-3), production-path non-vacuity (BT-11/BT-12), and purge-carries-forward (BT-9/BT-10).

## Open question for the owner (one notice, not a blocker)

Threshold (Decision B): **any one valid admin may purge a camper record** (recommended, 70%), vs a
two-tier quorum. The honest residual: a removed admin could author a purge on a pre-removal fork that the
document rule would call valid — bounded by admission (Gate A refuses the removed device live), not by the
document rule, and irreversible when it lands. Pinned as BT-4b so it is documented, not accidental.

## Gate

Full security + battle-test gate per the board (`security-assessment` + Security + Red Hat + Grader +
real adversarial battle-testing, red-before-green). A Grader FAIL is a STOP → escalate to the organizer,
never a third round.
