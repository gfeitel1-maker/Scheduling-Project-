---
title: "Schema-version handshake and a version gate before Automerge merge"
document_type: ticket
status: completed
task_class: database-sync
date: 2026-09-26
created: 2026-09-26
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md, docs/adr/2026-09-26-schema-version-gate-before-merge.md]
related_adrs: [docs/adr/2026-09-26-schema-version-gate-before-merge.md, docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md, docs/adr/2026-09-17-wan-rendezvous-seam.md]
related_tickets: [docs/work/tickets/T211-wire-rendezvous-into-discovery-path.md, docs/work/tickets/T222-update-on-open.md]
program: relay-sync
archive_when: "A same-genesis document whose schema version differs from this device's is refused at the merge step while the peer's authentication and connection survive, the refusal is silent (no director-facing surface) and self-resolves once both devices run the same version, and a non-vacuous integration test orders the mismatch so the receiving device cannot have merged it by accident"
---

# T271 — Schema-version handshake and a version gate before Automerge merge

## The defect this closes (anchored to code, not to the ADR that wanted it)

The sync transport cannot identify a peer's schema version, and merges anyway:

- `electron/sync/automerge/mutualAuth.js:33` — the authenticate handshake sends
  `{ type: 'authenticate', token, device_id }`. **There is no version field**, so a peer's schema
  version is never known at the auth seam.
- `electron/sync/automerge/syncNode.js:187`→`200` — `handleReceived` refuses a document that does
  not share this camp's genesis (the destructive-merge guard at :187), and then at :200 merges
  **any** same-genesis document **unconditionally** via `A.merge(currentDoc, incoming)`. There is no
  schema-version check between those two points.

Consequence: two devices with matching genesis but different schema versions merge freely and
silently. `syncNode.js:180-188`'s own comment already documents that a genesis-sharing but
structurally incompatible merge is destructive rather than merely useless — collections collide as
map keys, one side's collection can disappear nondeterministically, and the admission gate cannot
catch it because the sender is a legitimately admitted peer ("Found by porting integration scenario
14 to libp2p"). This is a known, already-manifested defect.

The repo's own adjacent practice makes the omission conspicuous:
`electron/sync/automerge/rendezvousRecord.js:159-161` **does** version-gate
(`if (version !== VERSION) return { unsupportedVersion: true }`) before reading any
variable-length field.

## Why now

T270 (`electron/sync/automerge/rendezvousClient.js`) extends this transport from an mDNS-bounded LAN
to any internet peer that publishes a rendezvous record. That widens the blast radius of the
version-blind merge from "someone in the building" to "anyone holding a valid camp token, from
anywhere". Security, Red Hat, and Code Reviewer independently converged: this gate must land before
rendezvous is enabled. ADR 2026-09-18's mixed-version safety argument rested on update-on-open
(T222), which the owner rejected ("when someone comes online, they sync"); that ADR's
premise-removed note reopened the question under this program and named T271 as its resolution.

## Owner-locked decisions (do not re-open in implementation)

Owner ruling, 2026-09-26, verbatim: *"a s fine. self resolve. yes to enable gate."*

1. **Strict exact-match.** Merge only when the incoming document's schema version equals this
   device's. No forward-tolerant range, no compatibility window.
2. **Silent and self-resolving. No director-facing surface** — no flag, no banner, no message. The
   mismatch heals on its own once both devices run the same version.
3. **Refuse the merge, not the authentication.** The peer stays authenticated and connected; only
   the specific merge is declined. This is the distinction that keeps this gate from being the
   update-on-open the owner rejected: it never holds a device out of sync *at the door*, and a
   director never sees a blocked state.
4. **Sequencing.** This lands before the Tier-4 re-assessment, before `INTERNET_TRANSPORT_SIGNOFF`
   flips, and before T211 unparks.

## Success predicate

**Revised (round 3) — the original predicate below the line described a document-root carrier that
was found defective and removed. See ADR 2026-09-26's round-3 revision. The shipped predicate is:**

- The `authenticate` handshake carries a per-device schema version (additive field; it does **not**
  gate auth — a peer omitting it is still admitted).
- That per-device value — **not** a document field — is the authoritative compatibility signal,
  recorded per-peer at admission time in `syncNode.js`'s `peerSchemaVersions` map and cleared on
  disconnect alongside `syncStates`. **Every** admission path must populate it: `onAuthenticate` and
  `joinSession.js`'s first-join `login`/`admitPeer` bypass are the two that exist.
- A version check gates **all three** sites where `syncNode.js` touches a remote merge/sync
  primitive — `stepSync` (silently, no log; it fires on every trigger), `handleSyncMessage` (the real
  production incremental path), and `handleReceived` — each mirroring the `sharesGenesis` refusal's
  shape (return, no throw).
- In `handleSyncMessage` the refusal **precedes any state-advancing call**, so `syncStates` is never
  touched for a refused peer and the peer is never marked caught-up.
- A mismatched document is not merged; the connection, auth, and trust state survive.
- Nothing surfaces to the director.
- **Fail-closed:** a peer with no recorded version (or a non-numeric one) is refused, never admitted
  by default.

_Prior (round 1, defective — retained for history): the Automerge document root carried an
authoritative `schemaVersion`, and a single version check sat in `handleReceived`. That carrier was
shared LWW CRDT state that nothing ever stamped onto a pre-existing document, freezing every
existing camp forever; and `handleReceived` is not the production sync path._

## What this gate does and does not buy

**It prevents accidents, not attacks.** The version is a peer's self-reported claim. A compromised
but authenticated peer can announce a matching version and send arbitrarily-shaped data, and the
merge proceeds. That is not a regression: per `SECURITY.md`, a compromised paired peer is already
attacker-controlled at the CRDT layer, and this gate neither widens nor closes that boundary. Do not
cite this gate as an anti-forgery control.

## Does NOT count as done

- Gating or refusing **authentication** on version grounds (that is the rejected door-blocking).
- Any director-facing surface for a version mismatch.
- A forward-tolerant compatibility range, or any `mergeBreaking`/migration-classification machinery
  (explicitly out of scope — strict exact-match needs none of it).
- Touching `INTERNET_TRANSPORT_SIGNOFF`, T211 wiring, or `rendezvousClient.js`.
- Unit tests only: the merge-refusal must be proven at the integration harness
  (`test/integration/run.automerge.js`), non-vacuously — the mismatch ordered so the receiving
  device could not have merged it by accident.

## Evidence required

- Integration-harness test: a version-mismatched same-genesis document offered to a device is
  refused at the merge step, auth/connection intact, nothing surfaced.
- Non-vacuity: the test fails if the gate is removed.
- `node scripts/check-governance.js` clean.
