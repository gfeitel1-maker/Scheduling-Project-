---
title: "The CRDT cutover removes Host-side authorization of incoming writes"
document_type: evidence
status: active
created: 2026-09-08
task: docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
archive_when: the owner has decided, and the decision is recorded in SECURITY.md
---

# The CRDT cutover removes Host-side authorization of incoming writes

**DECIDED (2026-09-08).** The product owner chose option 1: *"accept it and record it for the
security concern."* `SECURITY.md` now carries it under Known limitations as **"Role enforcement is
device-side under CRDT sync"**, including what it does and does not change, and why it is accepted
rather than fixed. The false sentences it used to contain have been corrected in place rather than
deleted, so a reader of the old text can see what changed.

This was a Constitution Article IV gate (*"any change to a security tradeoff recorded as accepted in
`SECURITY.md`"*), which is why the work stopped here rather than proceeding. Found by porting
integration scenario 16 (mid-session role change) to libp2p.

## What SECURITY.md currently promises

> The same `authorize()` call and the same action-derivation logic … are used identically on both the
> IPC and WebSocket paths, **so there is no way to bypass IPC-level restrictions by connecting
> directly to the WebSocket.**

> Work queued offline during this window is submitted to the Host when connectivity is restored —
> **the Host's `authorize()` call on the WS path will then reject it.**

Both sentences are **false once the op-log is retired**, and neither is false today.

## Why

Under the op-log, a Client submitted individual *operations* to the Host, and the Host ran
`authorize()` on each one — checking the author's current role against a permission matrix, re-read
from the database every time. The Host was the enforcement point.

Under the CRDT, a Client does not submit operations. It writes into **its own document** and the two
documents merge. The Host merges whatever an *admitted* peer sends; there is no per-write decision
to make, and nothing in the receive path consults a role. Enforcement has moved entirely onto the
writing device, which is the device you would not trust in this threat model.

## Measured, not argued

Two nodes, real libp2p, a real join. The joining device's user is then demoted to `staff` **on the
Host** — the authority — and the device writes anyway:

```
>> HOST ACCEPTED the write from a demoted device: "Written by staff"
```

`authorize()` is untouched and still correct: it gates that device's own IPC calls. What has gone is
the *second* check, on receipt, by the Host.

## What this does and does not mean

**It is not a hole in the join flow, the auth handshake, or admission.** A stranger still cannot
reach the document: they need the camp code, director approval, and a PIN, and a revoked device is
now evicted from the live admission set (a separate gap found by porting scenario 05, already
fixed).

**It is a change in who is trusted.** Previously: an admitted device could connect, but the Host
still refused actions above its role. Now: an admitted device is trusted for anything it writes. The
realistic threat is a staff member with a legitimately paired device who bypasses the app — editing
the local SQLite directly, or running modified code — to make changes their role forbids.

**It is inherent to the shape, not a bug to fix in passing.** Validating a merged document per-change
means re-deriving who wrote what and whether they could, on every merge, which is most of the way
back to a central authority — the property the migration exists to remove.

## Options, for the owner

1. **Accept it and record it.** Amend `SECURITY.md`: on a LAN of devices the director has personally
   approved, role separation is a UI/workflow control rather than an enforced boundary. Cheapest and
   arguably honest for a camp — but it must be *written down*, because the current text promises the
   opposite.
2. **Authorize at the merge boundary.** Reject incoming changes whose author lacks the role for the
   entity they touched. Requires per-change authorship in the document (Automerge has actor ids, so
   this is possible) and a rule for what happens to a document that is half-acceptable. Real work,
   and it partially reintroduces a central decision point.
3. **Narrow what a non-admin device can hold.** Keep admin-only entities out of the shared document
   entirely and move those writes to an explicit Host-side IPC call. Preserves enforcement for the
   things that matter without validating every merge — but it splits the data model across two sync
   mechanisms, which is what this migration set out to stop doing.

**No recommendation was given.** This was a product judgement about who a camp trusts with a paired
device, and the options differed in what they cost a director rather than in what they cost to build.
**Option 1 was chosen.**

## Status of the work this stopped

Porting integration scenarios to libp2p, so the WS layer can be deleted safely. Two done and
passing (05 revocation, 17+25+26+27 collapsed into one). Scenario 16 is the one that surfaced this.
With option 1 chosen, it is ported as what is now true rather than what used to be: a role change
takes effect immediately on the writing device's own `authorize()` — no token re-issue, no restart —
which is the half of the original property that survives. The half that does not (the Host's second
check on receipt) is recorded in `SECURITY.md` instead of asserted in a test, because there is no
longer anything there to assert.
