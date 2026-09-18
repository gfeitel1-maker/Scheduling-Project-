---
title: "Phase C — feed validated rendezvous discoveries into the existing dial and mutual-auth path"
document_type: ticket
status: parked
created: 2026-09-17
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
archive_when: "A trusted peer discovered via rendezvous completes mutual auth and Automerge sync identically to an mDNS-discovered peer, an untrusted one never reaches the auth seam, and the owner has recorded the Tier-4 re-assessment"
---

# T211 — Phase C: wire rendezvous into the existing path

## Scope

A rendezvous client surfaces validated candidates in the **identical shape** mDNS already produces,
into the same `onPeerDiscovery` consumer, so that mutual auth, dial, Noise/Yamux and Automerge
cannot distinguish the two sources and need no change.

## Blocked — this is the owner gate

This is the ticket that makes the node internet-reachable in practice. It requires:

1. T207 landed, so the widened guard actually sees this change.
2. T208 landed, so a rendezvous-sourced peer cannot be sent a credential.
3. The Tier-4 re-assessment recorded and `INTERNET_TRANSPORT_SIGNOFF` flipped **by the owner**.
   No agent may flip it. The preconditions are enumerated in
   `docs/work/security/2026-09-17-rendezvous-wan-assessment.md`.

Also unresolved and in scope here: revocation lag (a revoked device off-LAN can still be reached by
peers whose revocation has not converged, and its signed record survives in KV for up to its TTL),
and dial budgeting/backoff so stale or private addresses cannot turn startup into a dial storm.

## Does NOT count as done

- Any change to `authorize()`, `mutualAuth.js`'s auth decision, or the pairing state machine.
  If this ticket touches those, the scope has crept.
- Verification against the `:5200` browser mock. Sync and auth claims require `electron:dev`.
